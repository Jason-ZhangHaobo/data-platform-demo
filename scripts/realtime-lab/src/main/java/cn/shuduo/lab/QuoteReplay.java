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
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.io.StringReader;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.HexFormat;
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
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    private record Update(String security, JsonNode value) {}
    private record Checkpoint(long id, Path path, String digest) {}

    public static void main(String[] args) throws Exception {
        if (args.length == 5 && args[0].equals("--flink-worker")) {
            runFlinkWorker(args);
            return;
        }
        boolean crash = args.length == 3 && args[2].equals("--checkpoint-crash");
        if (args.length != 2 && !crash)
            throw new IllegalArgumentException("Usage: QuoteReplay REPO_ROOT NEW_RUN_DIR [--checkpoint-crash]");
        Path repo = Path.of(args[0]).toRealPath();
        Path run = Path.of(args[1]).toAbsolutePath();
        Files.createDirectory(run);
        Path fixturePath = repo.resolve("fixtures/streams/quotes_recovered.jsonl");
        List<String> fixture = Files.readAllLines(fixturePath);
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
        Process flinkProcess = null;
        JobClient original = null;
        JobClient restored = null;
        try {
            createTopics(address, broker);
            List<String> initial = fixture.subList(0, 4);
            publish(address, initial, 0);
            int originalPort = crash ? freePort() : 0;
            String originalJobId;
            if (crash) {
                flinkProcess = javaProcess(768, run.resolve("flink-before-crash.log"), QuoteReplay.class.getName(),
                    "--flink-worker", repo.toString(), run.toString(), address, String.valueOf(originalPort));
                originalJobId = awaitJobId(run, flinkProcess);
            } else {
                original = submit(sql, address, run, null, 0);
                originalJobId = original.getJobID().toString();
            }
            var expectedInitial = expected(initial);
            List<Update> before = committedOutput(address, expectedInitial);
            Checkpoint checkpoint = null;
            Path savedState;
            if (crash) {
                // Wait for the next completed checkpoint so its sink transaction and
                // the preceding committed output are already visible at the broker.
                checkpoint = nextCompletedCheckpoint(run, originalJobId, originalPort);
                savedState = checkpoint.path();
                publish(address, List.of(fixture.get(4)), initial.size());
                require(flinkProcess.isAlive(), "FLINK_EXITED_BEFORE_INJECTED_FAILURE");
                flinkProcess.destroyForcibly();
                require(flinkProcess.waitFor(8, TimeUnit.SECONDS) && flinkProcess.exitValue() == 137,
                    "FLINK_SIGKILL_NOT_CONFIRMED");
                require(fileDigest(savedState.resolve("_metadata")).equals(checkpoint.digest()), "ORIGINAL_CHECKPOINT_CHANGED");
                require(committedOutput(address, expectedInitial).equals(before), "OUTPUT_CHANGED_BEFORE_RECOVERY");
            } else {
                String savepoint = original.stopWithSavepoint(false, flinkFile(run.resolve("savepoints")),
                    SavepointFormatType.CANONICAL).get(WAIT_SECONDS, TimeUnit.SECONDS);
                savedState = localSavepoint(run, savepoint);
            }

            var late = (ObjectNode) JSON.readTree(fixture.get(0));
            late.put("event_id", "EVT-Q-LATE");
            late.put("price", "11.00");
            var invalid = (ObjectNode) JSON.readTree(fixture.get(4));
            invalid.put("event_id", "EVT-Q-INVALID");
            invalid.put("sequence", 6);
            invalid.put("price", "-1.00");
            var additional = new ArrayList<>(List.of(fixture.get(0), late.toString(), invalid.toString(), fixture.get(5)));
            if (!crash) additional.add(3, fixture.get(4));
            long nextInputOffset = publish(address, additional, initial.size() + (crash ? 1 : 0));
            int restoredPort = crash ? freePort() : 0;
            restored = submit(sql, address, run, flinkFile(savedState), restoredPort);
            String restoredJobId = restored.getJobID().toString();
            require(!originalJobId.equals(restoredJobId), "JOB_WAS_NOT_RESTARTED");
            long restoredCheckpointId = crash ? verifyRestoredCheckpoint(restoredPort, restoredJobId, checkpoint) : 0;
            var complete = new ArrayList<>(initial);
            if (crash) complete.add(fixture.get(4));
            complete.addAll(additional);
            var expectedFinal = expected(complete);
            committedOutput(address, expectedFinal);
            String finalSavepoint = restored.stopWithSavepoint(false, flinkFile(run.resolve("savepoints")),
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
            evidence.put("fixtureDigest", fileDigest(fixturePath));
            evidence.put("inputEvents", nextInputOffset);
            evidence.put("committedUpdatesBefore", before.size());
            evidence.put("committedUpdatesAfter", after.size());
            evidence.put("originalJobId", originalJobId);
            evidence.put("restoredJobId", restoredJobId);
            if (crash) {
                evidence.putObject("checkpointRecovery")
                    .put("checkpointId", checkpoint.id()).put("restoredCheckpointId", restoredCheckpointId)
                    .put("checkpointDigest", checkpoint.digest()).put("exitCode", flinkProcess.exitValue())
                    .put("inputOffsetBeforeExit", initial.size()).put("committedUpdatesAtExit", before.size());
            } else evidence.put("originalSavepointDigest", fileDigest(savedState.resolve("_metadata")));
            evidence.put("restoredSavepointDigest", fileDigest(localSavepoint(run, finalSavepoint).resolve("_metadata")));
            evidence.set("finalQuotes", JSON.valueToTree(expectedFinal));
            JSON.writerWithDefaultPrettyPrinter().writeValue(run.resolve("evidence.json").toFile(), evidence);
            System.out.println(evidence);
        } finally {
            if (flinkProcess != null && flinkProcess.isAlive()) {
                flinkProcess.destroyForcibly();
                flinkProcess.waitFor(8, TimeUnit.SECONDS);
            }
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

    private static int freePort() throws Exception {
        try (ServerSocket socket = loopbackSocket()) {
            return socket.getLocalPort();
        }
    }

    private static String flinkFile(Path path) {
        // Flink encodes the supplied path itself, including Unicode and whitespace.
        return "file://" + path;
    }

    private static Path localSavepoint(Path run, String savepoint) {
        Path path = Path.of(new org.apache.flink.core.fs.Path(savepoint).toUri().getPath());
        require(path.getParent().equals(run.resolve("savepoints")) &&
            Files.isRegularFile(path.resolve("_metadata")), "SAVEPOINT_METADATA_MISSING_OR_OUTSIDE_RUN");
        return path;
    }

    private static void runFlinkWorker(String[] args) throws Exception {
        Path repo = Path.of(args[1]);
        Path run = Path.of(args[2]);
        String sql = Files.readString(repo.resolve("scripts/realtime-lab/quotes.sql"));
        JobClient job = submit(sql, args[3], run, null, Integer.parseInt(args[4]));
        Files.writeString(run.resolve("flink-before-crash.job"), job.getJobID().toString());
        job.getJobExecutionResult().get();
    }

    private static String awaitJobId(Path run, Process process) throws Exception {
        Path marker = run.resolve("flink-before-crash.job");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_SECONDS);
        while (System.nanoTime() < deadline && process.isAlive()) {
            if (Files.exists(marker)) {
                String jobId = Files.readString(marker);
                if (jobId.matches("[0-9a-f]{32}")) return jobId;
            }
            Thread.sleep(150);
        }
        throw new IllegalStateException("FLINK_WORKER_NOT_READY");
    }

    private static JsonNode checkpointStats(int port, String jobId) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/jobs/" + jobId + "/checkpoints"))
            .timeout(Duration.ofSeconds(3)).build();
        var response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        require(response.statusCode() == 200, "FLINK_CHECKPOINT_STATS_UNAVAILABLE");
        return JSON.readTree(response.body()).path("latest");
    }

    private static Path checkpointDirectory(String externalPath) {
        var location = new org.apache.flink.core.fs.Path(externalPath).toUri();
        require("file".equals(location.getScheme()), "CHECKPOINT_STORAGE_IS_NOT_LOCAL");
        Path path = Path.of(location.getPath()).normalize();
        return path.getFileName().toString().equals("_metadata") ? path.getParent() : path;
    }

    private static Checkpoint nextCompletedCheckpoint(Path run, String jobId, int port) throws Exception {
        long previous = checkpointStats(port, jobId).path("completed").path("id").asLong(-1);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_SECONDS);
        while (System.nanoTime() < deadline) {
            JsonNode completed = checkpointStats(port, jobId).path("completed");
            long id = completed.path("id").asLong(-1);
            if (id > Math.max(previous,0) && completed.path("status").asText().equals("COMPLETED") &&
                completed.path("is_savepoint").isBoolean() && !completed.path("is_savepoint").asBoolean()) {
                Path path = checkpointDirectory(completed.path("external_path").asText());
                Path expectedParent = run.resolve("checkpoints").resolve(jobId);
                require(path.getParent().equals(expectedParent) && path.getFileName().toString().equals("chk-" + id),
                    "CHECKPOINT_OUTSIDE_ORIGINAL_JOB");
                return new Checkpoint(id, path, fileDigest(path.resolve("_metadata")));
            }
            Thread.sleep(200);
        }
        throw new IllegalStateException("NO_NEW_COMPLETED_CHECKPOINT");
    }

    private static long verifyRestoredCheckpoint(int port, String jobId, Checkpoint checkpoint) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_SECONDS);
        while (System.nanoTime() < deadline) {
            JsonNode restored = checkpointStats(port, jobId).path("restored");
            if (restored.isObject()) {
                long id = restored.path("id").asLong(-1);
                Path restoredPath = checkpointDirectory(restored.path("external_path").asText());
                // NO_CLAIM labels external state as savepoint-like on restore.
                // Its original type was verified in the originating job's stats.
                require(id == checkpoint.id() && restoredPath.equals(checkpoint.path()) &&
                    fileDigest(restoredPath.resolve("_metadata")).equals(checkpoint.digest()),
                    "FLINK_RESTORED_CHECKPOINT_MISMATCH");
                return id;
            }
            Thread.sleep(200);
        }
        throw new IllegalStateException("FLINK_RESTORED_CHECKPOINT_UNCONFIRMED");
    }

    private static String fileDigest(Path file) throws Exception {
        byte[] bytes = Files.readAllBytes(file);
        require(bytes.length > 0, "EVIDENCE_FILE_EMPTY");
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
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
        return javaProcess(384, log, main, args);
    }

    private static Process javaProcess(int heapMb, Path log, String main, String... args) throws Exception {
        var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-Xmx" + heapMb + "m", "-Dorg.slf4j.simpleLogger.defaultLogLevel=warn", "-cp",
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

    private static JobClient submit(String sql, String address, Path run, String restorePath, int port) {
        EnvironmentSettings settings = EnvironmentSettings.newInstance().inStreamingMode().build();
        TableEnvironment table = TableEnvironment.create(settings);
        table.getConfig().set("parallelism.default", "1");
        table.getConfig().set("taskmanager.numberOfTaskSlots", "1");
        table.getConfig().set("rest.bind-address", "127.0.0.1");
        table.getConfig().set("jobmanager.bind-host", "127.0.0.1");
        table.getConfig().set("taskmanager.bind-host", "127.0.0.1");
        table.getConfig().set("execution.checkpointing.interval", "1 s");
        table.getConfig().set("execution.checkpointing.dir", flinkFile(run.resolve("checkpoints")));
        if (port != 0) {
            table.getConfig().set("rest.bind-port", String.valueOf(port));
            table.getConfig().set("execution.checkpointing.min-pause", "6 s");
            table.getConfig().set("execution.checkpointing.externalized-checkpoint-retention", "RETAIN_ON_CANCELLATION");
            table.getConfig().set("state.checkpoints.num-retained", "3");
        }
        if (restorePath != null) table.getConfig().set("execution.state-recovery.path", restorePath);
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
