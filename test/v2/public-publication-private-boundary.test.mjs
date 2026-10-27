// Real loopback HTTP with an in-memory store and synthetic identities only.
// Queue/model callbacks fail if reached: these tests do not run cloud compute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { createFcIngress } from '../../src/v2/fc-ingress.mjs';
import { signSchedulerTick } from '../../src/v2/scheduler-tick.mjs';
import { cloudPublicationMode } from '../../src/v2/cloud-publication.mjs';

async function fixture(t, { publicationOnly = true } = {}) {
  const store = new MetadataStore(':memory:'), now = Date.now();
  const taskId = '00000000-0000-4000-8000-000000000001';
  const verificationId = '00000000-0000-4000-8000-000000000002';
  const packageDigest = 'a'.repeat(64);
  const secret = 'synthetic-private-boundary-timer-key-only-123456789';
  const triggerName = 'shuduo-release-private-boundary-contract';
  let modelCalls = 0, computeCalls = 0, objectCalls = 0;
  const runner = async () => { computeCalls++; throw Error('COMPUTE_FORBIDDEN_IN_BOUNDARY_TEST'); };
  runner.descriptor = { engine: 'Apache Spark', isolation: 'REMOTE_FUNCTION',
    transport: 'PRIVATE_OSS_QUEUE', healthVerified: true, publicWriteEnabled: true };
  runner.durable = Object.fromEntries(['prepare', 'submit', 'read', 'cancel'].map(name => [name,
    () => { computeCalls++; throw Error('QUEUE_FORBIDDEN_IN_BOUNDARY_TEST'); }]));
  const env = { V2_LOCAL_DEVELOPMENT: 'false', V2_HOST: '127.0.0.1',
    V2_ALLOW_INSECURE_PUBLIC_COOKIES: 'true', V2_PROVISIONING_ONLY: 'true',
    V2_PRIVATE_SMOKE_ENABLED: 'true', V2_PRIVATE_DATA_SERVICES_ENABLED: 'true',
    V2_PUBLIC_ORIGIN: 'https://boundary.example.invalid',
    V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid',
    V2_DURABLE_SQL_AGENT_ENABLED: 'true', V2_PRIVATE_RELEASE_ENABLED: 'true',
    V2_SCHEDULER_TICK_SECRET: secret, V2_PRIVATE_RELEASE_TRIGGER_NAMES: triggerName,
    V2_AGENT_DRIVER_MODE: 'OSS_EVENTS', OSS_BUCKET: 'synthetic-boundary-bucket',
    V2_AGENT_EVENT_ACCOUNT_ID: '123456789012', V2_SPARK_EXECUTOR_TRANSPORT: 'OSS_QUEUE',
    V2_SPARK_EXECUTOR_SECRET: 'synthetic-private-boundary-queue-key-only-123456789',
    ...(publicationOnly ? { V2_FC_PUBLIC_WRITE_SCOPE: 'PUBLICATION_ONLY',
      V2_PUBLIC_PUBLICATION_TASK_ID: taskId, V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: packageDigest,
      V2_PUBLIC_PUBLICATION_VERIFICATION_ID: verificationId,
      V2_PUBLIC_PUBLICATION_STARTS_AT: new Date(now - 1000).toISOString(),
      V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(now + 3600000).toISOString() } : {}) };
  const app = createV2Server({ store, env, runner, now: () => now,
    ingress: createFcIngress({ publicHttpEnabled: true }),
    generator: async () => { modelCalls++; throw Error('MODEL_FORBIDDEN_IN_BOUNDARY_TEST'); },
    agentWakeTransport: Object.fromEntries(['create', 'read'].map(name => [name,
      async () => { objectCalls++; throw Error('OBJECT_IO_FORBIDDEN_IN_BOUNDARY_TEST'); }])) });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); store.close(); });
  for (const email of ['owner@example.invalid', 'other@example.invalid'])
    app.auth.bootstrapAdmin({ email, password: 'SyntheticBoundary!2026', displayName: '虚构边界测试账号' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const invoke = async body => {
    const response = await fetch(base + '/invoke', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/octet-stream', 'x-fc-control-path': '/invoke' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const identities = {};
  for (const [name, email] of [['owner', 'owner@example.invalid'], ['other', 'other@example.invalid']]) {
    const response = await fetch(base + '/api/v2/auth/login', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', origin: env.V2_PUBLIC_ORIGIN },
      body: JSON.stringify({ email, password: 'SyntheticBoundary!2026' }) });
    assert.equal(response.status, 200);
    const session = await response.json();
    identities[name] = { cookie: response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; '),
      'x-csrf-token': session.csrfToken, 'x-shuduo-client': 'cli', 'idempotency-key': `boundary-${name}` };
  }
  const bridge = (path, body, identity = 'owner') => invoke({ operation: 'PRIVATE_APPLICATION_HTTP_V1',
    method: body === undefined ? 'GET' : 'POST', path, headers: identities[identity],
    ...(body === undefined ? {} : { body }) });
  const timer = (releaseId, valid = true) => {
    const timestamp = String(now), nonce = 'synthetic-private-boundary-timer-event';
    const body = JSON.stringify({ releaseId, triggerName, expiresAt: now + 120000 });
    return invoke({ triggerName, triggerTime: new Date(now).toISOString(), payload: JSON.stringify({
      operation: 'PRIVATE_RELEASE_TIMER_V1', timestamp, nonce, body,
      signature: valid ? signSchedulerTick({ sharedSecret: secret, timestamp, nonce, body }) : 'invalid',
    }) });
  };
  return { invoke, bridge, timer, store, taskId, verificationId, packageDigest,
    counts: () => ({ modelCalls, computeCalls, objectCalls }) };
}

test('private HTTP forwarding cannot create revisions, tasks or credentials outside a publication window scope', async t => {
  const f = await fixture(t);
  const beforeUsers = f.store.list('auth_user', PROJECT).length;
  const requests = [
    ['/api/v2/revisions', { sql: 'SELECT 1', contextId: 'holdings-t1' }],
    ['/api/v2/agent/tasks', { message: '虚构证券资产加工', sql: 'SELECT 1', contextId: 'holdings-t1' }],
    ['/api/v2/data-services/applications', { name: '虚构外部测试应用' }],
  ];
  for (const identity of ['owner', 'other']) for (const [path, body] of requests) {
    const response = await f.bridge(path, body, identity);
    assert.equal(response.status, 200); // Private envelope contains the actual application status.
    assert.equal(response.body.status, 403);
    assert.equal(response.body.body.code, identity === 'owner' ? 'PUBLIC_PUBLICATION_SCOPE_DENIED' : 'PUBLIC_PUBLICATION_CLOSED');
  }
  for (const kind of ['revision', 'agent', 'service_app', 'run']) assert.equal(f.store.list(kind, PROJECT).length, 0, kind);
  assert.equal(f.store.list('auth_user', PROJECT).length, beforeUsers);
  assert.deepEqual(f.counts(), { modelCalls: 0, computeCalls: 0, objectCalls: 0 });
});

test('legacy private acceptance and Agent drivers are rejected before creating users, tasks or object IO', async t => {
  const f = await fixture(t), beforeUsers = f.store.list('auth_user', PROJECT).length;
  for (const input of [
    { operation: 'PRIVATE_APPLICATION_TASK_V1', caseId: 'holdings-t1', submitOnly: true },
    { operation: 'PRIVATE_AGENT_RECOVERY_V1', action: 'prepare', requestId: 'synthetic-recovery-request' },
    { operation: 'PRIVATE_AGENT_TICK_V1', requestId: 'synthetic-tick-request' },
    { events: [] }, // Recognized legacy OSS Agent event envelope; must not reach its driver.
  ]) {
    const response = await f.invoke(input);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'PUBLIC_PUBLICATION_SCOPE_DENIED');
  }
  assert.equal(f.store.list('auth_user', PROJECT).length, beforeUsers);
  for (const kind of ['agent', 'agent_background', 'agent_wake', 'revision', 'run'])
    assert.equal(f.store.list(kind, PROJECT).length, 0, kind);
  assert.deepEqual(f.counts(), { modelCalls: 0, computeCalls: 0, objectCalls: 0 });
});

test('publication scope retains private status, authenticated reads and signature-checked release timer dispatch', async t => {
  const f = await fixture(t);
  const status = await f.invoke({ operation: 'PRIVATE_STATUS_V1' });
  assert.equal(status.status, 200); assert.equal(status.body.mode, 'PRIVATE_CONTROL_PLANE');
  const session = await f.bridge('/api/v2/auth/session');
  assert.equal(session.status, 200); assert.equal(session.body.status, 200);
  assert.equal(session.body.body.authenticated, true);
  // Empty, already-completed synthetic release tests dispatch only, not Spark or E2E.
  const release = f.store.create('release', PROJECT, { mode: cloudPublicationMode,
    sourceAgentTaskId: f.taskId, packageDigest: f.packageDigest, verificationId: f.verificationId,
    status: 'COMPLETED_CLOUD_TEST' });
  const invalid = await f.timer(release.id, false);
  assert.equal(invalid.status, 401); assert.equal(invalid.body.code, 'PRIVATE_RELEASE_TIMER_INVALID');
  assert.equal(f.store.list('cloud_release_tick', PROJECT).length, 0);
  const valid = await f.timer(release.id);
  assert.equal(valid.status, 200); assert.equal(valid.body.releaseId, release.id);
  assert.equal(valid.body.pending, 0); assert.equal(f.store.list('cloud_release_tick', PROJECT).length, 1);
  const replay = await f.timer(release.id);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(f.store.list('cloud_release_tick', PROJECT).length, 1);
  assert.deepEqual(f.counts(), { modelCalls: 0, computeCalls: 0, objectCalls: 0 });
});

test('without publication scope the existing private revision and read routes remain compatible', async t => {
  const f = await fixture(t, { publicationOnly: false });
  const saved = await f.bridge('/api/v2/revisions', { sql: 'SELECT 1', contextId: 'holdings-t1' });
  assert.equal(saved.status, 200); assert.equal(saved.body.status, 201);
  assert.equal(f.store.list('revision', PROJECT).length, 1);
  const read = await f.bridge(`/api/v2/revisions/${saved.body.body.id}`);
  assert.equal(read.body.status, 200); assert.equal(read.body.body.sql, 'SELECT 1');
  assert.equal((await f.invoke({ operation: 'PRIVATE_STATUS_V1' })).status, 200);
  // Old event validation still runs outside this opt-in publication scope.
  const legacyEvent = await f.invoke({ events: [] });
  assert.equal(legacyEvent.status, 422); assert.equal(legacyEvent.body.code, 'AGENT_OBJECT_EVENT_INVALID');
  assert.deepEqual(f.counts(), { modelCalls: 0, computeCalls: 0, objectCalls: 0 });
});
