import test from "node:test";
import assert from "node:assert/strict";
import { bindExternalConsumption } from "../../src/v2/external-consumption-binding.mjs";
import { consumerCanonical, consumerDigest, consumerV2PlanEvidence } from "../../src/v2/consumer-source.mjs";

// Synthetic in-memory report documents only. MATCHED means consistent documents,
// never actual network/model/Spark execution or verified external environment.
const hash = value => consumerDigest(consumerCanonical(value));
function fixture({ scope = "PRIVATE_CLOUD_TEST", sourceKind = "AGENT", twoGranted = false, standalone=false } = {}) {
  const source = { schema: "shuduo-service-consumer-source/v1", scope, sourceKind, taskId: "synthetic-task", revisionId: "synthetic-revision",
    revisionHash: consumerDigest("synthetic SQL"), developmentRunId: "synthetic-development", contextId: "holdings-t1",
    validationContractId: "securities-assets-five-fixtures-2026-09-14", packageDigest: consumerDigest("synthetic package"),
    releaseId: "synthetic-release", sourceReleaseRunId: "synthetic-published-batch" };
  if(standalone){delete source.taskId;Object.assign(source,{schema:'shuduo-service-consumer-source/v2',manualDeliveryTaskId:'synthetic-manual-delivery',sourceAttribution:'ENGINEER_AUTHORED',agentIndependentE2E:false});}
  const plan = { protocol: "SERVICE_CONSUMER_V2", authorized: true, source,
    origin: scope === "LOCAL_TEST_ONLY" ? "http://127.0.0.1:34567" : "https://consumer.example.invalid",
    approvedOrigin: scope === "LOCAL_TEST_ONLY" ? "http://127.0.0.1:34567" : "https://consumer.example.invalid",
    testOnly: scope === "LOCAL_TEST_ONLY", startedAt: "2026-11-05T00:00:00.000Z", deadline: "2026-11-05T02:00:00.000Z",
    timeoutMs: 5000, maxRequests: twoGranted ? 20 : 17, reportFile: "/private/synthetic-report.json",
    expectedRows: [
      { client_id: "CLIENT-001", holding_market_value: "1500.00", available_cash: "300.00", total_assets: "1800.00", security_count: 2 },
      { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 },
    ],
    dapis: [
      { id: "holdings-service", slug: "holdings", versionId: "holdings-version", configHash: consumerDigest("holdings config"), alias: "holdings", fields: ["client_id", "holding_market_value", "security_count"], granted: true },
      { id: "cash-service", slug: "cash", versionId: "cash-version", configHash: consumerDigest("cash config"), alias: "cash", fields: ["client_id", "available_cash", "total_assets"], granted: twoGranted },
    ],
    xapi: { id: "overview-service", slug: "overview", versionId: "overview-version", configHash: consumerDigest("overview config") },
    ungranted: twoGranted ? { type: "DAPI", slug: "ungranted", id: "ungranted-service", versionId: "ungranted-version", configHash: consumerDigest("ungranted config") } : { type: "DAPI", slug: "cash" },
    rateLimit: { serviceId: "overview-service", perMinute: 8 } };
  const metadata = consumerV2PlanEvidence(plan), targets = [...plan.dapis.filter(d => d.granted).map(d => ({ ...d, type: "DAPI" })), { ...plan.xapi, type: "XAPI" }];
  const report = { ...metadata, protocol: plan.protocol, planDigest: hash(plan), credentialDigest: consumerDigest("synthetic token digest input"),
    maxRequests: plan.maxRequests, startedAt: plan.startedAt, deadline: plan.deadline,
    evidence: plan.testOnly ? "LOCAL_HTTP_FIXTURE" : "HTTP_CONSUMER_ONLY", requestCount: 0, phases: { consume: "PASSED", revoked: "PASSED" }, requests: [] };
  const append = (service, check, query, status, phase = "consume") => {
    const sequence = report.requests.length + 1, callId = `synthetic-call-${sequence}`;
    const entry = { sequence, phase, check, serviceId: service.id, type: service.type, versionId: service.versionId, configHash: service.configHash,
      expectedStatus: status, queryDigest: hash(query), result: "PASSED", statusCode: status,
      startedAt: new Date(Date.parse(plan.startedAt) + sequence * 1000).toISOString(), finishedAt: new Date(Date.parse(plan.startedAt) + sequence * 1000 + 100).toISOString() };
    if (status === 200) {
      const all = plan.expectedRows.filter(row => !query.client_id || row.client_id === query.client_id), wanted = all.slice(query.page - 1, query.page);
      const data = wanted.map(row => service.type === "DAPI" ? Object.fromEntries(service.fields.map(field => [field, row[field]])) :
        { client_id: row.client_id, holdings: { holding_market_value: row.holding_market_value, security_count: row.security_count }, cash: { available_cash: row.available_cash, total_assets: row.total_assets } });
      Object.assign(entry, { rowsDigest: hash(data), responseDigest: hash({ data, pagination: { page: query.page, pageSize: 1, total: all.length, totalPages: Math.max(1, all.length) } }),
        rowCount: data.length, callIdDigest: consumerDigest(callId), versionBindingsVerified: true, childBindingsVerified: service.type === "XAPI" });
      if (service.type === "XAPI") entry.childBindingsDigest = hash(plan.dapis.map(d => ({ alias: d.alias, dapiId: d.id, dapiVersionId: d.versionId })));
    }
    report.requests.push(entry); return { entry, callId };
  };
  const query = { page: 1, page_size: 1 };
  targets.forEach((service, index) => {
    append(service, `SERVICE_${index + 1}_PAGE_1`, query, 200);
    append(service, `SERVICE_${index + 1}_PAGE_2`, { ...query, page: 2 }, 200);
    append(service, `SERVICE_${index + 1}_FILTER`, { ...query, client_id: "CLIENT-001" }, 200);
  });
  append(targets[0], "MISSING_TOKEN", query, 401); append(targets[0], "INVALID_TOKEN", query, 401);
  append(metadata.ungrantedService, "UNGRANTED_SERVICE", query, 403); append(targets[0], "INVALID_PARAMETERS", { ...query, page: 0 }, 400);
  let matched;
  for (let used = 3; used <= 8; used++) {
    const row = append(targets.at(-1), used === 8 ? "RATE_LIMIT_REJECTED" : "RATE_LIMIT_ALLOWED", query, used === 8 ? 429 : 200);
    if (used !== 8) matched = row;
  }
  append(targets[0], "REVOKED_TOKEN", query, 401, "revoked");
  report.requestCount = report.requests.length; report.finishedAt = report.requests.at(-1).finishedAt;
  const manual = sourceKind === "MANUAL" ? { sourceAttribution: standalone?"ENGINEER_AUTHORED":"ENGINEER_ASSISTED" } : {};
  const taskEvidence = { protocol: standalone?"shuduo-private-manual-consumption/v1":plan.testOnly ? "shuduo-local-task-consumption/v1" : "shuduo-private-task-consumption/v1", ...(standalone?{manualDeliveryTaskId:source.manualDeliveryTaskId}:{taskId:source.taskId}),
    packageDigest: source.packageDigest, releaseId: source.releaseId, sourceKind, ...manual, scope, status: "VERIFIED", checkedAt: "2026-11-05T00:01:00.000Z",
    matchingCount: 1, truncated: false, externalSystemVerified: false, agentIndependentE2E: false, publicDeployed: false,
    services: [{ serviceId: plan.xapi.id, serviceType: "XAPI", name: "合成证券组合", versionId: plan.xapi.versionId, configHash: plan.xapi.configHash,
      status: "VERIFIED", source: structuredClone(source), sourceKind, ...manual, agentIndependentE2E: false, releaseId: source.releaseId,
      sourceRunIds: [source.sourceReleaseRunId], fullAssetComposition: true,
      sourceVersions: plan.dapis.map(d => ({ serviceId: d.id, versionId: d.versionId, configHash: d.configHash, fields: [...d.fields],
        releaseId: source.releaseId, sourceReleaseRunId: source.sourceReleaseRunId, packageDigest: source.packageDigest, sourceKind })),
      call: { callId: matched.callId, versionId: plan.xapi.versionId, configHash: plan.xapi.configHash, rowCount: matched.entry.rowCount,
        resultHash: matched.entry.rowsDigest, verified: true, applicationId: "synthetic-app", applicationStatus: "REVOKED", finishedAt: matched.entry.finishedAt } }] };
  return { expectedSource: structuredClone(source), plan, report, taskEvidence };
}
const notCandidate = value => { const result = bindExternalConsumption(value); assert.notEqual(result.status, "MATCHED"); assert.equal(result.eligibleForExternalAcceptance, false); return result; };

