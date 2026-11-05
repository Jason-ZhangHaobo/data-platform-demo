import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LocalArtifactStore } from "../../src/v2/artifact-store.mjs";
import { createDeliveryPackage, validateDeliveryPackage, sha256 } from "../../src/v2/delivery.mjs";
import { createPythonDeliveryPackage, validatePythonDeliveryPackage } from "../../src/v2/python-delivery.mjs";
import { publicRelease } from "../../src/v2/release-scheduler.mjs";
import { createCloudPublication, cloudPublicationMode } from "../../src/v2/cloud-publication.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { getContext, contextIds, referenceSql, validationContractId } from "../../src/v2/context.mjs";

// All records and malformed comparison contents are synthetic. No runner is used.
const marker = "SYNTHETIC_UNPROJECTED_COMPARISON";
function evidence() {
  const raw = { schema: "untrusted", mismatches: [{ actual: marker, arbitrary: true }] };
  return { passed: true, selectedPassed: true, contractId: validationContractId,
    assertions: ["legacy assertion"], issues: [], legacyMetadata: { retained: true }, comparison: raw,
    regressions: contextIds.map(contextId => ({ contextId, passed: true, rowCount: 3, issues: [], comparison: raw })) };
}
function source() {
  const revision = { id: randomUUID(), projectId: PROJECT, sql: referenceSql, hash: sha256(referenceSql), contextId: "holdings-t1" };
  const run = { id: randomUUID(), projectId: PROJECT, revisionId: revision.id, revisionHash: revision.hash, contextId: revision.contextId,
    validationContractId, status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    validation: evidence(), rows: getContext(revision.contextId).expected };
  return { revision, run };
}
function assertStripped(validation) {
  assert.equal(Object.hasOwn(validation, "comparison"), false);
  assert.ok(validation.regressions.every(row => !Object.hasOwn(row, "comparison")));
  assert.equal(validation.passed, true);
  assert.equal(validation.selectedPassed, true);
  assert.deepEqual(validation.assertions, ["legacy assertion"]);
  assert.deepEqual(validation.legacyMetadata, { retained: true });
  assert.deepEqual(validation.regressions.map(row => ({ contextId: row.contextId, passed: row.passed, rowCount: row.rowCount, issues: row.issues })),
    contextIds.map(contextId => ({ contextId, passed: true, rowCount: 3, issues: [] })));
  assert.doesNotMatch(JSON.stringify(validation), new RegExp(marker));
}

test("new SQL delivery removes raw comparison before freezing file hashes without mutating source or weakening gates", () => {
  const input = source(), before = structuredClone(input), bundle = createDeliveryPackage(input);
  assertStripped(JSON.parse(bundle.files["validation.json"]).report);
  assert.equal(bundle.manifest.files["validation.json"].sha256, sha256(bundle.files["validation.json"]));
  assert.doesNotThrow(() => validateDeliveryPackage(bundle, bundle.digest));
  assert.deepEqual(input, before);
  const fileBytes = bundle.files["validation.json"], frozenDigest = bundle.digest;
  input.run.validation.comparison.mismatches[0].actual = "changed-after-freeze";
  assert.equal(bundle.files["validation.json"], fileBytes);
  assert.equal(bundle.digest, frozenDigest);
  const failed = structuredClone(before); failed.run.validation.regressions[0].passed = false;
  assert.throws(() => createDeliveryPackage(failed), { status: 409 });
});

test("new Python delivery uses the same bounded omission before hashes and keeps its existing execution checks", () => {
  const code = "def transform(data, params):\n    return []", revision = { id: randomUUID(), projectId: PROJECT, contextId: "holdings-t1", code, codeHash: sha256(code) };
  const run = { id: randomUUID(), projectId: PROJECT, revisionId: revision.id, revisionHash: revision.codeHash, contextId: revision.contextId,
    validationContractId, status: "SUCCEEDED", engine: "CPython", engineVersion: "3.12.14", validation: evidence(), resourceLimits: { cpu: true, fileSize: true } };
  const before = structuredClone(run), bundle = createPythonDeliveryPackage({ run, revision });
  assertStripped(JSON.parse(bundle.files["validation.json"]).report);
  assert.equal(bundle.manifest.files["validation.json"].sha256, sha256(bundle.files["validation.json"]));
  assert.doesNotThrow(() => validatePythonDeliveryPackage(bundle, bundle.digest));
  assert.deepEqual(run, before);
  assert.throws(() => createPythonDeliveryPackage({ run: { ...run, resourceLimits: { cpu: false, fileSize: true } }, revision }), { status: 409 });
});

