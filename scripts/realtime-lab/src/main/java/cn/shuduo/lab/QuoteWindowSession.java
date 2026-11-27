package cn.shuduo.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.flink.api.common.JobStatus;
import org.apache.flink.core.execution.JobClient;
import org.apache.flink.core.execution.SavepointFormatType;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.PartitionInfo;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.serialization.StringDeserializer;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static cn.shuduo.lab.QuoteReplay.*;

final class QuoteWindowSession {
    private static final String INPUT_TOPIC = "shuduo-live-quotes";
    private static final String OUTPUT_TOPIC = "shuduo-live-windows";
    private static final int MAX_VISIBLE_ROWS = 24;

    private record Topics(String clusterId, String inputId, String outputId) {}

    static void run(Path repo, Path run) throws Exception {
        String broker = localBroker(System.getenv("SHUDUO_REALTIME_LIVE_BOOTSTRAP"));
        Topics topics = readTopics(broker);
        Files.createDirectory(run);
        String restorePlan = System.getenv("SHUDUO_REALTIME_LIVE_RESTORE_PLAN");
        String restorePath = System.getenv("SHUDUO_REALTIME_LIVE_RESTORE_SAVEPOINT");
        String restoreDigest = System.getenv("SHUDUO_REALTIME_LIVE_RESTORE_DIGEST");
        require((restorePlan == null && restorePath == null && restoreDigest == null) ||
            (restorePlan != null && restorePath != null && restoreDigest != null), "LIVE_RESTORE_INCOMPLETE");
        Path sourceSavepoint = restorePath == null ? null : Path.of(restorePath);
        if (sourceSavepoint != null) require(restoreDigest.equals(fileDigest(sourceSavepoint.resolve("_metadata"))),
            "LIVE_RESTORE_SAVEPOINT_MISMATCH");
        var stop = CompletableFuture.supplyAsync(QuoteWindowSession::readStop);
        try (var consumer = new KafkaConsumer<>(Map.of("bootstrap.servers", broker,
            "isolation.level", "read_committed", "enable.auto.commit", false,
            "request.timeout.ms", 4000, "default.api.timeout.ms", 6000),
            new StringDeserializer(), new StringDeserializer())) {
            var partitions = consumer.partitionsFor(INPUT_TOPIC, Duration.ofSeconds(10));
            require(!partitions.isEmpty() && partitions.size() <= 8, "LIVE_INPUT_PARTITIONS_UNSUPPORTED");
            var input = partitions.stream().sorted(Comparator.comparingInt(PartitionInfo::partition))
                .map(partition -> new TopicPartition(INPUT_TOPIC, partition.partition())).toList();
            var outputPartitions = consumer.partitionsFor(OUTPUT_TOPIC, Duration.ofSeconds(10));
            require(outputPartitions.size() == 1 && outputPartitions.get(0).partition() == 0,
                "LIVE_OUTPUT_PARTITIONS_UNSUPPORTED");
            var output = new TopicPartition(OUTPUT_TOPIC, 0);
            long from = consumer.endOffsets(List.of(output), Duration.ofSeconds(10)).get(output);
            consumer.assign(List.of(output));
            consumer.seek(output, from);
            Path sqlPath = repo.resolve("scripts/realtime-lab/live-windows.sql");
            String sqlDigest = fileDigest(sqlPath);
            Path planPath = run.resolve("live-plan.json");
            JsonNode plan;
            if (restorePlan != null) {
                Path originalPlan = Path.of(restorePlan);
                require(fileDigest(originalPlan).equals(System.getenv("SHUDUO_REALTIME_LIVE_RESTORE_PLAN_DIGEST")),
                    "LIVE_RESTORE_PLAN_DIGEST_MISMATCH");
                plan = JSON.readTree(originalPlan.toFile());
                Files.copy(originalPlan,planPath);
            } else {
                var offsets = consumer.endOffsets(input, Duration.ofSeconds(10));
                var document = JSON.createObjectNode().put("session",UUID.randomUUID().toString())
                    .put("clusterId",topics.clusterId()).put("inputTopicId",topics.inputId())
                    .put("outputTopicId",topics.outputId()).put("sqlDigest",sqlDigest);
                var entries = document.putArray("offsets");
                for (var partition : input) entries.addObject().put("partition",partition.partition())
                    .put("offset",offsets.get(partition));
                JSON.writeValue(planPath.toFile(),document);
                plan = document;
            }
            String positions = verifiedPositions(plan,topics,sqlDigest,input);
            String session = plan.path("session").asText();
            String planDigest = fileDigest(planPath);
            // Substitution after statement splitting preserves the semicolons in the Kafka offsets literal.
            var statements = List.of(Files.readString(sqlPath).split(";")).stream()
                .map(statement -> statement.replace("@SESSION@", session).replace("@OFFSETS@", positions)).toList();
            int restPort = sourceSavepoint == null ? 0 : freePort();
            var job = submit(statements, broker, run, sourceSavepoint == null ? null : flinkFile(sourceSavepoint), restPort);
            try {
                awaitRunning(job);
                String jobId=job.getJobID().toString();
                if (sourceSavepoint != null) awaitRestored(restPort,jobId,sourceSavepoint,restoreDigest);
                var observed = new Observations(jobId,session,sqlDigest,planDigest,restoreDigest,input.size());
                emit(observed.snapshot("RUNNING"));
                long nextStatusRead = System.nanoTime();
                while (!stop.isDone()) {
                    if (observed.read(consumer)) emit(observed.snapshot("RUNNING"));
                    if (System.nanoTime() >= nextStatusRead) {
                        require(!job.getJobStatus().get(5, TimeUnit.SECONDS).isGloballyTerminalState(), "LIVE_JOB_EXITED");
                        nextStatusRead = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
                    }
                }
                stop.join();
                String saved = job.stopWithSavepoint(false, flinkFile(run.resolve("savepoints")),
                    SavepointFormatType.CANONICAL).get(45, TimeUnit.SECONDS);
                long drainUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (System.nanoTime() < drainUntil) observed.read(consumer);
                var finished = observed.snapshot("STOPPED").put("savepointDigest",
                    fileDigest(localSavepoint(run, saved).resolve("_metadata")));
                JSON.writerWithDefaultPrettyPrinter().writeValue(run.resolve("evidence.json").toFile(), finished);
                emit(finished);
            } finally {
                stopJob(job);
            }
        }
    }

