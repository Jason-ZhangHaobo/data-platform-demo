import { publishedReportSource, reportRequestId } from './published-report-request.mjs';

export const fundQualityProtocol = 'shuduo-fund-report-quality/v1';
export const fundQualityRuleSet = 'fund-snapshot-quality/v1';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function fundQualityRules(businessDate) {
  return [
    { id: 'trade-date', name: '交易日等于发布业务日', field: 'trade_date', type: 'ALLOWED_VALUES', config: { values: [businessDate] } },
    { id: 'asset-class', name: '资产类别非空', field: 'asset_class', type: 'NOT_NULL', config: {} },
    { id: 'exposure-amount', name: '敞口金额符合非负两位小数范围', field: 'exposure_amount', type: 'VALUE_RANGE',
      config: { min: '0.00', max: '999999999999999999.99' } },
  ];
}

export function checkedFundReportQuality(value, { requestId, lineage } = {}) {
  const bad = () => { throw Error('原报表质量检测的批次、快照或规则回执无法核对'); };
  if (value?.protocol !== fundQualityProtocol || value.scope !== 'LOCAL_TEST_ONLY' || value.publicDeployed !== false ||
      value.ruleSet !== fundQualityRuleSet || !hash(value.basisDigest) ||
      !['PENDING', 'PASSED', 'FAILED'].includes(value.status)) bad();
  const { report, snapshot, source, businessDate, status, checks } = value;
  const binding = publishedReportSource(source);
  try {
    for (const id of [value.requestId, report?.id, report?.versionId, report?.runId, snapshot?.id]) reportRequestId(id);
  } catch { bad(); }
  if (requestId && value.requestId !== requestId || !hash(report.resultHash) || !hash(snapshot.contentHash) ||
      !Number.isSafeInteger(snapshot.rowCount) || snapshot.rowCount < 1 || snapshot.rowCount > 1000 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) bad();
  if (lineage && (JSON.stringify(binding) !== JSON.stringify(publishedReportSource(lineage.source)) ||
      value.requestId !== lineage.requestId || ['id', 'versionId', 'runId', 'resultHash'].some(key => report[key] !== lineage.report[key]) ||
      ['id', 'contentHash', 'rowCount'].some(key => snapshot[key] !== lineage.snapshot[key]) || businessDate !== lineage.release.businessDate)) bad();
  if (status === 'PENDING') {
    if (value.actualExecution !== false || checks !== undefined || value.checkId !== undefined || value.receiptDigest !== undefined) bad();
    return value;
  }
  try { reportRequestId(value.checkId); } catch { bad(); }
  const rules = fundQualityRules(businessDate);
  if (value.actualExecution !== true || !hash(value.receiptDigest) || !Number.isFinite(Date.parse(value.checkedAt)) ||
      !Array.isArray(checks) || checks.length !== rules.length) bad();
  if (checks.some((check, index) => !check || check.id !== rules[index].id || check.evaluatedCount !== snapshot.rowCount ||
      !Number.isSafeInteger(check.failedCount) || check.failedCount < 0 || check.failedCount > snapshot.rowCount ||
      check.passedCount !== snapshot.rowCount - check.failedCount || check.status !== (check.failedCount ? 'FAILED' : 'PASSED') ||
      check.actualExecution !== true || check.fullLifecycleE2E !== false ||
      check.passRate !== Number((check.passedCount / snapshot.rowCount).toFixed(4)) ||
      !Number.isSafeInteger(check.durationMs) || check.durationMs < 0 || check.invalidRowHashes !== undefined)) bad();
  if ((status === 'PASSED') !== checks.every(check => check.status === 'PASSED')) bad();
  return value;
}

export async function readFundReportQuality(client, { requestId, lineage }) {
  const id = reportRequestId(requestId);
  return checkedFundReportQuality(await client.request(`/reports/published/requests/${id}/quality`), { requestId: id, lineage });
}

export async function runFundReportQuality(client, { requestId, snapshotId, basisDigest, confirm }, lineage) {
  const id = reportRequestId(requestId);
  reportRequestId(snapshotId);
  if (!hash(basisDigest) || confirm !== true) throw Error('请先核对原快照和质量规则版本，再明确确认检测');
  const result = checkedFundReportQuality(await client.request(`/reports/published/requests/${id}/quality`, {
    method: 'POST', body: { confirm, snapshotId, basisDigest },
  }), { requestId: id, lineage });
  if (result.status === 'PENDING' || result.snapshot.id !== snapshotId || result.basisDigest !== basisDigest)
    throw Error('未确认原快照的质量检测回执，请重新读取');
  return result;
}
