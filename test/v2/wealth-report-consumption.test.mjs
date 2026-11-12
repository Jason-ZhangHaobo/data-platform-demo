import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataStore } from '../../src/v2/store.mjs';
import { BusinessQueryStore, DataServiceManager, dataServiceFields } from '../../src/v2/data-services.mjs';
import { ReportDataStore, ReportManager } from '../../src/v2/reports.mjs';
import { resolvePublishedReportSource } from '../../src/v2/published-report-source.mjs';
import { readWealthReportConsumption } from '../../src/v2/wealth-report-consumption.mjs';
import { checkedWealthReportConsumption } from '../../src/v2/wealth-report-consumption-client.mjs';
import { verifySavedWealthLifecycle } from '../../src/v2/wealth-saved-lifecycle.mjs';
import { resolveDeliverySchedule, validateDeliveryPackage } from '../../src/v2/delivery.mjs';
import { seedLocalServiceSource } from './fixtures/local-service-sources.mjs';

test('wealth report reads only original manual snapshot and complete historically authorized pages', async t => {
  const store = new MetadataStore(':memory:'), businessStore = new BusinessQueryStore(), reportStore = new ReportDataStore();
  t.after(() => { reportStore.close(); businessStore.close(); store.close(); });
  const project = 'synthetic-wealth', actor = 'local-engineer';
  const fixture = seedLocalServiceSource({ store, project });
  const { revision, codeRun, release, bundle, batches: [batch, sibling] } = fixture;
  store.update('revision', revision.id, project, { source: 'MANUAL', author: actor,
    manualProvenance: { actorId: actor, kind: 'ENGINEER_EDIT', agentIndependentE2E: false } });
  const plan = validateDeliveryPackage(bundle, bundle.digest), scheduledFor = '2026-09-11T09:00:00+08:00';
  const occurrence = resolveDeliverySchedule(plan, scheduledFor);
  const workflowTrace = plan.order.map(node => ({ id: node.id, kind: node.kind, status: 'SUCCEEDED' }));
  const time = seconds => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  store.update('release', release.id, project, { businessScheduledFor: scheduledFor });
  store.update('run', codeRun.id, project, { startedAt: time(4), finishedAt: time(5) });
  store.update('delivery_verification', fixture.verification.id, project, {
    scheduledFor, occurrence, workflowTrace, startedAt: time(6), finishedAt: time(7),
  });
  store.update('delivery_review', fixture.review.id, project, { reviewedAt: time(8) });
  store.update('release_approval', fixture.approval.id, project, { approvedAt: time(9) });
  for (const item of fixture.batches) store.update('release_run', item.id, project, { occurrence, workflowTrace });
  const source = { kind: 'MANUAL', releaseId: release.id, packageDigest: bundle.digest, revisionId: revision.id, runId: codeRun.id, batchId: batch.id };
  const resolve = pinned => resolvePublishedReportSource({ store, project, actorId: actor, source: pinned });
  let selectedBatch = batch.id;
  const reports = new ReportManager({ store, project, reportStore, assets: { reportRows: () => resolve({ ...source, batchId: selectedBatch }) } });
  const dataset = reports.createDataset({ assetId: 'dataset:customer_assets_t1', name: '虚构客户资产数据', code: 'wealth_asset', fields: dataServiceFields });
  reports.refreshDataset(dataset.id);
  const report = reports.createReport({ datasetId: dataset.id, name: '虚构客户资产报告', code: 'wealth_report', description: '已保存虚构客户资产',
    widgets: [{ id: 'total_assets', type: 'KPI', title: '总资产', aggregation: 'SUM', field: 'total_assets' }] });
  const original = reports.runReport(report.id).run;
  const read = (runId = original.id) => readWealthReportConsumption({ store, reportStore, businessStore, project, reportId: report.id, runId, actor });
  const manager = new DataServiceManager({ store, businessStore, project, releaseRunFor: id => store.get('release_run', id, project) });
  async function publish(draft) {
    await manager.test(draft.id);
    manager.publish(draft.id);
    return manager.detail(draft.id);
  }
  const holdings = await publish(manager.createDapi({ name: '虚构持仓', slug: 'wealth-holdings', sourceReleaseRunId: batch.id,
    fields: ['client_id', 'holding_market_value', 'security_count'] }));
  const cash = await publish(manager.createDapi({ name: '虚构现金', slug: 'wealth-cash', sourceReleaseRunId: batch.id,
    fields: ['client_id', 'available_cash', 'total_assets'] }));
  const combination = await publish(manager.createXapi({ name: '虚构组合', slug: 'wealth-combined', steps: [
    { dapiId: holdings.id, alias: 'holdings' }, { dapiId: cash.id, alias: 'cash' },
  ] }));
  async function call(service, pages) {
    const issued = manager.createApplication({ name: '虚构接口调用', serviceIds: [service.id] });
    const responses = [];
    for (const page of pages) responses.push(await manager.invoke(service.serviceType, service.slug, 'Bearer ' + issued.token, { page, pageSize: 1 }));
    manager.revokeApplication(issued.application.id);
    return responses;
  }
  const combinedCalls = await call(combination, [1, 2]);
  assert.equal(read().status, 'PENDING');
  const calls = await call(holdings, [1, 2]);
  const cashCalls = await call(cash, [1, 2]);
  const verified = read();
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.verifiedCalls, 6);
  assert.ok(!JSON.stringify(verified).includes('CLIENT-001'));
  assert.ok(verified.services.every(service => service.calls.every(receipt => receipt.applicationStatus === 'REVOKED')));
  assert.equal(checkedWealthReportConsumption(verified, { reportId: report.id, runId: original.id }), verified);
  assert.throws(() => checkedWealthReportConsumption(verified, { reportId: report.id, runId: report.id }));
  const mixedPages = structuredClone(verified);
  mixedPages.services.find(service => service.type === 'DAPI').calls[0].applicationId =
    mixedPages.services.find(service => service.type === 'XAPI').calls[0].applicationId;
  assert.throws(() => checkedWealthReportConsumption(mixedPages));
  const offline = { store, reportStore, businessStore, project, actor, reportId: report.id, runId: original.id,
    releaseId: release.id, batchId: batch.id, packageDigest: bundle.digest,
    dapiCallIds: [...calls, ...cashCalls].map(item => item.callId), xapiCallIds: combinedCalls.map(item => item.callId) };
  const audit = verifySavedWealthLifecycle(offline);
  assert.equal(audit.status, 'VERIFIED');
  assert.equal(audit.publication.batches.length, 2);
  assert.equal(audit.rehearsal.fileCount, 8);
  assert.deepEqual(verifySavedWealthLifecycle({ ...offline, dapiCallIds: offline.dapiCallIds.toReversed() }), audit);
  assert.throws(() => verifySavedWealthLifecycle({ ...offline, dapiCallIds: offline.dapiCallIds.slice(1) }),
    { code: 'WEALTH_SAVED_CONSUMPTION_UNPROVEN' });
  assert.throws(() => verifySavedWealthLifecycle({ ...offline, batchId: sibling.id }), { code: 'WEALTH_SAVED_REPORT_BATCH_CHANGED' });

  selectedBatch = sibling.id;
  reports.refreshDataset(dataset.id);
  reports.createReportVersion(report.id, {});
  const newer = reports.runReport(report.id).run;
  assert.equal(read(newer.id).status, 'PENDING');
  assert.equal(read(newer.id).source.batchId, sibling.id);
  assert.deepEqual(read(), verified);
  store.update('data_service_version', holdings.publishedVersionId, project, { status: 'RETIRED' });
  store.update('data_service', holdings.id, project, { publishedVersionId: cash.publishedVersionId });
  assert.deepEqual(read(), verified);
  store.update('service_call', calls[0].callId, project, { resultHash: 'f'.repeat(64) });
  const tampered = read();
  assert.equal(tampered.status, 'UNCONFIRMED');
  assert.equal(tampered.unconfirmedCalls, 1);
  assert.equal(tampered.verifiedCalls, 5);
  assert.throws(() => verifySavedWealthLifecycle(offline), { code: 'WEALTH_SAVED_CONSUMPTION_UNPROVEN' });
  assert.throws(() => readWealthReportConsumption({ store, reportStore, businessStore, project, reportId: report.id,
    runId: original.id, actor: 'another-engineer' }), { code: 'REPORT_SOURCE_OWNER' });
});
