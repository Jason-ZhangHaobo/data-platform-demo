import { isDeepStrictEqual as same } from "node:util";
import { consumerCanonical } from "./consumer-source.mjs";
import { DataServiceManager, serviceVersionConfigValid } from "./data-services.mjs";
import { deliveryFiles, sha256, validateDeliveryPackage } from "./delivery.mjs";
import { distributionComposition } from "./distribution-services.mjs";
import { resolveFundConsumptionSource } from "./fund-consumption-source.mjs";
import { normalizeFundFilters } from "./fund-dapi-contract.mjs";
import { fundAgentAttributionKind, verifiedFundRun } from "./fund-delivery.mjs";
import { fundContext } from "./fund-lookthrough.mjs";
import { createFundPreparations, fundAgentRequestSignature } from "./fund-preparation.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const time = value => typeof value === "string" ? Date.parse(value) : NaN;
const requireEvidence = (condition, stage) => {
  if (!condition) {
    const code = "FUND_SAVED_AGENT_" + stage;
    throw Object.assign(new Error(code), { code });
  }
};

function verifyAttempts({ task, read, preparation, context }) {
  const attempts = task.attempts;
  requireEvidence(Array.isArray(attempts) && attempts.length >= 1 && attempts.length <= 3, "ATTEMPTS_INVALID");
  let lastFinished = time(task.createdAt), lastFailedHash;
  const runIds = new Set(), revisionIds = new Set();
  return attempts.map((attempt, index) => {
    const run = read("run", attempt.runId), revision = read("revision", attempt.revisionId);
    const last = index === attempts.length - 1;
    requireEvidence(attempt.attempt === index + 1 && run.status === attempt.status &&
      run.agentTaskId === task.id && run.revisionId === revision.id && run.contextId === context.id &&
      revision.contextId === context.id && revision.author === task.submittedBy && revision.source === task.mode &&
      typeof revision.sql === "string" && sha256(revision.sql) === revision.hash && run.revisionHash === revision.hash &&
      same(revision.fundPreparation, task.fundPreparation) && same(run.fundPreparation, task.fundPreparation) &&
      revision.requirementBinding?.taskId === task.id && revision.requirementBinding.basisDigest === preparation.basis.digest &&
      digest.test(revision.requirementBinding.reportDigest) && run.engine === "Apache Spark" && run.testDouble !== true &&
      !runIds.has(run.id) && !revisionIds.has(revision.id) && lastFinished <= time(run.startedAt) &&
      time(run.startedAt) <= time(run.finishedAt), "ATTEMPT_BINDING_CHANGED");
    if (run.mainSqlExecuted === true) {
      requireEvidence(run.inputEvidence?.inputHash === preparation.execution.inputDigest &&
        run.inputEvidence.schemaHash === preparation.execution.schemaDigest, "ATTEMPT_INPUT_CHANGED");
    }
    requireEvidence(!lastFailedHash || revision.hash !== lastFailedHash, "REPAIR_SQL_UNCHANGED");
    if (last) {
      requireEvidence(run.id === task.runId && revision.id === task.revisionId && verifiedFundRun(run, context.id), "FINAL_RESULT_UNPROVEN");
    } else {
      requireEvidence(["FAILED", "VALIDATION_FAILED"].includes(run.status) && run.validation?.passed !== true, "FAILED_ATTEMPT_UNPROVEN");
      if (run.status === "VALIDATION_FAILED") {
        const matches = Array.isArray(run.rows) && run.rows.length === context.expected.length &&
          context.expected.every(expected => run.rows.filter(row => same(row, expected)).length === 1);
        requireEvidence(run.mainSqlExecuted === true && run.validation?.passed === false && !matches, "FAILED_ASSERTION_UNPROVEN");
      }
    }
    lastFailedHash = run.status === "VALIDATION_FAILED" ? revision.hash : undefined;
    lastFinished = time(run.finishedAt);
    runIds.add(run.id);
    revisionIds.add(revision.id);
    return { attempt: attempt.attempt, runId: run.id, revisionId: revision.id, sqlDigest: revision.hash,
      status: run.status, engineVersion: run.engineVersion, mainSqlExecuted: run.mainSqlExecuted === true,
      independentlyVerified: last, finishedAt: run.finishedAt };
  });
}

