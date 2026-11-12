import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MetadataStore } from '../../src/v2/store.mjs';
import { QualityManager } from '../../src/v2/quality.mjs';
import { publishedReportHash } from '../../src/v2/published-report-source.mjs';
import { fundReportQuality } from '../../src/v2/fund-report-quality.mjs';
import { checkedFundReportQuality, readFundReportQuality, runFundReportQuality } from '../../src/v2/fund-report-quality-client.mjs';

test('fund report quality measures each rule on a pinned snapshot and recovers one original receipt', async t => {
  const store = new MetadataStore(':memory:'), project = 'fixture';
  t.after(() => store.close());
  const rows = [
    { trade_date: '2026-09-11', asset_class: '债券', exposure_amount: '0.01' },
    { trade_date: '2026-09-10', asset_class: '', exposure_amount: '-0.01' },
  ];
  const quality = new QualityManager({ store, project, now: () => 500 });
  const lineage = { requestId: randomUUID(),
    source: { kind: 'AGENT', taskId: randomUUID(), releaseId: randomUUID(), batchId: randomUUID(), revisionId: randomUUID(),
      runId: randomUUID(), packageDigest: 'a'.repeat(64) },
    report: { id: randomUUID(), runId: randomUUID(), versionId: randomUUID(), resultHash: 'b'.repeat(64) },
    snapshot: { id: randomUUID(), contentHash: publishedReportHash(rows), rowCount: rows.length },
    release: { businessDate: '2026-09-11' } };
  const args = { store, project, actor: 'owner', quality, lineage, rows };
  const pending = fundReportQuality(args);
  assert.equal(pending.status, 'PENDING');
  assert.equal(store.list('quality_fund_report_check', project).length, 0);
  const confirmation = { confirm: true, snapshotId: pending.snapshot.id, basisDigest: pending.basisDigest };
  assert.throws(() => fundReportQuality({ ...args, confirmation: { ...confirmation, snapshotId: randomUUID() } }),
    { code: 'FUND_REPORT_QUALITY_CONFIRMATION_REQUIRED' });
  assert.throws(() => fundReportQuality({ ...args, rows: rows.slice(1), confirmation }), { code: 'FUND_REPORT_QUALITY_UNPROVEN' });

  const client = { request: async (path, options) => {
    assert.equal(path, `/reports/published/requests/${lineage.requestId}/quality`);
    return fundReportQuality({ ...args, confirmation: options?.body });
  } };
  await assert.rejects(runFundReportQuality(client, { ...confirmation, confirm: false, requestId: lineage.requestId }));
  const result = await runFundReportQuality(client, { ...confirmation, requestId: lineage.requestId }, lineage);
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(result.checks.map(check => [check.id, check.passedCount, check.failedCount]),
    [['trade-date', 1, 1], ['asset-class', 1, 1], ['exposure-amount', 1, 1]]);
  assert.ok(!JSON.stringify(result).includes('债券'));
  assert.deepEqual(await readFundReportQuality(client, { requestId: lineage.requestId, lineage }), result);
  assert.deepEqual(fundReportQuality({ ...args, confirmation }), result);
  assert.equal(store.list('quality_fund_report_check', project).length, 1);
  assert.equal(fundReportQuality({ ...args, actor: 'other-owner' }).status, 'PENDING');

  const wrongBatch = { ...lineage, source: { ...lineage.source, batchId: randomUUID() } };
  assert.throws(() => fundReportQuality({ ...args, lineage: wrongBatch }), { code: 'FUND_REPORT_QUALITY_UNPROVEN' });
  assert.throws(() => checkedFundReportQuality(result, { lineage: wrongBatch }));
  const record = store.get('quality_fund_report_check', result.checkId, project);
  store.update('quality_fund_report_check', result.checkId, project, { receipt: { ...record.receipt, status: 'PASSED' } });
  assert.throws(() => fundReportQuality(args), { code: 'FUND_REPORT_QUALITY_UNPROVEN' });
});
