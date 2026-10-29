import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { createDurableSqlAgent } from "../../src/v2/durable-agent.mjs";
import {
  allContextIds, contextIds, getContext, referenceSql, referenceSqlForContext,
  validationContractId, validationFamilyForContext,
} from "../../src/v2/context.mjs";
import {
  RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult,
} from "../../src/v2/remote-spark-queue.mjs";

// Protocol fixtures only: the generator, object queue and signed worker receipts
// below are synthetic. Passing these tests is not live model or Spark evidence.
const stockId = "stock-cash-t1";
const stockFamily = validationFamilyForContext(stockId);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function syntheticQueue() {
  const objects = new Map();
  const counts = { models: 0, jobs: 0, submits: 0, reads: 0 };
  const modelContexts = [];
  let loseSubmission = false;
  const config = {
    projectId: PROJECT,
    sharedSecret: "synthetic-semantic-family-secret-0123456789abcdef",
    jobPrefix: SPARK_QUEUE_PREFIXES.jobs,
    resultPrefix: SPARK_QUEUE_PREFIXES.results,
    cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations,
    timeoutMs: 180000,
  };
  const client = new RemoteSparkQueueClient(config, {
    read: async (key) => { counts.reads++; return objects.get(key); },
    create: async (key, body) => {
      assert.ok(key.startsWith(`${config.jobPrefix}/`), "tests must never create cancellation/background work");
      counts.submits++;
      if (objects.has(key)) {
        assert.equal(objects.get(key), body, "recovery must reuse the exact signed request");
        return { created: false };
      }
      objects.set(key, body);
      counts.jobs++;
      if (loseSubmission) {
        loseSubmission = false;
        throw new Error("synthetic accepted submission with response lost");
      }
      return { created: true };
    },
  });
  const runner = async () => { throw new Error("blocking or real Spark execution is forbidden in this fixture"); };
  runner.descriptor = {
    engine: "Apache Spark", isolation: "REMOTE_FUNCTION", transport: "PRIVATE_OSS_QUEUE",
    healthVerified: true, publicWriteEnabled: true,
  };
  runner.durable = {
    prepare: (input, id) => client.prepare(input, id),
    submit: (prepared) => client.submitPrepared(prepared),
    read: (prepared) => client.readPreparedResult(prepared),
    cancel: () => { throw new Error("unexpected cancellation"); },
  };
  const generator = async ({ context }) => {
    counts.models++;
    modelContexts.push({ id: context.id, definition: context.definition });
    return { sql: referenceSqlForContext(context.id), model: "SYNTHETIC_PROTOCOL_FIXTURE", usage: { total_tokens: 20 } };
  };
  return {
    runner, generator, counts, modelContexts,
    lose() { loseSubmission = true; },
    complete(run, validation = undefined) {
      const family = validationFamilyForContext(run.contextId);
      const prepared = run.remoteSubmission.prepared;
      objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, {
        status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
        rows: getContext(run.contextId).expected,
        log: "Synthetic protocol receipt, not real Spark execution",
        validation: validation ?? {
          passed: true, regressions: family.contextIds.map((contextId) => ({ contextId, passed: true })),
        },
      }, config)));
    },
  };
}