test("release projections strip comparisons but preserve verdicts, rows and the pre-existing log policy", () => {
  const input = { id: "synthetic-release-run", status: "FAILED", validation: evidence(), rows: [{ retained: "legacy row" }],
    artifactDirectory: "/synthetic/workspace/output", log: "/synthetic/workspace unchanged log", custom: "legacy" };
  const before = structuredClone(input), visible = publicRelease(input, "/synthetic/workspace");
  assertStripped(visible.validation);
  assert.equal(visible.status, "FAILED"); assert.equal(visible.custom, "legacy");
  assert.deepEqual(visible.rows, input.rows); assert.equal(visible.logExcerpt, "<workspace> unchanged log");
  assert.equal(visible.validationDetails, undefined); assert.deepEqual(input, before);
});

test("cloud publication terminal detail keeps original receipts and status while excluding raw comparison", async t => {
  const store = new MetadataStore(":memory:"); t.after(() => store.close());
  const agentId = randomUUID(), release = store.create("release", PROJECT, { mode: cloudPublicationMode, sourceAgentTaskId: agentId, status: "COMPLETED_CLOUD_TEST", health: "CRITICAL", validation: evidence() });
  const run = store.create("release_run", PROJECT, { releaseId: release.id, sequence: 1, status: "FAILED", validation: evidence(), rows: [{ original: true }], log: "retained in store" });
  let calls = 0;
  const forbidden = () => { calls++; throw Error("synthetic execution forbidden"); };
  const engine = createCloudPublication({ store, project: PROJECT, runner: { prepare: forbidden, submit: forbidden, read: forbidden, cancel: forbidden },
    artifactStore: { put: forbidden, verify: forbidden }, persist: forbidden });
  const detail = await engine.detail(agentId);
  assertStripped(detail.release.validation); assertStripped(detail.runs[0].validation);
  assert.equal(detail.release.health, "CRITICAL"); assert.equal(detail.runs[0].status, "FAILED");
  assert.equal(detail.runs[0].rows, undefined); assert.equal(detail.runs[0].log, undefined);
  assert.equal(detail.runs[0].validationDetails, undefined);
  assert.deepEqual(store.get("release", release.id, PROJECT), release);
  assert.deepEqual(store.get("release_run", run.id, PROJECT), run); assert.equal(calls, 0);
});

