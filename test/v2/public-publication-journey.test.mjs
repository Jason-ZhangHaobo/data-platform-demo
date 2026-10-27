// Real loopback HTTP, FC ingress and persisted SQLite contract regression.
// The stored model/Spark receipts and queue are synthetic fixtures; this is NOT
// evidence of a real model, Spark execution, cloud recovery or public E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { LocalArtifactStore } from '../../src/v2/artifact-store.mjs';
import { createFcIngress } from '../../src/v2/fc-ingress.mjs';
import { createDeliveryPackage, sha256 } from '../../src/v2/delivery.mjs';
import { contextIds, getContext, referenceSql, validationContractId } from '../../src/v2/context.mjs';
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult } from '../../src/v2/remote-spark-queue.mjs';
import { signSchedulerTick } from '../../src/v2/scheduler-tick.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'shuduo-publication-journey-'));
  const artifactStore = new LocalArtifactStore(join(directory, 'artifacts'));
  const objects = new Map(), identities = {};
  let now = Date.now(), app, store = new MetadataStore(join(directory, 'metadata.sqlite')), base;
  let modelCalls = 0, jobCreates = 0, submitCalls = 0;
  const queueConfig = { projectId: PROJECT, sharedSecret: 'synthetic-publication-queue-key-only-123456789',
    jobPrefix: SPARK_QUEUE_PREFIXES.jobs, resultPrefix: SPARK_QUEUE_PREFIXES.results,
    cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations, timeoutMs: 180000 };
  const queue = new RemoteSparkQueueClient(queueConfig, {
    read: async key => objects.get(key),
    create: async (key, body) => {
      if (objects.has(key)) { assert.equal(objects.get(key), body); return { created: false }; }
      objects.set(key, body); if (key.startsWith(queueConfig.jobPrefix + '/')) jobCreates++;
      return { created: true };
    },
  }, { now: () => now });
  const runner = async () => { throw Error('BLOCKING_RUNNER_FORBIDDEN_IN_PUBLICATION_FIXTURE'); };
  runner.descriptor = { engine: 'Apache Spark', isolation: 'REMOTE_FUNCTION', transport: 'PRIVATE_OSS_QUEUE', healthVerified: true, publicWriteEnabled: true };
  runner.durable = { prepare: (input, id) => queue.prepare(input, id),
    submit: prepared => { submitCalls++; return queue.submitPrepared(prepared); },
    read: prepared => queue.readPreparedResult(prepared), cancel: prepared => queue.cancelPrepared(prepared) };
  const validation = { passed: true, contractId: validationContractId,
    regressions: contextIds.map(contextId => ({ contextId, passed: true })) };
  const revision = store.create('revision', PROJECT, { sql: referenceSql, hash: sha256(referenceSql), contextId: 'holdings-t1' });
  const sourceRun = store.create('run', PROJECT, { revisionId: revision.id, revisionHash: revision.hash,
    status: 'SUCCEEDED', engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true,
    isolation: 'FUNCTION_PROCESS', validation, rows: getContext('holdings-t1').expected,
    log: 'Synthetic saved execution fixture; no real Spark was run.' });
  let agent = store.create('agent', PROJECT, { status: 'SUCCEEDED', mode: 'LIVE_MODEL', executionMode: 'DURABLE_SQL_AGENT_V1',
    attempts: [{ status: 'SUCCEEDED', model: 'synthetic-publication-contract-fixture', revisionId: revision.id, runId: sourceRun.id }] });
  agent = store.update('agent', agent.id, PROJECT, { createdAt: new Date(now - 86400000).toISOString() });
  const bundle = createDeliveryPackage({ run: sourceRun, revision });
  const artifact = await artifactStore.put('delivery-package', bundle.digest, bundle);
  const item = store.create('delivery_package', PROJECT, { ...bundle, artifact, sourceRunId: sourceRun.id });
  const verification = store.create('delivery_verification', PROJECT, { packageId: item.id, packageDigest: item.digest,
    status: 'SUCCEEDED', engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true,
    testSqlValidation: { passed: true, sqlHash: sha256(item.files['tests.sql']) }, validation });
  store.create('agent_delivery_task', PROJECT, { sourceAgentTaskId: agent.id, packageId: item.id, packageDigest: item.digest,
    sourceRevisionId: revision.id, sourceRunId: sourceRun.id, status: 'SUCCEEDED', actualExecution: true, verificationId: verification.id });
  const otherAgent = store.create('agent', PROJECT, { ...agent, createdAt: undefined });
  const secret = 'synthetic-publication-timer-key-only-123456789', triggerName = 'shuduo-release-local-contract';
  const env = { V2_LOCAL_DEVELOPMENT: 'false', V2_HOST: '127.0.0.1', V2_PROVISIONING_ONLY: 'true',
    V2_PRIVATE_SMOKE_ENABLED: 'true', V2_ALLOW_INSECURE_PUBLIC_COOKIES: 'true',
    V2_PUBLIC_ORIGIN: 'https://publication.example.invalid', V2_DURABLE_SQL_AGENT_ENABLED: 'true',
    V2_FC_PUBLIC_WRITE_SCOPE: 'PUBLICATION_ONLY', V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid',
    V2_PUBLIC_PUBLICATION_TASK_ID: agent.id, V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: item.digest,
    V2_PUBLIC_PUBLICATION_VERIFICATION_ID: verification.id,
    V2_PUBLIC_PUBLICATION_STARTS_AT: new Date(now - 1000).toISOString(),
    V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(now + 3600000).toISOString(),
    V2_PRIVATE_RELEASE_ENABLED: 'true', V2_SCHEDULER_TICK_SECRET: secret,
    // One historical source run plus exactly two new publication batches.
    V2_PRIVATE_RELEASE_TRIGGER_NAMES: triggerName, V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: '3' };
  const close = async () => {
    if (app) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app = undefined; }
    if (store) { store.close(); store = undefined; }
  };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const open = async () => {
    store ??= new MetadataStore(join(directory, 'metadata.sqlite'));
    app = createV2Server({ root: directory, store, artifactStore, runner, env, now: () => now,
      ingress: createFcIngress({ publicHttpEnabled: true }),
      generator: async () => { modelCalls++; throw Error('MODEL_CALL_FORBIDDEN_IN_PUBLICATION_FIXTURE'); } });
    const owner = app.auth.bootstrapAdmin({ email: env.V2_BOOTSTRAP_ADMIN_EMAIL, password: 'SyntheticPublication!2026', displayName: '虚构审阅工程师' });
    app.auth.bootstrapAdmin({ email: 'other@example.invalid', password: 'SyntheticPublication!2026', displayName: '虚构其他管理员' });
    for (const id of [agent.id, otherAgent.id]) {
      const current = store.get('agent', id, PROJECT);
      if (!current.submittedBy) store.update('agent', id, PROJECT, { submittedBy: owner.id });
    }
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const call = async (path, body, { identity = 'owner', key = 'original-package-publication', headers = {} } = {}) => {
    const response = await fetch(base + '/api/v2' + path, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', origin: env.V2_PUBLIC_ORIGIN,
        'idempotency-key': key, ...(identity ? identities[identity] : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  };
  const tick = async (releaseId, sequence, extra = {}) => {
    const timestamp = String(now), nonce = `synthetic-publication-event-${sequence}`;
    const body = JSON.stringify({ releaseId, triggerName, expiresAt: now + 120000 });
    const payload = JSON.stringify({ operation: 'PRIVATE_RELEASE_TIMER_V1', timestamp, nonce, body,
      signature: signSchedulerTick({ sharedSecret: secret, timestamp, nonce, body }) });
    const response = await fetch(base + '/invoke', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/octet-stream', 'x-fc-control-path': '/invoke' },
      body: JSON.stringify({ triggerName, triggerTime: new Date(now).toISOString(), payload, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  const complete = prepared => {
    const input = JSON.parse(prepared.job.body);
    objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, {
      status: 'SUCCEEDED', engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true,
      rows: getContext(input.context.id).expected, validation, durationMs: 20,
      testSqlValidation: { passed: true, sqlHash: sha256(input.testSql) },
      log: 'Synthetic signed queue receipt; no real Spark was run.',
    }, queueConfig, now)));
  };
  await open();
  for (const [identity, email] of [['owner', env.V2_BOOTSTRAP_ADMIN_EMAIL], ['other', 'other@example.invalid']]) {
    const logged = await call('/auth/login', { email, password: 'SyntheticPublication!2026' }, { identity: null });
    assert.equal(logged.status, 200);
    identities[identity] = { cookie: logged.cookies.map(cookie => cookie.split(';')[0]).join('; '), 'x-csrf-token': logged.body.csrfToken };
  }
  return { call, tick, complete, env, agent, item, verification, otherAgent,
    path: `/agent/tasks/${agent.id}/publication`,
    body: { packageDigest: item.digest, verificationId: verification.id,
      attestations: { code: true, assertions: true, deliveryFiles: true, cloudScope: true } },
    restart: async () => { await close(); await open(); }, advance: () => { now += 60000; },
    expire: () => { now = Date.parse(env.V2_PUBLIC_PUBLICATION_EXPIRES_AT); },
    get store() { return store; }, counts: () => ({ modelCalls, jobCreates, submitCalls }) };
}

test('formal ingress keeps publication scoped to the existing administrator, task and reviewed package', async t => {
  const f = await fixture(t);
  assert.ok(Date.parse(f.agent.createdAt) < Date.parse(f.env.V2_PUBLIC_PUBLICATION_STARTS_AT));
  const owner = (await f.call('/auth/session')).body;
  assert.equal(owner.authenticated, true); assert.equal(owner.readOnly, false);
  assert.equal(owner.publicationOnly, true); assert.deepEqual(owner.permissions, ['SESSION', 'DELIVERY']);
  assert.equal(owner.publicationTaskId, f.agent.id); assert.equal(owner.publicationPackageDigest, f.item.digest);
  const other = (await f.call('/auth/session', undefined, { identity: 'other' })).body;
  assert.equal(other.readOnly, true); assert.deepEqual(other.permissions, ['SESSION']);
  const anonymous = (await f.call('/auth/session', undefined, { identity: null })).body;
  for (const result of [other, anonymous])
    for (const field of ['publicationTaskId', 'publicationPackageDigest', 'publicationVerificationId'])
      assert.equal(Object.hasOwn(result, field), false);
  for (const identity of [null, 'other']) {
    const denied = await f.call(f.path, f.body, { identity });
    assert.equal(denied.status, 403); assert.equal(denied.body.code, 'PUBLIC_PUBLICATION_CLOSED');
  }
  assert.equal((await f.call(f.path, f.body, { headers: { 'x-project-id': 'another-synthetic-project' } })).status, 403);
  const csrf = await f.call(f.path, f.body, { headers: { 'x-csrf-token': 'wrong-token' } });
  assert.equal(csrf.status, 403); assert.equal(csrf.body.code, 'CSRF_REQUIRED');
  for (const body of [{ ...f.body, packageDigest: 'b'.repeat(64) }, { ...f.body, verificationId: f.otherAgent.id }]) {
    const denied = await f.call(f.path, body);
    assert.equal(denied.status, 403); assert.equal(denied.body.code, 'PUBLIC_PUBLICATION_TARGET_MISMATCH');
  }
  for (const path of ['/agent/tasks', '/revisions', '/runs', '/python/runs', '/releases', '/agent/intents',
    `/agent/tasks/${f.agent.id}/advance`, `/agent/tasks/${f.agent.id}/prepare-delivery`,
    `/agent/tasks/${f.otherAgent.id}/publication`, `/delivery/packages/${f.item.id}/approve`,
    '/auth/invitations', '/auth/password', '/auth/redeem', '/data-services/applications']) {
    const denied = await f.call(path, {});
    assert.equal(denied.status, 403, path); assert.equal(denied.body.code, 'PUBLIC_PUBLICATION_SCOPE_DENIED', path);
  }
  for (const kind of ['delivery_review', 'release_approval', 'release', 'release_run']) assert.equal(f.store.list(kind, PROJECT).length, 0);
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 0, submitCalls: 0 });
});

test('one reviewed publication survives controller restart with two stable externally triggered jobs', async t => {
  const f = await fixture(t), published = await f.call(f.path, f.body);
  assert.equal(published.status, 202); assert.equal(published.body.release.status, 'WAITING_SCHEDULER');
  const releaseId = published.body.release.id, jobIds = published.body.runs.map(run => run.id);
  assert.equal(jobIds.length, 2); assert.equal(new Set(jobIds).size, 2);
  assert.equal(published.body.release.packageDigest, f.item.digest);
  assert.equal(published.body.release.verificationId, f.verification.id);
  for (const key of ['original-package-publication', 'different-client-retry'])
    assert.equal((await f.call(f.path, f.body, { key })).body.release.id, releaseId);
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 0, submitCalls: 0 });
  assert.equal((await f.tick(releaseId, 1)).status, 200);
  const first = f.store.list('release_run', PROJECT).find(run => run.status === 'RUNNING');
  assert.equal(first.id, jobIds[0]); const firstPrepared = first.remoteSubmission.prepared;
  await f.restart();
  assert.equal((await f.call(f.path)).body.release.id, releaseId);
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1, submitCalls: 1 });
  assert.equal((await f.call(f.path, f.body)).body.release.id, releaseId);
  f.complete(firstPrepared);
  assert.equal((await f.call(f.path)).body.runs.find(run => run.id === first.id).status, 'SUCCEEDED');
  f.advance(); assert.equal((await f.tick(releaseId, 2)).status, 200);
  const second = f.store.list('release_run', PROJECT).find(run => run.status === 'RUNNING');
  assert.equal(second.id, jobIds[1]); const secondPrepared = second.remoteSubmission.prepared;
  await f.restart(); f.complete(secondPrepared); f.advance();
  assert.equal((await f.tick(releaseId, 3)).status, 200);
  const finished = (await f.call(f.path)).body;
  assert.equal(finished.release.health, 'HEALTHY'); assert.equal(finished.release.status, 'COMPLETED_CLOUD_TEST');
  assert.deepEqual(finished.runs.map(run => run.id), jobIds);
  assert.ok(finished.runs.every(run => run.status === 'SUCCEEDED' && run.schedulerTriggered && run.packageDigest === f.item.digest));
  assert.equal(finished.events.length, 2); assert.equal(finished.alerts.length, 0);
  assert.equal((await f.tick(releaseId, 3)).status, 200);
  assert.equal((await f.call(f.path, f.body)).body.release.id, releaseId);
  for (const kind of ['release', 'release_approval', 'delivery_review']) assert.equal(f.store.list(kind, PROJECT).length, 1);
  assert.equal(f.store.list('release_run', PROJECT).length, 2);
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 2, submitCalls: 2 });
});

