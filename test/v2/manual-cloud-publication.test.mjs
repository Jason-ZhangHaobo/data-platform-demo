import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LocalArtifactStore } from "../../src/v2/artifact-store.mjs";
import { getContext, referenceSqlForContext, validationFamilyForContext } from "../../src/v2/context.mjs";
import { saveManualRevision } from "../../src/v2/manual-revisions.mjs";
import { createDurableAgentDelivery } from "../../src/v2/agent-development-workflow.mjs";
import { createCloudPublication, cloudPublicationMode, validatePublicationSelector } from "../../src/v2/cloud-publication.mjs";
import { sha256 } from "../../src/v2/delivery.mjs";

// Pure in-memory metadata, immutable temporary artifacts and synthetic receipts.
// All runner calls below are counters; no model, Spark or cloud is contacted.
const project = "project-securities-lab";
const attestations = { code: true, assertions: true, deliveryFiles: true, cloudScope: true };
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "shuduo-manual-publication-")), store = new MetadataStore(":memory:"), artifacts = new LocalArtifactStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = store.create("auth_user", project, { email: "synthetic-owner@example.invalid", status: "ACTIVE" });
  const agent = store.create("agent", project, { submittedBy: actor.id, language: "SPARK_SQL", contextId: "stock-cash-t1", mode: "LIVE_MODEL", executionMode: "DURABLE_SQL_AGENT_V1",
    status: "FAILED", stage: "FAILED", usedTokens: 18000, maxAttempts: 3,
    attempts: [{ attempt: 1, status: "MODEL_OUTCOME_UNKNOWN", usageEstimated: true }, { attempt: 2, status: "VALIDATION_FAILED" }, { attempt: 3, status: "NO_SQL_CHANGE" }] });
  const family = validationFamilyForContext(agent.contextId), validation = { passed: true, contractId: family.id, regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) };
  const prepared = new Map(), receipts = new Map(), submits = [], cancellations = [];
  let time = Date.parse("2026-11-05T01:00:00Z"), flushes = 0, unknownFlush = false, afterVerify;
  const runner = {
    prepare: (input, id) => { const p = { job: { jobId: id }, input }; prepared.set(id, p); return p; },
    submit: async p => { submits.push(p.job.jobId); }, read: async p => receipts.get(p.job.jobId), cancel: async p => { cancellations.push(p.job.jobId); },
  };
  const artifactStore = { put: (...args) => artifacts.put(...args), verify: async (...args) => { await artifacts.verify(...args); if (afterVerify) await afterVerify(); } };
  const persist = async () => { flushes++; if (unknownFlush) { unknownFlush = false; throw Error("synthetic lost flush acknowledgement"); } };
  const options = { store, project, runner, artifactStore, persist, enabled: true, now: () => time };
  const complete = id => {
    const p = prepared.get(id);
    receipts.set(id, { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
      testSqlValidation: { passed: true, sqlHash: sha256(p.input.testSql) }, validation, rows: getContext(agent.contextId).expected });
  };
  let serial = 0;
  const manual = async () => {
    const number = ++serial;
    const revision = saveManualRevision({ store, project, actor: actor.id, key: `manual-version-${number}`, contextId: agent.contextId,
      sql: referenceSqlForContext(agent.contextId) + `\n-- synthetic version ${number}`, originAgentTaskId: agent.id }).revision;
    const run = store.create("run", project, { revisionId: revision.id, revisionHash: revision.hash, contextId: agent.contextId, validationContractId: family.id,
      status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, isolation: "FUNCTION_PROCESS", mode: "DURABLE_REMOTE_SUBMISSION",
      validation, rows: getContext(agent.contextId).expected });
    const engine = createDurableAgentDelivery(options), task = await engine.createManual({ runId: run.id, actorId: actor.id, key: `handoff-${number}` }), running = await engine.advance(task.id, task.version);
    complete(running.verificationId); const delivery = await engine.reconcile(task.id), item = store.get("delivery_package", delivery.packageId, project), verification = store.get("delivery_verification", delivery.verificationId, project);
    const input = { agent, sourceKind: "MANUAL", sourceRunId: run.id, actorId: actor.id, packageDigest: item.digest, verificationId: verification.id, attestations, idempotencyKey: `publish-${number}` };
    const selector = validatePublicationSelector({ sourceKind: "MANUAL", sourceRunId: run.id, packageDigest: item.digest, verificationId: verification.id }, actor.id);
    return { revision, run, delivery, item, verification, input, selector };
  };
  return { store, actor, agent, options, engine: createCloudPublication(options), manual, prepared, receipts, submits, cancellations, complete,
    advance: () => { time += 60000; }, now: () => time, loseFlush: () => { unknownFlush = true; }, flushes: () => flushes,
    onVerify: fn => { afterVerify = fn; } };
}
const event = (f, releaseId, n) => ({ releaseId, requestId: sha256(`synthetic-manual-tick-${releaseId}-${n}`), triggerName: `synthetic-manual-${n}`, triggerTime: new Date(f.now()).toISOString() });

