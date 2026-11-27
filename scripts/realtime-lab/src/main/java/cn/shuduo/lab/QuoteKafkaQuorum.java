package cn.shuduo.lab;

import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.common.TopicPartitionInfo;
import org.apache.kafka.common.Uuid;
import org.apache.kafka.common.config.ConfigResource;

import java.io.IOException;
import java.io.StringReader;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static cn.shuduo.lab.QuoteReplay.*;

final class QuoteKafkaQuorum implements AutoCloseable {
    private final String address;
    private final String output;
    private final List<Process> brokers = new ArrayList<>();

    record Failover(int leaderBefore, int leaderAfter, int replicasBefore, int replicasAfter, int exitCode) {}

    private QuoteKafkaQuorum(String address, String output) {
        this.address = address;
        this.output = output;
    }

    static QuoteKafkaQuorum start(Path run, String output) throws Exception {
        List<Integer> ports = allocatePorts();
        String address = String.join(",", ports.subList(0,3).stream().map(port -> "127.0.0.1:" + port).toList());
        String voters = "1@127.0.0.1:" + ports.get(3) + ",2@127.0.0.1:" + ports.get(4) + ",3@127.0.0.1:" + ports.get(5);
        String cluster = Uuid.randomUuid().toString();
        var quorum = new QuoteKafkaQuorum(address, output);
        try {
            for (int id=1;id<=3;id++) {
                Path node = Files.createDirectory(run.resolve("broker-" + id));
                Path config = node.resolve("kafka.properties");
                writeConfig(config,node.resolve("data"),id,ports.get(id-1),ports.get(id+2),voters);
                Process format = javaProcess(192,node.resolve("format.log"),"kafka.tools.StorageTool",
                    "format","--cluster-id",cluster,"--config",config.toString());
                if (!format.waitFor(20, TimeUnit.SECONDS)) {
                    format.destroyForcibly();
                    throw new IllegalStateException("KAFKA_QUORUM_FORMAT_TIMEOUT");
                }
                require(format.exitValue() == 0,"KAFKA_QUORUM_FORMAT_FAILED");
                quorum.brokers.add(javaProcess(320,node.resolve("broker.log"),"kafka.Kafka",config.toString()));
            }
            quorum.createReplicatedTopics();
            return quorum;
        } catch (Exception error) {
            quorum.close();
            throw error;
        }
    }

    String address() { return address; }

    private static List<Integer> allocatePorts() throws IOException {
        var sockets = new ArrayList<ServerSocket>();
        try {
            for (int i=0;i<6;i++) sockets.add(new ServerSocket(0,1,java.net.InetAddress.getByName("127.0.0.1")));
            return sockets.stream().map(ServerSocket::getLocalPort).toList();
        } finally {
            for (ServerSocket socket : sockets) socket.close();
        }
    }

    private static void writeConfig(Path config, Path data, int id, int port, int controllerPort, String voters)
        throws IOException {
        var properties = new Properties();
        properties.load(new StringReader("""
            process.roles=broker,controller
            node.id=%d
            controller.quorum.voters=%s
            listeners=PLAINTEXT://127.0.0.1:%d,CONTROLLER://127.0.0.1:%d
            advertised.listeners=PLAINTEXT://127.0.0.1:%d
            listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
            controller.listener.names=CONTROLLER
            inter.broker.listener.name=PLAINTEXT
            default.replication.factor=3
            min.insync.replicas=2
            unclean.leader.election.enable=false
            offsets.topic.replication.factor=3
            offsets.topic.num.partitions=3
            transaction.state.log.replication.factor=3
            transaction.state.log.min.isr=2
            transaction.state.log.num.partitions=3
            group.initial.rebalance.delay.ms=0
            num.network.threads=2
            num.io.threads=3
            auto.create.topics.enable=false
            """.formatted(id,voters,port,controllerPort,port)));
        properties.setProperty("log.dirs",data.toString());
        try (var file = Files.newOutputStream(config)) {
            properties.store(file,null);
        }
    }

