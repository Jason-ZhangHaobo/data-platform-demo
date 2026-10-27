import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publicationPilotEnvironment, restoredPilotEnvironment } from '../../scripts/deploy-development-pilot.mjs';
import { functionDigest } from '../../scripts/refresh-v2-spark-readiness.mjs';

const now = Date.parse('2026-10-27T04:00:00Z');
function fixture() {
  const before = { functionName: 'dataplatform-v2-fixture-api', runtime: 'custom.debian12', cpu: 0.25, memorySize: 512, instanceConcurrency: 8, codeChecksum: '1234', codeSize: 1000, environmentVariables: {
    V2_LOCAL_DEVELOPMENT: 'false', V2_PROVISIONING_ONLY: 'true', V2_PRIVATE_SMOKE_ENABLED: 'true', V2_FC_PUBLIC_HTTP_ENABLED: 'true', V2_FC_PUBLIC_READ_ONLY: 'true',
    V2_DURABLE_SQL_AGENT_ENABLED: 'true', V2_AGENT_DRIVER_MODE: 'OSS_EVENTS', V2_PRIVATE_RELEASE_ENABLED: 'false', V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid',
    V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: '30', V2_MODEL_MONTHLY_BUDGET_CNY: '50', OSS_BUCKET: 'synthetic-private-bucket',
    V2_SCHEDULER_TICK_SECRET: 'synthetic-old-scheduler-secret-'.repeat(2), V2_SPARK_EXECUTOR_SECRET: 'synthetic-worker-secret-'.repeat(2), OTHER_SECRET_FIXTURE: 'preserve-unchanged',
  } };
  const plan = { scope: 'INVITED_PUBLICATION_PILOT_V1', controlName: before.functionName, maxModelCalls: 0, maxSparkRuns: 2, maxIncrementCny: 5, monthlyCny: 200, priorReserveCny: 32,
    issuedAt: now - 1000, deadline: now + 3000000, baselineDigest: functionDigest(before), previous: { crc64: '1234', bytes: 1000 },
    target: { taskId: '00000000-0000-4000-8000-000000000001', packageDigest: 'a'.repeat(64), verificationId: '00000000-0000-4000-8000-000000000002' },
    triggerNames: Array.from({ length: 4 }, (_, i) => `shuduo-release-pilot-20261027-${i + 1}`), schedulerSecret: 'synthetic-temporary-release-secret-'.repeat(2),
    usage: { month: '2026-10', checkedAt: new Date(now - 1000).toISOString(), sparkRuns: 21, modelCny: 4.85 }, billCny: 2.18,
    bucketPrivacy: { bucketHash: createHash('sha256').update(before.environmentVariables.OSS_BUCKET).digest('hex'), aclPrivate: true, policyNotPublic: true, publicAccessBlocked: true, checkedAt: new Date(now - 1000).toISOString() },
  };
  return { before, plan };
}

