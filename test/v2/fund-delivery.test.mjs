import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliveryPackage, validateDeliveryPackage, deliveryFiles, sha256, computeManifestDigest, unpackDeliveryPackage } from '../../src/v2/delivery.mjs';
import { verifyDeliveryDirectory } from '../../src/v2/delivery-runner.mjs';
import { fundContext, fundReferenceSql } from '../../src/v2/fund-lookthrough.mjs';
import { fundDeliveryBinding } from '../../src/v2/fund-delivery.mjs';
import { deliverySourceSelection } from '../../web/src/delivery-source.ts';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { LocalArtifactStore } from '../../src/v2/artifact-store.mjs';
import { loadDeliveryDirectory } from '../../src/v2/delivery.mjs';
import { resolvePublishedReportSource } from '../../src/v2/published-report-source.mjs';
import { resolveFundConsumptionSource } from '../../src/v2/fund-consumption-source.mjs';

function fixture() {
  const context = fundContext(), binding = fundDeliveryBinding();
  const revision = { id: 'fund-revision', projectId: 'demo', contextId: context.id, sql: fundReferenceSql,
    hash: sha256(fundReferenceSql), source: 'MANUAL', author: 'engineer',
    manualProvenance: { kind: 'ENGINEER_EDIT', actorId: 'engineer', agentIndependentE2E: false } };
  const inputEvidence = { protocol: 'shuduo-spark-execution-input/v1', scope: 'MANAGER_SCOPED_REGISTERED_TABLES',
    contextId: context.id, inputHash: binding.inputHash, schemaHash: binding.schemaHash, tableCount: 3 };
  const assertionEvidence = { protocol: 'shuduo-securities-assertion-evidence/v1', verifierRevision: 'fund-lookthrough-v1',
    contentHash: binding.assertionHash };
  const run = { id: 'fund-run', revisionId: revision.id, revisionHash: revision.hash, projectId: revision.projectId,
    contextId: context.id, validationContractId: binding.contractId, status: 'SUCCEEDED', finishedAt: '2026-09-11T01:00:00.000Z',
    engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true, rows: context.expected, inputEvidence,
    validation: { passed: true, selectedPassed: true, contractId: binding.contractId, assertionEvidence,
      regressions: [{ contextId: context.id, passed: true, inputEvidence, assertionEvidence }] } };
  return { run, revision, binding };
}

test('fund files pin the original local run, scoped input and independent result', () => {
  const { run, revision, binding } = fixture();
  const bundle = createDeliveryPackage({ run, revision });
  const plan = validateDeliveryPackage(bundle, bundle.digest);
  assert.deepEqual(Object.keys(bundle.files).sort(), [...deliveryFiles].sort());
  assert.deepEqual(plan.source.fundLookthrough, binding);
  assert.equal(plan.source.attribution.kind, 'ENGINEER_AUTHORED');
  assert.match(bundle.files['tests.sql'], /未穿透.*450\.00/);
  assert.equal(plan.deployment.adapter, 'local-spark-v1');
  assert.equal(createDeliveryPackage({ run, revision }).digest, bundle.digest);
  assert.equal(deliverySourceSelection([run]).source, run.id);
  for (const bad of [{ ...run, isolation: 'FUNCTION_PROCESS' }, { ...run, rows: run.rows.slice(1) },
    { ...run, inputEvidence: { ...run.inputEvidence, inputHash: 'a'.repeat(64) } }]) {
    assert.throws(() => createDeliveryPackage({ run: bad, revision }), /本机真实 Spark/);
  }
});

test('fund file validation rejects a rehashed wrong date or weakened assertion', () => {
  const original = createDeliveryPackage(fixture());
  for (const mutate of [
    bundle => { bundle.manifest.source.fundLookthrough.businessDate = '2026-09-09'; },
    bundle => {
      bundle.files['tests.sql'] = 'SELECT true AS passed';
      bundle.manifest.files['tests.sql'] = { sha256: sha256(bundle.files['tests.sql']), bytes: Buffer.byteLength(bundle.files['tests.sql']) };
    },
  ]) {
    const bundle = structuredClone(original);
    mutate(bundle);
    bundle.digest = computeManifestDigest(bundle.manifest);
    assert.throws(() => validateDeliveryPackage(bundle, bundle.digest), { code: 'FUND_DELIVERY_CONTRACT_MISMATCH' });
  }
});