async function verifyPages({ manager, read, callIds, type, context, source, children, version, after }) {
  const calls = callIds.map(id => read("service_call", id));
  const app = read("service_app", calls[0].applicationId), pageSize = calls[0].parameters?.pageSize;
  const total = type === "DAPI" ? context.expected.length :
    new Set(context.expected.map(row => JSON.stringify([row.portfolio_id, row.trade_date]))).size;
  requireEvidence(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 100 &&
    calls.length === Math.ceil(total / pageSize) && app.scope === "LOCAL_TEST_ONLY" &&
    app.status === "REVOKED" && Array.isArray(app.serviceIds) && app.serviceIds.includes(version.serviceId), "CALL_PAGE_COVERAGE");
  if (type === "XAPI") {
    const composition = distributionComposition(children, version.steps);
    requireEvidence(same(composition, Object.fromEntries(Object.keys(composition).map(key => [key, version[key]]))) &&
      children.some(child => child.fields.includes("exposure_amount")) &&
      children.some(child => child.fields.includes("exposure_ratio")), "CALL_COMPOSITION_CHANGED");
  }

  const pages = [];
  calls.sort((left, right) => left.parameters?.page - right.parameters?.page);
  for (const [index, call] of calls.entries()) {
    const filters = normalizeFundFilters(call.parameters);
    requireEvidence(call.serviceId === version.serviceId && call.serviceVersionId === version.id &&
      call.applicationId === app.id && call.parameters.page === index + 1 && call.parameters.pageSize === pageSize &&
      Object.keys(filters).every(key => key === "trade_date") &&
      (filters.trade_date === undefined || filters.trade_date === source.businessDate) &&
      after <= time(call.startedAt) && time(call.finishedAt) <= time(app.revokedAt), "CALL_PAGE_COVERAGE");
    const proof = await manager.recheckFundCall(call.serviceId, call.id);
    requireEvidence(proof.verified && proof.independentResultVerified && proof.rowCount > 0 &&
      proof.versionId === version.id && proof.configHash === version.configHash, "CALL_RESULT_UNPROVEN");
    pages.push({ callId: call.id, page: call.parameters.page, rowCount: proof.rowCount, resultDigest: proof.resultHash });
  }
  requireEvidence(pages.reduce((sum, page) => sum + page.rowCount, 0) === total, "CALL_PAGE_COVERAGE");
  return { serviceId: version.serviceId, versionId: version.id, configHash: version.configHash, applicationId: app.id,
    applicationStatus: app.status, pageSize, rowCount: total, paginationUnit: type === "DAPI" ? "FUND_EXPOSURE_ROWS" : "PORTFOLIO_DATE_GROUPS",
    pages, ...(type === "XAPI" ? { pinnedDapiVersions: children.map(child => child.id) } : {}) };
}

