import { isDeepStrictEqual as same } from "node:util";
import { DataServiceManager } from "./data-services.mjs";
import { sha256, validateDeliveryPackage } from "./delivery.mjs";
import { inferCsvSchema, LandingStore, parseCsv } from "./ingestion.mjs";
import { checkedSyncReportLineage } from "./published-report-client.mjs";
import { publishedReportHash, resolvePublishedReportSource } from "./published-report-source.mjs";
import { publishedReportRequestKey } from "./published-report-workflow.mjs";
import { checkedPublishedReportArtifacts } from "./report-provenance.mjs";
import { publishedSqlColumnLineage } from "./sql-column-lineage.mjs";
import { syncReportLineage, syncReportFields } from "./sync-sql-report.mjs";
import { certifiedSyncSqlSource, readSyncSqlCallEvidence } from "./sync-sql-service-source.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const time = value => typeof value === "string" ? Date.parse(value) : NaN;
const chronological = (...values) => values.map(time).every((t, i, all) => Number.isFinite(t) && (!i || all[i - 1] <= t));
const requireEvidence = (condition, stage) => {
  if (!condition) {
    const code = "SYNC_SAVED_" + stage;
    throw Object.assign(Error(code), { code });
  }
};

export function verifySavedSyncSqlInput({ read, input, context, csv }) {
  const source = read("offline_sync_run", input.runId), task = read("offline_sync_task", input.taskId);
  const metadata = read("source_metadata", input.metadataVersionId), revision = read("source_revision", input.sourceRevisionId);
  const config = Object.fromEntries(["sourceRevisionId", "sourceType", "metadataVersionId", "targetTable", "mode", "mapping", "keyFields", "watermarkField"]
    .map(key => [key, task[key]]));
  const contentHash = sha256(csv), parsed = parseCsv(csv), columns = inferCsvSchema(parsed);
  requireEvidence(task.mode === "FULL" && task.sourceType === "LOCAL_CSV" && revision.sourceType === "LOCAL_CSV" &&
    task.sourceRevisionId === revision.id && task.metadataVersionId === metadata.id && metadata.revisionId === revision.id &&
    task.sourceId === revision.sourceId && metadata.sourceId === revision.sourceId &&
    source.taskId === task.id && source.status === "SUCCEEDED" && source.actualExecution === true &&
    source.sourceRevisionId === revision.id && source.metadataVersionId === metadata.id && source.targetTable === input.targetTable &&
    task.targetTable === input.targetTable && task.configHash === publishedReportHash(config) && source.configHash === task.configHash &&
    metadata.contentHash === contentHash && source.sourceHash === contentHash && metadata.bytes === Buffer.byteLength(csv) &&
    metadata.rowCount === parsed.rows.length && source.readCount === parsed.rows.length && source.finalCount === input.rowCount &&
    same(columns, metadata.columns) &&
    metadata.schemaHash === publishedReportHash(columns.map(({ name, type, nullable }) => ({ name, type, nullable }))),
  "INPUT_CHANGED");
  const landing = new LandingStore();
  try {
    const replay = landing.sync({ targetTable: task.targetTable, mode: task.mode, rows: parsed.rows, mapping: task.mapping,
      keyFields: task.keyFields, sourceHash: contentHash, syncedAt: source.finishedAt });
    const positions = context.tables.find(table => table.name === "positions");
    const projected = landing.readTable(task.targetTable).map(row => positions.columns.map(([name]) => row[name]));
    requireEvidence(replay.targetHash === source.targetHash && replay.targetHash === input.targetHash &&
      replay.finalCount === input.rowCount && same(projected, positions.rows), "INPUT_PROJECTION_CHANGED");
  } finally { landing.close(); }
  return { syncRunId: source.id, metadataVersionId: metadata.id, sourceRevisionId: revision.id, snapshotHash: input.snapshotHash,
    contentHash, targetHash: source.targetHash, rows: input.rowCount, finishedAt: source.finishedAt };
}

