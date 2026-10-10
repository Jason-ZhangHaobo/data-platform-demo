import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { MemorySnapshotBackend, ReplicatedMetadataStore } from "../../src/v2/metadata-replica.mjs";
import { createAgentDispatcher, agentTickProtocol } from "../../src/v2/agent-dispatcher.mjs";
import { createDurableSqlAgent, durableSqlAgentMode } from "../../src/v2/durable-agent.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { referenceSql, getContext, contextIds, validationContractId } from "../../src/v2/context.mjs";
import { createPrivateAgentInvoker, runAgentDriver } from "../../scripts/run-v2-agent-driver.mjs";

function fixture(t, store = new MetadataStore(":memory:")) {
  let clock = Date.now(), calls = 0, step, persist = async () => {};
  const owner = store.create("auth_user", PROJECT, { status: "ACTIVE", memberships: [{ projectId: PROJECT, role: "ENGINEER" }] });
  const create = (extra = {}) => store.create("agent", PROJECT, { executionMode: durableSqlAgentMode,
    status: "QUEUED", stage: "READY_FOR_MODEL", submittedBy: owner.id, durable: {}, ...extra });
  const engine = { advance: async (id, input) => { calls++; return step ? step(id, input) : store.update("agent", id, PROJECT, { status: "SUCCEEDED", stage: "SUCCEEDED" }, { expectedVersion: input.expectedVersion }); } };
  const build = () => createAgentDispatcher({ store, project: PROJECT, engine, persist: () => persist(), now: () => clock });
  let dispatcher = build();
  t.after(() => store.close());
  return { store, owner, create, build, engine, get calls() { return calls; }, get dispatcher() { return dispatcher; },
    tick: (requestId = randomUUID()) => dispatcher.tick({ requestId }), later: ms => clock += ms,
    step: fn => step = fn, persist: fn => persist = fn, restart: () => dispatcher = build() };
}

test("driver persists claim before side effects; duplicate ticks and concurrent drivers cannot repeat a step", async t => {
  const f = fixture(t); const task = f.create(); let release;
  f.step(async (id, input) => { await new Promise(r => release = r); return f.store.update("agent", id, PROJECT, { status: "SUCCEEDED", stage: "SUCCEEDED" }, { expectedVersion: input.expectedVersion }); });
  const requestId = randomUUID(), running = f.tick(requestId);
  await new Promise(r => setImmediate(r));
  assert.equal(f.calls, 1);
  assert.equal((await f.build().tick({ requestId: randomUUID() })).state, "BUSY");
  assert.equal((await f.tick(requestId)).state, "IN_PROGRESS");
  release(); const result = await running;
  assert.equal(result.taskId, task.id); assert.equal(result.state, "ADVANCED");
  assert.deepEqual(await f.tick(requestId), result); assert.equal(f.calls, 1);
  assert.equal((await f.tick()).state, "IDLE");
});

test("failed/slow persistence prevents side effects; expired claims recover after dispatcher restart", async t => {
  const f = fixture(t); f.create();
  f.persist(async () => { throw new Error("synthetic database outage"); });
  await assert.rejects(f.tick(), /database outage/); assert.equal(f.calls, 0);
  f.persist(async () => {}); f.restart(); assert.equal((await f.tick()).state, "BUSY");
  f.later(120001); assert.equal((await f.tick()).state, "ADVANCED"); assert.equal(f.calls, 1);
  f.create(); f.persist(async () => f.later(120001));
  assert.equal((await f.tick()).state, "LEASE_EXPIRED"); assert.equal(f.calls, 1);
});

test("driver rechecks owner permission, skips unknown model outcomes and respects live leases", async t => {
  const f = fixture(t); const task = f.create();
  f.store.update("auth_user", f.owner.id, PROJECT, { status: "DISABLED" });
  assert.equal((await f.tick()).state, "IDLE"); assert.equal(f.calls, 0);
  f.store.update("auth_user", f.owner.id, PROJECT, { status: "ACTIVE", memberships: [{ projectId: "other-project", role: "ADMIN" }] });
  assert.equal((await f.tick()).state, "IDLE");
  f.store.update("auth_user", f.owner.id, PROJECT, { memberships: [{ projectId: PROJECT, role: "ENGINEER" }] });
  f.store.update("agent", task.id, PROJECT, { stage: "MODEL_OUTCOME_UNKNOWN", status: "INTERRUPTED" });
  assert.equal((await f.tick()).state, "IDLE"); assert.equal(f.calls, 0);
  f.store.update("agent", task.id, PROJECT, { stage: "MODEL_IN_FLIGHT", status: "RUNNING", durable: { leaseExpiresAt: new Date(Date.now() + 90000).toISOString() } });
  f.create(); assert.equal((await f.tick()).state, "BUSY"); assert.equal(f.calls, 0);
  f.later(90001); assert.equal((await f.tick()).state, "ADVANCED");
});

