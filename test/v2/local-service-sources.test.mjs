import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MetadataStore } from "../../src/v2/store.mjs";
import { localServiceSources } from "../../src/v2/local-service-sources.mjs";
import { localTaskConsumption } from "../../src/v2/local-task-consumption.mjs";
import { BusinessQueryStore, DataServiceManager } from "../../src/v2/data-services.mjs";
import { seedLocalServiceSource } from "./fixtures/local-service-sources.mjs";

function fixture(t, contextId) {
  const store = new MetadataStore(":memory:"), project = "synthetic-local-source";
  t.after(() => store.close());
  return { store, project, ...seedLocalServiceSource({ store, project, contextId }) };
}
const read = (f, selection = f.selection) => localServiceSources({ store: f.store, project: f.project, selection });
function rollbackFixture(f, start = 30) {
  const time = seconds => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  const other = seedLocalServiceSource({ store: f.store, project: f.project, contextId: "stock-cash-t1" });
  const from = f.store.update("release", other.release.id, f.project, { status: "ROLLED_BACK_LOCAL", rolledBackToReleaseId: f.release.id, rolledBackAt: time(start) });
  const count = f.store.list("release_run", f.project).filter(run => run.releaseId === f.release.id && run.status === "SUCCEEDED").length;
  f.store.update("release", f.release.id, f.project, { status: "ACTIVE_LOCAL", health: "HEALTHY", successfulRunCount: count + 2,
    restoredAt: time(start + 1), restoredFromReleaseId: from.id });
  let rollback = f.store.create("release_rollback", f.project, { fromReleaseId: from.id, toReleaseId: f.release.id, actor: "local-engineer", status: "SCHEDULED_FOR_VERIFICATION", resolvedAlertIds: [] });
  rollback = f.store.update("release_rollback", rollback.id, f.project, { createdAt: time(start + 2) });
  const event = f.store.create("monitor_event", f.project, { type: "ROLLBACK_ACTIVATED", releaseId: from.id, recoveryReleaseId: f.release.id,
    rollbackId: rollback.id, observedAt: time(start + 3), status: "RECOVERY_SCHEDULED" });
  const batches = [0, 1].map(index => {
    let batch = f.store.create("release_run", f.project, { ...f.batches[index], triggerReason: "ROLLBACK_RECOVERY",
      scheduledTriggerAt: time(start + 4 + index * 2), triggeredAt: time(start + 4 + index * 2), startedAt: time(start + 4 + index * 2), finishedAt: time(start + 5 + index * 2) });
    batch = f.store.update("release_run", batch.id, f.project, { createdAt: time(start + 3) });
    f.store.create("monitor_event", f.project, { ...f.events[index], releaseRunId: batch.id, observedAt: batch.finishedAt });
    return batch;
  });
  return { from, rollback, event, batches };
}

test("local source selection is complete and malformed selectors cannot become broad discovery", t => {
  const f = fixture(t);
  for (const selection of [null, [], { taskId: "bad" }, { packageDigest: f.bundle.digest }, { releaseId: f.release.id },
    { taskId: f.agent.id, packageDigest: f.bundle.digest }, { ...f.selection, releaseId: "bad" }, { ...f.selection, actor: "other" }])
    assert.throws(() => read(f, selection), { status: 422, code: "INVALID_LOCAL_SERVICE_SELECTION" });
  for (const selection of [{ ...f.selection, taskId: randomUUID() }, { ...f.selection, releaseId: randomUUID() }, { ...f.selection, packageDigest: "f".repeat(64) }])
    assert.deepEqual(read(f, selection), []);
});

test("only fully bound local Agent batches appear, with a data-free whitelist and both semantic families", t => {
  const f = fixture(t), second = seedLocalServiceSource({ store: f.store, project: f.project, contextId: "stock-cash-t1" });
  const before = f.store.db.prepare("SELECT data FROM documents ORDER BY id").all();
  const selected = read(f);
  assert.deepEqual(selected.map(row => row.id), f.batches.map(batch => batch.id));
  assert.equal(read(f, {}).length, 4); assert.equal(read(f, { taskId: second.agent.id }).length, 2);
  assert.ok(selected.every(row => row.scope === "LOCAL_TEST_ONLY" && row.sourceKind === "AGENT" && row.agentIndependentE2E === false && row.publicDeployed === false &&
    row.sourceAgentTaskId === f.agent.id && row.sourceRevisionId === f.revision.id && row.sourceRunId === f.codeRun.id && row.releaseId === f.release.id && row.packageDigest === f.bundle.digest));
  assert.equal(selected[0].rowCount, 2);
  for (const hidden of ["rows", "log", "stdout", "stderr", "sql", "artifactDirectory", "source", "fileHashes"]) assert.equal(Object.hasOwn(selected[0], hidden), false);
  assert.equal(JSON.stringify(selected).includes("1800.00"), false);
  assert.deepEqual(f.store.db.prepare("SELECT data FROM documents ORDER BY id").all(), before, "discovery is read-only");
});

