import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { consumerCanonical, consumerDigest, consumerV2PlanEvidence, validateConsumerSource } from "./consumer-source.mjs";

const hash = value => consumerDigest(consumerCanonical(value));
const record = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const only = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
class BindingError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code) => { if (!condition) throw new BindingError(code); };
const same = isDeepStrictEqual;

function expectedRequests(plan, metadata) {
  const start = Date.parse(plan.startedAt), deadline = Date.parse(plan.deadline);
  check(plan.authorized === true && deadline > start && deadline - start <= 7200000 && integer(plan.timeoutMs, 1, 10000) &&
    integer(plan.maxRequests, 1, 40) && typeof plan.reportFile === "string" && isAbsolute(plan.reportFile), "INVALID_PLAN_BOUNDS");
  const granted = plan.dapis.filter(service => service.granted), targets = [...granted.map(service => ({ ...service, type: "DAPI" })), { ...plan.xapi, type: "XAPI" }];
  check(granted.length >= 1 && new Set(plan.dapis.map(service => service.slug)).size === 2 &&
    !targets.some(service => service.id === metadata.ungrantedService.id && service.type === metadata.ungrantedService.type) &&
    (granted.length !== 1 || metadata.ungrantedService.type === "DAPI" && metadata.ungrantedService.id === plan.dapis.find(service => !service.granted).id) &&
    integer(plan.rateLimit.perMinute, 3, 28), "INVALID_SERVICE_TARGETS");
  const rateTarget = targets.find(service => service.id === plan.rateLimit.serviceId);
  check(rateTarget, "INVALID_SERVICE_TARGETS");
  const requests = [], standard = { page: 1, page_size: Math.ceil(plan.expectedRows.length / 2) };
  const append = (service, query, expectedStatus, name, phase = "consume") => requests.push({ service, query, expectedStatus, check: name, phase });
  targets.forEach((service, index) => {
    append(service, standard, 200, `SERVICE_${index + 1}_PAGE_1`);
    append(service, { ...standard, page: 2 }, 200, `SERVICE_${index + 1}_PAGE_2`);
    append(service, { ...standard, client_id: plan.expectedRows[0].client_id }, 200, `SERVICE_${index + 1}_FILTER`);
  });
  append(targets[0], standard, 401, "MISSING_TOKEN"); append(targets[0], standard, 401, "INVALID_TOKEN");
  append(metadata.ungrantedService, standard, 403, "UNGRANTED_SERVICE");
  append(targets[0], { ...standard, page: 0 }, 400, "INVALID_PARAMETERS");
  for (let used = 3; used <= plan.rateLimit.perMinute; used++)
    append(rateTarget, standard, used === plan.rateLimit.perMinute ? 429 : 200, used === plan.rateLimit.perMinute ? "RATE_LIMIT_REJECTED" : "RATE_LIMIT_ALLOWED");
  append(targets[0], standard, 401, "REVOKED_TOKEN", "revoked");
  check(requests.length <= plan.maxRequests, "INVALID_PLAN_BOUNDS");
  return requests;
}

function independentResponse(plan, service, query) {
  const all = [...plan.expectedRows].sort((a, b) => a.client_id.localeCompare(b.client_id)).filter(row => !query.client_id || row.client_id === query.client_id);
  const page = all.slice((query.page - 1) * query.page_size, query.page * query.page_size);
  const projection = (row, fields) => Object.fromEntries(fields.map(field => [field, row[field]]));
  const data = page.map(row => service.type === "DAPI" ? projection(row, service.fields) : { client_id: row.client_id,
    ...Object.fromEntries(plan.dapis.map(child => [child.alias, projection(row, child.fields.filter(field => field !== "client_id"))])) });
  return { data, pagination: { page: query.page, pageSize: query.page_size, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / query.page_size)) } };
}