test("existing HTTP verification, bundle, workflow and release exports omit comparisons without new computation or record changes", async t => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-validation-exports-")), store = new MetadataStore(":memory:"), artifactStore = new LocalArtifactStore(join(root, "artifacts"));
  let calls = 0;
  const forbidden = async () => { calls++; throw Error("synthetic computation forbidden"); };
  const app = createV2Server({ root, store, artifactStore, runner: forbidden, deliveryRunner: forbidden, pythonRunner: forbidden,
    env: { V2_LOCAL_DEVELOPMENT: "true" } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-shuduo-client": "workbench", "idempotency-key": "synthetic-export-replay" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const fixture = source(), revision = store.create("revision", PROJECT, fixture.revision),
    run = store.create("run", PROJECT, { ...fixture.run, revisionId: revision.id });
  const bundle = createDeliveryPackage({ run, revision }), artifact = await artifactStore.put("delivery-package", bundle.digest, bundle),
    item = store.create("delivery_package", PROJECT, { ...bundle, artifact, sourceRunId: run.id }),
    verification = store.create("delivery_verification", PROJECT, { packageId: item.id, packageDigest: item.digest, status: "SUCCEEDED", validation: evidence(), custom: "legacy verification" });
  const task = store.create("agent", PROJECT, { status: "SUCCEEDED", contextId: revision.contextId, validationContractId, executionMode: "DURABLE_SQL_AGENT_V1",
    language: "SPARK_SQL", mode: "LIVE_MODEL", attempts: [{ status: "SUCCEEDED", revisionId: revision.id, runId: run.id }] });
  store.create("agent_delivery_task", PROJECT, { sourceAgentTaskId: task.id, sourceRevisionId: revision.id, sourceRunId: run.id, packageId: item.id, verificationId: verification.id, status: "SUCCEEDED" });
  const release = store.create("release", PROJECT, { status: "COMPLETED_CLOUD_TEST", validation: evidence() }),
    releaseRun = store.create("release_run", PROJECT, { releaseId: release.id, status: "SUCCEEDED", validation: evidence() });
  const code = "def transform(data, params):\n    return []", pythonRevision = store.create("python_revision", PROJECT, { code, codeHash: sha256(code), contextId: revision.contextId }),
    pythonRun = store.create("python_run", PROJECT, { revisionId: pythonRevision.id, status: "SUCCEEDED", validation: evidence() });
  const scheduledFor = "2026-09-11T09:00:00+08:00";
  store.deduplicate(PROJECT + ":delivery-verify:synthetic-export-replay", sha256(JSON.stringify({ packageId: item.id, digest: item.digest, scheduledFor })), () => verification);
  store.deduplicate(PROJECT + ":python-run:synthetic-export-replay", sha256(JSON.stringify({ revisionId: pythonRevision.id, codeHash: pythonRevision.codeHash, contextId: pythonRevision.contextId })), () => pythonRun);
  const kinds = ["revision", "run", "delivery_package", "delivery_verification", "agent", "agent_delivery_task", "release", "release_run", "python_revision", "python_run"],
    snapshot = () => Object.fromEntries(kinds.map(kind => [kind, store.list(kind, PROJECT)])), before = snapshot();
  for (const path of ["/delivery/verifications", "/release/runs", "/releases", "/python/runs"]) {
    const response = await call(path); assert.equal(response.status, 200, path); assertStripped(response.body[0].validation);
  }
  for (const path of [`/delivery/verifications/${verification.id}`, `/release/runs/${releaseRun.id}`, `/releases/${release.id}`, `/python/runs/${pythonRun.id}`]) {
    const response = await call(path); assert.equal(response.status, 200, path); assertStripped(response.body.validation); assert.equal(response.body.validationDetails, undefined);
  }
  const workflow = await call(`/agent/tasks/${task.id}/workflow`);
  assert.equal(workflow.status, 200); assertStripped(workflow.body.verification.validation); assert.equal(workflow.body.verification.validationDetails, undefined);
  const exported = await call(`/runs/${run.id}/bundle`);
  assert.equal(exported.status, 200); assertStripped(exported.body.validation); assertStripped(JSON.parse(exported.body.files["validation.json"]));
  assert.deepEqual(exported.body.rows, run.rows);
  for (const [path, body, status] of [[`/delivery/verifications/${verification.id}/cancel`, {}, 200],
    [`/delivery/packages/${item.id}/verify`, { scheduledFor }, 202], [`/python/runs/${pythonRun.id}/cancel`, {}, 200],
    ["/python/runs", { revisionId: pythonRevision.id }, 200]]) {
    const response = await call(path, body); assert.equal(response.status, status, path); assertStripped(response.body.validation);
  }
  assert.equal(calls, 0); assert.deepEqual(snapshot(), before);
  assert.equal(store.get("run", run.id, PROJECT).validation.comparison.mismatches[0].actual, marker);
  assert.equal(store.get("delivery_package", item.id, PROJECT).files["validation.json"], bundle.files["validation.json"]);
});

test("manual handoff workflow strips its rehearsal comparison without altering failed Agent history or enabling publication", async t => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-manual-validation-export-")), store = new MetadataStore(":memory:");
  let calls = 0;
  const forbidden = async () => { calls++; throw Error("synthetic computation forbidden"); };
  const app = createV2Server({ root, store, runner: forbidden, env: { V2_LOCAL_DEVELOPMENT: "false", V2_ALLOW_INSECURE_PUBLIC_COOKIES: "true" } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const password = "SyntheticExports!2026", actor = app.auth.bootstrapAdmin({ email: "manual-export@example.invalid", password, displayName: "合成工程师" });
  const agent = store.create("agent", PROJECT, { submittedBy: actor.id, executionMode: "DURABLE_SQL_AGENT_V1", language: "SPARK_SQL", mode: "LIVE_MODEL",
    contextId: "holdings-t1", status: "FAILED", usedTokens: 9000, attempts: [{ attempt: 1, status: "VALIDATION_FAILED" }] });
  const fixture = source(), revision = store.create("revision", PROJECT, { ...fixture.revision, source: "MANUAL", author: actor.id,
    manualProvenance: { kind: "ENGINEER_EDIT", originAgentTaskId: agent.id, actorId: actor.id, agentIndependentE2E: false } }),
    run = store.create("run", PROJECT, { ...fixture.run, revisionId: revision.id }),
    verification = store.create("delivery_verification", PROJECT, { status: "FAILED", validation: evidence(), error: "original rehearsal failure" });
  store.create("agent_delivery_task", PROJECT, { sourceKind: "MANUAL", sourceAgentTaskId: agent.id, sourceRevisionId: revision.id,
    sourceRunId: run.id, submittedBy: actor.id, verificationId: verification.id, status: "FAILED" });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`, login = await fetch(base + "/auth/login", { method: "POST",
    headers: { "content-type": "application/json", "x-shuduo-client": "workbench" }, body: JSON.stringify({ email: actor.email, password }) });
  assert.equal(login.status, 200); const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); await login.json();
  const path = base + `/runs/${run.id}/workflow`, result = await fetch(path, { headers: { cookie } });
  assert.equal(result.status, 200); const body = await result.json();
  assertStripped(body.verification.validation); assert.equal(body.verification.status, "FAILED");
  assert.equal(body.verification.error, "original rehearsal failure"); assert.equal(body.verification.validationDetails, undefined);
  assert.equal(body.publication.available, false); assert.equal(body.report.sourceKind, "MANUAL"); assert.equal(body.report.agentIndependentE2E, false);
  assert.equal((await fetch(path)).status, 401);
  assert.equal(calls, 0); assert.deepEqual(store.get("agent", agent.id, PROJECT), agent);
  assert.deepEqual(store.get("run", run.id, PROJECT), run); assert.deepEqual(store.get("delivery_verification", verification.id, PROJECT), verification);
});
