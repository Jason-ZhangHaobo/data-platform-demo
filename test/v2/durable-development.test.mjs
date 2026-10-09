import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { referenceSql, getContext, contextIds } from "../../src/v2/context.mjs";
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult } from "../../src/v2/remote-spark-queue.mjs";

function queue() {
  const objects = new Map(); let creates = 0, loseResponse = false;
  const config = { projectId: PROJECT, sharedSecret: "synthetic-durable-secret-0123456789abcdef", jobPrefix: SPARK_QUEUE_PREFIXES.jobs, resultPrefix: SPARK_QUEUE_PREFIXES.results, cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations, timeoutMs: 180000 };
  const transport = {
    read: async key => objects.get(key),
    create: async (key, body) => {
      if (objects.has(key)) { assert.equal(objects.get(key), body); return { created: false }; }
      objects.set(key, body); creates++;
      if (loseResponse) { loseResponse = false; throw new Error("simulated lost response"); }
      return { created: true };
    },
  };
  const client = new RemoteSparkQueueClient(config, transport), runner = async () => { throw new Error("blocking runner must not be called"); };
  runner.descriptor = { engine: "Apache Spark", isolation: "REMOTE_FUNCTION", transport: "PRIVATE_OSS_QUEUE", healthVerified: true, publicWriteEnabled: true };
  runner.durable = { prepare: (input, id) => client.prepare(input, id), submit: q => client.submitPrepared(q), read: q => client.readPreparedResult(q), cancel: q => client.cancelPrepared(q) };
  return { objects, config, runner, client, get creates() { return creates; }, lose() { loseResponse = true; } };
}

async function open(path, runner) {
  const store = new MetadataStore(path), app = createV2Server({ store, runner, env: { V2_LOCAL_DEVELOPMENT: "true" } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  const request = async (method, path, body, key = "durable-fixture") => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Shuduo-Client": "cli", "Idempotency-Key": key }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, request, close: async () => { await new Promise(resolve => app.server.close(resolve)); store.close(); } };
}

async function start(app) {
  const revision = await app.request("POST", "/revisions", { sql: referenceSql, contextId: "holdings-t1" });
  const run = await app.request("POST", "/runs", { revisionId: revision.body.id });
  return { revision: revision.body, run };
}

test("task submission returns before a result exists and survives controller restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "shuduo-durable-")), "store.sqlite"), q = queue();
  let app = await open(path, q.runner);
  const { revision, run } = await start(app);
  assert.equal(run.status, 202);
  assert.equal(run.body.status, "QUEUED");
  assert.equal(run.body.stage, "WAITING_FOR_WORKER_RESULT");
  assert.ok(!JSON.stringify(run.body).includes("signature"));
  const replay = await app.request("POST", "/runs", { revisionId: revision.id });
  assert.equal(replay.body.id, run.body.id);
  assert.equal(q.creates, 1);
  const prepared = app.store.get("run", run.body.id, PROJECT).remoteSubmission.prepared;
  await app.close();
  q.objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, {
    status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    rows: getContext("holdings-t1").expected, durationMs: 1234,
    log: "Synthetic signed worker output", stdout: "Synthetic stdout", stderr: "Synthetic stderr",
    validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) },
    id: "must-not-overwrite-run-id", revisionHash: "must-not-overwrite-revision",
  }, q.config)));
  app = await open(path, q.runner);
  try {
    const restored = await app.request("GET", `/runs/${run.body.id}`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.status, "SUCCEEDED");
    assert.equal(restored.body.id, run.body.id);
    assert.equal(restored.body.revisionHash, revision.hash);
    assert.equal(restored.body.rows[0].total_assets, "1800.00");
    assert.equal(restored.body.log, "Synthetic signed worker output");
    assert.equal(restored.body.stdout, "Synthetic stdout");
    assert.equal(restored.body.stderr, "Synthetic stderr");
    assert.equal(restored.body.remoteSubmission, undefined);
    const reread = (await app.request("GET", `/runs/${run.body.id}`)).body;
    assert.equal(reread.status, "SUCCEEDED");
    assert.equal(reread.log, restored.body.log);
  } finally { await app.close(); }
});

test("lost submission response resumes the identical persisted job without a duplicate event", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "shuduo-durable-")), "store.sqlite"), q = queue();
  let app = await open(path, q.runner); q.lose();
  const { run } = await start(app);
  assert.equal(run.status, 500);
  const saved = app.store.list("run", PROJECT)[0];
  assert.equal(saved.remoteSubmission.submitted, false);
  const before = [...q.objects.values()][0];
  await app.close(); app = await open(path, q.runner);
  try {
    assert.equal((await app.request("GET", `/runs/${saved.id}`)).body.status, "QUEUED");
    assert.equal(q.creates, 1);
    assert.equal([...q.objects.values()][0], before);
    assert.equal(app.store.get("run", saved.id, PROJECT).remoteSubmission.submitted, true);
  } finally { await app.close(); }
});

test("tampered worker result cannot make a queued task successful", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "shuduo-durable-")), "store.sqlite"), q = queue(), app = await open(path, q.runner);
  try {
    const { run } = await start(app), prepared = app.store.get("run", run.body.id, PROJECT).remoteSubmission.prepared;
    q.objects.set(prepared.resultKey, JSON.stringify({ ...createQueuedSparkResult(prepared.job, { status: "SUCCEEDED" }, q.config), signature: "forged" }));
    assert.equal((await app.request("GET", `/runs/${run.body.id}`)).body.code, "SPARK_QUEUE_RESULT_INVALID");
    assert.equal(app.store.get("run", run.body.id, PROJECT).status, "QUEUED");
  } finally { await app.close(); }
});

test("cancellation persists a signed marker and late success cannot overwrite it", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "shuduo-durable-")), "store.sqlite"), q = queue(), app = await open(path, q.runner);
  try {
    const { run } = await start(app), prepared = app.store.get("run", run.body.id, PROJECT).remoteSubmission.prepared;
    assert.equal((await app.request("POST", `/runs/${run.body.id}/cancel`, {})).body.status, "CANCELLED");
    assert.ok(q.objects.has(prepared.cancelKey));
    q.objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, {
      status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
      rows: getContext("holdings-t1").expected,
      validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) },
    }, q.config)));
    assert.equal((await app.request("GET", `/runs/${run.body.id}`)).body.status, "CANCELLED");
  } finally { await app.close(); }
});