test("V2 exact XAPI call, pinned DAPIs and independent row digests bind without claiming environment truth", () => {
  const input = fixture(), before = structuredClone(input), result = bindExternalConsumption(input);
  assert.equal(result.status, "MATCHED"); assert.equal(result.eligibleForExternalAcceptance, true);
  assert.equal(result.verificationScope, "REPORT_AND_PLATFORM_RECEIPT_CONSISTENCY");
  assert.equal(result.externalSystemVerified, false); assert.equal(result.agentIndependentE2E, false); assert.equal(result.publicDeployed, false);
  assert.deepEqual(result.source, input.expectedSource); assert.equal(result.matchedRequestSequence, 15);
  assert.notEqual(input.report.requests[14].rowsDigest, input.report.requests[14].responseDigest);
  assert.deepEqual(input, before);
  const text = JSON.stringify(result);
  for (const value of ["CLIENT-001", "1500.00", input.plan.reportFile, input.report.credentialDigest, input.taskEvidence.services[0].call.callId]) assert.equal(text.includes(value), false);
});

test("two directly granted DAPIs may use an explicitly bound fourth ungranted service", () => {
  const input = fixture({ twoGranted: true }); assert.equal(input.report.requestCount, 20);
  assert.equal(bindExternalConsumption(input).status, "MATCHED");
});