    private static Topics readTopics(String broker) throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers",broker,
            "request.timeout.ms",4000,"default.api.timeout.ms",8000))) {
            var nodes = admin.describeCluster().nodes().get(10,TimeUnit.SECONDS);
            require(!nodes.isEmpty() && nodes.stream().allMatch(node->"127.0.0.1".equals(node.host())),
                "LIVE_ADVERTISED_BROKER_NOT_LOOPBACK");
            String cluster = admin.describeCluster().clusterId().get(10,TimeUnit.SECONDS);
            var topics = admin.describeTopics(List.of(INPUT_TOPIC,OUTPUT_TOPIC)).allTopicNames().get(10,TimeUnit.SECONDS);
            require(cluster != null && !cluster.isBlank(), "LIVE_CLUSTER_ID_UNAVAILABLE");
            return new Topics(cluster,topics.get(INPUT_TOPIC).topicId().toString(),topics.get(OUTPUT_TOPIC).topicId().toString());
        }
    }

    private static String verifiedPositions(JsonNode plan, Topics topics, String sqlDigest, List<TopicPartition> input) {
        var offsets = plan.path("offsets");
        require(plan.path("session").asText().matches("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}") &&
            topics.clusterId().equals(plan.path("clusterId").asText()) &&
            topics.inputId().equals(plan.path("inputTopicId").asText()) &&
            topics.outputId().equals(plan.path("outputTopicId").asText()) &&
            sqlDigest.equals(plan.path("sqlDigest").asText()) && offsets.isArray() && offsets.size()==input.size(),
            "LIVE_RESTORE_SOURCE_MISMATCH");
        for (int i=0;i<input.size();i++) {
            var entry=offsets.get(i);
            require(entry.path("partition").asInt(-1)==input.get(i).partition() && entry.path("offset").canConvertToLong()
                && entry.path("offset").asLong()>=0,"LIVE_INPUT_OFFSETS_INVALID");
        }
        return java.util.stream.IntStream.range(0,input.size()).mapToObj(i ->
            "partition:"+input.get(i).partition()+",offset:"+offsets.get(i).path("offset").asLong())
            .collect(Collectors.joining(";"));
    }

    private static void awaitRestored(int port, String jobId, Path source, String expectedDigest) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime()<deadline) {
            var restored=checkpointStats(port,jobId).path("restored");
            if (restored.isObject()) {
                Path observed=checkpointDirectory(restored.path("external_path").asText());
                require(restored.path("id").asLong(-1)>=0 && observed.equals(source) &&
                    fileDigest(observed.resolve("_metadata")).equals(expectedDigest),"LIVE_RESTORE_EVIDENCE_MISMATCH");
                return;
            }
            Thread.sleep(150);
        }
        throw new IllegalStateException("LIVE_RESTORE_UNCONFIRMED");
    }

    private static String localBroker(String value) {
        require(value != null, "LIVE_BOOTSTRAP_REQUIRED");
        String[] endpoints = value.split(",", -1);
        require(endpoints.length <= 6, "LIVE_BOOTSTRAP_NOT_LOOPBACK");
        for (String endpoint : endpoints) {
            require(endpoint.matches("127\\.0\\.0\\.1:[1-9][0-9]{0,4}"), "LIVE_BOOTSTRAP_NOT_LOOPBACK");
            require(Integer.parseInt(endpoint.substring(10)) <= 65535, "LIVE_BOOTSTRAP_NOT_LOOPBACK");
        }
        return value;
    }

    private static String readStop() {
        try {
            String command = new BufferedReader(new InputStreamReader(System.in)).readLine();
            require(command == null || command.equals("STOP"), "LIVE_STOP_COMMAND_INVALID");
            return "STOP";
        } catch (IOException error) {
            throw new CompletionException(error);
        }
    }

    private static void awaitRunning(JobClient job) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            JobStatus status = job.getJobStatus().get(5, TimeUnit.SECONDS);
            if (status == JobStatus.RUNNING) return;
            require(!status.isGloballyTerminalState(), "LIVE_JOB_EXITED");
            Thread.sleep(200);
        }
        throw new IllegalStateException("LIVE_JOB_NOT_RUNNING");
    }

    private static void emit(ObjectNode observation) {
        System.out.println(observation);
        System.out.flush();
    }

    private static final class Observations {
        private final String jobId;
        private final String session;
        private final String sqlDigest;
        private final String planDigest;
        private final String restoreDigest;
        private final int sourcePartitions;
        private final ArrayDeque<JsonNode> rows = new ArrayDeque<>();
        private long count;

        Observations(String jobId, String session, String sqlDigest, String planDigest, String restoreDigest, int sourcePartitions) {
            this.jobId = jobId;
            this.session = session;
            this.sqlDigest = sqlDigest;
            this.planDigest = planDigest;
            this.restoreDigest = restoreDigest;
            this.sourcePartitions = sourcePartitions;
        }

        boolean read(KafkaConsumer<String,String> consumer) throws IOException {
            long before = count;
            for (var record : consumer.poll(Duration.ofMillis(250))) {
                JsonNode row = JSON.readTree(record.value());
                if (!session.equals(row.path("session_id").asText())) continue;
                require(row.isObject() && row.size() == 5 &&
                    row.path("security_code").asText().matches("SEC-DEMO-00[12]") &&
                    row.path("window_start_utc").asText().matches("[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]0") &&
                    row.path("event_count").isIntegralNumber() && row.path("event_count").asLong() > 0 &&
                    row.path("total_volume").isIntegralNumber() && row.path("total_volume").asLong() >= 0,
                    "LIVE_WINDOW_OUTPUT_MISMATCH");
                var clean = ((ObjectNode) row).deepCopy();
                clean.remove("session_id");
                require(rows.stream().noneMatch(prior -> prior.get("window_start_utc").equals(clean.get("window_start_utc")) &&
                    prior.get("security_code").equals(clean.get("security_code"))), "LIVE_WINDOW_DUPLICATED");
                rows.addLast(clean);
                if (rows.size() > MAX_VISIBLE_ROWS) rows.removeFirst();
                count++;
            }
            return count != before;
        }

        ObjectNode snapshot(String state) {
            var result = JSON.createObjectNode().put("protocol", "shuduo-live-window-stream/v1")
                .put("state", state).put("flinkJobId", jobId).put("sqlDigest", sqlDigest)
                .put("planDigest",planDigest)
                .put("sourcePartitions", sourcePartitions).put("committedWindowCount", count);
            if (restoreDigest!=null) result.put("restoredSavepointDigest",restoreDigest);
            result.putArray("windowRows").addAll(rows);
            return result;
        }
    }
}
