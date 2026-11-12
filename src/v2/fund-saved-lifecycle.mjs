import { isDeepStrictEqual as same } from "node:util";
import { DataServiceManager, serviceHash, serviceVersionConfigValid } from "./data-services.mjs";
import { fundDapiContract } from "./fund-dapi-contract.mjs";
import { fundContext } from "./fund-lookthrough.mjs";
import { expectedFundCallRows } from "./fund-call-result.mjs";
export { expectedFundCallRows } from "./fund-call-result.mjs";
import { resolveFundConsumptionSource } from "./fund-consumption-source.mjs";
import { createPublishedReportWorkflow, publishedReportRequestKey } from "./published-report-workflow.mjs";

const requireEvidence = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};

export async function verifySavedFundLifecycle({
  activeStore, historyStore, businessStore, reportStore, project, actor, requestId, dapiCallId, xapiCallId,
}) {
  const history = createPublishedReportWorkflow({ store: historyStore, reportStore, project });
  const development = history.readDevelopment(requestId, actor);
  const { lineage, revision, run, verification } = development;
  const { source } = lineage;
  const contextId = historyStore.get("run", source.runId, project)?.contextId;
  const context = contextId && fundContext(contextId);
  requireEvidence(context?.businessDate === lineage.release.businessDate, "FUND_CONTEXT_UNPROVEN");
  requireEvidence(!lineage.release.activeForConsumption, "FUND_HISTORICAL_RELEASE_REQUIRED");

  const active = resolveFundConsumptionSource({
    store: activeStore, project, selection: { releaseId: source.releaseId, packageDigest: source.packageDigest, batchId: source.batchId },
  });
  const monitor = active.evidence.batches.find(batch => batch.id === source.batchId);
  const historySnapshot = historyStore.get("report_snapshot", lineage.snapshot.id, project);
  requireEvidence(active.evidence.eligibleForService && active.evidence.resultDigest === lineage.release.resultDigest &&
    active.evidence.revisionId === revision.id && active.evidence.developmentRunId === run.id &&
    active.evidence.assertionDigest === verification.assertionDigest && active.evidence.testSqlDigest === verification.testSqlDigest &&
    monitor?.monitorEventId === lineage.batch.monitorEvent.id && monitor?.finishedAt === lineage.batch.finishedAt &&
    same(active.evidence.batches, historySnapshot?.sourceEvidence?.batches),
  "FUND_ACTIVE_HISTORY_MISMATCH");
  const activeRelease = activeStore.get("release", source.releaseId, project);
  const historicalRelease = historyStore.get("release", source.releaseId, project);
  const approval = activeStore.get("release_approval", activeRelease.approvalId, project);
  requireEvidence(approval?.rehearsalId === verification.rehearsalId && historicalRelease?.approvalId === approval.id &&
    same(approval, historyStore.get("release_approval", approval.id, project)), "FUND_REHEARSAL_MISMATCH");

  const manager = new DataServiceManager({
    store: activeStore, businessStore, project, releaseRunFor: id => activeStore.get("release_run", id, project),
    fundSourceFor: batch => resolveFundConsumptionSource({
      store: activeStore, project, selection: { batchId: batch.id, releaseId: batch.releaseId, packageDigest: batch.packageDigest },
    }),
  });
  async function verifyCall(callId, type) {
    const call = activeStore.get("service_call", callId, project);
    const service = call && activeStore.get("data_service", call.serviceId, project);
    const version = call && activeStore.get("data_service_version", call.serviceVersionId, project);
    const application = call && activeStore.get("service_app", call.applicationId, project);
    requireEvidence(service?.serviceType === type && version?.serviceType === type && version.serviceId === service.id &&
      version.outputContractId === fundDapiContract.id && version.scope === "LOCAL_TEST_ONLY" &&
      serviceVersionConfigValid(version) && version.id === service.publishedVersionId,
    "FUND_CALL_VERSION_UNPROVEN");
    requireEvidence(application?.status === "REVOKED" && Array.isArray(application.serviceIds) && application.serviceIds.includes(service.id) &&
      Date.parse(application.createdAt) <= Date.parse(call.startedAt) &&
      Date.parse(call.startedAt) <= Date.parse(application.revokedAt) &&
      same(call, historyStore.get("service_call", callId, project)) &&
      same(application, historyStore.get("service_app", application.id, project)),
    "FUND_CALL_AUTHORIZATION_UNPROVEN");

    const children = type === "DAPI" ? [version] : version.steps.map(step =>
      activeStore.get("data_service_version", step.dapiVersionId, project));
    requireEvidence(children.every(child => child?.sourceReleaseRunId === source.batchId &&
      child.sourceReleaseId === source.releaseId && child.sourcePackageDigest === source.packageDigest &&
      child.sourceEvidence?.resultDigest === lineage.release.resultDigest &&
      historyStore.get("data_service_version", child.id, project)?.configHash === child.configHash) &&
      historyStore.get("data_service_version", version.id, project)?.configHash === version.configHash,
    "FUND_CALL_SOURCE_MISMATCH");
    const replay = await manager.recheckCall(service.id, callId);
    const independent = expectedFundCallRows(version, children, call.parameters, context);
    requireEvidence(replay.verified && independent.length === replay.rowCount &&
      serviceHash(independent) === replay.resultHash, "FUND_CALL_RESULT_MISMATCH");
    return { type, callId, versionId: version.id, rowCount: replay.rowCount, resultHash: replay.resultHash,
      applicationStatus: "REVOKED", ...(type === "XAPI" ? { childVersionIds: children.map(child => child.id) } : {}) };
  }

  const dapi = await verifyCall(dapiCallId, "DAPI");
  const xapi = await verifyCall(xapiCallId, "XAPI");
  const ledger = publishedReportRequestKey(project, actor, requestId);
  const receipt = historyStore.get("published_report_creation", historyStore.deduplicatedId(ledger), project);
  const stages = { dataset: receipt.datasetId, snapshot: receipt.snapshotId, report: receipt.reportId, reportRun: receipt.reportRunId };
  requireEvidence(receipt.reportRunId === lineage.report.runId && Object.entries(stages).every(([stage, id]) =>
    historyStore.deduplicatedId(`${ledger}:${stage}`) === id), "FUND_REPORT_STAGE_LEDGER_MISMATCH");

  return {
    protocol: "shuduo-saved-fund-lifecycle/v1", status: "VERIFIED", scope: "LOCAL_SAVED_EVIDENCE",
    source: { ...source, attribution: "ENGINEER_AUTHORED" },
    development: { revisionHash: revision.hash, engine: run.engine, engineVersion: run.engineVersion,
      rowCount: run.rowCount, assertionCount: verification.assertions.length, assertionDigest: verification.assertionDigest },
    rehearsal: { id: verification.rehearsalId, testSqlDigest: verification.testSqlDigest,
      approvalId: approval.id, reviewId: approval.reviewId, approvalScope: approval.scope },
    publication: { savedBatches: active.evidence.batches, historicalStatus: lineage.release.status,
      activeForConsumptionInHistory: false, resultDigest: lineage.release.resultDigest },
    consumption: [dapi, xapi],
    report: { requestId, ...lineage.report, snapshotId: lineage.snapshot.id, snapshotHash: lineage.snapshot.contentHash,
      newerRunExists: historyStore.get("report", lineage.report.id, project).lastRunId !== lineage.report.runId },
    recovery: { originalReportStagesVerified: Object.keys(stages), interruptedExecutionObservedByThisRun: false },
    modelCalls: 0, sparkRuns: 0, cloudRequests: 0, agentIndependentE2E: false, publicDeployed: false,
  };
}