test("plan/source/service snapshots and unknown report fields fail closed even if an attacker rehashes a plan", () => {
  for (const mutate of [
    x => { x.expectedSource.revisionHash = consumerDigest("another revision"); },
    x => { x.expectedSource.sourceReleaseRunId = x.expectedSource.developmentRunId; },
    x => { x.plan.source.taskId = "other-task"; x.report.planDigest = hash(x.plan); },
    x => { x.report.source.extra = "DO_NOT_ECHO"; }, x => { x.plan.authorization = "DO_NOT_ECHO"; },
    x => { x.report.sourceDigest = "a".repeat(64); }, x => { x.report.expectedRowsDigest = "a".repeat(64); },
    x => { x.report.planDigest = "a".repeat(64); }, x => { x.report.services[0].configHash = "a".repeat(64); },
    x => { x.report.Authorization = "DO_NOT_ECHO"; }, x => { x.plan.authorized = false; x.report.planDigest = hash(x.plan); },
    x => { x.plan.deadline = "2026-11-05T02:00:00.001Z"; x.report.deadline = x.plan.deadline; x.report.planDigest = hash(x.plan); },
  ]) { const value = fixture(); mutate(value); assert.equal(JSON.stringify(notCandidate(value)).includes("DO_NOT_ECHO"), false); }
});