test("selector validates exact manual binding and only trusts the separately injected identity", () => {
  const input = { sourceKind: "MANUAL", sourceRunId: randomUUID(), packageDigest: "a".repeat(64), verificationId: randomUUID() }, actorId = randomUUID();
  assert.deepEqual(validatePublicationSelector(input, actorId), { ...input, actorId });
  assert.deepEqual(validatePublicationSelector(), { sourceKind: "AGENT" });
  for (const bad of [null, [], { sourceKind: null }, { sourceKind: "UNKNOWN" }, { actorId }, { ...input, actorId }, { ...input, releaseId: "../outside" },
    { ...input, sourceRunId: undefined }, { ...input, packageDigest: "old" }, { ...input, verificationId: undefined }, { ...input, arbitrary: true }])
    assert.throws(() => validatePublicationSelector(bad, actorId), { status: 422, code: "PUBLICATION_SELECTOR_INVALID" });
  assert.throws(() => validatePublicationSelector(input), { status: 422 });
});

test("manual review creates only a frozen attributed release; existing ticks execute two batches without changing original Agent history", async t => {
  const f = await fixture(t), m = await f.manual(), original = f.store.get("agent", f.agent.id, project), submitted = f.submits.length;
  const created = await f.engine.publish(m.input), id = created.release.id;
  assert.equal(created.release.status, "WAITING_SCHEDULER"); assert.equal(f.submits.length, submitted);
  for (const kind of ["delivery_review", "release_approval", "release", "release_run"]) {
    const records = f.store.list(kind, project); assert.ok(records.length > 0);
    for (const record of records) {
      assert.equal(record.sourceKind, "MANUAL"); assert.equal(record.sourceRunId, m.run.id);
      assert.equal(record.sourceAttribution, "ENGINEER_ASSISTED"); assert.equal(record.agentIndependentE2E, false);
      assert.equal(record.submittedBy, f.actor.id); assert.equal(record.packageDigest, m.item.digest);
    }
  }
  assert.equal((await f.engine.detail(f.agent.id)).release, undefined, "default AGENT read cannot claim manual success");
  assert.equal(created.release.submittedBy, undefined); assert.equal(created.runs[0].submittedBy, undefined);
  await f.engine.tick(event(f, id, 1)); let run = f.store.list("release_run", project).find(r => r.releaseId === id && r.status === "RUNNING"); f.complete(run.id);
  f.advance(); await f.engine.tick(event(f, id, 2)); run = f.store.list("release_run", project).find(r => r.releaseId === id && r.status === "RUNNING"); f.complete(run.id);
  f.advance(); const third = event(f, id, 3); await f.engine.tick(third); await f.engine.tick(third);
  const done = await f.engine.detail(f.agent.id, m.selector);
  assert.equal(done.release.status, "COMPLETED_CLOUD_TEST"); assert.equal(done.release.health, "HEALTHY");
  assert.equal(done.runs.length, 2); assert.ok(done.runs.every(r => r.status === "SUCCEEDED" && r.schedulerTriggered && r.agentIndependentE2E === false));
  assert.equal(f.submits.length, submitted + 2); assert.deepEqual(f.store.get("agent", f.agent.id, project), original);
  const historical = createCloudPublication({ store: f.store, project, now: f.now });
  assert.deepEqual(historical.savedDetail(f.agent.id, m.selector), { ...done, readMode: "SAVED_HISTORY" });
  assert.throws(() => historical.savedDetail(f.agent.id, { ...m.selector, actorId: "other-engineer" }), { status: 403 });
  assert.equal(f.submits.length, submitted + 2);
});