function verifyPages({ calls, read, expectedRows, batch }) {
  requireEvidence(calls.length > 0 && calls.every(call => call.applicationStatus === "REVOKED"), "APPLICATION_NOT_REVOKED");
  return ["DAPI", "XAPI"].map(type => {
    const pages = calls.filter(call => call.serviceType === type)
      .map(call => ({ proof: call, log: read("service_call", call.callId) }))
      .sort((a, b) => a.log.parameters?.page - b.log.parameters?.page);
    requireEvidence(pages.length > 0, "CALL_PAGE_COVERAGE");
    const first = pages[0].log, version = read("data_service_version", first.serviceVersionId);
    const app = read("service_app", first.applicationId), pageSize = first.parameters?.pageSize;
    requireEvidence(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100 && pages.length === Math.ceil(expectedRows / pageSize) &&
      app.status === "REVOKED" && app.versionGrants?.[version.serviceId] === version.id &&
      pages.every(({ proof, log }, index) => log.serviceVersionId === version.id && log.applicationId === app.id &&
        log.parameters?.page === index + 1 && log.parameters.pageSize === pageSize && log.parameters.clientId === undefined &&
        chronological(batch.finishedAt, log.startedAt, log.finishedAt, app.revokedAt) &&
        proof.rowCount === Math.min(pageSize, expectedRows - index * pageSize)), "CALL_PAGE_COVERAGE");
    const children = type === "XAPI" ? version.steps.map(step => read("data_service_version", step.dapiVersionId)) : [version];
    requireEvidence(children.every(child => child.sourceReleaseRunId === batch.id) &&
      (type !== "XAPI" || syncReportFields.every(field => children.some(child => child.fields.includes(field)))), "CALL_SOURCE_CHANGED");
    return { type, versionId: version.id, applicationId: app.id, status: "REVOKED",
      pages: pages.map(({ proof, log }) => ({ callId: proof.callId, page: log.parameters.page, rows: proof.rowCount, resultHash: proof.resultHash })) };
  });
}