test("native task, persisted code, delivery, review and approval cannot be replaced by success flags", t => {
  const f = fixture(t);
  const changes = [
    ["agent", f.agent, { status: "FAILED" }], ["agent", f.agent, { sourceKind: "MANUAL" }], ["agent", f.agent, { sourceKind: "UNKNOWN" }],
    ["agent", f.agent, { mode: "TEMPLATE" }], ["agent", f.agent, { attempts: [{ ...f.agent.attempts[0], model: "TEST_DOUBLE" }] }],
    ["agent", f.agent, { attempts: [{ ...f.agent.attempts[0], runId: randomUUID() }] }],
    ["revision", f.revision, { source: "MANUAL" }], ["revision", f.revision, { manualProvenance: { kind: "ENGINEER_EDIT" } }],
    ["revision", f.revision, { sql: "SELECT 1" }], ["run", f.codeRun, { agentTaskId: randomUUID() }],
    ["run", f.codeRun, { rows: [{ ...f.codeRun.rows[0], total_assets: "1.00" }, f.codeRun.rows[1]] }],
    ["run", f.codeRun, { rows: [null] }], ["run", f.codeRun, { isolation: "FUNCTION_PROCESS" }],
    ["run", f.codeRun, { engineVersion: "3.5.7" }], ["revision", f.revision, { sql: 123 }],
    ["agent_delivery_task", f.delivery, { status: "FAILED" }], ["agent_delivery_task", f.delivery, { actualExecution: false }],
    ["agent_delivery_task", f.delivery, { sourceRunId: randomUUID() }], ["agent_delivery_task", f.delivery, { sourceKind: "UNKNOWN" }],
    ["delivery_package", f.bundle, { digest: "f".repeat(64) }], ["delivery_package", f.bundle, { agentDeliveryTaskId: randomUUID() }],
    ["delivery_verification", f.verification, { scope: "M2A_CLOUD" }], ["delivery_verification", f.verification, { mode: "CLOUD_ISOLATED_FILE_REHEARSAL" }],
    ["delivery_verification", f.verification, { source: { ...f.verification.source, runId: randomUUID() } }],
    ["delivery_verification", f.verification, { testSqlValidation: { passed: true, sqlHash: "f".repeat(64) } }],
    ["delivery_review", f.review, { verificationId: randomUUID() }], ["delivery_review", f.review, { attestations: { code: true } }],
    ["delivery_review", f.review, { sourceAttribution: "ENGINEER_ASSISTED" }],
    ["release_approval", f.approval, { sourceCodeHash: "f".repeat(64) }], ["release_approval", f.approval, { consumedByReleaseId: randomUUID() }],
  ];
  for (const [kind, original, patch] of changes) {
    f.store.update(kind, original.id, f.project, patch); assert.deepEqual(read(f), [], `${kind}: ${Object.keys(patch)}`);
    // Undefined clears fields that did not exist before the mutation.
    f.store.update(kind, original.id, f.project, { ...Object.fromEntries(Object.keys(patch).map(key => [key, undefined])), ...original });
  }
  assert.equal(read(f).length, 2);
});

