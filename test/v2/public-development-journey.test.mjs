// HTTP/lifecycle regression with synthetic model and queue doubles only.
// This file is NOT evidence of live model, Spark, cloud recovery or public E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { LocalArtifactStore } from '../../src/v2/artifact-store.mjs';
import { createFcIngress } from '../../src/v2/fc-ingress.mjs';
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult } from '../../src/v2/remote-spark-queue.mjs';
import { referenceSql, contextIds, getContext } from '../../src/v2/context.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'shuduo-pilot-journey-'));
  let now = Date.now(), app, store, base, cookie, csrf, modelCalls = 0, jobCreates = 0, loseSubmission = false;
  const objects = new Map();
  const config = { projectId: PROJECT, sharedSecret: 'synthetic-journey-signing-key-only-123456789', jobPrefix: SPARK_QUEUE_PREFIXES.jobs, resultPrefix: SPARK_QUEUE_PREFIXES.results, cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations, timeoutMs: 180000 };
  const queue = new RemoteSparkQueueClient(config, {
    read: async key => objects.get(key),
    create: async (key, body) => {
      if (objects.has(key)) { assert.equal(objects.get(key), body); return { created: false }; }
      objects.set(key, body); if (key.startsWith(config.jobPrefix + '/')) jobCreates++;
      if (loseSubmission) { loseSubmission = false; throw Error('SYNTHETIC_LOST_RESPONSE'); }
      return { created: true };
    },
  }, { now: () => now });
  const runner = async () => { throw Error('BLOCKING_RUNNER_FORBIDDEN_IN_THIS_TEST'); };
  runner.descriptor = { engine: 'Apache Spark', isolation: 'REMOTE_FUNCTION', transport: 'PRIVATE_OSS_QUEUE', healthVerified: true, publicWriteEnabled: true };
  runner.durable = { prepare: (input, id) => queue.prepare(input, id), submit: q => queue.submitPrepared(q), read: q => queue.readPreparedResult(q), cancel: q => queue.cancelPrepared(q) };
  const env = { V2_LOCAL_DEVELOPMENT: 'false', V2_HOST: '127.0.0.1', V2_PROVISIONING_ONLY: 'true', V2_PRIVATE_SMOKE_ENABLED: 'true', V2_ALLOW_INSECURE_PUBLIC_COOKIES: 'true', V2_PUBLIC_ORIGIN: 'https://journey.example.invalid', V2_DURABLE_SQL_AGENT_ENABLED: 'true', V2_FC_PUBLIC_WRITE_SCOPE: 'DEVELOPMENT_ONLY', V2_PUBLIC_DEVELOPMENT_STARTS_AT: new Date(now - 1000).toISOString(), V2_PUBLIC_DEVELOPMENT_EXPIRES_AT: new Date(now + 3600000).toISOString(), V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid', V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: '4' };
  const close = async () => { if (!app) return; app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); store.close(); app = undefined; };
  const open = async () => {
    store = new MetadataStore(join(directory, 'metadata.sqlite'));
    app = createV2Server({ store, root: directory, env, runner, now: () => now, artifactStore: new LocalArtifactStore(join(directory, 'artifacts')), ingress: createFcIngress({ publicHttpEnabled: true }), generator: async () => {
      modelCalls++; return { sql: referenceSql, model: 'synthetic-protocol-fixture', explanation: 'Local lifecycle fixture, not a real model', usage: { total_tokens: 12 } };
    } });
    app.auth.bootstrapAdmin({ email: env.V2_BOOTSTRAP_ADMIN_EMAIL, password: 'SyntheticJourney!2026', displayName: '虚构开发者' });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  };
  const call = async (path, body, key = 'original-pilot-task') => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', origin: env.V2_PUBLIC_ORIGIN, 'idempotency-key': key, ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json(), cookies: r.headers.getSetCookie() };
  };
  const complete = prepared => {
    const payload = JSON.parse(prepared.job.body);
    objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, {
      status: 'SUCCEEDED', engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true,
      rows: getContext(payload.context.id).expected, durationMs: 100,
      validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) },
      ...(payload.testSql ? { testSqlValidation: { passed: true, sqlHash: createHash('sha256').update(payload.testSql).digest('hex') } } : {}),
      log: 'Synthetic queue receipt. No real Spark was run.',
    }, config, now)));
  };
  await open();
  const login = await call('/auth/login', { email: env.V2_BOOTSTRAP_ADMIN_EMAIL, password: 'SyntheticJourney!2026' });
  assert.equal(login.status, 200); cookie = login.cookies.map(c => c.split(';')[0]).join('; '); csrf = login.body.csrfToken;
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, complete, env, restart: async () => { await close(); await open(); }, expire: () => { now = Date.parse(env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT); }, lose: () => { loseSubmission = true; }, get store() { return store; }, counts: () => ({ modelCalls, jobCreates }) };
}
const taskInput = { message: '计算虚构客户总资产，避免现金重复累计。', code: 'SELECT 1', contextId: 'holdings-t1' };

