import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BusinessQueryStore, serviceHash, verifiedPrivateServiceSource } from "../../src/v2/data-services.mjs";
import { createPrivateDataServices } from "../../src/v2/private-data-services.mjs";
import { privateServiceRoute } from "../../src/v2/private-service-routes.mjs";
import { createDeliveryPackage, sha256 } from "../../src/v2/delivery.mjs";
import { saveManualRevision } from "../../src/v2/manual-revisions.mjs";
import { getContext, referenceSqlForContext, validationFamilyForContext } from "../../src/v2/context.mjs";

// Real in-memory SQLite snapshots and query manager. Source Spark receipts,
// identities and requests are synthetic; no cloud, model or Spark is invoked.
const project = "synthetic-manual-service";
function fixture(t) {
  const store = new MetadataStore(":memory:"), businessStore = new BusinessQueryStore(":memory:");
  t.after(() => { businessStore.close(); store.close(); });
  const owner = store.create("auth_user", project, { status: "ACTIVE" }), other = store.create("auth_user", project, { status: "ACTIVE" });
  const agent = store.create("agent", project, { submittedBy: owner.id, status: "FAILED", contextId: "stock-cash-t1",
    executionMode: "DURABLE_SQL_AGENT_V1", attempts: [{ status: "VALIDATION_FAILED", revisionId: randomUUID(), runId: randomUUID() }] });
  let serial = 0, flushes = 0, mutationChecks = 0;
  const source = (manual = true) => {
    const n = ++serial, contextId = manual ? agent.contextId : "holdings-t1", family = validationFamilyForContext(contextId);
    const sql = referenceSqlForContext(contextId) + `\n-- synthetic stored version ${n}`;
    const revision = manual ? saveManualRevision({ store, project, actor: owner.id, key: `manual-source-${n}`, sql, contextId, originAgentTaskId: agent.id }).revision
      : store.create("revision", project, { sql, hash: sha256(sql), contextId });
    const validation = { passed: true, contractId: family.id, regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) };
    const sourceRun = store.create("run", project, { revisionId: revision.id, revisionHash: revision.hash, contextId, validationContractId: family.id,
      status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, isolation: "FUNCTION_PROCESS", validation, rows: getContext(contextId).expected });
    const bundle = store.create("delivery_package", project, { ...createDeliveryPackage({ run: sourceRun, revision }), sourceRunId: sourceRun.id,
      ...(manual ? { sourceKind: "MANUAL", agentIndependentE2E: false } : {}) });
    const attributed = manual ? { sourceKind: "MANUAL", sourceAttribution: "ENGINEER_ASSISTED", agentIndependentE2E: false,
      sourceRunId: sourceRun.id, submittedBy: owner.id } : {};
    const approval = store.create("release_approval", project, { ...attributed, status: "APPROVED", packageId: bundle.id, packageDigest: bundle.digest,
      sourceRevisionId: revision.id, sourceCodeHash: revision.hash });
    const release = store.create("release", project, { ...attributed, mode: "DURABLE_PRIVATE_RELEASE_V1", scope: "PRIVATE_CLOUD_TEST",
      sourceAgentTaskId: agent.id, sourceRevisionId: revision.id, sourceCodeHash: revision.hash, status: "COMPLETED_CLOUD_TEST", health: "HEALTHY",
      packageId: bundle.id, packageDigest: bundle.digest, approvalId: approval.id, publicDeployed: false });
    const run = store.create("release_run", project, { ...attributed, sourceAgentTaskId: agent.id, releaseId: release.id, mode: release.mode, scope: release.scope,
      status: "SUCCEEDED", published: true, publicDeployed: false, schedulerTriggered: true, clockMode: "FC_TIMER", engine: "Apache Spark", engineVersion: "3.5.9",
      mainSqlExecuted: true, packageId: bundle.id, packageDigest: bundle.digest, rows: sourceRun.rows,
      testSqlValidation: { passed: true, sqlHash: sha256(bundle.files["tests.sql"]) }, validation, sequence: 1,
      createdAt: new Date(Date.UTC(2026, 10, 5, n)).toISOString() });
    return { revision, sourceRun, bundle, approval, release, run };
  };
  const first = source(), second = source(), old = source(false);
  const originalAgent = structuredClone(store.get("agent", agent.id, project));
  const api = createPrivateDataServices({ store, businessStore, project, persist: async () => { flushes++; },
    auth: { sessionFromHeaders: headers => headers["x-test-actor"] ? { role: "ADMIN", user: { id: headers["x-test-actor"] } } : undefined,
      requireMutation: () => { mutationChecks++; } } });
  const call = async (path, body, actorId = owner.id, extraHeaders = {}) => {
    try { return await api.handle({ method: body === undefined ? "GET" : "POST", headers: { "x-test-actor": actorId, "idempotency-key": `${++serial}-synthetic`, ...extraHeaders } },
      new URL(`/api/v2${path}`, "http://127.0.0.1"), async () => body); }
    catch (error) { return { status: error.status ?? 500, body: { code: error.code, message: error.message } }; }
  };
  const selection = value => new URLSearchParams({ agent_task_id: agent.id, package_digest: value.bundle.digest, release_id: value.release.id }).toString();
  const createDapi = async (value, label, fields) => {
    const made = await call("/data-services/dapis", { name: `合成人工${label}`, slug: `synthetic-${label}`, sourceReleaseRunId: value.run.id, fields });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call(`/data-services/dapis/${made.body.id}/test`, {})).status, 200);
    const pub = await call(`/data-services/dapis/${made.body.id}/publish`, { configHash: made.body.currentVersion.configHash });
    assert.equal(pub.status, 200); return pub.body.service;
  };
  const composed = async (value = first) => {
    const holdings = await createDapi(value, `holdings-${serial}`, ["client_id", "holding_market_value", "security_count"]);
    const cash = await createDapi(value, `cash-${serial}`, ["client_id", "available_cash", "total_assets"]);
    const made = await call("/data-services/xapis", { name: "合成人工组合", slug: `synthetic-overview-${serial}`,
      steps: [{ alias: "holdings", dapiId: holdings.id, dapiVersionId: holdings.publishedVersionId }, { alias: "cash", dapiId: cash.id, dapiVersionId: cash.publishedVersionId }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call(`/data-services/xapis/${made.body.id}/test`, {})).status, 200);
    const published = await call(`/data-services/xapis/${made.body.id}/publish`, { configHash: made.body.currentVersion.configHash });
    assert.equal(published.status, 200); return { holdings, cash, xapi: published.body.service };
  };
  return { store, businessStore, owner, other, agent, originalAgent, first, second, old, source, api, call, selection, createDapi, composed,
    counts: () => ({ flushes, mutationChecks, apps: store.list("service_app", project).length, calls: store.list("service_call", project).length }) };
}