function verifyReport(plan, report, metadata, program) {
  const keys = ["protocol", "planDigest", "credentialDigest", "maxRequests", "startedAt", "deadline", "evidence", "requestCount", "phases", "requests", "finishedAt", ...Object.keys(metadata)];
  check(exact(report, keys) && report.protocol === "SERVICE_CONSUMER_V2" && report.planDigest === hash(plan) && digest(report.credentialDigest) &&
    report.maxRequests === plan.maxRequests && report.startedAt === plan.startedAt && report.deadline === plan.deadline &&
    report.evidence === (plan.testOnly ? "LOCAL_HTTP_FIXTURE" : "HTTP_CONSUMER_ONLY") && Object.entries(metadata).every(([key, value]) => same(report[key], value)), "REPORT_BINDING_INVALID");
  check(exact(report.phases, ["consume", "revoked"]) && report.phases.consume === "PASSED" && report.phases.revoked === "PASSED" &&
    report.requestCount === program.length && Array.isArray(report.requests) && report.requests.length === program.length && timestamp(report.finishedAt), "REPORT_INCOMPLETE");
  const common = ["sequence", "phase", "check", "startedAt", "result", "serviceId", "type", "versionId", "configHash", "expectedStatus", "queryDigest", "statusCode", "finishedAt"];
  const success = ["rowsDigest", "rowCount", "callIdDigest", "responseDigest", "versionBindingsVerified", "childBindingsVerified"];
  const childBindingsDigest = hash(plan.dapis.map(child => ({ alias: child.alias, dapiId: child.id, dapiVersionId: child.versionId })));
  let previousEnd = Date.parse(plan.startedAt);
  const firstSuccess = new Map(), calls = new Set();
  report.requests.forEach((entry, index) => {
    const expected = program[index], service = expected.service;
    check(exact(entry, [...common, ...(expected.expectedStatus === 200 ? [...success, ...(service.type === "XAPI" ? ["childBindingsDigest"] : [])] : [])]) &&
      entry.sequence === index + 1 && entry.phase === expected.phase && entry.check === expected.check && entry.result === "PASSED" &&
      entry.serviceId === service.id && entry.type === service.type && entry.versionId === service.versionId && entry.configHash === service.configHash &&
      entry.expectedStatus === expected.expectedStatus && entry.statusCode === expected.expectedStatus && entry.queryDigest === hash(expected.query) &&
      timestamp(entry.startedAt) && timestamp(entry.finishedAt) && Date.parse(entry.startedAt) >= previousEnd &&
      Date.parse(entry.startedAt) < Date.parse(plan.deadline) && Date.parse(entry.finishedAt) >= Date.parse(entry.startedAt), "REQUEST_EVIDENCE_INVALID");
    previousEnd = Date.parse(entry.finishedAt);
    if (entry.check.startsWith("RATE_LIMIT_")) check(Date.parse(entry.startedAt) - firstSuccess.get(service.id) + plan.timeoutMs < 60000, "RATE_WINDOW_INVALID");
    if (entry.statusCode !== 200) return; // 401/403 etc are rejection checks, not version proofs.
    const response = independentResponse(plan, service, expected.query);
    check(entry.versionBindingsVerified === true && entry.childBindingsVerified === (service.type === "XAPI") &&
      (service.type !== "XAPI" || entry.childBindingsDigest === childBindingsDigest) && entry.rowsDigest === hash(response.data) &&
      entry.responseDigest === hash(response) && entry.rowCount === response.data.length && digest(entry.callIdDigest) && !calls.has(entry.callIdDigest), "INDEPENDENT_RESULT_MISMATCH");
    calls.add(entry.callIdDigest);
    if (!firstSuccess.has(service.id)) firstSuccess.set(service.id, Date.parse(entry.startedAt));
  });
  check(Date.parse(report.finishedAt) >= previousEnd, "REPORT_TIME_INVALID");
}

