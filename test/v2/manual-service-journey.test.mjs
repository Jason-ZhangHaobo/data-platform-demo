import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT } from "../../src/v2/server.mjs";
import { createManualServiceJourney } from "./fixtures/manual-service-journey.mjs";

// Authenticated loopback HTTP with signed synthetic publication receipts and
// real SQLite service snapshots. Restart covers metadata/controller only: the
// businessStore intentionally remains the same in-memory SQLite instance.
async function fixture(t) { const f = await createManualServiceJourney(); t.after(() => f.dispose()); return f; }

test("PUBLICATION_ONLY session resolves the exact manual source and lists only its published batches", async t => {
  const f = await fixture(t), before = f.counts();
  const session = await f.call("/auth/session");
  assert.equal(session.status, 200); assert.equal(session.body.publicationOnly, true);
  assert.deepEqual(session.body.permissions, ["SESSION", "DELIVERY"]);
  assert.deepEqual(session.body.publicationSource, { status: "RESOLVED", sourceKind: "MANUAL", taskId: f.agent.id,
    packageDigest: f.item.digest, verificationId: f.verification.id, revisionId: f.revision.id, runId: f.sourceRun.id });
  const sources = await f.call(f.sourcesPath);
  assert.equal(sources.status, 200); assert.equal(sources.body.length, 2);
  assert.ok(sources.body.every(run => run.releaseId === f.releaseId && run.packageDigest === f.item.digest && run.sourceKind === "MANUAL" && run.agentIndependentE2E === false));
  assert.ok(sources.body.some(run => run.id === f.sourceReleaseRunId));
  assert.equal(sources.body.some(run => run.id === f.distractor.releaseRun.id), false);
  const all = await f.call(`/data-services/sources?agent_task_id=${f.agent.id}`);
  assert.ok(all.body.some(run => run.id === f.distractor.releaseRun.id), "a genuine separate candidate exists, not just an empty negative fixture");
  assert.deepEqual(f.counts(), before); assert.deepEqual(f.store.get("agent", f.agent.id, PROJECT), f.originalAgent);
});

test("HTTP consumption reads the same revoked application's call and exact release without new calls or apps", async t => {
  const f = await fixture(t), before = f.counts();
  for (let n = 0; n < 2; n++) {
    const evidence = await f.call(f.evidencePath);
    assert.equal(evidence.status, 200); assert.equal(evidence.body.status, "VERIFIED");
    assert.equal(evidence.body.releaseId, f.releaseId); assert.equal(evidence.body.packageDigest, f.item.digest);
    assert.equal(evidence.body.sourceKind, "MANUAL"); assert.equal(evidence.body.sourceAttribution, "ENGINEER_ASSISTED");
    assert.equal(evidence.body.agentIndependentE2E, false); assert.equal(evidence.body.externalSystemVerified, false);
    const composed = evidence.body.services.find(service => service.serviceId === f.serviceIds.xapi);
    assert.equal(composed.call.callId, f.callId); assert.equal(composed.call.applicationId, f.applicationId);
    assert.equal(composed.call.applicationStatus, "REVOKED"); assert.deepEqual(composed.sourceRunIds, [f.sourceReleaseRunId]);
    assert.equal(evidence.body.services.some(service => service.serviceId === f.distractor.service.id), false);
    for (const hidden of ["tokenHash", "tokenPrefix", "sz_private_", '"rows"', '"parameters"']) assert.equal(JSON.stringify(evidence.body).includes(hidden), false);
  }
  const wrong = await f.call(f.evidencePath.replace(f.releaseId, f.distractor.release.id));
  assert.equal(wrong.body.status, "PENDING"); assert.deepEqual(wrong.body.services, []);
  assert.deepEqual(f.counts(), before); assert.equal(before.serviceCalls, 1); assert.equal(before.applications, 1);
});

test("another ADMIN cannot access manual consumption and the displayed publication window never permits service mutations", async t => {
  const f = await fixture(t), before = f.counts();
  for (const path of [f.sourcesPath, f.evidencePath, `/data-services/xapis/${f.serviceIds.xapi}`])
    assert.equal((await f.call(path, undefined, { identity: "other" })).status, 403);
  for (const path of ["/data-services/dapis", "/data-services/xapis", "/data-services/applications", `/data-services/applications/${f.applicationId}/revoke`]) {
    const response = await f.call(path, {});
    assert.equal(response.status, 403); assert.equal(response.body.code, "PUBLIC_PUBLICATION_SCOPE_DENIED");
  }
  assert.deepEqual(f.counts(), before);
});

test("metadata/controller restart preserves original source IDs, snapshot and the historical call without new synthetic jobs", async t => {
  const f = await fixture(t), before = f.counts();
  const version = f.store.get("data_service_version", f.services.holdings.publishedVersionId, PROJECT);
  const snapshot = f.businessStore.snapshot(version.snapshotId);
  await f.restart();
  const session = await f.call("/auth/session"), sources = await f.call(f.sourcesPath), evidence = await f.call(f.evidencePath);
  assert.equal(session.body.publicationSource.runId, f.sourceRun.id);
  assert.ok(sources.body.every(run => run.releaseId === f.releaseId && run.packageDigest === f.item.digest));
  assert.equal(evidence.body.status, "VERIFIED");
  assert.equal(evidence.body.services.find(service => service.serviceId === f.serviceIds.xapi).call.callId, f.callId);
  assert.deepEqual(f.businessStore.snapshot(version.snapshotId), snapshot);
  assert.deepEqual(f.counts(), before); assert.equal(before.jobCreates, 2); assert.equal(before.submitCalls, 2); assert.equal(before.modelCalls, 0);
  assert.equal(before.realModelCalls + before.realSparkRuns + before.realCloudCalls, 0);
  assert.deepEqual(f.store.get("agent", f.agent.id, PROJECT), f.originalAgent);
});
