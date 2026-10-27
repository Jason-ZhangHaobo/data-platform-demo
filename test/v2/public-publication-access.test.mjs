import test from 'node:test';
import assert from 'node:assert/strict';
import { publicPublicationConfig, publicationSession, assertPublicationMutation, assertPublicationTarget, assertPublicationExecutionWindow } from '../../src/v2/public-publication-access.mjs';

const now = Date.parse('2026-10-01T01:00:00Z');
const taskId = '00000000-0000-4000-8000-000000000001';
const otherTaskId = '00000000-0000-4000-8000-000000000002';
const verificationId = '00000000-0000-4000-8000-000000000003';
const packageDigest = 'a'.repeat(64);
const session = { role: 'ADMIN', user: { id: 'synthetic-admin', email: 'owner@example.invalid' } };
const settings = () => ({ V2_FC_PUBLIC_WRITE_SCOPE: 'PUBLICATION_ONLY', V2_LOCAL_DEVELOPMENT: 'false',
  V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid', V2_PUBLIC_PUBLICATION_TASK_ID: taskId,
  V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: packageDigest, V2_PUBLIC_PUBLICATION_VERIFICATION_ID: verificationId,
  V2_PUBLIC_PUBLICATION_STARTS_AT: new Date(now - 1000).toISOString(),
  V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(now + 3600000).toISOString() });
const target = { agentId: taskId, packageDigest, verificationId };
const release = { sourceAgentTaskId: taskId, packageDigest, verificationId };
const path = `/api/v2/agent/tasks/${taskId}/publication`;

test('publication rollout is disabled unless explicitly selected and other scopes are untouched', () => {
  for (const value of [undefined, '', 'DEVELOPMENT_ONLY', 'UNKNOWN']) {
    assert.equal(publicPublicationConfig({ V2_FC_PUBLIC_WRITE_SCOPE: value }), undefined);
  }
  assert.equal(publicationSession(undefined, session, now), undefined);
  assert.doesNotThrow(() => assertPublicationMutation(undefined, undefined, 'POST', '/unknown', NaN));
  assert.doesNotThrow(() => assertPublicationTarget(undefined, null, NaN));
  assert.doesNotThrow(() => assertPublicationExecutionWindow(undefined, null, NaN));
});

test('configuration validates exact package identifiers, administrator email and fixed two-hour bounds', () => {
  const env = settings(), config = publicPublicationConfig(env);
  assert.equal(config.taskId, taskId); assert.equal(config.packageDigest, packageDigest);
  assert.equal(config.verificationId, verificationId); assert.equal(Object.isFrozen(config), true);
  assert.equal(publicPublicationConfig({ ...env, V2_BOOTSTRAP_ADMIN_EMAIL: ' OWNER@example.invalid ' }).email, session.user.email);
  for (const change of [
    { V2_LOCAL_DEVELOPMENT: 'true' }, { V2_LOCAL_DEVELOPMENT: false },
    { V2_BOOTSTRAP_ADMIN_EMAIL: 'owner' }, { V2_BOOTSTRAP_ADMIN_EMAIL: 'a@b@c.invalid' },
    { V2_BOOTSTRAP_ADMIN_EMAIL: 'a b@example.invalid' }, { V2_BOOTSTRAP_ADMIN_EMAIL: undefined },
    { V2_BOOTSTRAP_ADMIN_EMAIL: `${'a'.repeat(160)}@example.invalid` },
    { V2_PUBLIC_PUBLICATION_TASK_ID: undefined }, { V2_PUBLIC_PUBLICATION_TASK_ID: 'f'.repeat(36) },
    { V2_PUBLIC_PUBLICATION_TASK_ID: `${taskId}/publication` }, { V2_PUBLIC_PUBLICATION_TASK_ID: [taskId] },
    { V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: 'g'.repeat(64) }, { V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: 'A'.repeat(64) },
    { V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: 'a'.repeat(63) }, { V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: undefined },
    { V2_PUBLIC_PUBLICATION_VERIFICATION_ID: 'bad' }, { V2_PUBLIC_PUBLICATION_VERIFICATION_ID: [verificationId] },
    { V2_PUBLIC_PUBLICATION_STARTS_AT: '' }, { V2_PUBLIC_PUBLICATION_STARTS_AT: now },
    { V2_PUBLIC_PUBLICATION_EXPIRES_AT: 'not-a-date' },
    { V2_PUBLIC_PUBLICATION_EXPIRES_AT: env.V2_PUBLIC_PUBLICATION_STARTS_AT },
    { V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(now - 2000).toISOString() },
    { V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(now + 2 * 3600000).toISOString() },
  ]) assert.throws(() => publicPublicationConfig({ ...env, ...change }), /PUBLIC_PUBLICATION_CONFIG_INVALID/);
  assert.doesNotThrow(() => publicPublicationConfig({ ...env, V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(config.startsAt + 2 * 3600000).toISOString() }));
});