test('publication plan enables only one exact target and four named timers without increasing model or Spark budgets', () => {
  const { before, plan } = fixture(), originalBefore = structuredClone(before), originalPlan = structuredClone(plan);
  const next = publicationPilotEnvironment(before, plan, now);
  assert.deepEqual(before, originalBefore); assert.deepEqual(plan, originalPlan);
  assert.equal(next.V2_FC_PUBLIC_READ_ONLY, 'false'); assert.equal(next.V2_FC_PUBLIC_WRITE_SCOPE, 'PUBLICATION_ONLY');
  assert.equal(next.V2_PUBLIC_PUBLICATION_TASK_ID, plan.target.taskId);
  assert.equal(next.V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST, plan.target.packageDigest);
  assert.equal(next.V2_PUBLIC_PUBLICATION_VERIFICATION_ID, plan.target.verificationId);
  assert.equal(Date.parse(next.V2_PUBLIC_PUBLICATION_STARTS_AT), now); assert.equal(Date.parse(next.V2_PUBLIC_PUBLICATION_EXPIRES_AT) - now, 7200000);
  assert.equal(next.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT, '23'); assert.equal(next.V2_MODEL_MONTHLY_BUDGET_CNY, before.environmentVariables.V2_MODEL_MONTHLY_BUDGET_CNY);
  assert.equal(next.V2_PRIVATE_RELEASE_ENABLED, 'true'); assert.equal(next.V2_PRIVATE_RELEASE_TRIGGER_NAMES, plan.triggerNames.join(','));
  assert.equal(next.V2_SCHEDULER_TICK_SECRET, plan.schedulerSecret); assert.equal(next.V2_SPARK_EXECUTOR_SECRET, before.environmentVariables.V2_SPARK_EXECUTOR_SECRET);
  assert.equal(next.V2_BOOTSTRAP_ADMIN_EMAIL, before.environmentVariables.V2_BOOTSTRAP_ADMIN_EMAIL); assert.equal(next.OTHER_SECRET_FIXTURE, before.environmentVariables.OTHER_SECRET_FIXTURE);
  const changed = Object.keys(next).filter(k => next[k] !== before.environmentVariables[k]).sort();
  assert.deepEqual(changed, ['V2_ACCOUNT_MONTHLY_SPEND_CNY','V2_FC_PUBLIC_READ_ONLY','V2_FC_PUBLIC_WRITE_SCOPE','V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT','V2_PRIVATE_RELEASE_ENABLED','V2_PRIVATE_RELEASE_TRIGGER_NAMES','V2_PUBLIC_PUBLICATION_TASK_ID','V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST','V2_PUBLIC_PUBLICATION_VERIFICATION_ID','V2_PUBLIC_PUBLICATION_STARTS_AT','V2_PUBLIC_PUBLICATION_EXPIRES_AT','V2_SCHEDULER_TICK_SECRET'].sort());
});

test('scope, deadline, target, temporary signer and exact timer changes fail closed', () => {
  for (const mutate of [p => { p.scope = 'INVITED_DEVELOPMENT_PILOT_V1'; }, p => { p.maxModelCalls = 1; }, p => { p.maxSparkRuns = 3; }, p => { p.maxIncrementCny = 6; }, p => { p.monthlyCny = 201; }, p => { p.priorReserveCny = 31; },
    p => { p.controlName = 'dataplatform-v2-another-api'; }, p => { p.issuedAt = now + 1; }, p => { p.deadline = now; }, p => { p.deadline = p.issuedAt + 3600001; }, p => { p.issuedAt = String(p.issuedAt); },
    p => { p.target.taskId = 'not-a-task'; }, p => { p.target.packageDigest = 'A'.repeat(64); }, p => { delete p.target.verificationId; }, p => { p.target.runCount = 3; },
    p => { p.triggerNames.pop(); }, p => { p.triggerNames.push('shuduo-release-extra'); }, p => { p.triggerNames[0] = p.triggerNames[1]; }, p => { p.triggerNames.reverse(); },
    p => { p.schedulerSecret = 'short'; }, p => { p.schedulerSecret = 'x'.repeat(513); }, p => { p.schedulerSecret += '\n'; }]) {
    const { before, plan } = fixture(); mutate(plan); assert.throws(() => publicationPilotEnvironment(before, plan, now));
  }
  for (const key of ['V2_SCHEDULER_TICK_SECRET','V2_SPARK_EXECUTOR_SECRET']) {
    const { before, plan } = fixture(); plan.schedulerSecret = before.environmentVariables[key];
    assert.throws(() => publicationPilotEnvironment(before, plan, now), /SCHEDULER_SECRET_INVALID/);
  }
});