    private Admin admin() {
        return Admin.create(Map.of("bootstrap.servers",address,"request.timeout.ms",3000,"default.api.timeout.ms",6000));
    }

    private void createReplicatedTopics() throws Exception {
        try (Admin client = admin()) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            while (true) {
                require(System.nanoTime() < deadline && brokers.stream().allMatch(Process::isAlive),"KAFKA_QUORUM_NOT_READY");
                try {
                    if (client.describeCluster().nodes().get(7,TimeUnit.SECONDS).size() == 3) break;
                } catch (ExecutionException | TimeoutException error) {
                    // Broker registration is asynchronous.
                }
                Thread.sleep(250);
            }
            var safety = Map.of("min.insync.replicas","2","unclean.leader.election.enable","false");
            client.createTopics(List.of(new NewTopic(INPUT,2,(short) 3).configs(safety),
                new NewTopic(output,1,(short) 3).configs(safety))).all().get(8,TimeUnit.SECONDS);
            readPartition(client,3,-1);
            var resources = List.of(new ConfigResource(ConfigResource.Type.TOPIC,INPUT),
                new ConfigResource(ConfigResource.Type.TOPIC,output));
            var configs = client.describeConfigs(resources).all().get(8,TimeUnit.SECONDS);
            for (var resource : resources) {
                var config = configs.get(resource);
                require(config != null && config.get("min.insync.replicas").value().equals("2") &&
                    config.get("unclean.leader.election.enable").value().equals("false"),"KAFKA_REPLICATION_POLICY_MISMATCH");
            }
        }
    }

    Failover stopInputLeader() throws Exception {
        try (Admin client = admin()) {
            TopicPartitionInfo before = readPartition(client,3,-1);
            int leader = before.leader().id();
            require(leader >= 1 && leader <= brokers.size(),"KAFKA_LEADER_OUTSIDE_TEST_QUORUM");
            Process removed = brokers.get(leader-1);
            require(removed.isAlive(),"KAFKA_LEADER_ALREADY_EXITED");
            removed.destroyForcibly();
            require(removed.waitFor(8,TimeUnit.SECONDS) && removed.exitValue() == 137,"KAFKA_LEADER_SIGKILL_UNCONFIRMED");
            TopicPartitionInfo after = readPartition(client,2,leader);
            require(brokers.stream().filter(Process::isAlive).count() == 2,"KAFKA_SURVIVORS_MISMATCH");
            return new Failover(leader,after.leader().id(),before.isr().size(),after.isr().size(),removed.exitValue());
        }
    }

    private TopicPartitionInfo readPartition(Admin client, int inSync, int excluded) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
        while (System.nanoTime() < deadline) {
            try {
                var topics = client.describeTopics(List.of(INPUT,output)).allTopicNames().get(7,TimeUnit.SECONDS);
                var input = topics.get(INPUT).partitions();
                var sink = topics.get(output).partitions();
                if (input.size() == 2 && sink.size() == 1 && java.util.stream.Stream.concat(input.stream(),sink.stream())
                    .allMatch(partition -> partition.leader() != null && partition.leader().id() >= 1 &&
                        partition.leader().id() != excluded && partition.replicas().size() == 3 &&
                        partition.isr().size() == inSync && partition.isr().stream().noneMatch(node -> node.id() == excluded))) {
                    return input.stream().filter(partition -> partition.partition() == 0).findFirst().orElseThrow();
                }
            } catch (ExecutionException | TimeoutException error) {
                // Topic metadata can be temporarily unavailable during election.
            }
            Thread.sleep(250);
        }
        throw new IllegalStateException("KAFKA_PARTITION_ELECTION_UNCONFIRMED");
    }

    @Override public void close() {
        for (Process broker : brokers) if (broker.isAlive()) broker.destroy();
        for (Process broker : brokers) {
            try {
                if (!broker.waitFor(8,TimeUnit.SECONDS)) {
                    broker.destroyForcibly();
                    broker.waitFor(8,TimeUnit.SECONDS);
                }
            } catch (InterruptedException error) {
                broker.destroyForcibly();
                Thread.currentThread().interrupt();
            }
        }
    }
}
