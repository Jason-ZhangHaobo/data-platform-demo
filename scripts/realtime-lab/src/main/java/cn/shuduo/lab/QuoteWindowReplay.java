package cn.shuduo.lab;

import com.fasterxml.jackson.databind.JsonNode;
import org.apache.flink.api.common.JobStatus;
import org.apache.flink.core.execution.JobClient;
import org.apache.flink.core.execution.SavepointFormatType;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.errors.GroupIdNotFoundException;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static cn.shuduo.lab.QuoteReplay.*;

final class QuoteWindowReplay {
    private static final String OUTPUT = "shuduo-quote-windows";
    private static final String GROUP = "shuduo-flink-window-lab";
    private static final String A = "SEC-DEMO-001";
    private static final String B = "SEC-DEMO-002";
    private static final Instant BASE = Instant.parse("2026-09-14T09:30:00Z");
    private static final DateTimeFormatter WINDOW = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss")
        .withZone(ZoneOffset.UTC);
    private static final TopicPartition LEFT = new TopicPartition(INPUT, 0);
    private static final TopicPartition RIGHT = new TopicPartition(INPUT, 1);

    private record Quote(int partition, long offset, int second, String security, long volume) {}
    private record Totals(long count, long volume) {}

    static void run(Path repo, Path run, boolean brokerCrash) throws Exception {
        Files.createDirectory(run);
        Path sqlPath = repo.resolve("scripts/realtime-lab/windows.sql");
        String sql = Files.readString(sqlPath);
        Process broker = null;
        QuoteKafkaQuorum quorum = null;
        String address;
        if (brokerCrash) {
            quorum = QuoteKafkaQuorum.start(run,OUTPUT);
            address = quorum.address();
        } else {
            int brokerPort;
            int controllerPort;
            try (var brokerSocket = loopbackSocket(); var controllerSocket = loopbackSocket()) {
                brokerPort = brokerSocket.getLocalPort();
                controllerPort = controllerSocket.getLocalPort();
            }
            address = "127.0.0.1:" + brokerPort;
            broker = startBroker(run, address, controllerPort);
        }
        Process worker = null;
        JobClient restored = null;
        try {
            if (!brokerCrash) createTopics(address, broker, OUTPUT, 2);
            var early = List.of(new Quote(0, 0, 1, A, 100), new Quote(0, 1, 14, A, 30),
                new Quote(1, 0, 8, A, 200), new Quote(1, 1, 4, B, 25));
            publish(address, early);
            int originalPort = brokerCrash ? 0 : freePort();
            String originalJobId;
            if (brokerCrash) {
                restored = submit(sql,address,run,null,0);
                originalJobId = restored.getJobID().toString();
            } else {
                worker = javaProcess(768, run.resolve("flink-before-crash.log"), QuoteReplay.class.getName(),
                    "--flink-worker", repo.toString(), run.toString(), address, String.valueOf(originalPort), "windows");
                originalJobId = awaitJobId(run, worker);
            }
            awaitOffsets(address, 2, 2);
            List<JsonNode> held = committedWindows(address, Map.of());
            System.out.println("WINDOWS_HELD_AT_COMMITTED_OFFSETS");

            var accepted = new ArrayList<>(early);
            var advanceRight = new Quote(1, 2, 13, B, 20);
            publish(address, List.of(advanceRight));
            accepted.add(advanceRight);
            List<JsonNode> before = committedWindows(address, expected(accepted, 10));
            Checkpoint checkpoint = brokerCrash ? null : nextCompletedCheckpoint(run, originalJobId, originalPort);

            var beforeExit = new Quote(0, 2, 16, A, 50);
            publish(address, List.of(beforeExit));
            accepted.add(beforeExit);
            QuoteKafkaQuorum.Failover failover = null;
            long restoredCheckpointId = 0;
            if (brokerCrash) {
                failover = quorum.stopInputLeader();
                require(restored.getJobStatus().get(6,TimeUnit.SECONDS) == JobStatus.RUNNING,"WINDOW_JOB_NOT_RUNNING_AFTER_ELECTION");
                System.out.println("KAFKA_WINDOW_LEADER_REELECTED");
            } else {
                require(worker.isAlive(), "WINDOW_JOB_EXITED_BEFORE_INJECTED_FAILURE");
                worker.destroyForcibly();
                require(worker.waitFor(8, TimeUnit.SECONDS) && worker.exitValue() == 137, "WINDOW_JOB_SIGKILL_UNCONFIRMED");
            }
            require(committedWindows(address, expected(accepted, 10)).equals(before), "WINDOWS_CHANGED_BEFORE_RECOVERY");
            if (!brokerCrash) {
                int restoredPort = freePort();
                restored = submit(sql, address, run, flinkFile(checkpoint.path()), restoredPort);
                require(!restored.getJobID().toString().equals(originalJobId), "WINDOW_JOB_NOT_RESTARTED");
                restoredCheckpointId = verifyRestoredCheckpoint(restoredPort, restored.getJobID().toString(), checkpoint);
                System.out.println("WINDOW_JOB_CHECKPOINT_RESTORED");
            }
            String restoredJobId = restored.getJobID().toString();
            var next = List.of(new Quote(0, 3, 25, A, 70), new Quote(1, 3, 24, B, 40));
            publish(address, next);
            accepted.addAll(next);
            List<JsonNode> afterRestore = committedWindows(address, expected(accepted, 20));
            require(afterRestore.subList(0, before.size()).equals(before), "WINDOW_HISTORY_CHANGED_ON_RECOVERY");

            var late = new Quote(1, 4, 7, A, 9999);
            var end = List.of(new Quote(1, 5, 34, B, 1), new Quote(0, 4, 33, A, 1));
            publish(address, List.of(late, end.get(0), end.get(1)));
            accepted.addAll(end);
            awaitOffsets(address, 5, 6);
            List<JsonNode> finalOutput = committedWindows(address, expected(accepted, 30));
            require(finalOutput.subList(0, afterRestore.size()).equals(afterRestore), "LATE_QUOTE_CHANGED_CLOSED_WINDOW");
            String finalSavepoint = restored.stopWithSavepoint(false, flinkFile(run.resolve("savepoints")),
                SavepointFormatType.CANONICAL).get(45, TimeUnit.SECONDS);
            require(committedWindows(address,expected(accepted,30)).equals(finalOutput),"OUTPUT_CHANGED_ON_STOP");

            var evidence = JSON.createObjectNode();
            evidence.put("scope", brokerCrash ? "LOCAL_KAFKA_REPLICATED_WINDOWS" : "LOCAL_KAFKA_FLINK_EVENT_TIME_WINDOWS");
            evidence.put("result", "VERIFIED");
            evidence.put("kafkaVersion",org.apache.kafka.common.utils.AppInfoParser.getVersion());
            evidence.put("flinkVersion",org.apache.flink.runtime.util.EnvironmentInformation.getVersion());
            evidence.put("sqlDigest", fileDigest(sqlPath));
            evidence.putArray("partitionInputCounts").add(5).add(6);
            evidence.put("windowsWhilePartitionHeld", held.size());
            evidence.put("windowsBeforeCrash", before.size());
            evidence.put("windowsAfterRestore", afterRestore.size());
            evidence.put("finalWindowRows", finalOutput.size());
            evidence.put("originalJobId", originalJobId);
            evidence.put("restoredJobId", restoredJobId);
            if (brokerCrash) {
                evidence.putObject("brokerFailover").put("partition",0)
                    .put("leaderBefore",failover.leaderBefore()).put("leaderAfter",failover.leaderAfter())
                    .put("replicasBefore",failover.replicasBefore()).put("replicasAfter",failover.replicasAfter())
                    .put("minInSyncReplicas",2).put("exitCode",failover.exitCode());
            } else {
                evidence.put("checkpointId", checkpoint.id());
                evidence.put("restoredCheckpointId", restoredCheckpointId);
                evidence.put("checkpointDigest", checkpoint.digest());
                evidence.put("exitCode", worker.exitValue());
            }
            evidence.put("restoredSavepointDigest",fileDigest(localSavepoint(run,finalSavepoint).resolve("_metadata")));
            evidence.put("partitionBeforeExit",beforeExit.partition());
            evidence.put("inputOffsetBeforeExit",beforeExit.offset());
            evidence.putArray("windowRows").addAll(finalOutput);
            JSON.writerWithDefaultPrettyPrinter().writeValue(run.resolve("evidence.json").toFile(), evidence);
        } finally {
            if (worker != null && worker.isAlive()) {
                worker.destroyForcibly();
                worker.waitFor(8, TimeUnit.SECONDS);
            }
            stopJob(restored);
            if (quorum != null) quorum.close();
            if (broker != null) {
                broker.destroy();
                if (!broker.waitFor(8, TimeUnit.SECONDS)) {
                    broker.destroyForcibly();
                    broker.waitFor(8, TimeUnit.SECONDS);
                }
            }
        }
    }