test('invited development reaches versioned files across restart without another task or submission', async t => {
  const f = await fixture(t);
  let task = (await f.call('/agent/tasks', taskInput)).body;
  task = (await f.call(`/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.stage, 'READY_FOR_RUN'); assert.equal(f.counts().modelCalls, 1);
  task = (await f.call(`/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.stage, 'WAITING_FOR_RUN'); assert.equal(f.counts().jobCreates, 1);
  const prepared = f.store.get('run', task.runId, PROJECT).remoteSubmission.prepared;
  await f.restart(); f.complete(prepared);
  task = (await f.call(`/agent/tasks/${task.id}`)).body;
  task = (await f.call(`/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.status, 'SUCCEEDED'); assert.deepEqual(f.counts(), { modelCalls: 1, jobCreates: 1 });
  const workflow = await f.call(`/agent/tasks/${task.id}/workflow`);
  assert.equal(workflow.body.report.status, 'PASSED');
  let delivery = (await f.call(`/agent/tasks/${task.id}/prepare-delivery`, {}, 'delivery-once')).body;
  assert.equal(delivery.stage, 'PACKAGE_READY');
  const bundle = f.store.get('delivery_package', delivery.packageId, PROJECT);
  for (const name of ['main.sql', 'tests.sql', 'schedule.json', 'deployment.json']) assert.equal(typeof bundle.files[name], 'string');
  delivery = (await f.call(`/agent/deliveries/${delivery.id}/advance`, { expectedVersion: delivery.version })).body;
  assert.equal(delivery.stage, 'FILE_REHEARSAL_RUNNING'); assert.equal(f.counts().jobCreates, 2);
  const rehearsal = f.store.get('agent_delivery_task', delivery.id, PROJECT).remoteSubmission.prepared;
  await f.restart(); f.complete(rehearsal);
  const completed = await f.call(`/agent/deliveries/${delivery.id}`);
  assert.equal(completed.body.stage, 'AWAITING_ENGINEER_REVIEW');
  assert.equal(completed.body.packageDigest, bundle.digest);
  assert.deepEqual(f.counts(), { modelCalls: 1, jobCreates: 2 });
  assert.equal((await f.call('/agent/tasks', taskInput, 'second-task')).body.code, 'PUBLIC_DEVELOPMENT_TASK_LIMIT');
  assert.equal((await f.call(`/agent/tasks/${task.id}/publication`, {})).body.code, 'PUBLIC_DEVELOPMENT_SCOPE_DENIED');
  assert.equal(f.store.list('release', PROJECT).length, 0);
});

test('unknown submission is not replayed by restart or expiry; an existing late result remains readable', async t => {
  const f = await fixture(t);
  const revision = (await f.call('/revisions', { sql: referenceSql, contextId: 'holdings-t1' }, 'manual-save')).body;
  f.lose(); const submitted = await f.call('/runs', { revisionId: revision.id }, 'manual-once');
  assert.equal(submitted.status, 500); assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1 });
  const saved = f.store.list('run', PROJECT)[0], prepared = saved.remoteSubmission.prepared;
  await f.restart();
  assert.equal((await f.call(`/runs/${saved.id}`)).body.status, 'QUEUED');
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1 });
  f.complete(prepared); f.expire();
  const late = await f.call(`/runs/${saved.id}`);
  assert.equal(late.body.status, 'SUCCEEDED'); assert.equal(late.body.id, saved.id);
  assert.equal((await f.call('/auth/session')).body.readOnly, true);
  assert.equal((await f.call('/runs', { revisionId: revision.id }, 'manual-once')).body.code, 'PUBLIC_DEVELOPMENT_CLOSED');
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1 });
});
