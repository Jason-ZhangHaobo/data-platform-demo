package cn.shuduo.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.flink.core.execution.JobClient;
import org.apache.flink.core.execution.SavepointFormatType;
import org.apache.flink.table.api.EnvironmentSettings;
import org.apache.flink.table.api.TableEnvironment;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.Uuid;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.io.StringReader;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class QuoteReplay {
    private static final String INPUT = "shuduo-quote-events";
    private static final String OUTPUT = "shuduo-latest-quotes";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long WAIT_SECONDS = 45;

    private record Update(String security, JsonNode value) {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: QuoteReplay REPO_ROOT NEW_RUN_DIR");
        Path repo = Path.of(args[0]).toRealPath();
        Path run = Path.of(args[1]).toAbsolutePath();
        Files.createDirectory(run);
        List<String> fixture = Files.readAllLines(repo.resolve("fixtures/streams/quotes_recovered.jsonl"));
        require(fixture.size() == 6 && fixture.get(4).equals(fixture.get(5)), "UNEXPECTED_QUOTE_FIXTURE");
        String sql = Files.readString(repo.resolve("scripts/realtime-lab/quotes.sql"));
        int brokerPort;
        int controllerPort;
        try (ServerSocket brokerSocket = loopbackSocket(); ServerSocket controllerSocket = loopbackSocket()) {
            brokerPort = brokerSocket.getLocalPort();
            controllerPort = controllerSocket.getLocalPort();
        }
        String address = "127.0.0.1:" + brokerPort;
        Process broker = startBroker(run, address, controllerPort);
        JobClient original = null;
        JobClient restored = null;
        try {
            createTopics(address, broker);
            List<String> initial = fixture.subList(0, 4);
            publish(address, initial, 0);
            original = submit(sql, address, run, null);
            var expectedInitial = expected(initial);
            List<Update> before = committedOutput(address, expectedInitial);
            String savepoint = original.stopWithSavepoint(false, flinkFile(run.resolve("savepoints")),
                SavepointFormatType.CANONICAL).get(WAIT_SECONDS, TimeUnit.SECONDS);
            Path savedState = Path.of(new org.apache.flink.core.fs.Path(savepoint).toUri().getPath());
            require(savedState.getParent().equals(run.resolve("savepoints")) &&
                Files.isRegularFile(savedState.resolve("_metadata")), "SAVEPOINT_METADATA_MISSING_OR_OUTSIDE_RUN");

            var late = (ObjectNode) JSON.readTree(fixture.get(0));
            late.put("event_id", "EVT-Q-LATE");
            late.put("price", "11.00");
            var invalid = (ObjectNode) JSON.readTree(fixture.get(4));
            invalid.put("event_id", "EVT-Q-INVALID");
            invalid.put("sequence", 6);
            invalid.put("price", "-1.00");
            List<String> additional = List.of(fixture.get(0), late.toString(), invalid.toString(), fixture.get(4), fixture.get(5));
            long nextInputOffset = publish(address, additional, initial.size());
            restored = submit(sql, address, run, flinkFile(savedState));
            require(!original.getJobID().equals(restored.getJobID()), "JOB_WAS_NOT_RESTARTED");
            var complete = new ArrayList<>(initial);
            complete.addAll(additional);
            var expectedFinal = expected(complete);
            committedOutput(address, expectedFinal);
            restored.stopWithSavepoint(false, flinkFile(run.resolve("savepoints")),
                SavepointFormatType.CANONICAL).get(WAIT_SECONDS, TimeUnit.SECONDS);
            List<Update> after = committedOutput(address, expectedFinal);
            require(after.size() == before.size() + 1 && after.subList(0, before.size()).equals(before),
                "UNEXPECTED_REPLAY_OR_EXTRA_UPDATES");
            require(after.get(after.size() - 1).value().path("event_id").asText().equals("EVT-Q-005"),
                "WRONG_RESTORED_UPDATE");

            var evidence = JSON.createObjectNode();
            evidence.put("scope", "LOCAL_KAFKA_FLINK_SYNTHETIC_QUOTES");
            evidence.put("result", "VERIFIED");
            evidence.put("kafkaVersion", org.apache.kafka.common.utils.AppInfoParser.getVersion());
            evidence.put("flinkVersion", org.apache.flink.runtime.util.EnvironmentInformation.getVersion());
            evidence.put("inputEvents", nextInputOffset);
            evidence.put("committedUpdatesBefore", before.size());
            evidence.put("committedUpdatesAfter", after.size());
            evidence.put("originalJobId", original.getJobID().toString());
            evidence.put("restoredJobId", restored.getJobID().toString());
            evidence.set("finalQuotes", JSON.valueToTree(expectedFinal));
            JSON.writerWithDefaultPrettyPrinter().writeValue(run.resolve("evidence.json").toFile(), evidence);
            System.out.println(evidence);
        } finally {
            stopJob(restored);
            stopJob(original);
            broker.destroy();
            if (!broker.waitFor(8, TimeUnit.SECONDS)) {
                broker.destroyForcibly();
                broker.waitFor(8, TimeUnit.SECONDS);
            }
        }
    }

    private static ServerSocket loopbackSocket() throws Exception {
        return new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
    }

    private static String flinkFile(Path path) {
        // Flink encodes the supplied path itself, including Unicode and whitespace.
        return "file://" + path;
    }

    private static Process startBroker(Path run, String address, int controllerPort) throws Exception {
        Path config = run.resolve("kafka.properties");
        var properties = new Properties();
        properties.load(new StringReader("""
            process.roles=broker,controller
            node.id=1
            controller.quorum.bootstrap.servers=127.0.0.1:%d
            listeners=PLAINTEXT://%s,CONTROLLER://127.0.0.1:%d
            advertised.listeners=PLAINTEXT://%s
            listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
            controller.listener.names=CONTROLLER
            inter.broker.listener.name=PLAINTEXT
            offsets.topic.replication.factor=1
            transaction.state.log.replication.factor=1
            transaction.state.log.min.isr=1
            group.initial.rebalance.delay.ms=0
            auto.create.topics.enable=false
            """.formatted(controllerPort, address, controllerPort, address)));
        properties.setProperty("log.dirs", run.resolve("broker-data").toString());
        try (var output = Files.newOutputStream(config)) {
            properties.store(output, null);
        }
        Process format = javaProcess(run.resolve("broker-format.log"), "kafka.tools.StorageTool",
            "format", "--standalone", "--cluster-id", Uuid.randomUuid().toString(), "--config", config.toString());
        if (!format.waitFor(20, TimeUnit.SECONDS)) {
            format.destroyForcibly();
            throw new IllegalStateException("BROKER_FORMAT_TIMEOUT");
        }
        require(format.exitValue() == 0, "BROKER_FORMAT_FAILED");
        return javaProcess(run.resolve("broker.log"), "kafka.Kafka", config.toString());
    }

    private static Process javaProcess(Path log, String main, String... args) throws Exception {
        var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-Xmx384m", "-Dorg.slf4j.simpleLogger.defaultLogLevel=warn", "-cp",
            System.getProperty("java.class.path"), main));
        command.addAll(List.of(args));
        return new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
    }

    private static void createTopics(String address, Process broker) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_SECONDS);
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", address, "request.timeout.ms", 2500,
            "default.api.timeout.ms", 3000))) {
            while (System.nanoTime() < deadline && broker.isAlive()) {
                try {
                    admin.describeCluster().nodes().get(3, TimeUnit.SECONDS);
                    admin.createTopics(List.of(new NewTopic(INPUT, 1, (short) 1),
                        new NewTopic(OUTPUT, 1, (short) 1))).all().get(10, TimeUnit.SECONDS);
                    return;
                } catch (ExecutionException | TimeoutException error) {
                    Thread.sleep(250);
                }
            }
        }
        throw new IllegalStateException("BROKER_NOT_READY");
    }

    private static long publish(String address, List<String> events, long nextOffset) throws Exception {
        try (var producer = new KafkaProducer<>(Map.of("bootstrap.servers", address, "acks", "all",
            "delivery.timeout.ms", 10000, "request.timeout.ms", 5000, "max.block.ms", 10000),
            new StringSerializer(), new StringSerializer())) {
            for (String event : events) {
                var record = producer.send(new ProducerRecord<String, String>(INPUT, event)).get(12, TimeUnit.SECONDS);
                require(record.partition() == 0 && record.offset() == nextOffset, "INPUT_OFFSET_MISMATCH");
                nextOffset++;
            }
        }
        return nextOffset;
    }

    private static JobClient submit(String sql, String address, Path run, String savepoint) {
        EnvironmentSettings settings = EnvironmentSettings.newInstance().inStreamingMode().build();
        TableEnvironment table = TableEnvironment.create(settings);
        table.getConfig().set("parallelism.default", "1");
        table.getConfig().set("taskmanager.numberOfTaskSlots", "1");
        table.getConfig().set("rest.bind-address", "127.0.0.1");
        table.getConfig().set("jobmanager.bind-host", "127.0.0.1");
        table.getConfig().set("taskmanager.bind-host", "127.0.0.1");
        table.getConfig().set("execution.checkpointing.interval", "1 s");
        table.getConfig().set("execution.checkpointing.dir", flinkFile(run.resolve("checkpoints")));
        if (savepoint != null) table.getConfig().set("execution.state-recovery.path", savepoint);
        JobClient job = null;
        for (String statement : sql.replace("@BROKER@", address).split(";")) {
            if (!statement.isBlank()) {
                var result = table.executeSql(statement.trim());
                if (result.getJobClient().isPresent()) job = result.getJobClient().orElseThrow();
            }
        }
        if (job == null) throw new IllegalStateException("FLINK_SQL_JOB_NOT_SUBMITTED");
        return job;
    }

    private static Map<String, JsonNode> expected(List<String> events) throws Exception {
        var latest = new TreeMap<String, JsonNode>();
        for (String text : events) {
            JsonNode event = JSON.readTree(text);
            if (new BigDecimal(event.path("price").asText()).signum() <= 0) continue;
            String security = event.path("security_code").asText();
            JsonNode prior = latest.get(security);
            if (prior == null || event.path("sequence").asLong() > prior.path("sequence").asLong())
                latest.put(security, event);
        }
        return latest;
    }

    private static List<Update> committedOutput(String address, Map<String, JsonNode> expected) throws Exception {
        var observed = new TreeMap<String, JsonNode>();
        var changes = new ArrayList<Update>();
        var partition = new TopicPartition(OUTPUT, 0);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_SECONDS);
        try (var consumer = new KafkaConsumer<>(Map.of("bootstrap.servers", address,
            "isolation.level", "read_committed", "enable.auto.commit", false, "default.api.timeout.ms", 5000),
            new StringDeserializer(), new StringDeserializer())) {
            consumer.assign(List.of(partition));
            consumer.seekToBeginning(List.of(partition));
            long stableSince = 0;
            while (System.nanoTime() < deadline) {
                for (var record : consumer.poll(Duration.ofMillis(200))) {
                    String key = JSON.readTree(record.key()).path("security_code").asText();
                    JsonNode value = record.value() == null ? null : JSON.readTree(record.value());
                    changes.add(new Update(key, value));
                    if (value == null) observed.remove(key);
                    else observed.put(key, value);
                    stableSince = 0;
                }
                if (!observed.equals(expected)) stableSince = 0;
                else if (stableSince == 0) stableSince = System.nanoTime();
                else if (System.nanoTime() - stableSince > TimeUnit.SECONDS.toNanos(2)) return changes;
            }
        }
        throw new IllegalStateException("COMMITTED_OUTPUT_MISMATCH");
    }

    private static void stopJob(JobClient job) {
        if (job == null) return;
        try {
            if (!job.getJobStatus().get(2, TimeUnit.SECONDS).isGloballyTerminalState())
                job.cancel().get(5, TimeUnit.SECONDS);
        } catch (Exception ignored) {
            // The embedded MiniCluster may already have closed at termination.
        }
    }

    private static void require(boolean condition, String error) {
        if (!condition) throw new IllegalStateException(error);
    }
}