test('a passing fund test SQL cannot override a mismatched file-run input', async t => {
  const input = fixture(), bundle = createDeliveryPackage(input);
  const root = mkdtempSync(join(tmpdir(), 'fund-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = unpackDeliveryPackage(bundle, join(root, 'files'), bundle.digest);
  const receipt = await verifyDeliveryDirectory({ directory, expectedDigest: bundle.digest, scheduledFor: '2026-09-11T09:00:00+08:00' }, {
    runner: async () => ({ ...input.run, inputEvidence: { ...input.run.inputEvidence, inputHash: 'b'.repeat(64) },
      testSqlValidation: { passed: true, sqlHash: sha256(bundle.files['tests.sql']) } }),
  });
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.published, false);
});

async function publicationFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fund-publication-'));
  const store = new MetadataStore(':memory:');
  const input = fixture();
  const revision = store.create('revision', PROJECT, { ...input.revision, projectId: PROJECT });
  const source = store.create('run', PROJECT, { ...input.run, projectId: PROJECT, revisionId: revision.id });
  let clock = Date.parse('2026-09-11T01:00:00Z'), releaseCalls = 0;
  const replayFiles = args => {
    const { bundle } = loadDeliveryDirectory(args.directory, args.expectedDigest);
    return verifyDeliveryDirectory(args, { runner: async () => ({ ...input.run, executionEvidenceMode: 'LOCAL_SPARK_PROCESS',
      testSqlValidation: { passed: true, sqlHash: sha256(bundle.files['tests.sql']) } }) });
  };
  const app = createV2Server({ root, store, artifactStore: new LocalArtifactStore(join(root, 'objects')),
    env: { V2_LOCAL_DEVELOPMENT: 'true', V2_RELEASE_SCHEDULER_MODE: 'LOCAL_TIMER' }, now: () => clock,
    setTimer: () => ({ unref() {} }), clearTimer: () => {}, deliveryRunner: replayFiles,
    releaseRunner: args => { releaseCalls++; return replayFiles(args); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  let request = 0;
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', 'idempotency-key': `fund-test-${++request}` },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json(), cacheControl: r.headers.get('cache-control') };
  };
  const created = await call('/delivery/packages', { sourceRunId: source.id, name: '合成基金发布测试夹具' });
  assert.equal(created.status, 201);
  const bundle = created.body, path = `/delivery/packages/${bundle.id}`;
  const accepted = await call(path + '/verify', { scheduledFor: '2026-09-11T09:00:00+08:00' });
  assert.equal(accepted.status, 202);
  let verification;
  for (let n = 0; n < 30; n++) {
    verification = (await call(`/delivery/verifications/${accepted.body.id}`)).body;
    if (verification.status === 'SUCCEEDED') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(verification.status, 'SUCCEEDED');
  const reviewInput = { packageDigest: bundle.digest, verificationId: verification.id, reviewNote: '仅用于合成测试夹具',
    attestations: { code: true, assertions: true, deliveryFiles: true, localScope: true } };
  const approve = (reviewId, fundConsent) => call(path + '/approve', { packageDigest: bundle.digest, reviewId, fundConsent });
  const consent = { scope: 'LOCAL_TEST_RELEASE', packageDigest: bundle.digest, verificationId: verification.id,
    businessDate: '2026-09-10', scheduleSpec: { triggerAfterSeconds: 1, intervalSeconds: 1, runCount: 2 }, confirmFrozenFictionalData: true };
  return { app, bundle, path, verification, reviewInput, approve, consent, call, store,
    calls: () => releaseCalls, at: time => { clock = Date.parse(time); } };
}

test('fixture fund publication requires exact evidence and one explicit two-batch approval', async t => {
  const f = await publicationFixture(t);
  const wrong = f.store.create('delivery_verification', PROJECT, { ...f.verification,
    occurrence: { ...f.verification.occurrence, businessDate: '2026-09-09' } });
  assert.equal((await f.call(f.path + '/review', { ...f.reviewInput, verificationId: wrong.id })).status, 409);
  const review = await f.call(f.path + '/review', f.reviewInput);
  assert.equal(review.status, 201);
  for (const consent of [undefined, { ...f.consent, businessDate: '2026-09-09' },
    { ...f.consent, scheduleSpec: { ...f.consent.scheduleSpec, runCount: 3 } }])
    assert.equal((await f.approve(review.body.id, consent)).status, 409);
  const approved = await f.approve(review.body.id, f.consent);
  assert.equal(approved.status, 201);
  assert.equal(f.store.list('release', PROJECT).length, 0);
  assert.equal((await f.call('/releases', { approvalId: approved.body.id, ...f.consent.scheduleSpec, intervalSeconds: 2 })).status, 409);
  const legacyPackage = f.store.create('delivery_package', PROJECT, { manifest: { source: {} } });
  const legacy = f.store.create('release', PROJECT, { status: 'ACTIVE_LOCAL', packageId: legacyPackage.id });
  const request = { approvalId: approved.body.id, ...f.consent.scheduleSpec };
  const releases = await Promise.all([f.call('/releases', request), f.call('/releases', request)]);
  assert.deepEqual(releases.map(r => r.status).sort(), [200, 201]);
  const id = releases[0].body.id;
  assert.equal(releases[1].body.id, id);
  assert.equal(f.store.get('release', legacy.id, PROJECT).status, 'ACTIVE_LOCAL');
  const runs = f.store.list('release_run', PROJECT).sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(runs.map(r => r.sequence), [1, 2]);
  await f.app.releaseScheduler.executeRun(runs[0].id);
  assert.equal(f.calls(), 0);
  for (const run of runs) {
    f.at(run.scheduledTriggerAt);
    assert.equal((await f.app.releaseScheduler.executeRun(run.id)).status, 'SUCCEEDED');
  }
  assert.equal(f.calls(), 2);
  assert.equal(f.store.get('release', id, PROJECT).health, 'HEALTHY');
  const dapi = await f.call('/data-services/dapis', { name: '基金批次不能作为客户来源', slug: 'fund-legacy-source', sourceReleaseRunId: runs[0].id });
  assert.equal(dapi.status, 422);
  assert.match(dapi.body.message, /基金组合穿透/);
  const { revisionId, runId } = f.bundle.manifest.source;
  assert.throws(() => resolvePublishedReportSource({ store: f.store, project: PROJECT, actorId: 'local-engineer',
    source: { kind: 'MANUAL', releaseId: id, revisionId, runId, packageDigest: f.bundle.digest, batchId: runs[0].id } }),
  error => error.code === 'REPORT_SOURCE_UNSUPPORTED');
});

test('a fund fixture with a changed batch date never calls the runner', async t => {
  const f = await publicationFixture(t);
  const review = await f.call(f.path + '/review', f.reviewInput);
  const approval = await f.approve(review.body.id, f.consent);
  const release = await f.call('/releases', { approvalId: approval.body.id, ...f.consent.scheduleSpec });
  assert.equal(release.status, 201);
  const first = f.store.list('release_run', PROJECT).find(run => run.sequence === 1);
  f.store.update('release_run', first.id, PROJECT, { businessScheduledFor: '2026-09-14T09:00:00+08:00' });
  f.at(first.scheduledTriggerAt);
  assert.equal((await f.app.releaseScheduler.executeRun(first.id)).status, 'FAILED');
  assert.equal(f.calls(), 0);
  assert.equal(f.store.get('release', release.body.id, PROJECT).health, 'CRITICAL');
  f.store.update('release_run', first.id, PROJECT, { businessScheduledFor: first.businessScheduledFor });
  const second = f.store.list('release_run', PROJECT).find(run => run.sequence === 2);
  f.at(second.scheduledTriggerAt);
  assert.equal((await f.app.releaseScheduler.executeRun(second.id)).status, 'SUCCEEDED');
  assert.equal(f.calls(), 1);
  assert.equal(f.store.get('release', release.body.id, PROJECT).health, 'CRITICAL');
  assert.deepEqual(f.store.list('monitor_alert', PROJECT).map(alert => [alert.releaseRunId, alert.status]), [[first.id, 'OPEN']]);
});

test('advancing a fund batch clock cannot override the approved schedule', async t => {
  const f = await publicationFixture(t);
  const review = await f.call(f.path + '/review', f.reviewInput);
  const approval = await f.approve(review.body.id, f.consent);
  const release = await f.call('/releases', { approvalId: approval.body.id, ...f.consent.scheduleSpec });
  const first = f.store.list('release_run', PROJECT).find(run => run.sequence === 1);
  f.store.update('release_run', first.id, PROJECT, { scheduledTriggerAt: release.body.activatedAt });
  assert.equal((await f.app.releaseScheduler.executeRun(first.id)).status, 'FAILED');
  assert.equal(f.calls(), 0);
});

test('stopping a fund fixture prevents both original batches from running', async t => {
  const f = await publicationFixture(t);
  const review = await f.call(f.path + '/review', f.reviewInput);
  const approval = await f.approve(review.body.id, f.consent);
  const release = await f.call('/releases', { approvalId: approval.body.id, ...f.consent.scheduleSpec });
  assert.equal(release.status, 201);
  const path = `/releases/${release.body.id}/cancel`;
  assert.equal((await f.call(path, { packageDigest: 'a'.repeat(64) })).status, 409);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal((await f.call(path, { packageDigest: f.bundle.digest })).body.status, 'CANCELLED');
  const runs = f.store.list('release_run', PROJECT);
  assert.equal(runs.length, 2);
  for (const run of runs) {
    f.at(run.scheduledTriggerAt);
    await f.app.releaseScheduler.executeRun(run.id);
    assert.equal(f.store.get('release_run', run.id, PROJECT).status, 'CANCELLED');
  }
  assert.equal(f.calls(), 0);
  assert.equal(f.store.list('monitor_alert', PROJECT).length, 0);
  assert.equal(f.store.list('monitor_event', PROJECT).filter(event => event.type === 'RELEASE_CANCELLED').length, 1);
});

test('fund service source reads one exact batch only after verifying both and labels synthetic execution', async t => {
  const f = await publicationFixture(t);
  const review = await f.call(f.path + '/review', f.reviewInput);
  const approval = await f.approve(review.body.id, f.consent);
  const release = await f.call('/releases', { approvalId: approval.body.id, ...f.consent.scheduleSpec });
  assert.equal(release.status, 201);
  const releaseId = release.body.id, packageDigest = f.bundle.digest;
  const [first, second] = f.store.list('release_run', PROJECT).sort((a, b) => a.sequence - b.sequence);
  const query = new URLSearchParams({ release_id: releaseId, package_digest: packageDigest });
  const path = (batchId = first.id, params = query) => `/data-services/fund-sources/${batchId}?${params}`;
  f.at(first.scheduledTriggerAt);
  await f.app.releaseScheduler.executeRun(first.id);
  assert.equal((await f.call(path())).status, 409);
  f.at(second.scheduledTriggerAt);
  await f.app.releaseScheduler.executeRun(second.id);
  const { status, body, cacheControl } = await f.call(path());
  assert.equal(status, 200, body.message);
  assert.equal(cacheControl, 'no-store');
  assert.deepEqual(body.keyFields, ['portfolio_id', 'trade_date', 'asset_class']);
  assert.equal(body.businessDate, '2026-09-10');
  assert.equal(body.batchId, first.id);
  assert.equal(body.rowCount, 7);
  assert.deepEqual(body.batches.map(batch => batch.id), [first.id, second.id]);
  assert.equal(body.engineClassification, 'TEST_HARNESS');
  assert.equal(body.eligibleForService, false);
  assert.equal(body.agentIndependentE2E, false);
  assert.equal(body.publicDeployed, false);
  for (const value of ['rows', 'exposure_amount', 'main.sql', 'approvalId']) assert.equal(JSON.stringify(body).includes(value), false);
  assert.equal(resolveFundConsumptionSource({ store: f.store, project: PROJECT,
    selection: { releaseId, packageDigest, batchId: first.id } }).rows, undefined);
  const other = await f.call(path(second.id));
  assert.equal(other.body.batchId, second.id);
  assert.equal(other.body.resultDigest, body.resultDigest);
  assert.equal((await f.call(path(first.id, query + '&release_id=' + releaseId))).status, 422);
  assert.equal((await f.call(path(first.id, new URLSearchParams({ release_id: releaseId, package_digest: '0'.repeat(64) })))).status, 409);
  assert.equal((await f.call(path('00000000-0000-0000-0000-000000000000'))).status, 409);

  const run = f.store.get('release_run', second.id, PROJECT);
  const event = f.store.list('monitor_event', PROJECT).find(item => item.releaseRunId === second.id);
  for (const [kind, record, field, value] of [
    ['release_run', run, 'rows', run.rows.map((row, index) => index === 0 ? { ...row, exposure_amount: '0.00' } : row)],
    ['release_run', run, 'fileHashes', { ...run.fileHashes, 'tests.sql': 'a'.repeat(64) }],
    ['release_run', run, 'executionEvidenceMode', 'LOCAL_SPARK_PROCESS'],
    ['monitor_event', event, 'status', 'FAILED'],
  ]) {
    f.store.update(kind, record.id, PROJECT, { [field]: value });
    assert.equal((await f.call(path())).status, 409);
    f.store.update(kind, record.id, PROJECT, { [field]: record[field] });
  }
  const before = f.store.get('release_run', first.id, PROJECT).version;
  assert.deepEqual((await f.call(path())).body, body);
  assert.equal(f.store.get('release_run', first.id, PROJECT).version, before);
  f.store.create('monitor_alert', PROJECT, { releaseId, releaseRunId: first.id, status: 'OPEN' });
  assert.equal((await f.call(path())).status, 409);
  assert.equal(f.calls(), 2);
  assert.equal(f.store.list('data_service', PROJECT).length, 0);
  assert.equal(f.store.list('service_call', PROJECT).length, 0);
});