test("wrong kind, actor, context, revision, run, package or rehearsal cannot approve manual delivery", async t => {
  const f = await fixture(t), m = await f.manual(), beforeSubmits = f.submits.length;
  for (const input of [{ ...m.input, sourceKind: "AGENT" }, { ...m.input, sourceRunId: undefined }, { ...m.input, actorId: "other-engineer" },
    { ...m.input, packageDigest: "f".repeat(64) }, { ...m.input, verificationId: randomUUID() }, { ...m.input, attestations: { code: true } }])
    await assert.rejects(f.engine.publish(input));
  const original = kind => f.store.get(kind, ({ agent: f.agent, revision: m.revision, run: m.run, agent_delivery_task: m.delivery, delivery_package: m.item, delivery_verification: m.verification })[kind].id, project);
  for (const [kind, patch] of [
    ["agent", { submittedBy: "other-engineer" }], ["revision", { author: "other-engineer" }], ["revision", { contextId: "holdings-t1" }],
    ["revision", { sql: "SELECT 1" }], ["revision", { manualProvenance: { ...m.revision.manualProvenance, agentIndependentE2E: true } }],
    ["run", { status: "VALIDATION_FAILED" }], ["run", { validationContractId: "other" }], ["run", { revisionHash: "0".repeat(64) }],
    ["agent_delivery_task", { submittedBy: "other-engineer" }], ["agent_delivery_task", { sourceRunId: randomUUID() }], ["agent_delivery_task", { actualExecution: false }],
    ["delivery_package", { sourceRunId: randomUUID() }], ["delivery_package", { agentDeliveryTaskId: randomUUID() }], ["delivery_package", { agentIndependentE2E: true }],
    ["delivery_verification", { actualExecution: false }], ["delivery_verification", { testDouble: true }], ["delivery_verification", { isolation: "LOCAL_PROCESS" }],
    ["delivery_verification", { agentDeliveryTaskId: randomUUID() }], ["delivery_verification", { testSqlValidation: { passed: true, sqlHash: "f".repeat(64) } }],
  ]) {
    const before = original(kind); f.store.update(kind, before.id, project, patch);
    await assert.rejects(f.engine.publish(m.input), undefined, kind + JSON.stringify(Object.keys(patch)));
    f.store.update(kind, before.id, project, { ...before, ...(Object.hasOwn(patch, "testDouble") ? { testDouble: undefined } : {}) });
  }
  assert.equal(f.submits.length, beforeSubmits);
  for (const kind of ["release", "release_run", "delivery_review", "release_approval"]) assert.equal(f.store.list(kind, project).length, 0);
});

test("artifact await re-reads source and preserves the original approval-window check before any record is created", async t => {
  const f = await fixture(t), m = await f.manual();
  for (const [kind, id, patch] of [["revision", m.revision.id, { author: "another-owner" }], ["run", m.run.id, { status: "FAILED" }],
    ["delivery_verification", m.verification.id, { status: "FAILED" }], ["agent_delivery_task", m.delivery.id, { sourceRunId: randomUUID() }],
    ["agent", f.agent.id, { usedTokens: 18001 }]]) {
    const before = f.store.get(kind, id, project); f.onVerify(() => f.store.update(kind, id, project, patch));
    await assert.rejects(f.engine.publish(m.input)); f.onVerify(undefined); f.store.update(kind, id, project, before);
    assert.equal(f.store.list("release", project).length, 0);
  }
  let checks = 0;
  const engine = createCloudPublication({ ...f.options, assertPublicationScope: target => {
    assert.deepEqual(target, { agentId: f.agent.id, packageDigest: m.item.digest, verificationId: m.verification.id });
    if (++checks > 1) throw Error("synthetic publication window expired");
  } });
  await assert.rejects(engine.publish(m.input), /window expired/);
  assert.equal(f.store.list("delivery_review", project).length, 0); assert.equal(f.store.list("release_approval", project).length, 0);
});