async function httpFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "shuduo-semantic-protocol-"));
  const path = join(directory, "metadata.sqlite");
  const q = syntheticQueue();
  let app, base;
  const open = async () => {
    const store = new MetadataStore(path);
    app = createV2Server({
      root: directory, store, runner: q.runner, generator: q.generator,
      env: { V2_LOCAL_DEVELOPMENT: "true", V2_DURABLE_SQL_AGENT_ENABLED: "true" },
    });
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  };
  const close = async () => {
    if (!app) return;
    const current = app;
    app = undefined;
    await new Promise((resolve) => current.server.close(resolve));
    current.store.close();
  };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  await open();
  return {
    q,
    get store() { return app.store; },
    async restart() { await close(); await open(); },
    async request(method, endpoint, body, key = "semantic-fixture") {
      const response = await fetch(base + endpoint, {
        method,
        headers: { "Content-Type": "application/json", "X-Shuduo-Client": "cli", "Idempotency-Key": key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function assertQueuedFamily(run, contextId) {
  const family = validationFamilyForContext(contextId);
  assert.equal(run.validationContractId, family.id);
  const payload = JSON.parse(run.remoteSubmission.prepared.job.body);
  assert.equal(payload.context.id, contextId);
  assert.deepEqual(payload.validationContexts.map((context) => context.id), family.contextIds);
  assert.equal(payload.validationContexts.length, 5);
  assert.deepEqual(payload.validationContexts, family.contextIds.map(getContext));
}

test("synthetic legacy task survives resolver adoption with the original contextDigest algorithm", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shuduo-legacy-semantic-"));
  const path = join(directory, "metadata.sqlite");
  let store = new MetadataStore(path);
  const q = syntheticQueue();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const make = (resolveValidationFamily) => createDurableSqlAgent({
    store, project: PROJECT, runner: q.runner.durable, generator: q.generator,
    persist: async () => {}, getContext, contextIds, contractId: validationContractId,
    ...(resolveValidationFamily ? { resolveValidationFamily } : {}),
  });
  const legacy = make();
  const task = await legacy.create({
    message: "生成全部持仓和现金的客户资产SQL", currentSql: referenceSql,
    contextId: "holdings-t1", actorId: "synthetic-owner", idempotencyKey: "old-digest",
  });
  const expectedDigest = digest({ context: getContext("holdings-t1"), validation: contextIds.map(getContext), contractId: validationContractId });
  assert.equal(store.get("agent", task.id, PROJECT).durable.contextDigest, expectedDigest);
  store.close();
  store = new MetadataStore(path);
  store.interruptPending(PROJECT);
  const upgraded = make(validationFamilyForContext);
  const ready = await upgraded.advance(task.id, { expectedVersion: upgraded.get(task.id).version });
  assert.equal(ready.stage, "READY_FOR_RUN");
  assert.equal(ready.validationContractId, validationContractId);
  assert.equal(store.get("agent", task.id, PROJECT).durable.contextDigest, expectedDigest);
  const waiting = await upgraded.advance(task.id, { expectedVersion: ready.version });
  assertQueuedFamily(store.get("run", waiting.runId, PROJECT), "holdings-t1");
  assert.equal(q.counts.models, 1);
  assert.equal(q.counts.jobs, 1);
});

test("local HTTP lists ten registered contexts without independent expected answers or execution", async (t) => {
  const f = await httpFixture(t);
  const response = await f.request("GET", "/contexts");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((context) => context.id), allContextIds);
  assert.equal(JSON.stringify(response.body).includes('"expected"'), false);
  assert.deepEqual(response.body.find((context) => context.id === stockId).validationFamily, stockFamily);
  assert.deepEqual(f.q.counts, { models: 0, jobs: 0, submits: 0, reads: 0 });
  assert.equal(f.store.list("agent", PROJECT).length, 0);
  assert.equal(f.store.list("run", PROJECT).length, 0);
});

test("synthetic stock Agent binds one family and recovers the original model and signed batch across restart", async (t) => {
  const f = await httpFixture(t);
  const input = { message: "仅统计股票持仓和现金，不是客户全资产", sql: referenceSql, contextId: stockId };
  let response = await f.request("POST", "/agent/tasks", input, "stock-agent-original");
  assert.equal(response.status, 202);
  let task = response.body;
  assert.equal(task.validationContractId, stockFamily.id);
  assert.equal(task.stage, "READY_FOR_MODEL");
  for (const path of [`/agent/tasks/${task.id}`, "/agent/tasks", "/agent/requests/stock-agent-original"])
    assert.equal((await f.request("GET", path)).status, 200);
  assert.equal(f.q.counts.models, 0);
  assert.equal(f.q.counts.jobs, 0);
  task = (await f.request("POST", `/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.stage, "READY_FOR_RUN");
  assert.equal(f.q.counts.models, 1);
  assert.match(f.q.modelContexts[0].definition, /不等于客户全资产/);
  assert.equal(f.q.modelContexts[0].id, stockId);
  f.q.lose();
  response = await f.request("POST", `/agent/tasks/${task.id}/advance`, { expectedVersion: task.version });
  assert.equal(response.status, 500);
  task = (await f.request("GET", `/agent/tasks/${task.id}`)).body;
  const run = f.store.get("run", task.runId, PROJECT);
  assertQueuedFamily(run, stockId);
  assert.equal(run.remoteSubmission.submitted, false);
  const originalSerialized = run.remoteSubmission.prepared.serialized;
  const originalRunId = run.id, originalRevisionId = task.revisionId;
  const countsBeforeRestart = { ...f.q.counts };
  await f.restart();
  task = (await f.request("GET", "/agent/requests/stock-agent-original")).body;
  assert.equal(task.runId, originalRunId);
  assert.equal(task.revisionId, originalRevisionId);
  assert.equal((await f.request("GET", `/runs/${run.id}`)).body.status, "QUEUED");
  assert.equal(f.q.counts.models, countsBeforeRestart.models);
  assert.equal(f.q.counts.jobs, countsBeforeRestart.jobs);
  assert.equal(f.q.counts.submits, countsBeforeRestart.submits, "GET must not resubmit an unknown write");
  const replay = await f.request("POST", "/agent/tasks", input, "stock-agent-original");
  assert.equal(replay.body.id, task.id);
  task = (await f.request("POST", `/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.runId, originalRunId);
  assert.equal(f.q.counts.models, 1);
  assert.equal(f.q.counts.jobs, 1);
  assert.equal(f.q.counts.submits, 2, "only the explicit recovery retries the same signed queue creation");
  assert.equal(f.store.get("run", originalRunId, PROJECT).remoteSubmission.prepared.serialized, originalSerialized);
  f.q.complete(f.store.get("run", originalRunId, PROJECT));
  assert.equal((await f.request("GET", `/agent/tasks/${task.id}`)).body.stage, "WAITING_FOR_RUN");
  const completedRun = (await f.request("GET", `/runs/${originalRunId}`)).body;
  assert.equal(completedRun.validation.contractId, stockFamily.id);
  assert.equal(completedRun.rows[0].total_assets, "1300.00");
  task = (await f.request("POST", `/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.status, "SUCCEEDED");
  assert.equal(task.fullLifecycleE2E, false);
  assert.equal(task.attempts[0].model, "SYNTHETIC_PROTOCOL_FIXTURE");
  assert.equal(f.store.list("revision", PROJECT).length, 1);
  assert.equal(f.store.list("run", PROJECT).length, 1);
  assert.equal(f.q.counts.models, 1);
  assert.equal(f.q.counts.jobs, 1);
});

test("local manual HTTP runs bind old or stock family and unknown submission recovery never creates another batch", async (t) => {
  const f = await httpFixture(t);
  for (const contextId of ["holdings-t1", stockId]) {
    const key = `manual-${contextId}`;
    const saved = await f.request("POST", "/revisions", { sql: referenceSqlForContext(contextId), contextId }, `${key}-save`);
    assert.equal(saved.status, 201);
    if (contextId === stockId) f.q.lose();
    const response = await f.request("POST", "/runs", { revisionId: saved.body.id }, key);
    assert.equal(response.status, contextId === stockId ? 500 : 202);
    const run = f.store.list("run", PROJECT).find((item) => item.revisionId === saved.body.id);
    assertQueuedFamily(run, contextId);
    if (contextId === stockId) {
      const before = { ...f.q.counts };
      await f.restart();
      assert.equal((await f.request("GET", `/runs/${run.id}`)).body.status, "QUEUED");
      assert.equal(f.q.counts.submits, before.submits);
      assert.equal(f.q.counts.jobs, before.jobs);
      const replay = await f.request("POST", "/runs", { revisionId: saved.body.id }, key);
      assert.equal(replay.status, 202);
      assert.equal(replay.body.id, run.id);
      assert.equal(f.q.counts.jobs, before.jobs);
    }
    f.q.complete(f.store.get("run", run.id, PROJECT));
    const completed = await f.request("GET", `/runs/${run.id}`);
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, "SUCCEEDED");
    assert.equal(completed.body.validation.contractId, validationFamilyForContext(contextId).id);
    assert.equal(completed.body.rows[0].total_assets, contextId === stockId ? "1300.00" : "1800.00");
    const bundle = await f.request("GET", `/runs/${run.id}/bundle`);
    assert.equal(bundle.body.currentValidationContractId, validationFamilyForContext(contextId).id);
    assert.equal(bundle.body.requiresRevalidation, false);
  }
  assert.equal(f.q.counts.jobs, 2);
  assert.equal(f.q.counts.models, 0);
  assert.equal(f.store.list("agent", PROJECT).length, 0);
});

test("signed synthetic receipts cannot substitute old, duplicate, extra or explicitly conflicting contracts", async (t) => {
  const f = await httpFixture(t);
  const revision = (await f.request("POST", "/revisions", { sql: referenceSqlForContext(stockId), contextId: stockId })).body;
  const started = await f.request("POST", "/runs", { revisionId: revision.id });
  assert.equal(started.status, 202);
  const run = f.store.get("run", started.body.id, PROJECT);
  const regression = (ids) => ids.map((contextId) => ({ contextId, passed: true }));
  const invalidChecks = [
    regression(contextIds),
    regression([stockId, stockId, ...stockFamily.contextIds.slice(2)]),
    regression([...stockFamily.contextIds, "holdings-t1"]),
    regression(stockFamily.contextIds.slice(0, 4)),
  ];
  for (const validation of [
    ...invalidChecks.map((regressions) => ({ passed: true, regressions })),
    { passed: true, contractId: validationContractId, regressions: regression(stockFamily.contextIds) },
  ]) {
    f.q.complete(run, validation);
    const response = await f.request("GET", `/runs/${run.id}`);
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "REMOTE_SPARK_INVALID_RESULT");
    assert.equal(f.store.get("run", run.id, PROJECT).status, "QUEUED");
  }
  f.q.complete(run);
  const valid = await f.request("GET", `/runs/${run.id}`);
  assert.equal(valid.status, 200);
  assert.equal(valid.body.validation.contractId, stockFamily.id);
  assert.equal(f.q.counts.jobs, 1);
  assert.equal(f.q.counts.submits, 1);
  assert.equal(f.q.counts.models, 0);
});

test("a persisted run bound to another contract cannot be relabelled by receipt reconciliation", async (t) => {
  const f = await httpFixture(t);
  const revision = (await f.request("POST", "/revisions", { sql: referenceSqlForContext(stockId), contextId: stockId })).body;
  const started = await f.request("POST", "/runs", { revisionId: revision.id });
  const run = f.store.get("run", started.body.id, PROJECT);
  f.q.complete(run);
  f.store.update("run", run.id, PROJECT, { validationContractId });
  const before = { ...f.q.counts };
  const response = await f.request("GET", `/runs/${run.id}`);
  assert.equal(response.status, 500);
  assert.equal(response.body.code, "REMOTE_SPARK_CONTRACT_MISMATCH");
  assert.equal(f.store.get("run", run.id, PROJECT).status, "QUEUED");
  assert.deepEqual(f.q.counts, before, "binding failure must occur before any queue read or submit");
});

test("historical runs resolve their revision context without accepting conflicting duplicate metadata", async (t) => {
  const f = await httpFixture(t);
  for (const contextId of ["holdings-t1", stockId]) {
    const family = validationFamilyForContext(contextId);
    const sql = referenceSqlForContext(contextId);
    const revision = f.store.create("revision", PROJECT, {
      contextId, sql, hash: createHash("sha256").update(sql).digest("hex"),
    });
    const run = f.store.create("run", PROJECT, {
      revisionId: revision.id, revisionHash: revision.hash,
      status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
      rows: getContext(contextId).expected,
      validation: { passed: true, contractId: family.id, regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) },
    });
    assert.equal((await f.request("GET", `/runs/${run.id}`)).status, 200);
    const bundle = await f.request("POST", "/delivery/packages", { sourceRunId: run.id }, `old-source-${contextId}`);
    assert.equal(bundle.status, 201);
    assert.equal(bundle.body.manifest.source.validationContractId, family.id);
    f.store.update("run", run.id, PROJECT, { contextId: contextId === stockId ? "holdings-t1" : stockId });
    const before = { ...f.q.counts };
    assert.equal((await f.request("GET", `/runs/${run.id}`)).status, 409);
    assert.equal((await f.request("POST", "/delivery/packages", { sourceRunId: run.id }, `conflict-${contextId}`)).status, 409);
    assert.deepEqual(f.q.counts, before, "conflicting source metadata must be refused before queue IO");
  }
});