const evidenceKeys = ["protocol", "taskId", "packageDigest", "releaseId", "scope", "sourceKind", "sourceAttribution", "status", "checkedAt", "services", "matchingCount", "truncated", "publicDeployed", "externalSystemVerified", "agentIndependentE2E", "notice"];
const entryKeys = ["serviceId", "serviceType", "name", "versionId", "configHash", "status", "sourceRunIds", "notice", "sourceKind", "sourceAttribution", "agentIndependentE2E", "releaseId", "sourceVersions", "fullAssetComposition", "call", "code", "source"];
const versionKeys = ["serviceId", "versionId", "configHash", "releaseId", "sourceReleaseRunId", "packageDigest", "sourceKind", "sourceAttribution", "fields"];
const callKeys = ["callId", "versionId", "configHash", "rowCount", "resultHash", "verified", "applicationId", "applicationStatus", "finishedAt"];
const attributionMatches = (value, source) => source.sourceKind === "MANUAL" ? value.sourceAttribution === (source.manualDeliveryTaskId?"ENGINEER_AUTHORED":"ENGINEER_ASSISTED") : value.sourceAttribution === undefined;
const textFieldsSafe = value => ["name", "notice", "code"].every(key => value[key] === undefined || typeof value[key] === "string" && value[key].length <= 4000);
const samePublicationSource = (value, source) => {
  const observed = validateConsumerSource(value);
  return ["scope", "sourceKind", ...(source.manualDeliveryTaskId?["manualDeliveryTaskId"]:["taskId"]), "packageDigest", "releaseId"].every(key => observed[key] === source[key]);
};

function platformMatch(source, plan, report, evidence) {
  check(only(evidence, source.manualDeliveryTaskId?[...evidenceKeys.filter(k=>k!=="taskId"),"manualDeliveryTaskId"]:evidenceKeys) && evidence.protocol === (source.manualDeliveryTaskId?"shuduo-private-manual-consumption/v1":source.scope === "LOCAL_TEST_ONLY" ? "shuduo-local-task-consumption/v1" : "shuduo-private-task-consumption/v1") &&
    evidence.scope === source.scope && (source.manualDeliveryTaskId?evidence.manualDeliveryTaskId===source.manualDeliveryTaskId&&evidence.taskId===undefined:evidence.taskId === source.taskId) && evidence.packageDigest === source.packageDigest && evidence.releaseId === source.releaseId &&
    evidence.sourceKind === source.sourceKind && attributionMatches(evidence, source) && evidence.externalSystemVerified === false && evidence.agentIndependentE2E === false &&
    evidence.publicDeployed === false && evidence.status === "VERIFIED" && evidence.truncated === false && timestamp(evidence.checkedAt) && textFieldsSafe(evidence) &&
    Array.isArray(evidence.services) && integer(evidence.services.length, 1, 20) && evidence.matchingCount === evidence.services.length &&
    new Set(evidence.services.map(entry => entry?.serviceId)).size === evidence.services.length, "PLATFORM_EVIDENCE_INVALID");
  check(evidence.services.every(entry => only(entry, entryKeys) && textFieldsSafe(entry) && id(entry.serviceId) && ["DAPI", "XAPI"].includes(entry.serviceType) &&
    ["PENDING", "VERIFIED", "NEEDS_ATTENTION"].includes(entry.status) &&
    // The API also lists services from other successful batches of this same
    // release. They may coexist, but cannot supply the selected XAPI's proof.
    (entry.source === undefined || samePublicationSource(entry.source, source)) &&
    (entry.call === undefined || exact(entry.call, callKeys)) &&
    (entry.sourceVersions === undefined || Array.isArray(entry.sourceVersions) && entry.sourceVersions.length <= 5 && entry.sourceVersions.every(version => only(version, versionKeys)))), "PLATFORM_RECORD_INVALID");
  const entry = evidence.services.find(value => value.serviceId === plan.xapi.id);
  check(entry && entry.serviceType === "XAPI" && entry.status === "VERIFIED" && entry.versionId === plan.xapi.versionId && entry.configHash === plan.xapi.configHash &&
    entry.sourceKind === source.sourceKind && attributionMatches(entry, source) && entry.agentIndependentE2E === false && entry.releaseId === source.releaseId &&
    same(validateConsumerSource(entry.source), source) && same(entry.sourceRunIds, [source.sourceReleaseRunId]) && entry.fullAssetComposition === true &&
    Array.isArray(entry.sourceVersions) && entry.sourceVersions.length === 2, "PLATFORM_SOURCE_MISMATCH");
  check(new Set(entry.sourceVersions.map(version => version.serviceId)).size === 2 && plan.dapis.every(service => {
    const version = entry.sourceVersions.find(value => value.serviceId === service.id);
    return version && version.versionId === service.versionId && version.configHash === service.configHash && version.releaseId === source.releaseId &&
      version.sourceReleaseRunId === source.sourceReleaseRunId && version.packageDigest === source.packageDigest && version.sourceKind === source.sourceKind &&
      (version.sourceAttribution === undefined || source.sourceKind === "MANUAL" && version.sourceAttribution === (source.manualDeliveryTaskId?"ENGINEER_AUTHORED":"ENGINEER_ASSISTED")) &&
      Array.isArray(version.fields) && same([...version.fields].sort(), [...service.fields].sort());
  }), "CHILD_VERSION_MISMATCH");
  const call = entry.call;
  check(exact(call, callKeys) && id(call.callId) && id(call.applicationId) && call.verified === true && call.versionId === entry.versionId && call.configHash === entry.configHash &&
    integer(call.rowCount, 1, 100) && digest(call.resultHash) && ["REVOKED", "EXPIRED"].includes(call.applicationStatus) &&
    timestamp(call.finishedAt) && Date.parse(call.finishedAt) <= Date.parse(evidence.checkedAt), "CALL_PROOF_INVALID");
  // Client/server clocks are not compared at per-request millisecond precision.
  // An out-of-window receipt needs clock/evidence review, never an automatic call.
  check(Date.parse(call.finishedAt) >= Date.parse(plan.startedAt) && Date.parse(call.finishedAt) < Date.parse(plan.deadline), "CALL_TIME_UNCONFIRMED");
  const callIdDigest = consumerDigest(call.callId), matches = report.requests.filter(request => request.phase === "consume" && request.statusCode === 200 &&
    request.serviceId === entry.serviceId && request.type === "XAPI" && request.versionId === entry.versionId && request.configHash === entry.configHash && request.callIdDigest === callIdDigest);
  check(matches.length === 1, "CALL_UNMATCHED");
  check(matches[0].rowsDigest === call.resultHash && matches[0].rowCount === call.rowCount, "CALL_RESULT_MISMATCH");
  return matches[0];
}