test("missing, failed, unknown or rearranged requests cannot be made complete by PASSED phase labels", () => {
  for (const mutate of [
    x => { x.report.phases.revoked = "NOT_STARTED"; }, x => { x.report.phases.extra = "PASSED"; },
    x => { x.report.requests.pop(); x.report.requestCount--; }, x => { x.report.requestCount++; },
    x => { x.report.requests[0].result = "PENDING"; }, x => { x.report.requests[0].failure = "UNKNOWN"; },
    x => { x.report.requests[0].queryDigest = "b".repeat(64); }, x => { x.report.requests[0].check = "SERVICE_2_PAGE_1"; },
    x => { x.report.requests[0].serviceId = x.plan.xapi.id; }, x => { x.report.requests[0].rowsDigest = x.report.requests[0].responseDigest; },
    x => { x.report.requests[3].childBindingsDigest = "c".repeat(64); }, x => { x.report.requests[3].childBindingsVerified = false; },
    x => { x.report.requests[8].versionBindingsVerified = true; }, x => { x.report.requests[0].rawBody = "DO_NOT_ECHO"; },
    x => { x.report.requests[0].finishedAt = x.plan.startedAt; }, x => { delete x.report.finishedAt; },
    x => { x.report.requests[15].startedAt = "2026-11-05T00:01:10.000Z"; x.report.requests[15].finishedAt = "2026-11-05T00:01:11.000Z"; },
  ]) { const value = fixture(); mutate(value); notCandidate(value); }
});

test("platform source, pinned versions, fields and call proof must match the report, not a VERIFIED label", () => {
  for (const mutate of [
    x => { x.taskEvidence.releaseId = "other-release"; }, x => { x.taskEvidence.truncated = true; },
    x => { x.taskEvidence.services[0].source.contextId = "cash-change"; },
    x => { x.taskEvidence.services[0].sourceRunIds = [x.expectedSource.developmentRunId]; },
    x => { x.taskEvidence.services[0].sourceVersions[0].versionId = "other-child-version"; },
    x => { x.taskEvidence.services[0].sourceVersions[0].configHash = "a".repeat(64); },
    x => { x.taskEvidence.services[0].sourceVersions[0].packageDigest = "a".repeat(64); },
    x => { x.taskEvidence.services[0].sourceVersions[0].fields = ["client_id", "total_assets"]; },
    x => { x.taskEvidence.services[0].sourceVersions.pop(); },
    x => { x.taskEvidence.services[0].call.resultHash = "a".repeat(64); },
    x => { x.taskEvidence.services[0].call.configHash = "a".repeat(64); },
    x => { x.taskEvidence.services[0].call.applicationStatus = "ACTIVE"; },
    x => { x.taskEvidence.services[0].call.verified = false; },
  ]) { const value = fixture(); mutate(value); notCandidate(value); }
});

test("a different latest platform call is UNMATCHED even when all data and version hashes are equal", () => {
  const input = fixture(); input.taskEvidence.services[0].call.callId = "another-latest-call";
  const result = bindExternalConsumption(input);
  assert.equal(result.status, "UNMATCHED"); assert.equal(result.reason, "CALL_UNMATCHED"); assert.equal(result.eligibleForExternalAcceptance, false);
});

test("another current DAPI batch does not hide an XAPI pinned to the original successful batch", () => {
  const input = fixture(), xapi = input.taskEvidence.services[0], child = input.plan.dapis[0];
  const otherSource = { ...input.expectedSource, sourceReleaseRunId: "another-successful-batch" };
  const otherVersion = { ...xapi.sourceVersions[0], versionId: "holdings-current-version", configHash: consumerDigest("current DAPI config"), sourceReleaseRunId: otherSource.sourceReleaseRunId };
  input.taskEvidence.services.push({ serviceId: child.id, serviceType: "DAPI", name: "同发布另一批次持仓", versionId: otherVersion.versionId,
    configHash: otherVersion.configHash, status: "PENDING", source: otherSource, sourceKind: "AGENT", agentIndependentE2E: false,
    releaseId: input.expectedSource.releaseId, sourceRunIds: [otherSource.sourceReleaseRunId], sourceVersions: [otherVersion], fullAssetComposition: false });
  input.taskEvidence.matchingCount = 2;
  assert.equal(bindExternalConsumption(input).status, "MATCHED", "only the exact XAPI and its immutable children prove this report call");
  const foreign = structuredClone(input); foreign.taskEvidence.services[1].source.packageDigest = consumerDigest("different package"); notCandidate(foreign);
  const changedXapi = structuredClone(input); changedXapi.taskEvidence.services[0].source.sourceReleaseRunId = otherSource.sourceReleaseRunId; notCandidate(changedXapi);
  const changedChild = structuredClone(input); changedChild.taskEvidence.services[0].sourceVersions[0].sourceReleaseRunId = otherSource.sourceReleaseRunId; notCandidate(changedChild);
});