test("cloud, development, mixed-file and false scheduler receipts cannot earn a local source", t => {
  const f = fixture(t), batch = f.batches[0];
  for (const [kind, original, patch] of [
    ["release", f.release, { mode: "DURABLE_PRIVATE_RELEASE_V1" }], ["release", f.release, { status: "SUPERSEDED_LOCAL" }],
    ["release", f.release, { health: "OBSERVING" }], ["release", f.release, { sourceCodeHash: "f".repeat(64) }],
    ["release_run", batch, { mode: "DURABLE_REMOTE_SUBMISSION" }], ["release_run", batch, { clockMode: "FC_TIMER" }],
    ["release_run", batch, { schedulerTriggered: false }], ["release_run", batch, { mainSqlExecuted: false }],
    ["release_run", batch, { testDouble: true }], ["release_run", batch, { packageId: randomUUID() }],
    ["release_run", batch, { source: { ...batch.source, runId: randomUUID() } }],
    ["release_run", batch, { fileHashes: { ...batch.fileHashes, "main.sql": "f".repeat(64) } }],
    ["release_run", batch, { fileHashes: { ...batch.fileHashes, "tests.sql": "f".repeat(64) } }],
    ["release_run", batch, { testSqlValidation: { passed: true } }],
    ["release_run", batch, { validation: { passed: true, regressions: batch.validation.regressions.slice(0, 4) } }],
    ["release_run", batch, { rows: [{ ...batch.rows[0], total_assets: "999.00" }, batch.rows[1]] }],
    ["release_run", batch, { rows: [null] }],
    ["release_run", batch, { finishedAt: "2026-09-15T00:00:01.000Z" }],
    ["monitor_event", f.events[0], { packageDigest: "f".repeat(64) }],
  ]) {
    f.store.update(kind, original.id, f.project, patch); assert.deepEqual(read(f), [], `${kind}: ${Object.keys(patch)}`);
    f.store.update(kind, original.id, f.project, { ...Object.fromEntries(Object.keys(patch).map(key => [key, undefined])), ...original });
  }
  const foreign = seedLocalServiceSource({ store: f.store, project: "other-project" });
  assert.deepEqual(read(f, foreign.selection), []);
  f.store.create("agent_delivery_task", f.project, { ...f.delivery });
  assert.deepEqual(read(f), [], "ambiguous delivery chain never chooses the first");
});

test("normal package reuse keeps immutable history while current successful forward proofs remain authoritative", t => {
  const f = fixture(t), originalFiles = JSON.stringify(f.bundle.files), originalManifest = JSON.stringify(f.bundle.manifest), originalDigest = f.bundle.digest;
  f.store.update("delivery_package", f.bundle.id, f.project, { agentDeliveryTaskId: undefined });
  assert.equal(read(f).length, 2, "ordinary package creation does not have an Agent reverse pointer");
  const prior = f.store.create("agent_delivery_task", f.project, { ...f.delivery, status: "CANCELLED", actualExecution: false });
  f.store.update("delivery_package", f.bundle.id, f.project, { agentDeliveryTaskId: prior.id });
  assert.equal(read(f).length, 2, "same-source retry can reuse the cancelled delivery's package");
  f.store.update("agent_delivery_task", prior.id, f.project, { status: "FAILED" });
  assert.equal(read(f).length, 2);
  for (const patch of [{ sourceAgentTaskId: randomUUID() }, { sourceRunId: randomUUID() }, { sourceRevisionId: randomUUID() },
    { sourceSqlHash: "f".repeat(64) }, { packageId: randomUUID() }, { packageDigest: "f".repeat(64) }, { sourceKind: "MANUAL" }, { status: "RUNNING" }]) {
    f.store.update("agent_delivery_task", prior.id, f.project, patch); assert.deepEqual(read(f), [], Object.keys(patch).join());
    f.store.update("agent_delivery_task", prior.id, f.project, { ...Object.fromEntries(Object.keys(patch).map(key => [key, undefined])), ...prior });
  }
  f.store.update("delivery_package", f.bundle.id, f.project, { agentDeliveryTaskId: randomUUID() }); assert.deepEqual(read(f), []);
  const saved = f.store.get("delivery_package", f.bundle.id, f.project);
  assert.equal(JSON.stringify(saved.files), originalFiles); assert.equal(JSON.stringify(saved.manifest), originalManifest); assert.equal(saved.digest, originalDigest);
});

test("verified rollback keeps historical pinned batches but requires two separately proven current recovery batches", t => {
  const f = fixture(t), recovery = rollbackFixture(f);
  assert.deepEqual(new Set(read(f).map(row => row.id)), new Set([...f.batches, ...recovery.batches].map(batch => batch.id)));
  assert.equal(read(f).filter(row => row.sequence === 1).length, 2, "sequence restarts in each recovery window");
  const second = rollbackFixture(f, 50);
  assert.deepEqual(new Set(read(f).map(row => row.id)), new Set([...f.batches, ...recovery.batches, ...second.batches].map(batch => batch.id)), "repeated legitimate recovery preserves each immutable historical batch");
  f.store.update("release_run", second.batches[1].id, f.project, { status: "RUNNING" });
  assert.deepEqual(read(f), [], "old successful windows never substitute for the pending latest recovery");
});