// Consistency only. No IO, clock reads, invocation, credential creation or eval
// changes. Even a completely self-consistent report can be fabricated; it is
// not proof that a real environment or independent system was exercised.
function matchedDapiReceipt(source,plan,report,evidence,xapiEvidence) {
  check(only(evidence,evidenceKeys) && evidence.protocol==="shuduo-private-task-consumption/v1" && evidence.taskId===source.taskId &&
    evidence.packageDigest===source.packageDigest && evidence.releaseId===source.releaseId &&
    evidence.scope===source.scope && evidence.sourceKind==="AGENT" && evidence.truncated===false &&
    evidence.externalSystemVerified===false && evidence.agentIndependentE2E===false && evidence.publicDeployed===false &&
    evidence.matchingCount===1 && Array.isArray(evidence.services) && evidence.services.length===1 &&
    timestamp(evidence.checkedAt), "DAPI_RECEIPT_INVALID");
  const [entry]=evidence.services, service=plan.dapis.find(row=>row.granted && row.id===entry?.serviceId);
  const call=entry?.call, versions=entry?.sourceVersions, xapi=xapiEvidence.services.find(row=>row.serviceId===plan.xapi.id);
  check(service && only(entry,entryKeys) && entry.serviceType==="DAPI" && entry.status==="VERIFIED" &&
    entry.sourceKind==="AGENT" && entry.versionId===service.versionId && entry.configHash===service.configHash &&
    entry.releaseId===source.releaseId && same(validateConsumerSource(entry.source),source) &&
    same(entry.sourceRunIds,[source.sourceReleaseRunId]) && Array.isArray(versions) && versions.length===1 &&
    only(versions[0],versionKeys) && versions[0].serviceId===service.id && versions[0].versionId===service.versionId &&
    versions[0].configHash===service.configHash && versions[0].releaseId===source.releaseId &&
    versions[0].packageDigest===source.packageDigest && versions[0].sourceReleaseRunId===source.sourceReleaseRunId &&
    versions[0].sourceKind==="AGENT" &&
    Array.isArray(versions[0].fields) && same([...versions[0].fields].sort(),[...service.fields].sort()),
    "DAPI_SOURCE_MISMATCH");
  check(exact(call,callKeys) && id(call.callId) && call.applicationId===xapi?.call?.applicationId &&
    call.verified===true && call.versionId===service.versionId && call.configHash===service.configHash &&
    ["REVOKED","EXPIRED"].includes(call.applicationStatus) && timestamp(call.finishedAt) &&
    Date.parse(call.finishedAt)>=Date.parse(plan.startedAt) && Date.parse(call.finishedAt)<Date.parse(plan.deadline) &&
    Date.parse(call.finishedAt)<=Date.parse(evidence.checkedAt),"DAPI_CALL_PROOF_INVALID");
  const callIdDigest=consumerDigest(call.callId);
  const matches=report.requests.filter(row=>row.type==="DAPI" && row.statusCode===200 && row.serviceId===service.id &&
    row.versionId===service.versionId && row.callIdDigest===callIdDigest);
  check(matches.length===1 && matches[0].rowsDigest===call.resultHash && matches[0].rowCount===call.rowCount,
    "DAPI_CALL_RESULT_MISMATCH");
  return {dapiCallIdDigest:callIdDigest,dapiRowsDigest:call.resultHash};
}

