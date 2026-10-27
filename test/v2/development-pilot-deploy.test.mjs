import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pilotEnvironment, restoredPilotEnvironment } from '../../scripts/deploy-development-pilot.mjs';
import { functionDigest } from '../../scripts/refresh-v2-spark-readiness.mjs';
const now = Date.parse('2026-10-27T04:00:00Z');
function fixture() {
  const before = { functionName: 'dataplatform-v2-fixture-api', runtime: 'custom.debian12', cpu: 0.25, memorySize: 512, instanceConcurrency: 8, codeChecksum: '1234', codeSize: 1000, environmentVariables: {
    V2_LOCAL_DEVELOPMENT: 'false', V2_PROVISIONING_ONLY: 'true', V2_FC_PUBLIC_HTTP_ENABLED: 'true', V2_FC_PUBLIC_READ_ONLY: 'true', V2_DURABLE_SQL_AGENT_ENABLED: 'true', V2_AGENT_DRIVER_MODE: 'OSS_EVENTS', V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: '200', V2_MODEL_MONTHLY_BUDGET_CNY: '50', OSS_BUCKET: 'synthetic-private-bucket', SECRET_FIXTURE: 'preserve-unchanged',
  } };
  const plan = { scope: 'INVITED_DEVELOPMENT_PILOT_V1', maxModelCalls: 3, maxSparkRuns: 4, maxIncrementCny: 5, monthlyCny: 200, issuedAt: now - 1000, deadline: now + 3000000, baselineDigest: functionDigest(before), previous: { crc64: '1234', bytes: 1000 }, usage: { month: '2026-10', checkedAt: new Date(now - 1000).toISOString(), sparkRuns: 18, modelCny: 4.85 }, billCny: 2.18, priorReserveCny: 27, bucketPrivacy: { bucketHash: createHash('sha256').update(before.environmentVariables.OSS_BUCKET).digest('hex'), aclPrivate: true, policyNotPublic: true, publicAccessBlocked: true, checkedAt: new Date(now - 1000).toISOString() } };
  return { before, plan };
}
test('authorized pilot preserves secrets and capacity, narrows quota and limits the window', () => {
  const { before, plan } = fixture(), original = structuredClone(before), next = pilotEnvironment(before, plan, now);
  assert.deepEqual(before, original);
  assert.equal(next.SECRET_FIXTURE, original.environmentVariables.SECRET_FIXTURE);
  assert.equal(next.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT, '22');
  assert.equal(next.V2_FC_PUBLIC_WRITE_SCOPE, 'DEVELOPMENT_ONLY');
  assert.equal(next.V2_FC_PUBLIC_READ_ONLY, 'false');
  assert.equal(Date.parse(next.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT) - now, 7200000);
  assert.ok(Number(next.V2_MODEL_MONTHLY_BUDGET_CNY) <= 8.86);
  const keys = Object.keys(next).filter(k => next[k] !== original.environmentVariables[k]).sort();
  assert.deepEqual(keys, ['V2_ACCOUNT_MONTHLY_SPEND_CNY', 'V2_FC_PUBLIC_READ_ONLY', 'V2_FC_PUBLIC_WRITE_SCOPE', 'V2_MODEL_MONTHLY_BUDGET_CNY', 'V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT', 'V2_PUBLIC_DEVELOPMENT_EXPIRES_AT', 'V2_PUBLIC_DEVELOPMENT_STARTS_AT'].sort());
});
test('stale use evidence, scope growth, public bucket and changed baseline are refused', () => {
  for (const mutate of [p => { p.maxSparkRuns = 5; }, p => { p.maxModelCalls = 4; }, p => { p.billCny = 169; }, p => { p.usage.checkedAt = new Date(now - 3600001).toISOString(); }, p => { p.usage.month = '2026-09'; }, p => { p.baselineDigest = 'changed'; }, p => { p.bucketPrivacy.aclPrivate = false; }, p => { p.bucketPrivacy.checkedAt = new Date(now - 3600001).toISOString(); }]) {
    const { before, plan } = fixture(); mutate(plan); assert.throws(() => pilotEnvironment(before, plan, now));
  }
  const { before, plan } = fixture(); before.instanceConcurrency = 16;
  assert.throws(() => pilotEnvironment(before, plan, now), /BASELINE/);
});
test('successful closure retains candidate code but restores exactly the prior environment', () => {
  const { before, plan } = fixture(), activated = pilotEnvironment(before, plan, now), candidate = { crc64: '5678', bytes: 1200 };
  const current = { ...before, environmentVariables: activated, codeChecksum: candidate.crc64, codeSize: candidate.bytes };
  assert.deepEqual(restoredPilotEnvironment(current, before, activated, candidate), before.environmentVariables);
  assert.throws(() => restoredPilotEnvironment({ ...current, cpu: 1 }, before, activated, candidate), /FOREIGN/);
  assert.throws(() => restoredPilotEnvironment({ ...current, environmentVariables: { ...activated, SECRET_FIXTURE: 'foreign-change' } }, before, activated, candidate), /FOREIGN/);
});