    private static void publish(String address, List<Quote> quotes) throws Exception {
        try (var producer = new KafkaProducer<>(Map.of("bootstrap.servers", address, "acks", "all",
            "delivery.timeout.ms", 10000, "request.timeout.ms", 5000, "max.block.ms", 10000),
            new StringSerializer(), new StringSerializer())) {
            for (Quote quote : quotes) {
                var event = JSON.createObjectNode().put("security_code", quote.security())
                    .put("event_ms", BASE.plusSeconds(quote.second()).toEpochMilli()).put("volume", quote.volume());
                var record = producer.send(new ProducerRecord<>(INPUT, quote.partition(), quote.security(), event.toString()))
                    .get(12, TimeUnit.SECONDS);
                require(record.partition() == quote.partition() && record.offset() == quote.offset(),
                    "WINDOW_INPUT_OFFSET_MISMATCH");
            }
        }
    }

    private static void awaitOffsets(String address, long left, long right) throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", address, "request.timeout.ms", 3000,
            "default.api.timeout.ms", 4000))) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            while (System.nanoTime() < deadline) {
                try {
                    var offsets = admin.listConsumerGroupOffsets(GROUP).partitionsToOffsetAndMetadata().get(5, TimeUnit.SECONDS);
                    var leftOffset = offsets.get(LEFT);
                    var rightOffset = offsets.get(RIGHT);
                    if (leftOffset != null && leftOffset.offset() == left &&
                        rightOffset != null && rightOffset.offset() == right) return;
                } catch (ExecutionException error) {
                    if (!(error.getCause() instanceof GroupIdNotFoundException)) throw error;
                }
                Thread.sleep(250);
            }
        }
        throw new IllegalStateException("WINDOW_SOURCE_OFFSETS_NOT_COMMITTED");
    }

    private static Map<String, Totals> expected(List<Quote> quotes, int closedBeforeSecond) {
        var totals = new TreeMap<String, Totals>();
        for (Quote quote : quotes) {
            int windowStart = (quote.second() / 10) * 10;
            if (windowStart >= closedBeforeSecond) continue;
            String key = WINDOW.format(BASE.plusSeconds(windowStart)) + "/" + quote.security();
            totals.merge(key, new Totals(1, quote.volume()),
                (a,b) -> new Totals(a.count() + b.count(), a.volume() + b.volume()));
        }
        return totals;
    }

    private static List<JsonNode> committedWindows(String address, Map<String, Totals> expected) throws Exception {
        var observed = new TreeMap<String, Totals>();
        var output = new ArrayList<JsonNode>();
        var partition = new TopicPartition(OUTPUT, 0);
        try (var consumer = new KafkaConsumer<>(Map.of("bootstrap.servers", address,
            "isolation.level", "read_committed", "enable.auto.commit", false, "default.api.timeout.ms", 5000),
            new StringDeserializer(), new StringDeserializer())) {
            consumer.assign(List.of(partition));
            consumer.seekToBeginning(List.of(partition));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
            long stableSince = 0;
            while (System.nanoTime() < deadline) {
                for (var record : consumer.poll(Duration.ofMillis(180))) {
                    JsonNode row = JSON.readTree(record.value());
                    require(row.isObject() && row.size() == 4 && row.path("event_count").isIntegralNumber() &&
                        row.path("total_volume").isIntegralNumber(), "WINDOW_OUTPUT_SCHEMA_MISMATCH");
                    String key = row.path("window_start_utc").asText() + "/" + row.path("security_code").asText();
                    var item = new Totals(row.path("event_count").asLong(), row.path("total_volume").asLong());
                    require(item.equals(expected.get(key)) && !observed.containsKey(key), "WINDOW_OUTPUT_MISMATCH");
                    observed.put(key, item);
                    output.add(row);
                    stableSince = 0;
                }
                if (!observed.equals(expected)) stableSince = 0;
                else if (stableSince == 0) stableSince = System.nanoTime();
                else if (System.nanoTime() - stableSince > TimeUnit.SECONDS.toNanos(2)) return output;
            }
        }
        throw new IllegalStateException("WINDOW_OUTPUT_NOT_COMMITTED");
    }
}