test('session only advertises delivery for the configured administrator inside the fixed window', () => {
  const config = publicPublicationConfig(settings()), view = publicationSession(config, session, now);
  assert.deepEqual(view, { readOnly: false, permissions: ['SESSION', 'DELIVERY'], publicationOnly: true,
    publicationTaskId: taskId, publicationPackageDigest: packageDigest, publicationVerificationId: verificationId,
    publicationStartsAt: new Date(config.startsAt).toISOString(), publicationExpiresAt: new Date(config.expiresAt).toISOString() });
  assert.equal(publicationSession(config, { ...session, user: { ...session.user, email: 'OWNER@example.invalid' } }, now).readOnly, false);
  for (const identity of [undefined, {}, { ...session, role: 'ENGINEER' },
    { ...session, user: { ...session.user, email: 'other@example.invalid' } },
    { ...session, user: { ...session.user, email: 123 } }]) {
    assert.equal(publicationSession(config, identity, now).readOnly, true);
    assert.deepEqual(publicationSession(config, identity, now).permissions, ['SESSION']);
    for (const field of ['publicationTaskId', 'publicationPackageDigest', 'publicationVerificationId'])
      assert.equal(Object.hasOwn(publicationSession(config, identity, now), field), false);
    assert.throws(() => assertPublicationMutation(config, identity, 'POST', path, now), { code: 'PUBLIC_PUBLICATION_CLOSED' });
  }
  assert.equal(publicationSession(config, session, config.startsAt).readOnly, false);
  for (const time of [config.startsAt - 1, config.expiresAt, NaN, Infinity, '123']) {
    assert.equal(publicationSession(config, session, time).readOnly, true);
    assert.equal(publicationSession(config, session, time).publicationTaskId, taskId);
    assert.throws(() => assertPublicationMutation(config, session, 'POST', path, time), { code: 'PUBLIC_PUBLICATION_CLOSED' });
    assert.throws(() => assertPublicationTarget(config, target, time), { code: 'PUBLIC_PUBLICATION_CLOSED' });
    assert.throws(() => assertPublicationExecutionWindow(config, release, time), { code: 'PUBLIC_PUBLICATION_CLOSED' });
  }
});

test('only exact selected-task publication and cancellation writes pass; reads and login/logout remain available', () => {
  const config = publicPublicationConfig(settings());
  for (const route of [path, `${path}/cancel`]) assert.doesNotThrow(() => assertPublicationMutation(config, session, 'POST', route, now));
  for (const route of ['/api/v2/agent/tasks', '/api/v2/revisions', '/api/v2/runs',
    `/api/v2/agent/tasks/${taskId}/advance`, `/api/v2/agent/tasks/${taskId}/prepare-delivery`,
    `/api/v2/agent/tasks/${otherTaskId}/publication`, `${path}/`, `${path}/cancel/`, `${path}?extra=1`,
    '/api/v2/releases', `/api/v2/delivery/packages/${taskId}/approve`,
    '/api/v2/auth/invitations', '/api/v2/auth/redeem', '/api/v2/auth/password',
    '/api/v2/data-services/applications', '/api/v2/python/runs'])
    assert.throws(() => assertPublicationMutation(config, session, 'POST', route, now), { code: 'PUBLIC_PUBLICATION_SCOPE_DENIED' });
  for (const method of ['PUT', 'PATCH', 'DELETE', 'post', undefined])
    assert.throws(() => assertPublicationMutation(config, session, method, path, now), { code: 'PUBLIC_PUBLICATION_SCOPE_DENIED' });
  for (const route of [path, '/api/v2/agent/tasks', '/api/v2/auth/session'])
    assert.doesNotThrow(() => assertPublicationMutation(config, undefined, 'GET', route, config.expiresAt));
  for (const route of ['/api/v2/auth/login', '/api/v2/auth/logout']) {
    assert.doesNotThrow(() => assertPublicationMutation(config, undefined, 'POST', route, config.expiresAt));
    assert.throws(() => assertPublicationMutation(config, session, 'DELETE', route, now), { code: 'PUBLIC_PUBLICATION_SCOPE_DENIED' });
  }
});

test('published body and execution release must retain the approved task, package and rehearsal identifier', () => {
  const config = publicPublicationConfig(settings());
  assert.doesNotThrow(() => assertPublicationTarget(config, target, now));
  for (const input of [undefined, null, {}, { ...target, agentId: otherTaskId },
    { ...target, packageDigest: 'b'.repeat(64) }, { ...target, verificationId: otherTaskId }])
    assert.throws(() => assertPublicationTarget(config, input, now), { code: 'PUBLIC_PUBLICATION_TARGET_MISMATCH' });
  assert.doesNotThrow(() => assertPublicationExecutionWindow(config, release, now));
  for (const input of [undefined, null, {}, { ...release, sourceAgentTaskId: otherTaskId },
    { ...release, packageDigest: 'b'.repeat(64) }, { ...release, verificationId: otherTaskId },
    { ...release, verificationId: null }, { sourceAgentTaskId: taskId, packageDigest }])
    assert.throws(() => assertPublicationExecutionWindow(config, input, now), { code: 'PUBLIC_PUBLICATION_TARGET_MISMATCH' });
});

test('execution unavailable degrades the publication window to read-only without losing its frozen source', () => {
  const config = publicPublicationConfig({ ...settings(), V2_EXECUTION_UNAVAILABLE: 'true' });
  assert.equal(publicationSession(config, session, now).readOnly, true);
  assert.equal(publicationSession(config, session, now).publicationTaskId, taskId);
  assert.throws(() => assertPublicationMutation(config, session, 'POST', path, now), { code: 'PUBLIC_PUBLICATION_CLOSED' });
  assert.throws(() => assertPublicationTarget(config, target, now), { code: 'PUBLIC_PUBLICATION_CLOSED' });
  assert.throws(() => assertPublicationExecutionWindow(config, release, now), { code: 'PUBLIC_PUBLICATION_CLOSED' });
  assert.doesNotThrow(() => assertPublicationMutation(config, undefined, 'GET', path, now));
  assert.doesNotThrow(() => assertPublicationMutation(config, undefined, 'POST', '/api/v2/auth/login', now));
});
