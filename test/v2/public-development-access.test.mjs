import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { createFcIngress } from '../../src/v2/fc-ingress.mjs';
import { publicDevelopmentConfig, developmentSession, assertDevelopmentMutation, assertDevelopmentTaskCreation, assertDevelopmentRecord, developmentBackgroundWindow, assertDevelopmentExecutionWindow } from '../../src/v2/public-development-access.mjs';

const address = 'owner@example.invalid';
const settings = now => ({ V2_LOCAL_DEVELOPMENT: 'false', V2_DURABLE_SQL_AGENT_ENABLED: 'true', V2_FC_PUBLIC_WRITE_SCOPE: 'DEVELOPMENT_ONLY', V2_PUBLIC_DEVELOPMENT_STARTS_AT: new Date(now - 1000).toISOString(), V2_PUBLIC_DEVELOPMENT_EXPIRES_AT: new Date(now + 3600000).toISOString(), V2_BOOTSTRAP_ADMIN_EMAIL: address });
const session = { role: 'ADMIN', user: { id: 'synthetic-owner', email: address } };

test('development rollout is opt-in, bounded in time and bound to the existing account', () => {
  const now = Date.now(), env = settings(now), config = publicDevelopmentConfig(env);
  assert.equal(publicDevelopmentConfig({}), undefined);
  assert.throws(() => publicDevelopmentConfig({ ...env, V2_FC_PUBLIC_WRITE_SCOPE: 'ALL' }), /INVALID/);
  assert.throws(() => publicDevelopmentConfig({ ...env, V2_PUBLIC_DEVELOPMENT_EXPIRES_AT: new Date(now + 3 * 3600000).toISOString() }), /INVALID/);
  assert.deepEqual(developmentSession(config, session, now).permissions, ['SESSION', 'AGENT', 'DEVELOPMENT', 'DELIVERY']);
  assert.equal(developmentSession(config, undefined, now).readOnly, true);
  assert.equal(developmentSession(config, { ...session, user: { ...session.user, email: 'other@example.invalid' } }, now).readOnly, true);
  assert.equal(developmentSession(config, session, config.expiresAt).readOnly, true);
  assert.throws(() => assertDevelopmentExecutionWindow(config, config.expiresAt), { code: 'PUBLIC_DEVELOPMENT_CLOSED' });
  assert.deepEqual(developmentBackgroundWindow(config, config.expiresAt - 65000), { durationMs: 65000, maxEvents: 20 });
  assert.deepEqual(developmentBackgroundWindow(config, now, { durationMs: 60000, maxEvents: 1 }), { durationMs: 60000, maxEvents: 1 });
  assert.throws(() => developmentBackgroundWindow(config, now, { durationMs: '60000', maxEvents: 1 }), { code: 'PUBLIC_DEVELOPMENT_LIMIT_INVALID' });
  assert.throws(() => developmentBackgroundWindow(config, config.expiresAt - 59000), { code: 'PUBLIC_DEVELOPMENT_CLOSED' });
  const degraded = publicDevelopmentConfig({ ...env, V2_DURABLE_SQL_AGENT_ENABLED: 'false', V2_EXECUTION_UNAVAILABLE: 'true' });
  assert.equal(developmentSession(degraded, session, now).readOnly, true);
  assert.doesNotThrow(() => assertDevelopmentMutation(degraded, session, 'GET', '/api/v2/agent/tasks', now));
  assert.throws(() => assertDevelopmentExecutionWindow(degraded, now), { code: 'PUBLIC_DEVELOPMENT_CLOSED' });
});
test('only SQL-development routes pass; publishing and credentials stay closed', () => {
  const now = Date.now(), config = publicDevelopmentConfig(settings(now)), id = '00000000-0000-4000-8000-000000000001';
  for (const path of ['/api/v2/revisions', '/api/v2/runs', '/api/v2/agent/tasks', `/api/v2/agent/tasks/${id}/prepare-delivery`, `/api/v2/agent/tasks/${id}/advance`, `/api/v2/agent/deliveries/${id}/advance`])
    assert.doesNotThrow(() => assertDevelopmentMutation(config, session, 'POST', path, now));
  for (const path of ['/api/v2/auth/redeem', '/api/v2/auth/invitations', '/api/v2/auth/password', '/api/v2/python/runs', '/api/v2/agent/intents', '/api/v2/releases', `/api/v2/agent/tasks/${id}/publication`, `/api/v2/agent/tasks/${id}/background/resume`, '/api/v2/data-services/applications'])
    assert.throws(() => assertDevelopmentMutation(config, session, 'POST', path, now), { code: 'PUBLIC_DEVELOPMENT_SCOPE_DENIED' });
  assert.doesNotThrow(() => assertDevelopmentMutation(config, session, 'POST', '/api/v2/auth/logout', config.expiresAt));
});
test('one new task survives refresh, idempotent retry does not consume another slot, history stays read-only', () => {
  const now = Date.now(), config = publicDevelopmentConfig(settings(now)), tasks = [];
  let original;
  const store = { list: () => tasks, deduplicatedId: key => key.endsWith(':same-key') ? original : undefined };
  assertDevelopmentTaskCreation(config, session, store, PROJECT, 'same-key', 'SPARK_SQL', now);
  original = 'new-task'; tasks.push({ id: original, submittedBy: session.user.id, createdAt: new Date(now).toISOString() });
  assertDevelopmentTaskCreation(config, session, store, PROJECT, 'same-key', 'SPARK_SQL', now);
  assert.throws(() => assertDevelopmentTaskCreation(config, session, store, PROJECT, 'another-key', 'SPARK_SQL', now), { code: 'PUBLIC_DEVELOPMENT_TASK_LIMIT' });
  assert.throws(() => assertDevelopmentTaskCreation(config, session, store, PROJECT, 'same-key', 'PYTHON', now), { code: 'PUBLIC_DEVELOPMENT_SQL_ONLY' });
  assertDevelopmentRecord(config, session, tasks[0]);
  assert.throws(() => assertDevelopmentRecord(config, session, { ...tasks[0], createdAt: new Date(config.startsAt - 1).toISOString() }), { code: 'PUBLIC_DEVELOPMENT_HISTORY_READ_ONLY' });
  assert.throws(() => assertDevelopmentRecord(config, session, { ...tasks[0], submittedBy: 'other-user' }), { code: 'PUBLIC_DEVELOPMENT_HISTORY_READ_ONLY' });
});
test('real HTTP retains CSRF/project checks, accepts one task, blocks other modules and closes at expiry', async t => {
  let now = Date.now(), modelCalls = 0, sparkCalls = 0;
  const env = { ...settings(now), V2_PROVISIONING_ONLY: 'true', V2_PRIVATE_SMOKE_ENABLED: 'true', V2_ALLOW_INSECURE_PUBLIC_COOKIES: 'true', V2_HOST: '127.0.0.1', V2_PUBLIC_ORIGIN: 'https://fixture.invalid' };
  const root = mkdtempSync(join(tmpdir(), 'shuduo-dev-access-'));
  const runner = async () => { sparkCalls++; }; runner.durable = { prepare() {}, submit() { sparkCalls++; }, read() {}, cancel() {} };
  const app = createV2Server({ root, env, runner, generator: async () => { modelCalls++; }, now: () => now, ingress: createFcIngress({ publicHttpEnabled: true }) });
  app.auth.bootstrapAdmin({ email: address, password: 'SyntheticOwner!2026', displayName: '虚构工程师' });
  app.auth.bootstrapAdmin({ email: 'other@example.invalid', password: 'SyntheticOwner!2026', displayName: '其他虚构成员' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); app.store.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, body, extra = {}) => { const r = await fetch(base + '/api/v2' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', origin: env.V2_PUBLIC_ORIGIN, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json(), cookies: r.headers.getSetCookie() }; };
  const login = async email => call('/auth/login', { email, password: 'SyntheticOwner!2026' });
  const auth = await login(address), headers = { cookie: auth.cookies.map(c => c.split(';')[0]).join('; '), 'x-csrf-token': auth.body.csrfToken, 'idempotency-key': 'same-key' };
  assert.equal(auth.body.readOnly, false); assert.equal(auth.body.developmentOnly, true); assert.equal(auth.body.permissions.includes('*'), false);
  const other = await login('other@example.invalid'); assert.equal(other.body.readOnly, true);
  const body = { message: '生成虚构客户资产SQL', code: 'SELECT 1', contextId: 'cash-change' };
  assert.equal((await call('/agent/tasks', body)).status, 403);
  assert.equal((await call('/agent/tasks', body, { cookie: headers.cookie, 'idempotency-key': 'same-key' })).status, 403);
  assert.equal((await call('/agent/tasks', body, { ...headers, 'x-project-id': 'other-project' })).status, 403);
  assert.equal((await call('/agent/tasks', { ...body, language: 'PYTHON' }, headers)).body.code, 'PUBLIC_DEVELOPMENT_SQL_ONLY');
  const created = await call('/agent/tasks', body, headers); assert.equal(created.status, 202);
  assert.equal((await call('/agent/tasks', body, headers)).body.id, created.body.id);
  assert.equal((await call('/agent/tasks', body, { ...headers, 'idempotency-key': 'new-key' })).body.code, 'PUBLIC_DEVELOPMENT_TASK_LIMIT');
  for (const path of ['/auth/invitations', '/auth/password', '/releases', '/agent/intents', '/data-services/applications']) assert.equal((await call(path, {}, headers)).body.code, 'PUBLIC_DEVELOPMENT_SCOPE_DENIED');
  now = Date.parse(env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT);
  assert.equal((await call('/auth/session', undefined, headers)).body.readOnly, true);
  assert.equal((await call(`/agent/tasks/${created.body.id}/advance`, { expectedVersion: created.body.version }, headers)).body.code, 'PUBLIC_DEVELOPMENT_CLOSED');
  assert.equal(modelCalls, 0); assert.equal(sparkCalls, 0);
});