test("source selectors are strict, complete and cannot downgrade into task-wide discovery", () => {
  const task = randomUUID(), release = randomUUID(), digest = "a".repeat(64);
  const source = "/api/v2/data-services/sources", evidence = "/api/v2/data-services/task-evidence";
  for (const query of ["", `?agent_task_id=${task}`, `?agent_task_id=${task}&package_digest=${digest}&release_id=${release}`])
    assert.equal(privateServiceRoute("GET", source + query), true);
  for (const suffix of ["", `&release_id=${release}`]) assert.equal(privateServiceRoute("GET", evidence + `?agent_task_id=${task}&package_digest=${digest}` + suffix), true);
  for (const query of [`?package_digest=${digest}`, `?release_id=${release}`, `?agent_task_id=${task}&package_digest=${digest}`,
    `?agent_task_id=${task}&release_id=${release}`, `?agent_task_id=${task}&package_digest=${digest}&release_id=invalid`,
    `?agent_task_id=${task}&package_digest=${digest}&release_id=${release}&release_id=${release}`, `?agent_task_id=${task}&unknown=true`])
    assert.equal(privateServiceRoute("GET", source + query), false, query);
  for (const query of [`?agent_task_id=${task}&package_digest=${digest}&extra=1`, `?agent_task_id=${task}&package_digest=${digest}&package_digest=${digest}`, `?agent_task_id=${task}&package_digest=${digest}&release_id=`])
    assert.equal(privateServiceRoute("GET", evidence + query), false, query);
});