test("rollback metadata, event, current window and historical source integrity cannot be forged", t => {
  const f = fixture(t), recovery = rollbackFixture(f), release = f.store.get("release", f.release.id, f.project);
  for (const [kind, original, patch] of [
    ["release", release, { restoredFromReleaseId: randomUUID() }], ["release", release, { restoredAt: undefined }],
    ["release", recovery.from, { rolledBackToReleaseId: randomUUID() }],
    ["release_rollback", recovery.rollback, { toReleaseId: randomUUID() }], ["release_rollback", recovery.rollback, { status: "UNKNOWN" }],
    ["monitor_event", recovery.event, { rollbackId: randomUUID() }], ["monitor_event", recovery.event, { recoveryReleaseId: randomUUID() }],
    ["release_run", recovery.batches[0], { triggerReason: "LOCAL_TEST_SCHEDULE" }], ["release_run", recovery.batches[0], { status: "FAILED" }],
    ["release_run", recovery.batches[0], { packageDigest: "f".repeat(64) }], ["release_run", recovery.batches[0], { sequence: 2 }],
    ["release_run", f.batches[0], { fileHashes: { ...f.batches[0].fileHashes, "main.sql": "f".repeat(64) } }],
    ["release_run", f.batches[0], { source: { ...f.batches[0].source, runId: randomUUID() } }],
  ]) {
    f.store.update(kind, original.id, f.project, patch); assert.deepEqual(read(f), [], `${kind}: ${Object.keys(patch)}`);
    f.store.update(kind, original.id, f.project, { ...Object.fromEntries(Object.keys(patch).map(key => [key, undefined])), ...original });
  }
  assert.equal(read(f).length, 4);
  const ordinary = fixture(t);
  ordinary.store.create("release_run", ordinary.project, { ...ordinary.batches[0] });
  assert.deepEqual(read(ordinary), [], "ordinary first publication retains its exact batch-count rule");
});

test("exact consumption shares the same strict source while the legacy unbound projection remains unchanged", async t => {
  const f = fixture(t), businessStore = new BusinessQueryStore(":memory:"); t.after(() => businessStore.close());
  const manager = new DataServiceManager({ store: f.store, businessStore, project: f.project, releaseRunFor: id => f.store.get("release_run", id, f.project) });
  const make = async (slug, fields) => { const service = manager.createDapi({ name: slug, slug, sourceReleaseRunId: f.batches[0].id, fields });
    await manager.test(service.id, {}); manager.publish(service.id); return service; };
  const holdings = await make("local-source-holdings", ["client_id", "holding_market_value", "security_count"]), cash = await make("local-source-cash", ["client_id", "available_cash", "total_assets"]);
  const xapi = manager.createXapi({ name: "合成本机组合", slug: "local-source-overview", steps: [{ alias: "holdings", dapiId: holdings.id }, { alias: "cash", dapiId: cash.id }] });
  await manager.test(xapi.id, {}); manager.publish(xapi.id);
  const issued = manager.createApplication({ name: "合成本机应用", serviceIds: [xapi.id] });
  await manager.invoke("XAPI", "local-source-overview", "Bearer " + issued.token, {}); manager.revokeApplication(issued.application.id);
  const consume = extra => localTaskConsumption({ store: f.store, project: f.project, agent: f.agent, packageDigest: f.bundle.digest, manager, ...extra });
  const before = f.store.list("service_call", f.project);
  assert.equal((await consume({ releaseId: f.release.id })).status, "VERIFIED");
  rollbackFixture(f);
  const restored = await consume({ releaseId: f.release.id });
  assert.equal(restored.status, "VERIFIED", "fixed historical service versions survive a completely verified rollback");
  assert.deepEqual(restored.services.find(service => service.serviceId === xapi.id).sourceRunIds, [f.batches[0].id]);
  f.store.update("delivery_review", f.review.id, f.project, { attestations: { code: true } });
  assert.deepEqual(read(f), []); assert.equal((await consume({ releaseId: f.release.id })).status, "PENDING");
  assert.equal((await consume({})).status, "VERIFIED", "old task+digest semantics are not silently reinterpreted");
  assert.deepEqual(f.store.list("service_call", f.project), before); assert.equal(manager.listApplications().length, 1);
});
