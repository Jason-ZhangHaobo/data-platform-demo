import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteSparkQueueClient,
  createQueuedSparkJob,
  createQueuedSparkResult,
  queueConfigFromEnvironment,
  verifyQueuedSparkJob,
  verifyQueuedSparkResult,
  consumeQueuedSparkJob,
} from "../../src/v2/remote-spark-queue.mjs";

const config = queueConfigFromEnvironment({
  V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE",
  V2_SPARK_EXECUTOR_SECRET: "synthetic-shared-secret-32-characters-long",
  V2_PROJECT_ID: "project-securities-lab",
  V2_SPARK_QUEUE_TIMEOUT_MS: "5000",
  V2_SPARK_QUEUE_POLL_MS: "200",
});
const input = { sql: "SELECT 1", context: { id: "demo" }, validationContexts: [] };

test("signed OSS queue job binds a fixed project, nonce, expiry and result key", () => {
  const queued = createQueuedSparkJob(input, config, { now: 1789900000000, requestId: "11111111-1111-4111-8111-111111111111", nonce: "n".repeat(24) });
  assert.match(queued.jobKey, /jobs\/11111111-1111-4111-8111-111111111111\.json$/);
  assert.match(queued.resultKey, /results\/11111111-1111-4111-8111-111111111111\.json$/);
  assert.equal(verifyQueuedSparkJob(queued.job, config, 1789900000100).sql, "SELECT 1");
  assert.throws(() => verifyQueuedSparkJob({ ...queued.job, projectId: "other" }, config, 1789900000100), { code: "SPARK_QUEUE_JOB_INVALID" });
  assert.throws(() => verifyQueuedSparkJob({ ...queued.job, signature: "v1=bad" }, config, 1789900000100), { code: "SPARK_QUEUE_SIGNATURE_INVALID" });
});

test("signed result cannot be substituted across jobs", () => {
  const queued = createQueuedSparkJob(input, config, { now: 1789900000000, requestId: "22222222-2222-4222-8222-222222222222", nonce: "m".repeat(24) });
  const result = createQueuedSparkResult(queued.job, { status: "SUCCEEDED", engine: "Apache Spark" }, config, 1789900000200);
  assert.equal(verifyQueuedSparkResult(result, queued.job.jobId, config).status, "SUCCEEDED");
  assert.throws(() => verifyQueuedSparkResult({ ...result, jobId: "33333333-3333-4333-8333-333333333333" }, queued.job.jobId, config), { code: "SPARK_QUEUE_RESULT_INVALID" });
});

test("queue client persists a cancellation marker and never returns an unsigned result", async () => {
  const objects = new Map(), controller = new AbortController();
  const transport = { create: async (key, body) => { if (objects.has(key)) throw new Error("conflict"); objects.set(key, body); }, read: async (key) => objects.get(key) };
  let clock = 1789900000000;
  const client = new RemoteSparkQueueClient(config, transport, { now: () => clock, wait: async () => { controller.abort(); clock += 300; } });
  await assert.rejects(client.execute({ ...input, signal: controller.signal }), { code: "REMOTE_SPARK_CANCELLED" });
  assert.equal([...objects.keys()].some((key) => key.endsWith(".cancel.json")), true);
});

test("Worker consumer executes only a signed create-only job and writes a bound result", async () => {
  const objects = new Map(), queued = createQueuedSparkJob(input, config, {
    now: 1789900000000,
    requestId: "44444444-4444-4444-8444-444444444444",
    nonce: "q".repeat(24),
  });
  objects.set(queued.jobKey, JSON.stringify(queued.job));
  const transport = {
    create: async (key, body) => { if (objects.has(key) && objects.get(key) !== body) throw new Error("conflict"); objects.set(key, body); },
    read: async (key) => objects.get(key),
  };
  const consumed = await consumeQueuedSparkJob({
    jobKey: queued.jobKey,
    config,
    transport,
    now: () => 1789900000100,
    runner: async (value) => ({ status: "SUCCEEDED", engine: "Apache Spark", observedSql: value.sql }),
  });
  assert.equal(consumed.status, "SUCCEEDED");
  const stored = JSON.parse(objects.get(queued.resultKey));
  assert.equal(verifyQueuedSparkResult(stored, queued.job.jobId, config).observedSql, "SELECT 1");
  await assert.rejects(
    consumeQueuedSparkJob({ jobKey: "other/job.json", config, transport, runner: async () => ({}) }),
    { code: "SPARK_QUEUE_JOB_KEY_INVALID" },
  );
});

test("Worker consumer honors a valid cancellation marker before running", async () => {
  const objects = new Map(), queued = createQueuedSparkJob(input, config, {
    now: 1789900000000,
    requestId: "55555555-5555-4555-8555-555555555555",
    nonce: "r".repeat(24),
  });
  objects.set(queued.jobKey, JSON.stringify(queued.job));
  objects.set(queued.cancelKey, JSON.stringify({ schema: "shuduo-spark-queue-cancel/v1", jobId: queued.job.jobId }));
  const transport = { create: async (key, body) => objects.set(key, body), read: async (key) => objects.get(key) };
  const result = await consumeQueuedSparkJob({
    jobKey: queued.jobKey, config, transport, now: () => 1789900000100,
    runner: async () => { throw new Error("must not run"); },
  });
  assert.equal(result.status, "CANCELLED");
});