test("repeated task faults back off and pause without starving other tasks; manual state change permits retry", async t => {
  const f = fixture(t), bad = f.create(), good = f.create();
  f.step(async id => { if (id === bad.id) throw new Error("synthetic secret error must not leak"); return f.store.update("agent", id, PROJECT, { status: "SUCCEEDED", stage: "SUCCEEDED" }); });
  for (let i = 0; i < 5; i++) { const result = await f.tick(); assert.doesNotMatch(JSON.stringify(result), /secret/); f.later(60001); }
  assert.equal(f.store.get("agent", good.id, PROJECT).status, "SUCCEEDED");
  assert.equal(f.calls, 4); assert.equal((await f.tick()).state, "IDLE");
  f.store.update("agent", bad.id, PROJECT, { operatorReviewed: true });
  assert.equal((await f.tick()).state, "STEP_FAILED"); assert.equal(f.calls, 5);
});

test("competing replicated claims fail before a second external effect", async t => {
  const backend = new MemorySnapshotBackend(), a = await ReplicatedMetadataStore.open({ backend, project: PROJECT, autoFlush: false });
  const f = fixture(t, a); f.create(); await a.flush();
  const b = await ReplicatedMetadataStore.open({ backend, project: PROJECT, autoFlush: false }); t.after(() => b.close());
  f.persist(() => a.flush());
  let secondCalls = 0;
  const other = createAgentDispatcher({ store: b, project: PROJECT, persist: () => b.flush(), engine: { advance: async () => { secondCalls++; } } });
  assert.equal((await f.tick()).state, "ADVANCED");
  await assert.rejects(other.tick({ requestId: randomUUID() }), { code: "CLOUD_METADATA_CONFLICT" });
  assert.equal(secondCalls, 0);
});

test("permission revoked during claim persistence blocks execution, while cancellation cleanup remains possible", async t => {
  const f = fixture(t), task = f.create();
  f.persist(async () => f.store.update("auth_user", f.owner.id, PROJECT, { status: "DISABLED" }));
  const rejected = await f.tick();
  assert.equal(rejected.code, "AGENT_OWNER_PERMISSION_REVOKED"); assert.equal(f.calls, 0);
  f.persist(async () => {}); f.later(60001);
  f.store.update("agent", task.id, PROJECT, { stage: "CANCELLING" });
  assert.equal((await f.tick()).state, "ADVANCED"); assert.equal(f.calls, 1);
});

test("a late tick cannot release a newer claim or overwrite its dispatch receipt", async t => {
  const f = fixture(t); f.create(); let release;
  f.step(async () => { await new Promise(r => release = r); return { status: "RUNNING", stage: "WAITING_FOR_RUN" }; });
  const old = f.tick(); await new Promise(r => setImmediate(r));
  f.later(120001); f.step(async () => ({ status: "RUNNING", stage: "READY_FOR_RUN" }));
  const newer = await f.build().tick({ requestId: randomUUID() });
  assert.equal(newer.stage, "READY_FOR_RUN");
  const stateBefore = f.store.list("agent_dispatch_state", PROJECT)[0];
  release(); assert.equal((await old).state, "LEASE_EXPIRED");
  assert.deepEqual(f.store.list("agent_dispatch_state", PROJECT)[0], stateBefore);
});

