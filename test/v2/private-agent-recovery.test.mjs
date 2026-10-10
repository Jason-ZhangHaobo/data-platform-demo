import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MetadataStore } from "../../src/v2/store.mjs";
import { privateAgentRecovery } from "../../src/v2/private-agent-recovery.mjs";
import { createDurableSqlAgent } from "../../src/v2/durable-agent.mjs";
import { getContext, contextIds, validationContractId, referenceSql } from "../../src/v2/context.mjs";

test("fixed private recovery fixture is idempotent, checkpointed, read-only on reread and rejects forged acceptance", async t => {
  const store = new MetadataStore(":memory:"), project = "synthetic-project", requestId = randomUUID();
  t.after(() => store.close()); let calls = 0, receipt;
  const engine = createDurableSqlAgent({ store, project, persist: async () => {}, getContext, contextIds, contractId: validationContractId,
    generator: async () => { calls++; return { sql: referenceSql, model: "TEST_DOUBLE", usage: { total_tokens: 20 } }; },
    runner: { prepare: (_, id) => ({ job: { jobId: id } }), submit: async () => {}, read: async () => receipt, cancel: async () => {} } });
  const invoke = (action, bootId = "runtime-a", extra = {}) => privateAgentRecovery({ operation: "PRIVATE_AGENT_RECOVERY_V1", action, requestId, ...extra }, { store, project, engine, persist: async () => {}, bootId });
  await assert.rejects(invoke("read"), { code: "RECOVERY_FIXTURE_NOT_FOUND" });
  const task = await invoke("prepare");
  assert.equal((await invoke("prepare")).taskId, task.taskId); assert.equal(store.list("auth_user", project).length, 1); assert.equal(calls, 0);
  await assert.rejects(invoke("prepare", "runtime-a", { sql: "SELECT secret" }), { code: "PRIVATE_AGENT_RECOVERY_INVALID" });
  await assert.rejects(invoke("finish"), { code: "RECOVERY_TASK_STILL_ACTIVE" });
  const generated = await invoke("generate"); assert.equal(calls, 1);
  const restored = await invoke("read", "runtime-b");
  const byTask = await privateAgentRecovery({ operation: "PRIVATE_AGENT_RECOVERY_V1", action: "read", taskId: task.taskId },
    { store, project, engine, persist: async () => {}, bootId: "runtime-b" });
  assert.equal(byTask.requestId, requestId); assert.equal(byTask.taskId, task.taskId);
  await assert.rejects(privateAgentRecovery({ operation: "PRIVATE_AGENT_RECOVERY_V1", action: "generate", taskId: task.taskId },
    { store, project, engine }), { code: "PRIVATE_AGENT_RECOVERY_INVALID" });
  await assert.rejects(privateAgentRecovery({ operation: "PRIVATE_AGENT_RECOVERY_V1", action: "read", taskId: randomUUID() },
    { store, project, engine }), { code: "RECOVERY_FIXTURE_NOT_FOUND" });
  assert.equal(restored.differentRuntimeInstance, true); assert.equal(restored.revisionHash, generated.revisionHash);
  assert.equal(restored.taskVersion, generated.taskVersion); assert.equal(restored.realModel, false);
  await invoke("generate"); assert.equal(calls, 1);
  await engine.advance(task.taskId, { expectedVersion: engine.get(task.taskId).version });
  receipt = { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    rows: getContext("holdings-t1").expected, validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) } };
  await engine.advance(task.taskId, { expectedVersion: engine.get(task.taskId).version });
  const result = await invoke("finish");
  assert.equal(result.independentResultMatches, true); assert.equal(result.verified, false);
  assert.equal(store.list("auth_user", project)[0].status, "DISABLED");
  const run = store.get("run", result.runId, project);
  store.update("run", run.id, project, { rows: [{ ...run.rows[0], total_assets: "999999.00" }] });
  assert.equal((await invoke("read")).independentResultMatches, false);
  assert.doesNotMatch(JSON.stringify(result), /password|secret|SELECT/);
});
