// Pure policy + in-memory service engine contracts. Source receipts are
// synthetic; no cloud, model, Spark or external consumer is exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicServiceConfig, serviceSession, assertServiceMutation, createServicePilotGuard } from '../../src/v2/public-service-access.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { BusinessQueryStore, DataServiceManager, serviceHash } from '../../src/v2/data-services.mjs';

const now = Date.parse('2026-10-28T01:00:00Z'), taskId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const admin = { role: 'ADMIN', user: { id: 'synthetic-owner', email: 'owner@example.invalid' } };
const plan = () => ({ taskId, packageDigest: 'a'.repeat(64), sourceReleaseRunId: runId,
  dapis: [
    { name: '虚构持仓接口', slug: 'pilot-holdings', fields: ['client_id', 'holding_market_value', 'security_count'], timeoutMs: 1000, rateLimitPerMinute: 3 },
    { name: '虚构现金接口', slug: 'pilot-cash', fields: ['client_id', 'available_cash', 'total_assets'], timeoutMs: 1000, rateLimitPerMinute: 3 },
  ], xapi: { name: '虚构资产组合', slug: 'pilot-assets', timeoutMs: 1500, rateLimitPerMinute: 3,
    steps: [{ alias: 'holdings', dapiSlug: 'pilot-holdings' }, { alias: 'cash', dapiSlug: 'pilot-cash' }] }, applicationName: '虚构证券调用方' });
const env = value => ({ V2_FC_PUBLIC_WRITE_SCOPE: 'SERVICE_CONSUMPTION_ONLY', V2_LOCAL_DEVELOPMENT: 'false',
  V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid', V2_PUBLIC_SERVICE_STARTS_AT: new Date(now - 1000).toISOString(),
  V2_PUBLIC_SERVICE_EXPIRES_AT: new Date(now + 3600000).toISOString(), V2_PUBLIC_SERVICE_PLAN: JSON.stringify(value ?? plan()) });

test('only explicit consumption scope enables a deeply frozen, clock-independent plan identity', () => {
  for (const value of [undefined, '', 'DEVELOPMENT_ONLY', 'PUBLICATION_ONLY']) assert.equal(publicServiceConfig({ V2_FC_PUBLIC_WRITE_SCOPE: value }), undefined);
  const config = publicServiceConfig(env());
  assert.equal(config.pilotId, serviceHash(plan())); assert.equal(Object.isFrozen(config.plan.dapis[0].fields), true);
  assert.equal(publicServiceConfig({ ...env(), V2_PUBLIC_SERVICE_EXPIRES_AT: new Date(now + 5000).toISOString() }).pilotId, config.pilotId);
  assert.equal(publicServiceConfig({ ...env(), V2_BOOTSTRAP_ADMIN_EMAIL: ' OWNER@EXAMPLE.INVALID ' }).email, admin.user.email);
});

test('configuration rejects unknown capability fields, malformed identities and non-fixed service composition', () => {
  const mutations = [
    p => { p.taskId = [taskId]; }, p => { p.packageDigest = ['a'.repeat(64)]; }, p => { p.sourceReleaseRunId = 'other'; },
    p => { p.companySource = 'forbidden'; }, p => { p.dapis.push(p.dapis[0]); }, p => { p.dapis.pop(); },
    p => { p.dapis[0].fields = ['client_id', 'secret']; }, p => { p.dapis[0].fields = ['client_id', 'client_id']; },
    p => { p.dapis[0].fields = ['available_cash']; }, p => { p.dapis[0].timeoutMs = '1000'; },
    p => { p.dapis[0].rateLimitPerMinute = 601; }, p => { p.dapis[0].slug = '../private'; },
    p => { p.dapis[0].name = 'x'.repeat(81); }, p => { p.dapis[1].slug = p.dapis[0].slug; },
    p => { p.xapi.slug = p.dapis[0].slug; }, p => { p.xapi.steps[1].dapiSlug = p.dapis[0].slug; },
    p => { p.xapi.steps[0].alias = 'Bad'; }, p => { p.xapi.steps[1].alias = p.xapi.steps[0].alias; },
    p => { p.xapi.steps[0].dapiSlug = 'unknown'; }, p => { p.xapi.steps[0].url = 'https://example.invalid'; },
    p => { p.applicationName = ''; },
  ];
  for (const mutate of mutations) { const p = plan(); mutate(p); assert.throws(() => publicServiceConfig(env(p)), /PUBLIC_SERVICE_CONFIG_INVALID/); }
  for (const patch of [{ V2_LOCAL_DEVELOPMENT: 'true' }, { V2_PUBLIC_SERVICE_PLAN: '{}' }, { V2_PUBLIC_SERVICE_PLAN: 'x'.repeat(8193) },
    { V2_BOOTSTRAP_ADMIN_EMAIL: 'owner' }, { V2_PUBLIC_SERVICE_STARTS_AT: now },
    { V2_PUBLIC_SERVICE_EXPIRES_AT: new Date(now - 1000).toISOString() },
    { V2_PUBLIC_SERVICE_EXPIRES_AT: new Date(now + 7200000).toISOString() }])
    assert.throws(() => publicServiceConfig({ ...env(), ...patch }), /PUBLIC_SERVICE_CONFIG_INVALID/);
});

