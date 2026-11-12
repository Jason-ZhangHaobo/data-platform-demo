import { isDeepStrictEqual as same } from 'node:util';
import { executeDistributionReport } from './distribution-reports.mjs';
import { fundReportQuality } from './fund-report-quality.mjs';
import { createPublishedReportWorkflow, publishedReportRequestKey } from './published-report-workflow.mjs';
import { publishedReportHash } from './published-report-source.mjs';

const requireEvidence = (condition, stage) => {
  if (!condition) {
    const code = `FUND_SAVED_REPORT_${stage}`;
    throw Object.assign(new Error(code), { code });
  }
};

export function verifyFundQualityCounts(receipt, rows) {
  const maxCents = 99999999999999999999n;
  const tests = {
    'trade-date': row => row.trade_date === receipt.businessDate,
    'asset-class': row => typeof row.asset_class === 'string' && Boolean(row.asset_class.trim()),
    'exposure-amount': row => typeof row.exposure_amount === 'string' && /^\d+\.\d{2}$/.test(row.exposure_amount) &&
      BigInt(row.exposure_amount.replace('.', '')) <= maxCents,
  };
  requireEvidence(receipt.snapshot.rowCount === rows.length && publishedReportHash(rows) === receipt.snapshot.contentHash &&
    Array.isArray(receipt.checks) && receipt.checks.length === Object.keys(tests).length, 'QUALITY_SOURCE_CHANGED');
  const checks = Object.entries(tests).map(([id, evaluate], index) => {
    const check = receipt.checks[index], passedCount = rows.filter(evaluate).length, failedCount = rows.length - passedCount;
    requireEvidence(check?.id === id && check.evaluatedCount === rows.length && check.passedCount === passedCount &&
      check.failedCount === failedCount, 'QUALITY_COUNTS_CHANGED');
    return { id, passedCount, failedCount };
  });
  return checks;
}

export function verifySavedFundReportQuality({ store, reportStore, project, actor, requestId, source, context, fundSignedExecutionFor, timeUnitMs }) {
  const workflow = createPublishedReportWorkflow({ store, reportStore, project, fundSignedExecutionFor });
  const { lineage, rows, snapshot, version, run } = workflow.qualitySource(requestId, actor, timeUnitMs);
  const binding = lineage.source;
  const monitor = source.batches.find(batch => batch.id === source.batchId);
  requireEvidence(binding.kind === 'AGENT' && binding.taskId === source.agentTaskId &&
    ['releaseId', 'batchId', 'packageDigest', 'revisionId'].every(key => binding[key] === source[key]) &&
    binding.runId === source.developmentRunId && lineage.release.modelMode === source.modelMode &&
    lineage.release.businessDate === source.businessDate && lineage.release.resultDigest === source.resultDigest &&
    lineage.release.assertionDigest === source.assertionDigest && snapshot.contextId === context.id &&
    lineage.batch.monitorEvent.id === monitor?.monitorEventId && lineage.batch.finishedAt === monitor?.finishedAt &&
    same(snapshot.sourceEvidence.batches, source.batches), 'BATCH_MISMATCH');

  const key = publishedReportRequestKey(project, actor, requestId);
  const readLedger = store.db.prepare('SELECT result_id,signature FROM idempotency WHERE key=?');
  const creationId = store.deduplicatedId(key);
  const stages = { dataset: snapshot.datasetId, snapshot: snapshot.id, report: lineage.report.id, reportRun: run.id };
  for (const [name, id] of Object.entries(stages)) {
    const entry = readLedger.get(`${key}:${name}`);
    requireEvidence(entry?.result_id === id &&
      entry.signature === publishedReportHash({ id: creationId, name, sourceEvidenceHash: snapshot.assetEvidenceHash }),
      'STAGE_LEDGER_CHANGED');
  }

  const replay = executeDistributionReport({ version, snapshot: { rows, rowCount: rows.length, contentHash: snapshot.contentHash },
    metadata: snapshot, hash: publishedReportHash });
  requireEvidence(same(replay.widgets, run.widgets) && same(replay.distributionValidation, run.distributionValidation), 'RESULT_CHANGED');
  const report = { requestId, ...lineage.report, snapshotId: snapshot.id, snapshotHash: snapshot.contentHash,
    rowCount: rows.length, originalStagesVerified: Object.keys(stages), independentlyRechecked: true };

  const receipt = fundReportQuality({ store, project, actor, lineage });
  const records = store.list('quality_fund_report_check', project).filter(record =>
    record.basis?.requestId === requestId && record.basis.report?.runId === run.id);
  if (receipt.status === 'PENDING') {
    requireEvidence(records.length === 0, 'QUALITY_LEDGER_MISSING');
    return { report, quality: { status: 'NOT_RECORDED', ruleSet: receipt.ruleSet, basisDigest: receipt.basisDigest } };
  }
  requireEvidence(records.length === 1 && records[0].id === receipt.checkId &&
    Date.parse(lineage.batch.finishedAt) <= Date.parse(run.createdAt) &&
    Date.parse(run.createdAt) <= Date.parse(receipt.checkedAt), 'QUALITY_CHRONOLOGY_OR_LEDGER_CHANGED');
  const checks = verifyFundQualityCounts(receipt, rows);
  return { report, quality: { status: receipt.status === 'PASSED' ? 'VERIFIED' : 'FAILED', ruleSet: receipt.ruleSet,
    checkId: receipt.checkId, basisDigest: receipt.basisDigest, receiptDigest: receipt.receiptDigest,
    rowCount: rows.length, checks, independentlyRechecked: true } };
}