export function bindExternalConsumption({ expectedSource, plan, report, taskEvidence, dapiEvidence } = {}) {
  const base = { schema: "shuduo-external-consumption-binding/v1", verificationScope: "REPORT_AND_PLATFORM_RECEIPT_CONSISTENCY",
    eligibleForExternalAcceptance: false, externalSystemVerified: false, agentIndependentE2E: false, publicDeployed: false };
  if (plan?.protocol !== "SERVICE_CONSUMER_V2" || report?.protocol !== "SERVICE_CONSUMER_V2")
    return { ...base, status: "INELIGIBLE", reason: "V2_REPORT_REQUIRED" };
  if (report.mode === "PLAN_ONLY" || report.evidence === "NOT_EXECUTED" || [plan, report, taskEvidence, dapiEvidence].some(value =>
    value?.testDouble === true || value?.synthetic === true || value?.executionEvidenceMode === "TEST_HARNESS"))
    return { ...base, status: "INELIGIBLE", reason: "NON_EXECUTION_EVIDENCE" };
  try {
    const source = validateConsumerSource(expectedSource), metadata = consumerV2PlanEvidence(plan);
    check(same(source, metadata.source), "SOURCE_MISMATCH");
    const program = expectedRequests(plan, metadata);
    verifyReport(plan, report, metadata, program);
    const matched = platformMatch(source, plan, report, taskEvidence);
    const dapi = dapiEvidence===undefined ? {} : matchedDapiReceipt(source,plan,report,dapiEvidence,taskEvidence);
    const eligible = source.scope === "PRIVATE_CLOUD_TEST" && source.sourceKind === "AGENT" && plan.testOnly === false && report.evidence === "HTTP_CONSUMER_ONLY";
    return { ...base, status: eligible ? "MATCHED" : "MATCHED_ONLY", reason: eligible ? "REPORT_AND_RECEIPT_MATCHED" : "LOCAL_OR_MANUAL_CONSISTENCY_ONLY",
      eligibleForExternalAcceptance: eligible, source, sourceDigest: metadata.sourceDigest, expectedRowsDigest: metadata.expectedRowsDigest,
      planDigest: report.planDigest, reportDigest: hash(report), servicesDigest: hash(metadata.services),
      callIdDigest: matched.callIdDigest, rowsDigest: matched.rowsDigest, matchedRequestSequence: matched.sequence, ...dapi };
  } catch (error) {
    return { ...base, status: "UNMATCHED", reason: error instanceof BindingError ? error.code : "INVALID_DOCUMENT" };
  }
}
