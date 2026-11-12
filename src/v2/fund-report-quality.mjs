import { isDeepStrictEqual } from 'node:util';
import { publishedReportHash } from './published-report-source.mjs';
import { checkedFundReportQuality, fundQualityRules, fundQualityRuleSet, fundQualityProtocol } from './fund-report-quality-client.mjs';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const unproven = () => fail(409, 'FUND_REPORT_QUALITY_UNPROVEN', '原批次质量回执与报表快照不一致');

export function fundReportQuality({ store, project, actor, quality, lineage, rows, confirmation }) {
  const { requestId, source, report, snapshot, release } = lineage;
  const snapshotRef = { id: snapshot.id, contentHash: snapshot.contentHash, rowCount: snapshot.rowCount };
  const basis = { protocol: fundQualityProtocol, scope: 'LOCAL_TEST_ONLY', requestId, source, report,
    snapshot: snapshotRef, ruleSet: fundQualityRuleSet, businessDate: release.businessDate, publicDeployed: false };
  const rules = fundQualityRules(basis.businessDate);
  const basisDigest = publishedReportHash({ basis, rules });
  const key = `${project}:${fundQualityRuleSet}:${actor}:${requestId}`;
  const kind = 'quality_fund_report_check';
  const ledger = () => store.db.prepare('SELECT signature,result_id FROM idempotency WHERE key=?').get(key);
  const read = () => {
    const entry = ledger();
    if (!entry) return { ...basis, basisDigest, status: 'PENDING', actualExecution: false };
    const record = store.get(kind, entry.result_id, project);
    const receipt = record?.receipt;
    if (!receipt || entry.signature !== basisDigest || !isDeepStrictEqual(record.basis, basis) ||
        receipt.basisDigest !== basisDigest || record.receiptDigest !== publishedReportHash(receipt)) throw unproven();
    try {
      return checkedFundReportQuality({ ...basis, ...receipt, checkId: record.id, receiptDigest: record.receiptDigest }, { lineage });
    } catch { throw unproven(); }
  };
  if (confirmation === undefined) return read();
  if (!isDeepStrictEqual(confirmation, { confirm: true, snapshotId: snapshotRef.id, basisDigest }))
    throw fail(409, 'FUND_REPORT_QUALITY_CONFIRMATION_REQUIRED', '请重新核对并确认原报表快照和规则版本');
  if (!Array.isArray(rows) || rows.length !== snapshotRef.rowCount || publishedReportHash(rows) !== snapshotRef.contentHash)
    throw unproven();
  store.deduplicate(key, basisDigest, () => {
    const checks = rules.map(rule => ({ id: rule.id, ...quality.evaluateRows(rule, rows) }));
    const receipt = { basisDigest, status: checks.every(check => check.status === 'PASSED') ? 'PASSED' : 'FAILED',
      actualExecution: true, checkedAt: new Date().toISOString(), checks };
    return store.create(kind, project, { basis, receipt, receiptDigest: publishedReportHash(receipt) });
  });
  return read();
}