test('expired publication window rejects new publication and new Spark while late original evidence remains readable', async t => {
  const f = await fixture(t), created = await f.call(f.path, f.body), releaseId = created.body.release.id;
  assert.equal(created.status, 202); assert.equal((await f.tick(releaseId, 1)).status, 200);
  const first = f.store.list('release_run', PROJECT).find(run => run.status === 'RUNNING');
  const prepared = first.remoteSubmission.prepared;
  await f.restart(); f.expire(); f.complete(prepared);
  const session = (await f.call('/auth/session')).body;
  assert.equal(session.readOnly, true); assert.deepEqual(session.permissions, ['SESSION']);
  const denied = await f.call(f.path, f.body);
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'PUBLIC_PUBLICATION_CLOSED');
  const detail = (await f.call(f.path)).body;
  assert.equal(detail.release.id, releaseId);
  assert.equal(detail.runs.find(run => run.id === first.id).status, 'SUCCEEDED');
  assert.equal(detail.runs.filter(run => run.status === 'SCHEDULED').length, 1);
  const tick = await f.tick(releaseId, 2);
  assert.equal(tick.status, 403); assert.equal(tick.body.code, 'PUBLIC_PUBLICATION_CLOSED');
  assert.equal((await f.call(f.path)).body.release.id, releaseId);
  assert.equal(f.store.list('release_run', PROJECT).length, 2);
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1, submitCalls: 1 });
});