test("manual and model versions never cross reads or cancellation, and invalidated source does not prevent stopping its persisted release", async t => {
  const f = await fixture(t), one = await f.manual(), two = await f.manual(),
    first = await f.engine.publish(one.input), second = await f.engine.publish(two.input);
  const legacy = f.store.create("release", project, { mode: cloudPublicationMode, sourceAgentTaskId: f.agent.id, status: "WAITING_SCHEDULER", packageDigest: "d".repeat(64), verificationId: randomUUID() });
  assert.equal((await f.engine.detail(f.agent.id)).release.id, legacy.id);
  assert.equal((await f.engine.detail(f.agent.id, one.selector)).release.id, first.release.id);
  assert.equal((await f.engine.detail(f.agent.id, two.selector)).release.id, second.release.id);
  assert.equal((await f.engine.detail(f.agent.id, { ...one.selector, packageDigest: two.item.digest })).release, undefined);
  await assert.rejects(f.engine.cancel(f.agent.id, { ...one.selector, releaseId: second.release.id }), { status: 404 });
  await assert.rejects(f.engine.detail(f.agent.id, { ...one.selector, actorId: "other-engineer" }), { status: 403 });
  const otherModel = f.store.create("release", project, { ...legacy, sourceKind: "AGENT" });
  await assert.rejects(f.engine.detail(f.agent.id), { status: 409, code: "PUBLICATION_SELECTOR_AMBIGUOUS" });
  await assert.rejects(f.engine.cancel(f.agent.id), { status: 409 });
  assert.equal((await f.engine.detail(f.agent.id, { releaseId: otherModel.id })).release.id, otherModel.id);
  const before = f.store.get("agent", f.agent.id, project);
  f.store.update("revision", one.revision.id, project, { sql: "SELECT 1 -- invalidated after publish" });
  f.store.update("delivery_verification", one.verification.id, project, { status: "FAILED" });
  const stopped = await f.engine.cancel(f.agent.id, { ...one.selector, releaseId: first.release.id });
  assert.equal(stopped.release.status, "CANCELLED"); assert.ok(stopped.runs.every(r => r.status === "CANCELLED"));
  assert.equal((await f.engine.detail(f.agent.id, two.selector)).release.status, "WAITING_SCHEDULER");
  assert.equal(f.store.get("release", legacy.id, project).status, "WAITING_SCHEDULER"); assert.deepEqual(f.store.get("agent", f.agent.id, project), before);
});

test("unknown publication acknowledgement reuses exact records and changed idempotency input never returns another existing package", async t => {
  const f = await fixture(t), one = await f.manual(), before = f.store.get("agent", f.agent.id, project), submitted = f.submits.length;
  f.loseFlush(); await assert.rejects(f.engine.publish(one.input), /lost flush acknowledgement/);
  const saved = f.store.list("release", project)[0]; assert.equal(saved.status, "WAITING_SCHEDULER");
  const recovered = await createCloudPublication(f.options).publish(one.input); assert.equal(recovered.release.id, saved.id);
  assert.equal((await f.engine.publish({ ...one.input, idempotencyKey: "different-key-same-source" })).release.id, saved.id);
  const two = await f.manual(); await f.engine.publish(two.input);
  await assert.rejects(f.engine.publish({ ...two.input, idempotencyKey: one.input.idempotencyKey }), { status: 409 });
  assert.equal(f.store.list("release", project).length, 2); assert.equal(f.store.list("release_approval", project).length, 2);
  assert.equal(f.store.list("release_run", project).length, 4); assert.equal(f.submits.length, submitted + 1, "only the second synthetic handoff rehearsed");
  assert.deepEqual(f.store.get("agent", f.agent.id, project), before);
});

test("same package with a new rehearsal cannot inherit old approval or evade single-release cancellation policy", async t => {
  const f = await fixture(t), m = await f.manual(), engine = createCloudPublication({ ...f.options, singleRelease: true }), first = await engine.publish(m.input);
  await engine.cancel(f.agent.id, { ...m.selector, releaseId: first.release.id });
  assert.equal((await engine.publish({ ...m.input, idempotencyKey: "cancelled-same-binding" })).release.id, first.release.id);
  const next = f.store.create("delivery_verification", project, { ...m.verification });
  f.store.update("agent_delivery_task", m.delivery.id, project, { verificationId: next.id });
  const changed = { ...m.input, verificationId: next.id, idempotencyKey: "new-rehearsal" };
  await assert.rejects(engine.publish(changed), { status: 409 });
  assert.equal(f.store.list("release", project).length, 1); assert.equal(f.store.list("release_approval", project).length, 1);
  const reopened = await f.engine.publish(changed);
  assert.notEqual(reopened.release.id, first.release.id); assert.equal(reopened.release.verificationId, next.id);
  assert.notEqual(reopened.release.approvalId, first.release.approvalId);
  assert.equal((await f.engine.detail(f.agent.id, m.selector)).release.id, first.release.id);
});