test('only unchanged private read-only baseline and its exact previous code are accepted', () => {
  for (const mutate of [b => { b.cpu = 1; }, b => { b.memorySize = 1024; }, b => { b.instanceConcurrency = 1; }, b => { b.runtime = 'nodejs20'; },
    b => { b.environmentVariables.V2_FC_PUBLIC_READ_ONLY = 'false'; }, b => { b.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE = 'DEVELOPMENT_ONLY'; },
    b => { b.environmentVariables.V2_AGENT_DRIVER_MODE = 'PRIVATE_TICK'; }, b => { b.environmentVariables.V2_PRIVATE_RELEASE_ENABLED = 'true'; },
    b => { delete b.environmentVariables.V2_PRIVATE_SMOKE_ENABLED; }, b => { delete b.environmentVariables.V2_BOOTSTRAP_ADMIN_EMAIL; },
    b => { b.environmentVariables.V2_BOOTSTRAP_ADMIN_EMAIL = 'owner@example.invalid\n'; }]) {
    const { before, plan } = fixture(); mutate(before); plan.baselineDigest = functionDigest(before);
    assert.throws(() => publicationPilotEnvironment(before, plan, now), /BASELINE/);
  }
  for (const mutate of [p => { p.baselineDigest = 'changed'; }, p => { p.previous.crc64 = '5678'; }, p => { p.previous.bytes++; }, p => { p.previous.bytes = String(p.previous.bytes); },
    p => { p.bucketPrivacy.bucketHash = 'b'.repeat(64); }, p => { p.bucketPrivacy.aclPrivate = false; }, p => { p.bucketPrivacy.policyNotPublic = false; },
    p => { p.bucketPrivacy.publicAccessBlocked = false; }, p => { p.bucketPrivacy.checkedAt = new Date(now - 3600000).toISOString(); }, p => { p.bucketPrivacy.checkedAt = new Date(now + 1).toISOString(); }]) {
    const { before, plan } = fixture(); mutate(plan); assert.throws(() => publicationPilotEnvironment(before, plan, now));
  }
});

test('fresh actual monthly usage and all existing reserves are mandatory; Spark cap never grows', () => {
  for (const mutate of [p => { p.usage.month = '2026-09'; }, p => { p.usage.checkedAt = new Date(now - 3600000).toISOString(); }, p => { p.usage.checkedAt = new Date(now + 1).toISOString(); },
    p => { p.usage.sparkRuns = -1; }, p => { p.usage.sparkRuns = 1.5; }, p => { p.usage.sparkRuns = '21'; }, p => { p.usage.modelCny = -1; }, p => { p.usage.modelCny = NaN; },
    p => { p.billCny = 163; }, p => { p.billCny = -1; }, p => { p.billCny = '2'; }]) {
    const { before, plan } = fixture(); mutate(plan); assert.throws(() => publicationPilotEnvironment(before, plan, now));
  }
  for (const cap of ['22', '', 'invalid', '23.5', undefined]) {
    const { before, plan } = fixture(); before.environmentVariables.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT = cap; plan.baselineDigest = functionDigest(before);
    assert.throws(() => publicationPilotEnvironment(before, plan, now), /QUOTA_INSUFFICIENT/);
  }
  const { before, plan } = fixture(); before.environmentVariables.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT = '23'; before.environmentVariables.V2_MODEL_MONTHLY_BUDGET_CNY = '0'; plan.baselineDigest = functionDigest(before);
  const next = publicationPilotEnvironment(before, plan, now); assert.equal(next.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT, '23'); assert.equal(next.V2_MODEL_MONTHLY_BUDGET_CNY, '0');
});

test('publication closure removes all temporary fields and restores the exact previous environment and signer', () => {
  const { before, plan } = fixture(), activated = publicationPilotEnvironment(before, plan, now), candidate = { crc64: '5678', bytes: 1200 };
  const current = { ...before, environmentVariables: activated, codeChecksum: candidate.crc64, codeSize: candidate.bytes };
  const restored = restoredPilotEnvironment(current, before, activated, candidate);
  assert.deepEqual(restored, before.environmentVariables); assert.equal(restored.V2_SCHEDULER_TICK_SECRET, before.environmentVariables.V2_SCHEDULER_TICK_SECRET);
  assert.equal(restored.V2_FC_PUBLIC_WRITE_SCOPE, undefined); assert.equal(restored.V2_PUBLIC_PUBLICATION_TASK_ID, undefined);
  for (const altered of [{ ...current, cpu: 1 }, { ...current, environmentVariables: { ...activated, OSS_BUCKET: 'different-private-bucket' } }, { ...current, environmentVariables: { ...activated, V2_SCHEDULER_TICK_SECRET: 'foreign-secret' } }])
    assert.throws(() => restoredPilotEnvironment(altered, before, activated, candidate), /FOREIGN_CONFIGURATION/);
});
