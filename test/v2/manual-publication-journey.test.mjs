import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PROJECT } from "../../src/v2/server.mjs";
import { cloudPublicationMode } from "../../src/v2/cloud-publication.mjs";
import { createManualPublicationJourney } from "./fixtures/manual-publication-journey.mjs";

// Real loopback/auth/CSRF/SQLite with only synthetic signed queue receipts.
async function fixture(t) { const f = await createManualPublicationJourney(); t.after(() => f.dispose()); return f; }
const noNewComputation = f => { const c = f.counts(); assert.equal(c.modelCalls, 0); assert.equal(c.jobCreates, 0); assert.equal(c.submitCalls, 0); };
const counts = f => Object.fromEntries(["release", "release_run", "delivery_review", "release_approval"].map(kind => [kind, f.store.list(kind, PROJECT).length]));

test("manual workflow exposes review while PUBLICATION_ONLY allows DELIVERY but no development or another actor", async t => {
  const f = await fixture(t), original = f.store.get("agent", f.agent.id, PROJECT), budget = (await f.call("/budget")).body;
  const session = (await f.call("/auth/session")).body;
  assert.equal(session.authenticated, true); assert.equal(session.readOnly, false); assert.equal(session.publicationOnly, true);
  assert.deepEqual(session.permissions, ["SESSION", "DELIVERY"]); assert.equal(session.publicationPackageDigest, f.item.digest);
  const workflow = await f.call(`/runs/${f.sourceRun.id}/workflow`);
  assert.equal(workflow.status, 200); assert.equal(workflow.body.report.status, "PASSED");
  assert.equal(workflow.body.report.sourceKind, "MANUAL"); assert.equal(workflow.body.report.agentIndependentE2E, false);
  assert.equal(workflow.body.publication.available, true); assert.equal(workflow.body.publication.sourceRunId, f.sourceRun.id);
  assert.equal(workflow.body.package.digest, f.item.digest); assert.equal(workflow.body.verification.id, f.verification.id);
  for (const identity of [null, "other"]) assert.equal((await f.call(f.path, f.body, { identity })).status, 403);
  assert.equal((await f.call(f.path, f.body, { headers: { "x-csrf-token": "wrong" } })).status, 403);
  for (const path of ["/agent/tasks", "/revisions", "/runs", `/runs/${f.sourceRun.id}/prepare-delivery`, `/agent/deliveries/${f.delivery.id}/advance`])
    assert.equal((await f.call(path, {})).body.code, "PUBLIC_PUBLICATION_SCOPE_DENIED", path);
  for (const body of [{ ...f.body, packageDigest: "f".repeat(64) }, { ...f.body, verificationId: randomUUID() }])
    assert.equal((await f.call(f.path, body)).body.code, "PUBLIC_PUBLICATION_TARGET_MISMATCH");
  for (const body of [{ ...f.body, actorId: f.owner.id }, { ...f.body, attestations: { code: true } }, { ...f.body, sourceRunId: undefined }])
    assert.equal((await f.call(f.path, body)).status, 422);
  for (const suffix of [f.query + "&sourceKind=MANUAL", f.query + "&packageDigest=" + f.item.digest, f.query + "&actorId=" + f.owner.id])
    assert.equal((await f.call(f.path + suffix)).status, 422);
  assert.equal((await f.call(f.path + f.query, f.body)).status, 422, "POST cannot mix query and body selectors");
  assert.equal((await f.call(f.path + f.query, undefined, { identity: "other" })).status, 403);
  assert.deepEqual(counts(f), { release: 0, release_run: 0, delivery_review: 0, release_approval: 0 });
  assert.deepEqual(f.store.get("agent", f.agent.id, PROJECT), original);
  assert.deepEqual((await f.call("/budget")).body.model, budget.model); noNewComputation(f);
});