export async function verifySavedSyncSqlLifecycle({ store, businessStore, reportStore, project, actor,
  releaseId, packageDigest, requestId, csv, originalPackage, lineages, timeUnitMs = 1000 }) {
  requireEvidence(uuid.test(releaseId ?? "") && digest.test(packageDigest ?? "") &&
    typeof requestId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(requestId) &&
    typeof csv === "string" && Array.isArray(lineages) && lineages.length === 2 &&
    Number.isSafeInteger(timeUnitMs) && timeUnitMs >= 1, "SELECTION_INVALID");
  const read = (kind, id) => {
    const value = typeof id === "string" && store.get(kind, id, project);
    requireEvidence(value?.id === id && value.projectId === project, "RECORD_MISSING");
    return value;
  };
  const release = read("release", releaseId), bundle = read("delivery_package", release.packageId);
  requireEvidence(release.packageDigest === packageDigest && bundle.digest === packageDigest &&
    same(originalPackage, { manifest: bundle.manifest, files: bundle.files, digest: bundle.digest }), "PACKAGE_CHANGED");
  const plan = validateDeliveryPackage(bundle, packageDigest), source = plan.source, input = source.syncInput;
  requireEvidence(input?.actorId === actor && ["LIVE_MODEL", "SYNTHETIC_MODEL"].includes(input.developmentMode), "AGENT_SOURCE_REQUIRED");
  const task = read("agent", input.agentTaskId), development = read("run", source.runId);
  const approval = read("release_approval", release.approvalId), review = read("delivery_review", approval.reviewId);
  const rehearsal = read("delivery_verification", approval.rehearsalId);
  const key = `${project}:agent:${requestId}`, ledger = store.db.prepare("SELECT signature,result_id FROM idempotency WHERE key=?").get(key);
  const selection = { targetTable: input.targetTable, runId: input.runId, targetHash: input.targetHash };
  requireEvidence(ledger?.result_id === task.id && ledger.signature === sha256(JSON.stringify({
    message: task.message, language: task.language, currentCode: task.initialSql, contextId: task.contextId, syncInput: selection,
  })) && task.mode === input.developmentMode && task.language === "SPARK_SQL" &&
    task.fullLifecycleE2E === false && source.requirement?.taskId === task.id, "REQUEST_CHANGED");
  const origin = verifySavedSyncSqlInput({ read, input, context: plan.fixtures.context, csv });
  const trace = plan.order.map(({ id, kind }) => ({ id, kind, status: "SUCCEEDED" }));
  requireEvidence(same(rehearsal.workflowTrace, trace) && chronological(origin.finishedAt, task.createdAt,
    development.startedAt, development.finishedAt, rehearsal.startedAt, rehearsal.finishedAt, review.reviewedAt,
    approval.approvedAt, release.activatedAt), "DEVELOPMENT_OR_REVIEW_CHANGED");

  const certify = run => certifiedSyncSqlSource({ store, project, run, enabled: true, timeUnitMs });
  const manager = new DataServiceManager({ store, businessStore, project, syncSourceFor: certify,
    releaseRunFor: id => read("release_run", id) });
  const batches = store.list("release_run", project).filter(batch => batch.releaseId === releaseId)
    .sort((a, b) => a.sequence - b.sequence);
  requireEvidence(batches.length === 2 && new Set(lineages.map(item => item?.source?.batchId)).size === 2, "BATCH_SELECTION_CHANGED");
  const records = [];
  for (const batch of batches) {
    const proof = certify(batch), archived = lineages.find(item => item?.source?.batchId === batch.id);
    requireEvidence(proof && archived && same(batch.workflowTrace, trace), "BATCH_RESULT_CHANGED");
    const request = await checkedSyncReportLineage(archived);
    const reportKey = publishedReportRequestKey(project, actor, request.requestId);
    const reportLedger = store.db.prepare("SELECT signature,result_id FROM idempotency WHERE key=?").get(reportKey);
    const record = read("published_report_creation", reportLedger?.result_id);
    requireEvidence(record.actorId === actor && record.requestId === request.requestId && record.status === "SUCCEEDED" &&
      reportLedger.signature === publishedReportHash(record.input) && same(record.input.source, request.source), "REPORT_REQUEST_CHANGED");
    const artifacts = checkedPublishedReportArtifacts({ store, project, reportStore, record });
    const resolved = resolvePublishedReportSource({ store, project, source: request.source, actorId: actor, allowSync: true, timeUnitMs });
    requireEvidence(same(resolved.sourceEvidence, proof.sourceEvidence) && chronological(batch.finishedAt, artifacts.snapshot.createdAt, artifacts.run.createdAt),
      "REPORT_BATCH_CHANGED");
    const calls = await readSyncSqlCallEvidence({ store, project, manager, evidence: proof.sourceEvidence });
    const rebuilt = syncReportLineage({ record, artifacts, resolved, batch, calls, hash: publishedReportHash });
    requireEvidence(same(request, rebuilt), "REPORT_DOWNLOAD_CHANGED");
    const column = publishedSqlColumnLineage({ store, project, run: batch, assetId: rebuilt.snapshot.assetId });
    requireEvidence(column.status === "COMPLETE" && column.fields.length === syncReportFields.length &&
      column.fields.every(field => field.status === "RESOLVED"), "COLUMN_LINEAGE_UNPROVEN");
    const event = store.list("monitor_event", project).find(item => item.releaseRunId === batch.id && item.type === "BATCH_SUCCEEDED");
    records.push({ batchId: batch.id, sequence: batch.sequence, engineVersion: batch.engineVersion, monitorEventId: event.id,
      outputHash: publishedReportHash(batch.rows), columnFields: column.fields.map(field => field.target),
      consumption: verifyPages({ calls, read, expectedRows: proof.expected.length, batch }),
      report: { requestId: record.requestId, runId: artifacts.run.id, snapshotHash: artifacts.snapshot.contentHash, lineageDigest: rebuilt.digest } });
  }
  requireEvidence(new Set(records.map(item => item.report.runId)).size === 2 &&
    time(batches[0].finishedAt) <= time(batches[1].triggeredAt), "BATCH_CHRONOLOGY_CHANGED");
  const result = { protocol: "shuduo-saved-sync-sql-lifecycle/v1", status: "VERIFIED", scope: "LOCAL_SAVED_EVIDENCE",
    input: origin, requirement: { requestId, taskId: task.id, digest: source.requirement.basisDigest },
    development: { runId: development.id, revisionId: source.revisionId, sqlHash: source.sqlHash, engineVersion: development.engineVersion },
    rehearsal: { id: rehearsal.id, fileCount: Object.keys(bundle.files).length, testSqlHash: sha256(bundle.files["tests.sql"]) },
    review: { id: review.id, approvalId: approval.id, scope: approval.scope, humanReviewVerified: false },
    publication: { releaseId, packageDigest, businessDate: plan.fixtures.context.businessDate, batches: records },
    provenance: { developmentMode: input.developmentMode, newSparkRuns: 0, newModelCalls: 0, cloudRequests: 0,
      publicDeployed: false, countsTowardLiveEvaluation: false, agentIndependentE2E: false } };
  return { ...result, evidenceDigest: publishedReportHash(result) };
}