test('cancelling a selected publication prevents new-key requests from creating another two-batch allowance', async t => {
  const f = await fixture(t), created = await f.call(f.path, f.body), releaseId = created.body.release.id;
  assert.equal(created.status, 202);
  const originalIds = created.body.runs.map(run => run.id);
  assert.equal((await f.call(f.path + '/cancel', {}, { identity: 'other' })).status, 403);
  const cancelled = await f.call(f.path + '/cancel', {});
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.release.status, 'CANCELLED');
  await f.restart();
  const retried = await f.call(f.path, f.body, { key: 'new-key-after-cancellation' });
  assert.equal(retried.status, 202); assert.equal(retried.body.release.id, releaseId);
  assert.equal(retried.body.release.status, 'CANCELLED');
  assert.deepEqual(retried.body.runs.map(run => run.id), originalIds);
  assert.ok(retried.body.runs.every(run => run.status === 'CANCELLED'));
  assert.equal((await f.tick(releaseId, 1)).status, 409);
  assert.equal(f.store.list('release', PROJECT).length, 1);
  assert.equal(f.store.list('release_run', PROJECT).length, 2);
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 0, submitCalls: 0 });
});

test('a signed private timer cannot submit if the approved release source has changed or lost its rehearsal binding', async t => {
  const f = await fixture(t), created = await f.call(f.path, f.body), releaseId = created.body.release.id;
  assert.equal(created.status, 202);
  const invalidSignature = await f.tick(releaseId, 1, { payload: JSON.stringify({ signature: 'invalid' }) });
  assert.equal(invalidSignature.status, 401); assert.equal(invalidSignature.body.code, 'PRIVATE_RELEASE_TIMER_INVALID');
  const original = f.store.get('release', releaseId, PROJECT);
  const variants = [{ verificationId: undefined }, { verificationId: f.otherAgent.id },
    { packageDigest: 'c'.repeat(64) }, { sourceAgentTaskId: f.otherAgent.id }];
  for (const [index, patch] of variants.entries()) {
    f.store.update('release', releaseId, PROJECT, { sourceAgentTaskId: original.sourceAgentTaskId,
      packageDigest: original.packageDigest, verificationId: original.verificationId, ...patch });
    const denied = await f.tick(releaseId, index + 2);
    assert.equal(denied.status, 403); assert.equal(denied.body.code, 'PUBLIC_PUBLICATION_TARGET_MISMATCH');
    assert.ok(f.store.list('release_run', PROJECT).every(run => run.status === 'SCHEDULED' && !run.remoteSubmission));
  }
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 0, submitCalls: 0 });
});