test("call timestamps outside the original fixed plan window remain unconfirmed without imposing per-request clock equality", () => {
  const input = fixture(), call = input.taskEvidence.services[0].call;
  call.finishedAt = input.plan.startedAt;
  assert.equal(bindExternalConsumption(input).status, "MATCHED", "the fixed window start is inclusive, without assuming synchronized client/server milliseconds");
  for (const finishedAt of ["2025-01-01T00:00:00.000Z", input.plan.deadline, "2026-11-05T02:00:00.001Z"]) {
    const value = fixture(); value.taskEvidence.services[0].call.finishedAt = finishedAt;
    value.taskEvidence.checkedAt = "2026-11-05T02:00:01.000Z";
    const result = bindExternalConsumption(value);
    assert.equal(result.status, "UNMATCHED"); assert.equal(result.reason, "CALL_TIME_UNCONFIRMED");
    assert.equal(result.eligibleForExternalAcceptance, false); assert.equal(result.externalSystemVerified, false);
  }
});

test("manual/local consistency never upgrades native external acceptance and legacy/plans/simulation remain ineligible", () => {
  for (const options of [{ sourceKind: "MANUAL" }, { scope: "LOCAL_TEST_ONLY" }, { scope: "LOCAL_TEST_ONLY", sourceKind: "MANUAL" }]) {
    const result = bindExternalConsumption(fixture(options));
    assert.equal(result.status, "MATCHED_ONLY"); assert.equal(result.eligibleForExternalAcceptance, false);
    assert.equal(result.externalSystemVerified, false); assert.equal(result.agentIndependentE2E, false);
  }
  for (const mutate of [x => { x.report.protocol = "SERVICE_CONSUMER_V1"; }, x => { x.report.mode = "PLAN_ONLY"; },
    x => { x.report.testDouble = true; }, x => { x.taskEvidence.executionEvidenceMode = "TEST_HARNESS"; },
    x => { x.report.externalSystemVerified = true; }, x => { x.report.agentIndependentE2E = true; }]) {
    const input = fixture(); mutate(input); notCandidate(input);
  }
});

test('standalone manual report identity binds without inventing an Agent or upgrading authored work',()=>{
 const input=fixture({sourceKind:'MANUAL',standalone:true}),result=bindExternalConsumption(input);assert.equal(result.status,'MATCHED_ONLY');assert.equal(result.eligibleForExternalAcceptance,false);assert.equal(result.source.taskId,undefined);assert.equal(result.source.manualDeliveryTaskId,'synthetic-manual-delivery');assert.equal(result.source.sourceAttribution,'ENGINEER_AUTHORED');assert.equal(result.externalSystemVerified,false);assert.equal(result.agentIndependentE2E,false);
 for(const mutate of[x=>{x.taskEvidence.taskId='synthetic-manual-delivery';},x=>{x.taskEvidence.sourceAttribution='ENGINEER_ASSISTED';},x=>{x.taskEvidence.manualDeliveryTaskId='wrong-manual';},x=>{x.plan.source.taskId='forged-agent';}]){const bad=structuredClone(input);mutate(bad);notCandidate(bad);}
});