test('only the selected administrator sees the plan; the fixed window cannot be extended by a session', () => {
  const config = publicServiceConfig(env());
  const view = serviceSession(config, admin, now);
  assert.equal(view.readOnly, false); assert.equal(view.consumptionOnly, true);
  assert.deepEqual(view.permissions, ['SESSION', 'SERVICES']); assert.equal(view.consumptionPilotId, config.pilotId);
  assert.deepEqual(view.consumptionPlan, plan());
  for (const session of [undefined, {}, { ...admin, role: 'ENGINEER' }, { ...admin, user: { email: 'other@example.invalid' } }]) {
    const denied = serviceSession(config, session, now);
    assert.equal(denied.readOnly, true); assert.deepEqual(denied.permissions, ['SESSION']);
    for (const field of ['consumptionTaskId', 'consumptionPlan', 'consumptionPilotId']) assert.equal(Object.hasOwn(denied, field), false);
  }
  for (const clock of [config.startsAt - 1, config.expiresAt, NaN, Infinity]) assert.equal(serviceSession(config, admin, clock).readOnly, true);
});

test('only first-version service writes are allowed; selected application revocation remains possible after expiry', () => {
  const config = publicServiceConfig(env()), base = '/api/v2/data-services';
  for (const path of [`${base}/dapis`, `${base}/xapis`, `${base}/applications`, `${base}/dapis/${runId}/test`, `${base}/xapis/${runId}/publish`])
    assert.doesNotThrow(() => assertServiceMutation(config, admin, 'POST', path, now));
  for (const path of [`${base}/dapis/${runId}/versions`, `${base}/xapis/${runId}/activate`, '/api/v2/agent/tasks',
    '/api/v2/revisions', '/api/v2/runs', '/api/v2/auth/redeem', '/api/v2/auth/invitations', `${base}/dapis/`])
    assert.throws(() => assertServiceMutation(config, admin, 'POST', path, now), { code: 'PUBLIC_SERVICE_SCOPE_DENIED' });
  const revoke = `${base}/applications/${runId}/revoke`;
  assert.doesNotThrow(() => assertServiceMutation(config, admin, 'POST', revoke, config.expiresAt));
  assert.throws(() => assertServiceMutation(config, { ...admin, role: 'ENGINEER' }, 'POST', revoke, config.expiresAt), { code: 'PUBLIC_SERVICE_CLOSED' });
  assert.throws(() => assertServiceMutation(config, admin, 'POST', `${base}/dapis`, config.expiresAt), { code: 'PUBLIC_SERVICE_CLOSED' });
  assert.doesNotThrow(() => assertServiceMutation(config, undefined, 'GET', `${base}/dapis`, config.expiresAt));
  for (const path of ['/api/v2/auth/login', '/api/v2/auth/logout']) assert.doesNotThrow(() => assertServiceMutation(config, undefined, 'POST', path, config.expiresAt));
});

function fixture(t) {
  const store = new MetadataStore(':memory:'), businessStore = new BusinessQueryStore(); let clock = now;
  t.after(() => { store.close(); businessStore.close(); });
  const project = 'synthetic-securities-project';
  const release = store.create('release', project, { sourceAgentTaskId: taskId, packageDigest: 'a'.repeat(64) });
  const run = store.create('release_run', project, { releaseId: release.id, packageDigest: 'a'.repeat(64), status: 'SUCCEEDED',
    published: true, schedulerTriggered: true, publicDeployed: false, engine: 'Apache Spark', engineVersion: '3.5.9',
    mainSqlExecuted: true, testSqlValidation: { passed: true }, validation: { passed: true },
    rows: [{ client_id: 'CLIENT-001', holding_market_value: '1500.00', available_cash: '300.00', total_assets: '1800.00', security_count: 2 }] });
  const p = { ...plan(), sourceReleaseRunId: run.id }, config = publicServiceConfig(env(p));
  const source = id => store.get('release_run', id, project);
  const manager = new DataServiceManager({ store, businessStore, project, scope: 'PRIVATE_CLOUD_TEST', releaseRunFor: source, verifySource: sourceRun => sourceRun, now: () => clock });
  const guard = createServicePilotGuard({ config, store, project, source, detail: id => manager.detail(id), now: () => clock });
  const dapiBody = index => ({ ...p.dapis[index], sourceReleaseRunId: run.id });
  const createDapi = index => {
    const body = dapiBody(index); guard.assertCreate('DAPI', body); const item = manager.createDapi(body);
    store.update('data_service', item.id, project, { scope: 'PRIVATE_CLOUD_TEST', ...guard.recordTags }); return manager.detail(item.id);
  };
  const publish = async item => { guard.assertService(item); await manager.test(item.id); manager.publish(item.id); return manager.detail(item.id); };
  const xapiBody = dapis => ({ name: p.xapi.name, slug: p.xapi.slug, timeoutMs: p.xapi.timeoutMs, rateLimitPerMinute: p.xapi.rateLimitPerMinute,
    steps: p.xapi.steps.map((step, index) => ({ alias: step.alias, dapiId: dapis[index].id, dapiVersionId: dapis[index].publishedVersionId })) });
  return { store, project, manager, guard, config, release, run, dapiBody, createDapi, publish, xapiBody,
    expire: () => { clock = config.expiresAt; } };
}

