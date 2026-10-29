import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getContext, contextIds, validationContractId, validationFamilyForContext, referenceSqlForContext } from "../../src/v2/context.mjs";
import { createDeliveryPackage, validateDeliveryPackage, computeManifestDigest, sha256 } from "../../src/v2/delivery.mjs";
import { createPythonDeliveryPackage, validatePythonDeliveryPackage, computePythonManifestDigest } from "../../src/v2/python-delivery.mjs";
import { createDurableAgentDelivery, developmentVerificationReport } from "../../src/v2/agent-development-workflow.mjs";
import { createCloudPublication } from "../../src/v2/cloud-publication.mjs";
import { verifiedPrivateServiceSource } from "../../src/v2/data-services.mjs";
import { privateAgentRecovery } from "../../src/v2/private-agent-recovery.mjs";
import { agentEvidenceJourney } from "../../src/v2/agent-journey.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LocalArtifactStore } from "../../src/v2/artifact-store.mjs";

// Synthetic receipts only: these tests never invoke a model, Spark or a cloud API.
const project = "synthetic-semantic-delivery";
const validation = contextId => {
  const family = validationFamilyForContext(contextId);
  return { passed: true, contractId: family.id, regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) };
};
function source(contextId = "stock-cash-t1", python = false) {
  const code = "def transform(data, params):\n    return []", sql = referenceSqlForContext(contextId);
  const revision = { id: "semantic-revision", projectId: project, contextId,
    ...(python ? { code, codeHash: sha256(code) } : { sql, hash: sha256(sql) }) };
  const run = { id: "semantic-run", projectId: project, contextId, revisionId: revision.id,
    revisionHash: python ? revision.codeHash : revision.hash, validationContractId: validationFamilyForContext(contextId).id,
    status: "SUCCEEDED", engine: python ? "CPython" : "Apache Spark", engineVersion: python ? "3.12.14" : "3.5.9",
    validation: validation(contextId), rows: getContext(contextId).expected,
    ...(python ? { resourceLimits: { cpu: true, addressSpace: false, fileSize: true } } : { isolation: "FUNCTION_PROCESS", mainSqlExecuted: true }) };
  return { revision, run };
}
function rehash(bundle, python = false) {
  for (const [name, text] of Object.entries(bundle.files)) bundle.manifest.files[name] = { sha256: sha256(text), bytes: Buffer.byteLength(text) };
  bundle.digest = (python ? computePythonManifestDigest : computeManifestDigest)(bundle.manifest);
  return bundle;
}
function fixture(t) {
  const store = new MetadataStore(":memory:"), root = mkdtempSync(join(tmpdir(), "semantic-delivery-"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const s = source(), revision = store.create("revision", project, { ...s.revision, id: undefined });
  const run = store.create("run", project, { ...s.run, id: undefined, revisionId: revision.id });
  const agent = store.create("agent", project, { contextId: revision.contextId, validationContractId: run.validationContractId,
    revisionId: revision.id, runId: run.id, executionMode: "DURABLE_SQL_AGENT_V1", mode: "LIVE_MODEL", status: "SUCCEEDED",
    submittedBy: "synthetic-owner", attempts: [{ status: "SUCCEEDED", model: "qwen3-coder-plus", usageEstimated: false, revisionId: revision.id, runId: run.id }] });
  const receipts = new Map(), submissions = [], runner = {
    prepare: (input, id) => ({ job: { jobId: id }, input }), submit: async p => submissions.push(p.job.jobId),
    read: async p => receipts.get(p.job.jobId), cancel: async () => {},
  };
  const options = { store, project, runner, artifactStore: new LocalArtifactStore(root), persist: async () => {} };
  const receipt = p => ({ status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    testSqlValidation: { passed: true, sqlHash: sha256(p.input.testSql) }, validation: run.validation, rows: run.rows });
  return { store, revision, run, agent, receipts, submissions, options, receipt };
}
const malformed = () => [
  validation("holdings-t1"),
  { ...validation("stock-cash-t1"), contractId: validationContractId },
  { ...validation("stock-cash-t1"), regressions: validation("stock-cash-t1").regressions.slice(0, 4) },
  { ...validation("stock-cash-t1"), regressions: [...validation("stock-cash-t1").regressions.slice(0, 4), { contextId: contextIds[4], passed: true }] },
  { ...validation("stock-cash-t1"), regressions: [...validation("stock-cash-t1").regressions.slice(0, 4), validation("stock-cash-t1").regressions[0]] },
  { ...validation("stock-cash-t1"), regressions: [...validation("stock-cash-t1").regressions, ...validation("holdings-t1").regressions] },
];

test("SQL and Python packages select exactly the source family's five independent fixtures", () => {
  for (const python of [false, true]) for (const id of ["holdings-t1", "stock-cash-t1"]) {
    const create = python ? createPythonDeliveryPackage : createDeliveryPackage;
    const check = python ? validatePythonDeliveryPackage : validateDeliveryPackage;
    const bundle = create(source(id, python)), plan = check(bundle, bundle.digest), family = validationFamilyForContext(id);
    assert.equal(plan.source.validationContractId, family.id);
    assert.deepEqual(plan.fixtures.validationContexts.map(c => c.id), family.contextIds);
    assert.equal(plan.fixtures.validationContexts.length, 5);
    assert.deepEqual(plan.fixtures.context.expected, getContext(id).expected);
    assert.equal(Object.hasOwn(bundle.manifest.source, "validationFamily"), false, "no extra legacy manifest fields");
    if (id === "holdings-t1") assert.equal(bundle.manifest.name, python ? "客户资产 T+1 · Python" : "客户资产 T+1");
    else {
      assert.match(bundle.manifest.name, /股票持仓.*非客户全资产/);
      assert.equal(plan.fixtures.context.expected[0].total_assets, "1300.00");
      if (!python) assert.match(bundle.files["tests.sql"], /1300\.00/);
    }
  }
});

test("legacy SQL and Python package fingerprints remain byte-compatible with the pre-family implementation", () => {
  // Golden digests independently obtained from the pre-family implementation,
  // with only createdAt fixed. No source/proof/fixture fields were added.
  for (const python of [false, true]) {
    const s = source("holdings-t1", python);
    s.revision.id = "legacy-revision"; s.revision.projectId = "synthetic-compatibility";
    s.run.id = "legacy-run"; s.run.projectId = s.revision.projectId; s.run.revisionId = s.revision.id;
    if (python) delete s.run.validation.contractId;
    const bundle = (python ? createPythonDeliveryPackage : createDeliveryPackage)(s);
    bundle.manifest.createdAt = "2026-01-01T00:00:00.000Z";
    const digest = (python ? computePythonManifestDigest : computeManifestDigest)(bundle.manifest);
    assert.equal(digest, python ? "b544a2cac2845357593064c3ad9cedad60de2e97ceca6ac6f8adeff7e5e353c2" : "c7f0aa3aa54f9a1694ff93bb44175ac28c4a76610b31589fc214bd7b160e99b6");
  }
});

test("SQL and Python reject wrong, missing, duplicate, mixed and oversized regression families", () => {
  for (const python of [false, true]) for (const report of malformed()) {
    const s = source("stock-cash-t1", python); s.run.validation = report;
    assert.throws(() => (python ? createPythonDeliveryPackage : createDeliveryPackage)(s));
  }
  const oldPython = source("holdings-t1", true); delete oldPython.run.validation.contractId;
  assert.doesNotThrow(() => createPythonDeliveryPackage(oldPython), "historical Python report omits contractId");
  const wrongSource = source(); wrongSource.run.contextId = "holdings-t1";
  assert.throws(() => createDeliveryPackage(wrongSource));
});

test("rehashing a crossed family, source run, fixture or validation proof cannot make a valid package", () => {
  for (const python of [false, true]) {
    const create = python ? createPythonDeliveryPackage : createDeliveryPackage, check = python ? validatePythonDeliveryPackage : validateDeliveryPackage;
    for (const mutate of [
      b => { b.manifest.source.validationContractId = validationContractId; },
      b => { b.manifest.source.contextId = "holdings-t1"; },
      b => { const f = JSON.parse(b.files["fixtures.json"]); f.validationContexts = contextIds.map(getContext); b.files["fixtures.json"] = JSON.stringify(f); },
      b => { const p = JSON.parse(b.files["validation.json"]); p.sourceRunId = "different-run"; b.files["validation.json"] = JSON.stringify(p); },
      b => { const p = JSON.parse(b.files["validation.json"]); p.report = validation("holdings-t1"); b.files["validation.json"] = JSON.stringify(p); },
    ]) {
      const bundle = create(source("stock-cash-t1", python)); mutate(bundle); rehash(bundle, python);
      assert.throws(() => check(bundle, bundle.digest));
    }
  }
});

test("development report compares stock results with independent stock answers and retains family metadata", () => {
  const s = source(), task = { id: "semantic-task", contextId: "stock-cash-t1" };
  const report = developmentVerificationReport(task, s.run, s.revision);
  assert.equal(report.status, "PASSED"); assert.equal(report.validationFamily.id, s.run.validationContractId);
  assert.match(report.summary, /不等于客户全资产/);
  assert.equal(developmentVerificationReport(task, { ...s.run, rows: getContext("holdings-t1").expected }, s.revision).status, "NEEDS_ATTENTION");
  assert.equal(developmentVerificationReport(task, s.run, { ...s.revision, contextId: "holdings-t1" }).status, "NEEDS_ATTENTION");
  assert.equal(developmentVerificationReport(task, { ...s.run, validationContractId }, s.revision).status, "NEEDS_ATTENTION");
  assert.equal(developmentVerificationReport({ ...task, validationContractId }, s.run, s.revision).status, "NEEDS_ATTENTION");
  for (const report of malformed()) assert.equal(developmentVerificationReport(task, { ...s.run, validation: report }, s.revision).status, "NEEDS_ATTENTION");
});

test("durable file rehearsal sends only the selected five fixtures and rejects cross-family receipts", async t => {
  for (const [index, report] of [validation("stock-cash-t1"), ...malformed()].entries()) {
    const f = fixture(t), engine = createDurableAgentDelivery(f.options), task = await engine.create(f.agent, "family-rehearsal");
    await engine.advance(task.id, task.version);
    const p = f.store.get("agent_delivery_task", task.id, project).remoteSubmission.prepared;
    assert.deepEqual(p.input.validationContexts.map(c => c.id), validationFamilyForContext("stock-cash-t1").contextIds);
    f.receipts.set(p.job.jobId, { ...f.receipt(p), validation: report });
    assert.equal((await engine.reconcile(task.id)).status, index === 0 ? "SUCCEEDED" : "FAILED");
    assert.equal(f.submissions.length, 1);
  }
});

test("publication and service eligibility bind immutable bundle family, not the global legacy family", async t => {
  const f = fixture(t), delivery = createDurableAgentDelivery(f.options), task = await delivery.create(f.agent, "publish-family");
  await delivery.advance(task.id, task.version);
  const p = f.store.get("agent_delivery_task", task.id, project).remoteSubmission.prepared;
  f.receipts.set(p.job.jobId, f.receipt(p)); await delivery.reconcile(task.id);
  const d = f.store.get("agent_delivery_task", task.id, project), bundle = f.store.get("delivery_package", d.packageId, project);
  const engine = createCloudPublication({ ...f.options, enabled: true, now: () => Date.parse("2026-10-12T01:00:00Z") });
  const input = { agent: f.agent, packageDigest: bundle.digest, verificationId: d.verificationId,
    attestations: { code: true, assertions: true, deliveryFiles: true, cloudScope: true }, actorId: "synthetic-owner", idempotencyKey: "family-publish" };
  for (const report of malformed()) {
    f.store.update("delivery_verification", d.verificationId, project, { validation: report });
    await assert.rejects(engine.publish(input));
    assert.equal(f.store.list("release", project).length, 0);
  }
  f.store.update("delivery_verification", d.verificationId, project, { validation: f.run.validation });
  const published = await engine.publish(input);
  const release = { ...published.release, status: "COMPLETED_CLOUD_TEST", health: "HEALTHY" };
  const approval = f.store.get("release_approval", release.approvalId, project);
  const run = { ...f.receipt(p), id: "synthetic-release-run", mode: "DURABLE_PRIVATE_RELEASE_V1", releaseId: release.id,
    packageId: bundle.id, packageDigest: bundle.digest, published: true, schedulerTriggered: true, clockMode: "FC_TIMER", publicDeployed: false };
  assert.equal(verifiedPrivateServiceSource({ run, release, approval, bundle }), run);
  for (const report of malformed()) assert.throws(() => verifiedPrivateServiceSource({ run: { ...run, validation: report }, release, approval, bundle }));
  const legacyBundle = { ...createDeliveryPackage(source("holdings-t1")), id: bundle.id };
  assert.throws(() => verifiedPrivateServiceSource({ run, release, approval, bundle: legacyBundle }));
  assert.equal(f.submissions.length, 1, "publication creates records only; no real Spark submission");
});

test("recovery and backend journey reject legacy evidence for a stock task", async t => {
  const f = fixture(t);
  f.store.create("agent_recovery_acceptance", project, { taskId: f.agent.id, requestId: "00000000-0000-0000-0000-000000000001", initialBootId: "synthetic-a" });
  const read = () => privateAgentRecovery({ operation: "PRIVATE_AGENT_RECOVERY_V1", action: "read", taskId: f.agent.id },
    { store: f.store, project, engine: {}, bootId: "synthetic-b" });
  assert.equal((await read()).verified, true);
  assert.equal(agentEvidenceJourney({ store: f.store, project, task: f.agent }).stages.find(s => s.id === "DEBUG").status, "SUCCEEDED");
  for (const report of malformed()) {
    f.store.update("run", f.run.id, project, { validation: report });
    assert.equal((await read()).verified, false);
    assert.notEqual(agentEvidenceJourney({ store: f.store, project, task: f.agent }).stages.find(s => s.id === "DEBUG").status, "SUCCEEDED");
  }
  f.store.update("run", f.run.id, project, { validation: f.run.validation, rows: getContext("holdings-t1").expected });
  assert.equal((await read()).independentResultMatches, false);
});

test("stock journey milestones require matching five-case rehearsal evidence, including missing-report rejection", t => {
  const f = fixture(t), bundle = createDeliveryPackage({ run: f.run, revision: f.revision });
  const item = f.store.create("delivery_package", project, { ...bundle, sourceRunId: f.run.id, agentDeliveryTaskId: "synthetic-delivery" });
  const check = f.store.create("delivery_verification", project, { packageId: item.id, packageDigest: item.digest,
    status: "SUCCEEDED", mode: "LOCAL_FILE_REHEARSAL", engine: "Apache Spark", mainSqlExecuted: true,
    testSqlValidation: { passed: true }, validation: f.run.validation });
  const milestone = () => agentEvidenceJourney({ store: f.store, project, task: f.agent }).stages.find(s => s.id === "DEPLOY_FILE");
  assert.equal(milestone().status, "SUCCEEDED");
  for (const report of [{ passed: true }, ...malformed()]) {
    f.store.update("delivery_verification", check.id, project, { validation: report });
    assert.notEqual(milestone().status, "SUCCEEDED");
  }
});