export async function verifySavedFundAgentLifecycle({ store, businessStore, project, actor, taskId,
  requestId, releaseId, packageDigest, dapiCallIds, xapiCallIds }) {
  requireEvidence([dapiCallIds, xapiCallIds].every(ids => Array.isArray(ids) && ids.length >= 1 && ids.length <= 10), "SELECTION_INVALID");
  const callIds = [...dapiCallIds, ...xapiCallIds];
  requireEvidence([taskId, requestId, releaseId, ...callIds].every(id => typeof id === "string" && uuid.test(id)) &&
    typeof packageDigest === "string" && digest.test(packageDigest) &&
    new Set(callIds).size === callIds.length, "SELECTION_INVALID");
  const read = (kind, id) => {
    const value = typeof id === "string" && store.get(kind, id, project);
    requireEvidence(value?.id === id && value.projectId === project, "RECORD_MISSING");
    return value;
  };
  const task = read("agent", taskId);
  const ledger = store.db.prepare("SELECT result_id, signature FROM idempotency WHERE key=?").get(`${project}:agent:${requestId}`);
  const preparation = createFundPreparations({ store, project }).read(requestId, actor);
  requireEvidence(task.status === "SUCCEEDED" && task.submittedBy === actor && task.fundPreparation?.requestId === requestId &&
    task.message === preparation.input.message && task.contextId === preparation.input.contextId &&
    task.fundPreparation.basisDigest === preparation.basis.digest && task.requirements?.basis?.requestDigest === preparation.basis.requestDigest &&
    ledger?.result_id === task.id && ledger.signature === fundAgentRequestSignature(task), "REQUEST_BINDING_CHANGED");

  const release = read("release", releaseId), bundle = read("delivery_package", release.packageId);
  requireEvidence(bundle.digest === packageDigest && bundle.manifest.source.attribution?.kind === fundAgentAttributionKind &&
    bundle.manifest.source.attribution.originAgentTaskId === task.id, "PACKAGE_BINDING_CHANGED");
  const plan = validateDeliveryPackage(bundle, packageDigest), context = fundContext(plan.source.contextId);
  const attempts = verifyAttempts({ task, read, preparation, context });
  const dapi = read("data_service_version", read("service_call", dapiCallIds[0]).serviceVersionId);
  const xapi = read("data_service_version", read("service_call", xapiCallIds[0]).serviceVersionId);
  requireEvidence(dapi.serviceType === "DAPI" && xapi.serviceType === "XAPI" && Array.isArray(xapi.steps) &&
    xapi.steps.length === 2 && serviceVersionConfigValid(dapi) && serviceVersionConfigValid(xapi), "CALL_VERSION_UNPROVEN");
  const children = xapi.steps.map(step => read("data_service_version", step.dapiVersionId));
  const resolveSource = batchId => resolveFundConsumptionSource({ store, project, selection: { batchId, releaseId, packageDigest } });
  const { evidence: source } = resolveSource(dapi.sourceReleaseRunId);
  requireEvidence(source.agentTaskId === task.id && source.modelMode === task.mode && source.revisionId === task.revisionId &&
    source.developmentRunId === task.runId && source.eligibleForService && source.businessDate === preparation.input.businessDate &&
    children.some(child => child.id === dapi.id) && children.every((child, index) => child.serviceId === xapi.steps[index].dapiId &&
      child.sourceReleaseRunId === source.batchId && same(child.sourceEvidence, source) && serviceVersionConfigValid(child)), "CALL_SOURCE_CHANGED");

  const approval = read("release_approval", release.approvalId), review = read("delivery_review", approval.reviewId);
  const verification = read("delivery_verification", approval.rehearsalId);
  const trace = plan.order.map(node => ({ id: node.id, kind: node.kind, status: "SUCCEEDED" }));
  const monitoring = source.batches.map(batch => {
    const run = read("release_run", batch.id);
    requireEvidence(same(run.workflowTrace, trace), "RELEASE_TRACE_CHANGED");
    return { ...batch, engineVersion: run.engineVersion, rowCount: run.rows.length };
  });
  requireEvidence(same(verification.workflowTrace, trace) && same(Object.keys(verification.fileHashes).sort(), [...deliveryFiles].sort()) &&
    time(attempts.at(-1).finishedAt) <= time(verification.startedAt) && time(verification.startedAt) <= time(verification.finishedAt) &&
    time(verification.finishedAt) <= time(review.reviewedAt) && time(review.reviewedAt) <= time(approval.approvedAt) &&
    time(approval.approvedAt) <= time(release.activatedAt), "REHEARSAL_REVIEW_ORDER_UNPROVEN");
  const manager = new DataServiceManager({ store, businessStore, project, releaseRunFor: id => read("release_run", id),
    fundSourceFor: run => resolveSource(run.id) });
  const after = time(monitoring.at(-1).finishedAt);
  const dapiProof = await verifyPages({ manager, read, callIds: dapiCallIds, type: "DAPI", context, source, version: dapi, after });
  const xapiProof = await verifyPages({ manager, read, callIds: xapiCallIds, type: "XAPI", context, source, children, version: xapi, after });
  const report = {
    protocol: "shuduo-saved-fund-agent-lifecycle/v1", status: "VERIFIED", scope: "LOCAL_SAVED_EVIDENCE",
    source: { taskId, requestId, packageDigest, releaseId, batchId: source.batchId, businessDate: source.businessDate },
    requirement: { requestDigest: preparation.basis.requestDigest, basisDigest: preparation.basis.digest,
      inputDigest: preparation.execution.inputDigest, assertionDigest: preparation.execution.assertionDigest },
    development: { revisionId: task.revisionId, runId: task.runId, attempts, independentlyVerifiedRows: source.rowCount },
    rehearsal: { verificationId: verification.id, fileCount: deliveryFiles.length, testSqlDigest: source.testSqlDigest, trace },
    review: { reviewId: review.id, approvalId: approval.id, approvalScope: approval.scope, humanReviewVerified: false },
    publication: { resultDigest: source.resultDigest, monitoring },
    consumption: { dapi: dapiProof, xapi: xapiProof, xapiExposureRows: source.rowCount },
    provenance: { modelMode: task.mode, engineClassification: source.engineClassification, newModelCalls: 0, newSparkRuns: 0,
      cloudRequests: 0, publicDeployed: false, agentIndependentE2E: false, countsTowardLiveEvaluation: false },
  };
  return { ...report, evidenceDigest: sha256(consumerCanonical(report)) };
}