test("exact discovery returns only the selected manual release, never a newer old Agent package", async t => {
  const f = fixture(t), before = f.counts();
  const result = await f.call(`/data-services/sources?${f.selection(f.first)}`);
  assert.equal(result.status, 200); assert.deepEqual(result.body.map(run => run.id), [f.first.run.id]);
  assert.equal(result.body[0].sourceKind, "MANUAL"); assert.equal(result.body[0].sourceAttribution, "ENGINEER_ASSISTED");
  assert.equal(result.body[0].agentIndependentE2E, false); assert.equal(Object.hasOwn(result.body[0], "rows"), false);
  assert.equal((await f.call(`/data-services/sources?agent_task_id=${f.agent.id}`)).body.length, 3);
  for (const query of [f.selection(f.first).replace(f.first.release.id, randomUUID()), f.selection(f.first).replace(f.first.bundle.digest, f.second.bundle.digest)])
    assert.deepEqual((await f.call(`/data-services/sources?${query}`)).body, []);
  assert.deepEqual(f.counts(), before); assert.deepEqual(f.store.get("agent", f.agent.id, project), f.originalAgent);
});

test("another ADMIN cannot discover or create from manual sources; legacy Agent ADMIN access remains", async t => {
  const f = fixture(t);
  const list = await f.call("/data-services/sources", undefined, f.other.id);
  assert.deepEqual(list.body.map(run => run.id), [f.old.run.id]); assert.equal(list.body[0].sourceKind, "AGENT");
  assert.equal((await f.call(`/data-services/sources?${f.selection(f.first)}`, undefined, f.other.id)).status, 403);
  assert.equal((await f.call(`/data-services/task-evidence?${f.selection(f.first)}`, undefined, f.other.id)).status, 403);
  const input = { name: "跨管理员错误来源", slug: "wrong-manual-owner", sourceReleaseRunId: f.first.run.id, fields: ["client_id", "total_assets"] };
  assert.equal((await f.call("/data-services/dapis", input, f.other.id)).status, 403);
  assert.equal((await f.call("/data-services/dapis", { ...input, sourceReleaseRunId: f.old.run.id }, f.other.id)).status, 201);
});

test("manual source attribution must agree across manifest, approval, release and batch", t => {
  const f = fixture(t), original = f.first;
  assert.equal(verifiedPrivateServiceSource(original).id, original.run.id);
  for (const [kind, key, value] of [
    ["bundle", "sourceKind", "AGENT"], ["bundle", "sourceRunId", randomUUID()], ["bundle", "agentIndependentE2E", true],
    ...["release", "run", "approval"].flatMap(kind => [[kind, "sourceKind", "AGENT"], [kind, "sourceRunId", randomUUID()],
      [kind, "sourceAttribution", "MODEL"], [kind, "agentIndependentE2E", true], [kind, "submittedBy", f.other.id]]),
    ...["release", "approval"].flatMap(kind => [[kind, "sourceRevisionId", randomUUID()], [kind, "sourceCodeHash", "f".repeat(64)]]),
    ["run", "sourceRevisionId", randomUUID()], ["run", "sourceCodeHash", "f".repeat(64)], ["run", "sourceAgentTaskId", randomUUID()],
    ["release", "sourceAgentTaskId", randomUUID()],
  ]) {
    const changed = structuredClone(original); changed[kind][key] = value;
    assert.throws(() => verifiedPrivateServiceSource(changed), { code: "INVALID_RELEASE_PROVENANCE" }, `${kind}.${key}`);
  }
  assert.doesNotThrow(() => verifiedPrivateServiceSource(f.old));
});