test("headless ticks recover the actual SQL Agent state machine across SQLite reopen without browser requests", async t => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-dispatch-")), path = join(root, "meta.sqlite");
  let store = new MetadataStore(path), clock = Date.now(), models = 0, submissions = 0, receipt;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = store.create("auth_user", PROJECT, { status: "ACTIVE", memberships: [{ projectId: PROJECT, role: "ENGINEER" }] });
  const runner = { prepare: (_, id) => ({ job: { jobId: id } }), submit: async () => { submissions++; }, read: async () => receipt, cancel: async () => {} };
  const build = () => {
    const engine = createDurableSqlAgent({ store, project: PROJECT, runner, persist: async () => {}, getContext, contextIds,
      contractId: validationContractId, now: () => clock,
      generator: async () => { models++; return { sql: referenceSql, model: "TEST_DOUBLE", usage: { total_tokens: 20 } }; } });
    const driver = createAgentDispatcher({ store, project: PROJECT, engine, persist: async () => {}, now: () => clock });
    return { engine, driver };
  };
  let { engine, driver } = build();
  const task = await engine.create({ actorId: owner.id, message: "虚构证券客户资产", currentSql: referenceSql, contextId: "holdings-t1", idempotencyKey: "headless" });
  assert.equal((await driver.tick({ requestId: randomUUID() })).stage, "READY_FOR_RUN");
  store.close(); store = new MetadataStore(path); store.interruptPending(PROJECT); clock += 6000;
  ({ engine, driver } = build());
  assert.equal((await driver.tick({ requestId: randomUUID() })).stage, "WAITING_FOR_RUN");
  receipt = { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    rows: getContext("holdings-t1").expected, validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) } };
  clock += 6000; assert.equal((await driver.tick({ requestId: randomUUID() })).status, "SUCCEEDED");
  assert.equal(models, 1); assert.equal(submissions, 1); assert.equal(store.list("revision", PROJECT).length, 1);
  assert.equal(engine.get(task.id).status, "SUCCEEDED");
});

test("private tick route is opt-in, validates fields and is unavailable outside private provisioning", async t => {
  const f = fixture(t), raw = async () => {}; raw.durable = { prepare() {}, submit() {}, read() {}, cancel() {} };
  const env = { V2_LOCAL_DEVELOPMENT: "false", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: "true", V2_DURABLE_SQL_AGENT_ENABLED: "true", V2_AGENT_DRIVER_MODE: "PRIVATE_TICK" };
  const app = createV2Server({ store: f.store, runner: raw, env });
  await new Promise(r => app.server.listen(0, "127.0.0.1", r)); t.after(() => new Promise(r => app.server.close(r)));
  const call = async body => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}/invoke`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const input = { operation: "PRIVATE_AGENT_TICK_V1", requestId: randomUUID() };
  assert.equal((await call(input)).body.state, "IDLE");
  assert.equal((await call({ ...input, confirmModelRetry: true })).status, 422);
  assert.equal((await call({ ...input, requestId: "bad" })).status, 422);
  assert.throws(() => createV2Server({ store: f.store, runner: raw, env: { ...env, V2_PROVISIONING_ONLY: "false" } }), /私有调用边界/);
  assert.throws(() => createV2Server({ store: f.store, runner: raw, env: { ...env, V2_DURABLE_SQL_AGENT_ENABLED: "false" } }), /私有调用边界/);
});

test("CLI driver reuses unknown tick IDs, stops on repeated errors/idle/time limit and never installs cloud resources", async () => {
  const ids = [], events = []; let calls = 0;
  const result = await runAgentDriver({ maxTicks: 4, wait: async () => {}, onEvent: e => events.push(e), invoke: async input => {
    ids.push(input.requestId); calls++; if (calls === 1) throw new Error("synthetic unknown ACK");
    return { protocol: agentTickProtocol, state: "IDLE", pending: 0 };
  } });
  assert.equal(result.reason, "IDLE"); assert.equal(ids[0], ids[1]); assert.notEqual(ids[1], ids[2]);
  assert.equal(events[0].state, "UNCONFIRMED");
  await assert.rejects(runAgentDriver({ wait: async () => {}, invoke: async () => { throw new Error("private raw details"); } }), { code: "AGENT_DRIVER_REPEATED_INVOKE_FAILURE" });
  let clock = 0;
  assert.equal((await runAgentDriver({ now: () => clock, maxDurationMs: 30000, wait: async ms => clock += ms,
    invoke: async () => ({ protocol: agentTickProtocol, state: "BUSY" }) })).reason, "TIME_LIMIT");
  let args;
  const invoke = createPrivateAgentInvoker({ functionName: "synthetic-control", region: "cn-hangzhou", execImpl: async (...input) => { args = input; return { stdout: JSON.stringify({ protocol: agentTickProtocol, state: "IDLE" }) }; } });
  await invoke({ operation: "PRIVATE_AGENT_TICK_V1", requestId: randomUUID() });
  assert.equal(args[0], "aliyun"); assert.equal(args[1][1], "POST"); assert.match(args[1][2], /\/invocations$/);
  assert.equal(args[1][args[1].indexOf("--retry-count") + 1], "0");
  assert.throws(() => createPrivateAgentInvoker({ functionName: "../other", region: "cn-hangzhou" }), { code: "AGENT_DRIVER_TARGET_INVALID" });
});