test('exact DAPI slots and source lineage are checked before materialization; duplicate requests must use outer dedup', t => {
  const f = fixture(t), body = f.dapiBody(0);
  for (const change of [{ sourceReleaseRunId: otherId }, { fields: ['client_id', 'total_assets'] }, { timeoutMs: 2000 }, { name: 'other' }, { arbitrary: true }])
    assert.throws(() => f.guard.assertCreate('DAPI', { ...body, ...change }), { code: 'PUBLIC_SERVICE_TARGET_MISMATCH' });
  const created = f.createDapi(0); assert.doesNotThrow(() => f.guard.assertService(created));
  assert.throws(() => f.guard.assertCreate('DAPI', body), { code: 'PUBLIC_SERVICE_SLOT_USED' });
  f.store.update('release', f.release.id, f.project, { sourceAgentTaskId: otherId });
  assert.throws(() => f.guard.assertService(created), { code: 'PUBLIC_SERVICE_TARGET_MISMATCH' });
  assert.equal(f.store.list('data_service', f.project).length, 1);
});

test('XAPI only combines this pilot exact published DAPI versions and rejects historic or different source services', async t => {
  const f = fixture(t), dapis = [f.createDapi(0), f.createDapi(1)];
  assert.throws(() => f.guard.assertCreate('XAPI', f.xapiBody(dapis)), { code: 'PUBLIC_SERVICE_TARGET_MISMATCH' });
  const published = await Promise.all(dapis.map(f.publish)); const body = f.xapiBody(published);
  assert.doesNotThrow(() => f.guard.assertCreate('XAPI', body));
  const wrong = structuredClone(body); wrong.steps[0].dapiVersionId = otherId;
  assert.throws(() => f.guard.assertCreate('XAPI', wrong), { code: 'PUBLIC_SERVICE_TARGET_MISMATCH' });
  f.store.update('data_service', published[0].id, f.project, { pilotId: 'b'.repeat(64) });
  assert.throws(() => f.guard.assertCreate('XAPI', body), { code: 'PUBLIC_SERVICE_TARGET_MISMATCH' });
});

test('one short-term application has only a nonempty subset of the three pilot services and cannot be renewed by revoke', async t => {
  const f = fixture(t), dapis = await Promise.all([f.createDapi(0), f.createDapi(1)].map(f.publish));
  const body = f.xapiBody(dapis); f.guard.assertCreate('XAPI', body);
  const xapi = f.manager.createXapi(body); f.store.update('data_service', xapi.id, f.project, { scope: 'PRIVATE_CLOUD_TEST', ...f.guard.recordTags });
  const published = await f.publish(f.manager.detail(xapi.id));
  const application = { name: f.config.plan.applicationName, serviceIds: [dapis[0].id, published.id] };
  assert.doesNotThrow(() => f.guard.assertApplicationCreate(application));
  for (const change of [{ name: 'another' }, { serviceIds: [] }, { serviceIds: [otherId] }, { serviceIds: [published.id, published.id] }, { expiresAt: 'later' }])
    assert.throws(() => f.guard.assertApplicationCreate({ ...application, ...change }));
  const app = f.store.create('service_app', f.project, { ...application, scope: 'PRIVATE_CLOUD_TEST', status: 'ACTIVE', ...f.guard.applicationTags });
  assert.equal(app.expiresAt, new Date(f.config.expiresAt).toISOString()); assert.doesNotThrow(() => f.guard.assertApplication(app));
  f.store.update('service_app', app.id, f.project, { status: 'REVOKED' });
  assert.throws(() => f.guard.assertApplicationCreate(application), { code: 'PUBLIC_SERVICE_APPLICATION_USED' });
  f.expire(); assert.doesNotThrow(() => f.guard.assertApplication(app));
  assert.doesNotThrow(() => f.guard.assertService(published));
  assert.throws(() => f.guard.assertApplicationCreate(application), { code: 'PUBLIC_SERVICE_CLOSED' });
});

test('no configured scope leaves legacy guards untouched', () => {
  assert.equal(serviceSession(undefined, admin, now), undefined);
  assert.doesNotThrow(() => assertServiceMutation(undefined, undefined, 'POST', '/anything', NaN));
  const guard = createServicePilotGuard({});
  assert.doesNotThrow(() => guard.assertCreate('ANYTHING', {})); assert.deepEqual(guard.recordTags, {}); assert.deepEqual(guard.applicationTags, {});
});