test("manual DAPI/XAPI query and evidence use the pinned release without changing failed Agent history", async t => {
  const f = fixture(t), { holdings, cash, xapi } = await f.composed();
  const path = `/data-services/task-evidence?${f.selection(f.first)}`, beforeRead = f.counts();
  const pending = await f.call(path); assert.equal(pending.body.status, "PENDING");
  assert.equal(pending.body.releaseId, f.first.release.id); assert.equal(pending.body.sourceKind, "MANUAL");
  assert.equal(pending.body.sourceAttribution, "ENGINEER_ASSISTED"); assert.deepEqual(f.counts(), beforeRead);
  const issued = await f.call("/data-services/applications", { name: "合成一次消费", serviceIds: [holdings.id, xapi.id] });
  assert.equal(issued.status, 201);
  const auth = { authorization: `Bearer ${issued.body.token}` };
  const actual = await f.call(`/open/xapis/${xapi.slug}?client_id=CLIENT-001`, undefined, undefined, auth);
  assert.equal(actual.status, 200); assert.deepEqual(actual.body.data, [{ client_id: "CLIENT-001",
    holdings: { holding_market_value: "1000.00", security_count: 1 }, cash: { available_cash: "300.00", total_assets: "1300.00" } }]);
  assert.deepEqual(actual.body.service.steps, [{ alias: "holdings", dapiId: holdings.id, dapiVersionId: holdings.publishedVersionId }, { alias: "cash", dapiId: cash.id, dapiVersionId: cash.publishedVersionId }]);
  assert.equal((await f.call(`/open/dapis/${cash.slug}`, undefined, undefined, auth)).status, 403);
  const before = f.counts(), proof = await f.call(path);
  assert.equal(proof.body.status, "VERIFIED"); assert.equal(proof.body.agentIndependentE2E, false);
  assert.deepEqual(proof.body.services.find(s => s.serviceId === xapi.id).sourceRunIds, [f.first.run.id]);
  assert.equal((await f.call(path.replace(`&release_id=${f.first.release.id}`, ""))).body.status, "VERIFIED", "old task+digest query remains supported");
  for (const query of [f.selection(f.second), f.selection(f.first).replace(f.first.release.id, f.second.release.id), f.selection(f.first).replace(f.first.release.id, randomUUID())]) {
    const other = await f.call(`/data-services/task-evidence?${query}`);
    assert.equal(other.body.status, "PENDING"); assert.equal(other.body.services.length, 0);
  }
  assert.deepEqual(f.counts(), before, "read-only evidence never issues credentials, invokes queries or persists calls");
  for (const field of [issued.body.token, "tokenHash", "tokenPrefix", "CLIENT-001", '"rows"', '"parameters"']) assert.equal(JSON.stringify(proof.body).includes(field), false);
  assert.deepEqual(f.store.get("agent", f.agent.id, project), f.originalAgent);
  assert.equal((await f.call(`/data-services/xapis/${xapi.id}`, undefined, f.other.id)).status, 403);
  assert.equal((await f.call("/data-services/applications", { name: "错误管理员授权", serviceIds: [xapi.id] }, f.other.id)).status, 403);
  assert.deepEqual((await f.call("/data-services/applications", undefined, f.other.id)).body, []);
  assert.deepEqual((await f.call("/data-services/calls", undefined, f.other.id)).body, []);
});

test("cross-package or cross-batch children cannot compose or borrow another release's evidence", async t => {
  const f = fixture(t), { holdings, cash, xapi } = await f.composed();
  const wrong = await f.createDapi(f.second, "different-package", ["client_id", "available_cash", "total_assets"]);
  const create = await f.call("/data-services/xapis", { name: "不允许混合发布", slug: "mixed-release-source", steps: [
    { alias: "holdings", dapiId: holdings.id }, { alias: "cash", dapiId: wrong.id }] });
  assert.equal(create.status, 409); assert.equal(create.body.code, "MIXED_SOURCE_VERSIONS");
  const version = f.store.get("data_service_version", xapi.publishedVersionId, project), steps = [
    version.steps[0], { ...version.steps[1], dapiId: wrong.id, dapiVersionId: wrong.publishedVersionId }];
  const config = Object.fromEntries(["serviceType", "scope", "joinKey", "timeoutMs", "rateLimitPerMinute", "parameterSchema"].map(key => [key, version[key]]));
  f.store.update("data_service_version", version.id, project, { steps, configHash: serviceHash({ ...config, steps }) });
  const proof = await f.call(`/data-services/task-evidence?${f.selection(f.first)}`);
  assert.equal(proof.body.status, "PENDING");
  assert.equal(proof.body.services.find(s => s.serviceId === xapi.id).code, "MIXED_SOURCE_VERSIONS");
  // A second scheduled batch of the same package is still a different snapshot.
  const next = f.store.create("release_run", project, { ...f.first.run, id: undefined });
  const samePackageOtherBatch = await f.createDapi({ ...f.first, run: next }, "different-batch", ["client_id", "available_cash"]);
  const mixedBatch = await f.call("/data-services/xapis", { name: "不允许混合批次", slug: "mixed-batch-source", steps: [
    { alias: "holdings", dapiId: holdings.id }, { alias: "cash", dapiId: samePackageOtherBatch.id }] });
  assert.equal(mixedBatch.status, 409); assert.equal(mixedBatch.body.code, "MIXED_SOURCE_VERSIONS");
  assert.equal(f.counts().calls, 0); assert.equal(f.counts().apps, 0);
});