test("lost publication acknowledgement reuses exact approval, then two signed timer batches survive SQLite/controller restart", async t => {
  const f = await fixture(t), original = f.store.get("agent", f.agent.id, PROJECT), modelBudget = (await f.call("/budget")).body.model;
  f.loseNextPublicationAcknowledgement(); const unknown = await f.call(f.path, f.body);
  assert.equal(unknown.status, 500); assert.deepEqual(counts(f), { release: 1, release_run: 2, delivery_review: 1, release_approval: 1 });
  const saved = f.store.list("release", PROJECT)[0], ids = f.store.list("release_run", PROJECT).sort((a,b) => a.sequence-b.sequence).map(run => run.id);
  const originalRecords = counts(f); await f.restart();
  for (const key of ["synthetic-manual-reviewed-package", "synthetic-replay-other-key"]) {
    const recovered = await f.call(f.path, f.body, { key }); assert.equal(recovered.status, 202); assert.equal(recovered.body.release.id, saved.id);
  }
  assert.deepEqual(counts(f), originalRecords); noNewComputation(f);
  const defaultView = await f.call(f.path); assert.equal(defaultView.status, 200); assert.equal(defaultView.body.release, undefined); assert.deepEqual(defaultView.body.runs, []);
  const selected = await f.call(f.path + f.query); assert.equal(selected.status, 200); assert.equal(selected.body.release.id, saved.id);
  assert.equal(selected.body.release.sourceKind, "MANUAL"); assert.equal(selected.body.release.sourceAttribution, "ENGINEER_ASSISTED");
  assert.equal(selected.body.release.agentIndependentE2E, false); assert.equal(selected.body.release.submittedBy, undefined);
  assert.equal((await f.tick(saved.id, 1, { triggerName: "not-approved" })).status, 401);
  assert.equal((await f.tick(saved.id, 1)).status, 200);
  const first = f.store.get("release_run", ids[0], PROJECT); assert.equal(first.status, "RUNNING");
  await f.restart(); f.complete(first.remoteSubmission.prepared);
  assert.equal((await f.call(f.path + f.query)).body.runs.find(run => run.id === first.id).status, "SUCCEEDED");
  f.advance(); assert.equal((await f.tick(saved.id, 2)).status, 200);
  const second = f.store.get("release_run", ids[1], PROJECT); assert.equal(second.status, "RUNNING");
  await f.restart(); f.complete(second.remoteSubmission.prepared); f.advance();
  assert.equal((await f.tick(saved.id, 3)).status, 200); assert.equal((await f.tick(saved.id, 3)).status, 200);
  const finished = (await f.call(f.path + f.query)).body;
  assert.equal(finished.release.status, "COMPLETED_CLOUD_TEST"); assert.equal(finished.release.health, "HEALTHY");
  assert.deepEqual(finished.runs.map(run => run.id), ids); assert.ok(finished.runs.every(run => run.status === "SUCCEEDED" && run.schedulerTriggered && run.agentIndependentE2E === false));
  assert.equal(finished.events.length, 2); assert.equal(finished.alerts.length, 0);
  assert.deepEqual(counts(f), originalRecords); assert.equal(f.counts().modelCalls, 0); assert.equal(f.counts().jobCreates, 2); assert.equal(f.counts().submitCalls, 2);
  assert.deepEqual(f.store.get("agent", f.agent.id, PROJECT), original); assert.deepEqual((await f.call("/budget")).body.model, modelBudget);
});

test("precise cancellation needs no successful receipt read and cannot stop a different historical package", async t => {
  const f = await fixture(t), published = await f.call(f.path, f.body); assert.equal(published.status, 202);
  const current = published.body.release, original = f.store.get("agent", f.agent.id, PROJECT);
  // A separate saved historical record exists; it is never run or accepted as
  // evidence for this window, which permits only the current digest/rehearsal.
  const other = f.store.create("release", PROJECT, { mode: cloudPublicationMode, sourceKind: "MANUAL", sourceRunId: randomUUID(), sourceAgentTaskId: f.agent.id,
    submittedBy: f.owner.id, sourceAttribution: "ENGINEER_ASSISTED", agentIndependentE2E: false, packageDigest: "b".repeat(64), verificationId: randomUUID(), status: "WAITING_SCHEDULER" });
  const otherSelector = { sourceKind: "MANUAL", sourceRunId: other.sourceRunId, packageDigest: other.packageDigest, verificationId: other.verificationId, releaseId: other.id };
  assert.equal((await f.call(f.path + "/cancel", otherSelector)).body.code, "PUBLIC_PUBLICATION_TARGET_MISMATCH");
  assert.equal((await f.call(f.path + "/cancel", { ...f.selector, releaseId: other.id })).status, 404);
  assert.equal((await f.call(f.path + "/cancel", { ...f.selector, actorId: f.owner.id })).status, 422);
  assert.equal((await f.tick(current.id, 1)).status, 200);
  f.failReceiptReads(true); assert.equal((await f.call(f.path + f.query)).status, 500);
  const beforeReads = f.counts().resultReads;
  const stopped = await f.call(f.path + "/cancel", { ...f.selector, releaseId: current.id });
  assert.equal(stopped.status, 200); assert.equal(stopped.body.release.status, "CANCELLED"); assert.ok(stopped.body.runs.every(run => run.status === "CANCELLED"));
  assert.equal(f.counts().resultReads, beforeReads); assert.equal(f.counts().cancelCalls, 1);
  assert.deepEqual(f.store.get("release", other.id, PROJECT), other);
  await f.restart(); assert.equal((await f.call(f.path, f.body, { key: "after-stop-new-key" })).body.release.id, current.id);
  assert.equal((await f.tick(current.id, 2)).status, 409); assert.equal(f.counts().jobCreates, 1); assert.equal(f.counts().modelCalls, 0);
  assert.deepEqual(f.store.get("agent", f.agent.id, PROJECT), original);
});

test("expired manual publication window permits only original late evidence reads, not renewed approval or a new batch", async t => {
  const f = await fixture(t), published = await f.call(f.path, f.body), releaseId = published.body.release.id;
  assert.equal(published.status, 202); assert.equal((await f.tick(releaseId, 1)).status, 200);
  const run = f.store.list("release_run", PROJECT).find(item => item.status === "RUNNING");
  f.expire(); f.complete(run.remoteSubmission.prepared); await f.restart();
  assert.equal((await f.call("/auth/session")).body.readOnly, true);
  assert.equal((await f.call(f.path, f.body)).body.code, "PUBLIC_PUBLICATION_CLOSED");
  assert.equal((await f.call(f.path + "/cancel", f.selector)).body.code, "PUBLIC_PUBLICATION_CLOSED");
  const detail = await f.call(f.path + f.query); assert.equal(detail.status, 200); assert.equal(detail.body.runs.find(item => item.id === run.id).status, "SUCCEEDED");
  assert.equal((await f.tick(releaseId, 2)).body.code, "PUBLIC_PUBLICATION_CLOSED");
  assert.equal(f.counts().jobCreates, 1); assert.equal(f.counts().submitCalls, 1); assert.equal(f.counts().modelCalls, 0);
});
