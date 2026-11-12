import { isDeepStrictEqual as same } from 'node:util';
import { getContext } from './context.mjs';
import { normalizedServiceSourceRows } from './data-services.mjs';
import { resolveDeliverySchedule, sha256, validateDeliveryPackage } from './delivery.mjs';
import { resolvePublishedReportSource, publishedReportHash } from './published-report-source.mjs';
import { checkedWealthReportConsumption } from './wealth-report-consumption-client.mjs';
import { readWealthReportConsumption } from './wealth-report-consumption.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const chronological = (...values) => values.map(time).every((stamp, index, stamps) =>
  Number.isFinite(stamp) && (!index || stamps[index - 1] <= stamp));
const requireEvidence = (condition, stage) => {
  if (!condition) {
    const code = 'WEALTH_SAVED_' + stage;
    throw Object.assign(new Error(code), { code });
  }
};

export function verifySavedWealthLifecycle({ store, reportStore, businessStore, project, actor,
  releaseId, packageDigest, batchId, reportId, runId, dapiCallIds, xapiCallIds }) {
  requireEvidence([dapiCallIds, xapiCallIds].every(ids => Array.isArray(ids) && ids.length > 0), 'SELECTION_INVALID');
  const callIds = [...dapiCallIds, ...xapiCallIds].sort();
  requireEvidence(callIds.length <= 100 && new Set(callIds).size === callIds.length &&
    [releaseId, batchId, reportId, runId, ...callIds].every(id => typeof id === 'string' && uuid.test(id)) &&
    typeof packageDigest === 'string' && digest.test(packageDigest), 'SELECTION_INVALID');
  const read = (kind, id) => {
    const record = typeof id === 'string' && store.get(kind, id, project);
    requireEvidence(record?.id === id && record.projectId === project, 'RECORD_MISSING');
    return record;
  };
  const release = read('release', releaseId), bundle = read('delivery_package', release.packageId);
  requireEvidence(release.packageDigest === packageDigest && bundle.digest === packageDigest, 'PACKAGE_CHANGED');
  const plan = validateDeliveryPackage(bundle, packageDigest), source = plan.source;
  const revision = read('revision', source.revisionId), development = read('run', source.runId);
  const approval = read('release_approval', release.approvalId), review = read('delivery_review', approval.reviewId);
  const rehearsal = read('delivery_verification', approval.rehearsalId);
  const occurrence = resolveDeliverySchedule(plan, release.businessScheduledFor);
  const trace = plan.order.map(node => ({ id: node.id, kind: node.kind, status: 'SUCCEEDED' }));
  const rows = normalizedServiceSourceRows(getContext(source.contextId).expected);
  const matchesRows = record => same(normalizedServiceSourceRows(record.rows), rows);
  requireEvidence(occurrence.eligible && development.status === 'SUCCEEDED' && development.engine === 'Apache Spark' &&
    development.mainSqlExecuted === true && development.testDouble !== true && revision.source === 'MANUAL' &&
    matchesRows(development) && matchesRows(rehearsal) && rehearsal.mode === 'LOCAL_FILE_REHEARSAL' &&
    same(rehearsal.occurrence, occurrence) && rehearsal.scheduledFor === occurrence.scheduledFor &&
    same(rehearsal.workflowTrace, trace) && chronological(development.startedAt, development.finishedAt,
      rehearsal.startedAt, rehearsal.finishedAt, review.reviewedAt, approval.approvedAt, release.activatedAt),
  'DEVELOPMENT_OR_REVIEW_CHANGED');

  const batches = store.list('release_run', project).filter(batch => batch.releaseId === releaseId &&
    [undefined, 'LOCAL_TEST_SCHEDULE'].includes(batch.triggerReason)).sort((left, right) => left.sequence - right.sequence);
  const spec = release.scheduleSpec;
  requireEvidence([2, 3].includes(spec?.runCount) && batches.length === spec.runCount && batches.some(batch => batch.id === batchId) &&
    Number.isSafeInteger(spec.triggerAfterSeconds) && spec.triggerAfterSeconds > 0 &&
    Number.isSafeInteger(spec.intervalSeconds) && spec.intervalSeconds > 0, 'SCHEDULE_CHANGED');
  const monitoring = store.list('monitor_event', project).filter(event => event.releaseId === releaseId && event.type === 'BATCH_SUCCEEDED');
  const batchEvidence = batches.map((batch, index) => {
    const prior = batches[index - 1];
    const events = monitoring.filter(event => event.releaseRunId === batch.id);
    const [event] = events;
    requireEvidence(batch.sequence === index + 1 && same(batch.occurrence, occurrence) && same(batch.workflowTrace, trace) &&
      chronological(release.activatedAt, batch.scheduledTriggerAt, batch.triggeredAt, batch.startedAt, batch.finishedAt) &&
      (prior ? time(batch.scheduledTriggerAt) - time(prior.scheduledTriggerAt) === spec.intervalSeconds * 1000 &&
        time(prior.finishedAt) <= time(batch.triggeredAt) :
        time(batch.scheduledTriggerAt) - time(release.activatedAt) >= spec.triggerAfterSeconds * 1000), 'BATCH_SCHEDULE_CHANGED');
    requireEvidence(events.length === 1 && event.status === 'SUCCEEDED' && event.schedulerTriggered === true &&
      event.packageDigest === packageDigest && chronological(batch.finishedAt, event.observedAt), 'MONITORING_CHANGED');
    const resolved = resolvePublishedReportSource({ store, project, actorId: actor, source: { kind: 'MANUAL', releaseId,
      packageDigest, batchId: batch.id, revisionId: revision.id, runId: development.id } });
    requireEvidence(same(normalizedServiceSourceRows(resolved.rows), rows), 'BATCH_RESULT_CHANGED');
    return { batchId: batch.id, sequence: batch.sequence, monitorEventId: event.id,
      finishedAt: batch.finishedAt, observedAt: event.observedAt, resultDigest: publishedReportHash(rows) };
  });

  const receipt = checkedWealthReportConsumption(readWealthReportConsumption({ store, reportStore, businessStore,
    project, reportId, runId, actor, callIds }), { reportId, runId });
  requireEvidence(receipt.source.releaseId === releaseId && receipt.source.packageDigest === packageDigest &&
    receipt.source.batchId === batchId && receipt.source.revisionId === revision.id && receipt.source.runId === development.id,
  'REPORT_BATCH_CHANGED');
  const reportRun = read('report_run', runId), snapshot = read('report_snapshot', receipt.snapshot.id);
  requireEvidence(chronological(batches.find(batch => batch.id === batchId).finishedAt, snapshot.createdAt, reportRun.createdAt),
    'REPORT_CHRONOLOGY_CHANGED');
  const dapi = new Set(dapiCallIds), xapi = new Set(xapiCallIds);
  requireEvidence(receipt.status === 'VERIFIED' && receipt.unconfirmedCalls === 0 && receipt.verifiedCalls === callIds.length &&
    receipt.services.every(service => service.calls.every(call => call.applicationStatus === 'REVOKED' &&
      (service.type === 'DAPI' ? dapi : xapi).has(call.callId))), 'CONSUMPTION_UNPROVEN');
  const services = receipt.services.map(service => ({ ...service, calls: service.calls.toSorted((a, b) => a.callId.localeCompare(b.callId)) }))
    .sort((a, b) => a.versionId.localeCompare(b.versionId));
  const result = { protocol: 'shuduo-saved-wealth-lifecycle/v1', status: 'VERIFIED', scope: 'LOCAL_SAVED_EVIDENCE',
    source: { releaseId, batchId, packageDigest, revisionId: revision.id, developmentRunId: development.id,
      contextId: source.contextId, businessDate: occurrence.businessDate, attribution: 'ENGINEER_AUTHORED' },
    development: { engine: development.engine, engineVersion: development.engineVersion, rowCount: rows.length, sqlDigest: sha256(revision.sql) },
    rehearsal: { id: rehearsal.id, fileCount: Object.keys(bundle.files).length, testSqlDigest: sha256(bundle.files['tests.sql']), trace },
    review: { id: review.id, approvalId: approval.id, scope: approval.scope, humanReviewVerified: false },
    publication: { batches: batchEvidence }, report: { ...receipt.report, snapshot: receipt.snapshot },
    consumption: { directDapiCalls: dapi.size, xapiCalls: xapi.size, services },
    provenance: { newSparkRuns: 0, newModelCalls: 0, cloudRequests: 0, publicDeployed: false, countsTowardLiveEvaluation: false } };
  return { ...result, evidenceDigest: publishedReportHash(result) };
}
