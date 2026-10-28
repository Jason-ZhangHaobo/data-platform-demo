// Synthetic operator IO only: no CLI, network, real identity, cloud resource,
// credential issuance, model invocation or Spark submission is performed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runPublicationPilotOperation, serviceConsumptionPilotEnvironment, validatePilotPackageTransport } from '../../scripts/deploy-development-pilot.mjs';
import { functionDigest } from '../../scripts/refresh-v2-spark-readiness.mjs';
import { runServiceCodePrestage } from '../../scripts/service-code-prestage.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const failure = safeCode => Object.assign(new Error(safeCode), { safeCode });
function fixture() {
  let now = Date.parse('2026-10-28T08:00:00Z');
  const previousBytes = Buffer.from('synthetic previous read-only service package');
  const candidateBytes = Buffer.from('synthetic reviewed service-consumption package');
  const previous = { sha256: sha(previousBytes), bytes: previousBytes.length, crc64: '1234' };
  const candidate = { sha256: sha(candidateBytes), bytes: candidateBytes.length, crc64: '5678' };
  const baseline = { functionName: 'dataplatform-v2-synthetic-api', runtime: 'custom.debian12', cpu: 0.25, memorySize: 512,
    instanceConcurrency: 8, codeChecksum: previous.crc64, codeSize: previous.bytes, timeout: 120, internetAccess: true,
    environmentVariables: { V2_LOCAL_DEVELOPMENT: 'false', V2_PROVISIONING_ONLY: 'true', V2_PRIVATE_SMOKE_ENABLED: 'true',
      V2_PRIVATE_DATA_SERVICES_ENABLED: 'true', V2_FC_PUBLIC_HTTP_ENABLED: 'true', V2_FC_PUBLIC_READ_ONLY: 'true',
      V2_DURABLE_SQL_AGENT_ENABLED: 'false', V2_AGENT_DRIVER_MODE: 'OSS_EVENTS', V2_PRIVATE_RELEASE_ENABLED: 'false',
      V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: '0', V2_MODEL_MONTHLY_BUDGET_CNY: '0', V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid',
      OSS_BUCKET: 'synthetic-private-bucket', V2_SPARK_EXECUTOR_SECRET: 'synthetic-existing-queue-secret-only',
      V2_SCHEDULER_TICK_SECRET: 'synthetic-existing-signing-secret-only', ORIGINAL_VALUE: 'preserve-me' } };
  const target = { taskId: '00000000-0000-4000-8000-000000000011', packageDigest: 'a'.repeat(64),
    sourceReleaseRunId: '00000000-0000-4000-8000-000000000012' };
  const basePlan = { scope: 'INVITED_SERVICE_CONSUMPTION_PILOT_V1', controlName: baseline.functionName,
    maxModelCalls: 0, maxSparkRuns: 0, maxIncrementCny: 2, monthlyCny: 200, priorReserveCny: 37,
    maxReads: 120, maxProbes: 40, normalReadLimit: 84, readLimit: 108, ownerCleanupReadReserve: 12,
    issuedAt: now - 1000, deadline: now + 3500000, baselineDigest: functionDigest(baseline), previous, candidate, target,
    usage: { month: '2026-10', checkedAt: new Date(now).toISOString(), sparkRuns: 7, modelCny: 2.5 }, billCny: 3.25,
    bucketPrivacy: { bucketHash: sha(baseline.environmentVariables.OSS_BUCKET), aclPrivate: true, policyNotPublic: true,
      publicAccessBlocked: true, checkedAt: new Date(now).toISOString() },
    servicePlan: { ...target, applicationName: '合成验收应用', dapis: [
      { name: '合成持仓', slug: 'synthetic-holdings', fields: ['client_id', 'holding_market_value'], timeoutMs: 1000, rateLimitPerMinute: 6 },
      { name: '合成现金', slug: 'synthetic-cash', fields: ['client_id', 'available_cash'], timeoutMs: 1000, rateLimitPerMinute: 6 },
    ], xapi: { name: '合成概览', slug: 'synthetic-overview', timeoutMs: 1000, rateLimitPerMinute: 20,
      steps: [{ alias: 'holdings', dapiSlug: 'synthetic-holdings' }, { alias: 'cash', dapiSlug: 'synthetic-cash' }] } },
    priorUsage: { configReads: 10, activeHttp: 0, configWrites: 0, objectGets: 0, objectPuts: 0, triggerCreates: 0, triggerDeletes: 0, permissionProbes: 0 },
    // Historical completed batches stay visible, separate from this fixed batch.
    historyUsage: { configReads: 137, activeHttp: 58, configWrites: 9, objectGets: 7, objectPuts: 3, triggerCreates: 8, triggerDeletes: 8, permissionProbes: 2 } };
  let current = structuredClone(baseline), lastPlan, lastReport, activeReport, saved;
  const calls = [], controls = {}, objects = new Map([[previous.sha256, previousBytes]]);
  const io = {
    now: () => now, wait: async () => {}, save: report => { saved = structuredClone(report); },
    readCandidate: async () => { calls.push({ candidateRead: true }); assert.notEqual(controls.forbidCandidateRead, true); return candidateBytes; },
    command: async (args, body) => {
      assert.deepEqual(saved.cumulativeUsage, activeReport.cumulativeUsage, 'reserve before every effect');
      assert.ok(!args.some(arg => String(arg).includes('/triggers')), 'service operations cannot inspect or mutate timers');
      calls.push({ args: [...args], body: structuredClone(body) });
      if (args[0] === 'bssopenapi') return { Success: true, Data: { PageNum: 1, PageSize: 300, TotalCount: 1,
        BillingCycle: '2026-10', Items: { Item: [{ Currency: 'CNY', PretaxAmount: controls.bill ?? '3.25' }] } } };
      assert.equal(args[0], 'fc'); const [method, path] = args.slice(1);
      if (method === 'GET' && path.endsWith('/concurrency')) return { reservedConcurrency: controls.reservedConcurrency ?? 1 };
      if (method === 'GET' && path.endsWith('/scaling-config')) return { minInstances: controls.minInstances ?? 0 };
      assert.equal(path, `/2023-03-30/functions/${baseline.functionName}`);
      if (method === 'GET') return structuredClone(controls.readSnapshots?.length ? controls.readSnapshots.shift() : current);
      assert.equal(method, 'PUT'); assert.ok(Object.keys(body).every(key => ['code', 'environmentVariables'].includes(key)));
      const prior = structuredClone(current);
      if (controls.unappliedUpdate) throw failure('CLOUD_REQUEST_UNCONFIRMED');
      if (body.code) {
        const pkg = body.code.checksum === previous.crc64 ? previous : candidate;
        assert.equal(body.code.ossObjectName, `data-platform-demo/v2/control-plane/${pkg.sha256}.zip`);
        current.codeChecksum = pkg.crc64; current.codeSize = pkg.bytes;
      }
      if (body.environmentVariables) current.environmentVariables = structuredClone(body.environmentVariables);
      if (controls.pendingAfterUpdate) {
        controls.pendingAfterUpdate = false;
        controls.readSnapshots = [{ ...prior, state: 'Active', lastUpdateStatus: 'InProgress' }, { ...current, state: 'Active', lastUpdateStatus: 'InProgress' }];
      }
      if (controls.stuckPendingAfterUpdate) current = { ...prior, state: 'Active', lastUpdateStatus: 'InProgress' };
      if (controls.lostUpdate) throw failure('CLOUD_REQUEST_UNCONFIRMED');
      return structuredClone(current);
    },
    object: async (pkg, method, bytes, query) => {
      assert.deepEqual(saved.cumulativeUsage, activeReport.cumulativeUsage);
      assert.ok([previous.sha256, candidate.sha256].includes(pkg.sha256));
      calls.push({ object: pkg.sha256, method, query });
      if (controls.forbidObjectPut) assert.equal(method, 'GET');
      if (query === 'acl') return new Response(`<AccessControlPolicy><AccessControlList><Grant>${controls.publicObject ? 'public-read' : 'private'}</Grant></AccessControlList></AccessControlPolicy>`);
      if (method === 'PUT') {
        if (!controls.unappliedUpload) objects.set(pkg.sha256, bytes);
        if (controls.lostUpload || controls.unappliedUpload) throw failure('UPLOAD_UNCONFIRMED');
        return new Response('', { status: 200 });
      }
      if (!objects.has(pkg.sha256)) return new Response('', { status: 404 });
      return new Response(objects.get(pkg.sha256), { headers: { 'x-oss-hash-crc64ecma': controls.wrongCrc && pkg.sha256 === candidate.sha256 ? '9999' : pkg.crc64 } });
    },
    http: async path => {
      assert.deepEqual(saved.cumulativeUsage, activeReport.cumulativeUsage); calls.push({ http: path });
      if (controls.badRuntime) return { status: 503, body: {} };
      if (path.endsWith('/status')) return { status: controls.badStatus ? 503 : 200,
        body: { spark: { healthVerified: false }, agentDevelopment: { durableEnabled: false } } };
      assert.equal(path, '/api/v2/auth/session'); const e = current.environmentVariables;
      return { status: 200, body: { authenticated: false, readOnly: controls.anonymousWritable ? false : true,
        ...(e.V2_FC_PUBLIC_WRITE_SCOPE === 'SERVICE_CONSUMPTION_ONLY' ? { consumptionOnly: true,
          consumptionExpiresAt: controls.wrongExpires ? new Date(now + 1).toISOString() : e.V2_PUBLIC_SERVICE_EXPIRES_AT } : {}) } };
    },
  };
  async function step(mode, changes = {}) {
    const plan = { ...structuredClone(lastPlan ?? basePlan), mode,
      ...(lastReport ? { phase: lastReport.phase, baseline: lastReport.baseline, servicePlanDigest: lastReport.servicePlanDigest,
        stagedDigest: lastReport.staged && functionDigest(lastReport.staged), candidate: lastReport.candidate,
        activated: lastReport.activated, priorUsage: lastReport.cumulativeUsage,
        ...(lastReport.preStagedObjectDigest ? { preStagedObjectDigest: lastReport.preStagedObjectDigest } : {}) } : {}), ...changes };
    const report = { phase: 'STARTED', configReads: 1, identityReads: 1, configWrites: 0, objectGets: 0, objectPuts: 0,
      activeHttp: 0, triggerCreates: 0, triggerDeletes: 0, permissionProbes: 0, modelCalls: 0, sparkRuns: 0 };
    activeReport = report; lastPlan = plan; lastReport = report;
    await runPublicationPilotOperation(plan, structuredClone(current), report, io); return report;
  }
  return { step, open: async () => { await step('stage'); return step('activate'); }, basePlan, baseline, calls, controls, previous, candidate, candidateBytes, objects,
    get now() { return now; }, get current() { return current; }, get report() { return lastReport; }, get plan() { return lastPlan; },
    advance: ms => { now += ms; } };
}

function preStagedFixture(putAttempts = 0) {
  const f = fixture();
  f.basePlan.packageTransport = 'PRESTAGED_READ_ONLY_V1';
  f.basePlan.priorReserveCny = 39;
  f.basePlan.preStagedObject = { protocol: 'VERIFIED_PRIVATE_CODE_OBJECT_V1', ...f.candidate,
    verifiedAt: new Date(f.basePlan.issuedAt - 1000).toISOString(), putAttempts };
  f.basePlan.priorUsage.objectPuts = putAttempts;
  f.objects.set(f.candidate.sha256, f.candidateBytes);
  f.controls.forbidCandidateRead = true; f.controls.forbidObjectPut = true;
  return f;
}

test('service environment changes only the exact service window and bill without increasing compute quotas', () => {
  const f = fixture(), original = structuredClone(f.baseline), plan = structuredClone(f.basePlan);
  const env = serviceConsumptionPilotEnvironment(f.baseline, plan, f.now);
  assert.deepEqual(f.baseline, original); assert.deepEqual(plan, f.basePlan);
  assert.equal(env.V2_FC_PUBLIC_WRITE_SCOPE, 'SERVICE_CONSUMPTION_ONLY'); assert.equal(env.V2_FC_PUBLIC_READ_ONLY, 'false');
  assert.deepEqual(JSON.parse(env.V2_PUBLIC_SERVICE_PLAN), plan.servicePlan);
  assert.equal(Date.parse(env.V2_PUBLIC_SERVICE_STARTS_AT), f.now);
  assert.equal(Date.parse(env.V2_PUBLIC_SERVICE_EXPIRES_AT) - f.now, 7200000);
  assert.deepEqual(Object.keys(env).filter(key => env[key] !== original.environmentVariables[key]).sort(),
    ['V2_FC_PUBLIC_WRITE_SCOPE', 'V2_FC_PUBLIC_READ_ONLY', 'V2_PUBLIC_SERVICE_PLAN', 'V2_PUBLIC_SERVICE_STARTS_AT', 'V2_PUBLIC_SERVICE_EXPIRES_AT', 'V2_ACCOUNT_MONTHLY_SPEND_CNY'].sort());
  for (const key of ['V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT', 'V2_MODEL_MONTHLY_BUDGET_CNY', 'V2_SCHEDULER_TICK_SECRET', 'V2_SPARK_EXECUTOR_SECRET', 'ORIGINAL_VALUE'])
    assert.equal(env[key], original.environmentVariables[key]);
});

test('exact scope, source, service plan, object pair, budget and window reject expanded authority before IO', async () => {
  const mutations = [
    p => { p.maxModelCalls = 1; }, p => { p.maxSparkRuns = 1; }, p => { p.maxIncrementCny = 3; }, p => { p.monthlyCny = 201; },
    p => { p.priorReserveCny = 36; }, p => { p.issuedAt += 4000000; }, p => { p.deadline = p.issuedAt + 3600001; },
    p => { p.controlName += '-other'; }, p => { p.target.sourceReleaseRunId = '00000000-0000-4000-8000-000000000013'; },
    p => { p.target.extra = true; }, p => { p.servicePlan.taskId = '00000000-0000-4000-8000-000000000014'; },
    p => { p.servicePlan.xapi.steps[1].dapiSlug = 'another-source'; }, p => { p.servicePlan.dapis.push(p.servicePlan.dapis[0]); },
    p => { p.servicePlan.applicationName = ''; }, p => { p.servicePlan.extra = true; }, p => { p.servicePlan.dapis[0].fields.push('secret_field'); },
    p => { p.candidate.sha256 = p.previous.sha256; }, p => { p.candidate.sha256 = '../other'; }, p => { p.candidate.bytes = 67108865; },
    p => { p.billCny = 161; }, p => { p.billCny = '3.25'; }, p => { p.bucketPrivacy.aclPrivate = false; },
    p => { p.usage.checkedAt = new Date(Date.parse(p.usage.checkedAt) - 3600000).toISOString(); }, p => { p.usage.sparkRuns = -1; },
  ];
  for (const mutate of mutations) {
    const f = fixture(), plan = structuredClone(f.basePlan); mutate(plan);
    assert.throws(() => serviceConsumptionPilotEnvironment(f.baseline, plan, f.now));
    await assert.rejects(f.step('stage', plan)); assert.equal(f.calls.length, 0);
  }
});

test('service mode forbids timer fields, timer modes and inherited timer operations even when empty', async () => {
  for (const key of ['triggerNames', 'timerRecords', 'timerPreparedAt', 'schedulerSecret', 'permissionProbe', 'releaseId', 'stageCheckpoint']) {
    const f = fixture(); await assert.rejects(f.step('stage', { [key]: undefined }), /TIMER_AUTHORITY_FORBIDDEN/); assert.equal(f.calls.length, 0);
  }
  for (const mode of ['timers', 'cleanup-timers', 'resume-stage', 'deploy']) {
    const f = fixture(); await assert.rejects(f.step(mode), /SCOPE_INVALID/); assert.equal(f.calls.length, 0);
  }
  for (const key of ['triggerCreates', 'triggerDeletes', 'permissionProbes']) {
    const f = fixture(); await assert.rejects(f.step('stage', { priorUsage: { ...f.basePlan.priorUsage, [key]: 1 } }), /TIMER_AUTHORITY_FORBIDDEN/);
    assert.equal(f.calls.length, 0);
  }
});

test('read-only service baseline and original capacity are mandatory while unavailable Spark is permitted', async () => {
  for (const mutate of [b => { b.cpu = 1; }, b => { b.memorySize = 1024; }, b => { b.instanceConcurrency = 1; },
    b => { b.environmentVariables.V2_PRIVATE_DATA_SERVICES_ENABLED = 'false'; }, b => { b.environmentVariables.V2_FC_PUBLIC_READ_ONLY = 'false'; },
    b => { b.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE = 'PUBLICATION_ONLY'; }, b => { b.environmentVariables.V2_PRIVATE_RELEASE_ENABLED = 'true'; }]) {
    const f = fixture(), baseline = structuredClone(f.baseline); mutate(baseline);
    assert.throws(() => serviceConsumptionPilotEnvironment(baseline, { ...f.basePlan, baselineDigest: functionDigest(baseline) }, f.now), /BASELINE/);
  }
  for (const controls of [{ reservedConcurrency: 2 }, { minInstances: 1 }]) {
    const f = fixture(); Object.assign(f.controls, controls);
    await assert.rejects(f.step('stage'), /CAPACITY_MISMATCH/);
    assert.ok(!f.calls.some(call => call.args?.[1] === 'PUT' || call.method === 'PUT'));
  }
  const f = fixture(); await f.open(); assert.equal(f.report.runtime.ready, true); assert.equal(f.report.runtime.sparkReady, false);
});

test('stage, activate and close reuse one frozen package and preserve current and prior batch counters', async () => {
  const f = fixture(); const staged = await f.step('stage');
  assert.equal(staged.phase, 'STAGED'); assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables);
  const activated = await f.step('activate'); assert.equal(activated.phase, 'OPENED');
  assert.equal(activated.cumulativeUsage.configWrites, 2); assert.equal(activated.cumulativeUsage.objectPuts, 1);
  assert.equal(activated.runtime.consumptionOnly, true); assert.equal(activated.runtime.readOnlyAnonymous, true);
  assert.equal(activated.runtime.expiresAt, activated.activated.V2_PUBLIC_SERVICE_EXPIRES_AT);
  const deadline = activated.deadline; f.advance(1000);
  const closed = await f.step('close'); assert.equal(closed.phase, 'CLOSED_READONLY'); assert.equal(closed.deadline, deadline);
  assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables); assert.equal(f.current.codeChecksum, f.candidate.crc64);
  assert.equal(closed.cumulativeUsage.configWrites, 3); assert.equal(closed.cumulativeUsage.objectPuts, 1);
  assert.ok(closed.cumulativeUsage.configReads > staged.cumulativeUsage.configReads);
  assert.deepEqual(closed.historyUsage, f.basePlan.historyUsage); assert.ok(closed.cumulativeUsage.configReads < f.basePlan.historyUsage.configReads);
  for (const key of ['triggerCreates', 'triggerDeletes', 'permissionProbes', 'modelCalls', 'sparkRuns']) assert.equal(closed[key], 0);
  assert.equal(Object.hasOwn(closed, 'timerRecords'), false); assert.equal(closed.timersAbsenceVerified, undefined);
  assert.ok(!f.calls.some(call => call.args?.some(arg => /triggers|\/invoke|custom-domains|ram/.test(arg))));
});

test('a changed plan cannot be substituted between staging and activation, or renew an already-open window', async () => {
  const f = fixture(); await f.step('stage'); const changed = structuredClone(f.basePlan.servicePlan); changed.applicationName = '替换应用';
  await assert.rejects(f.step('activate', { servicePlan: changed }), /PLAN_CHECKPOINT_MISMATCH/);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'PUT').length, 1);
  const g = fixture(); await g.open(); const expires = g.report.activated.V2_PUBLIC_SERVICE_EXPIRES_AT;
  await assert.rejects(g.step('activate'), /STAGED_SNAPSHOT_REQUIRED/);
  assert.equal(g.current.environmentVariables.V2_PUBLIC_SERVICE_EXPIRES_AT, expires);
  assert.equal(g.calls.filter(call => call.args?.[1] === 'PUT').length, 2);
});

test('unknown applied configuration or upload response is reconciled without repeating a write', async () => {
  const f = fixture(); f.controls.lostUpload = true; f.controls.lostUpdate = true; await f.open();
  assert.equal(f.report.updateResponseUnknown, true); assert.equal(f.report.cumulativeUsage.configWrites, 2);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'PUT').length, 2);
  const g = fixture(); g.controls.unappliedUpdate = true;
  await assert.rejects(g.step('stage'), /UPDATE_NOT_RECONCILED/);
  assert.equal(g.report.rollback, 'ALREADY_BASELINE'); assert.equal(g.report.cumulativeUsage.configWrites, 1);
  assert.equal(g.calls.filter(call => call.args?.[1] === 'PUT').length, 1);
});

test('public object or lost unapplied upload stops before FC writes and never repeats the PUT', async () => {
  const f = fixture(); f.controls.publicObject = true; await assert.rejects(f.step('stage'), /PRIVACY_UNCONFIRMED/);
  assert.equal(f.report.cumulativeUsage.configWrites, 0);
  const g = fixture(); g.controls.unappliedUpload = true; await assert.rejects(g.step('stage'));
  assert.equal(g.report.cumulativeUsage.objectPuts, 1); assert.equal(g.report.cumulativeUsage.configWrites, 0);
  await assert.rejects(g.step('stage'), /STAGE_ALREADY_ATTEMPTED/);
  assert.equal(g.calls.filter(call => call.method === 'PUT').length, 1);
});

test('failed runtime restores the exact pre-step snapshot; successful read-only close needs status and expiry checks', async () => {
  const f = fixture(); f.controls.badRuntime = true;
  await assert.rejects(f.step('stage'), /READONLY_RESTORE_NOT_VERIFIED/);
  assert.equal(f.report.rollback, 'VERIFIED'); assert.deepEqual(f.current, f.baseline);
  for (const controls of [{ wrongExpires: true }, { badStatus: true }, { anonymousWritable: true }]) {
    const g = fixture(); await g.step('stage'); Object.assign(g.controls, controls);
    await assert.rejects(g.step('activate'), /PILOT_RUNTIME_NOT_VERIFIED/);
    assert.equal(g.report.rollback, 'VERIFIED'); assert.equal(g.report.rollbackTarget, 'STAGED_READONLY');
    assert.deepEqual(g.current.environmentVariables, g.baseline.environmentVariables); assert.equal(g.current.codeChecksum, g.candidate.crc64);
    Object.assign(g.controls, { wrongExpires: false, badStatus: false, anonymousWritable: false });
    const closed = await g.step('close'); assert.equal(closed.readOnlyAlreadyRestored, true); assert.equal(closed.cumulativeUsage.configWrites, 3);
  }
});

test('pending updates cannot be called restored and foreign state is never overwritten', async () => {
  const f = fixture(); f.controls.pendingAfterUpdate = true; await f.step('stage'); assert.equal(f.report.phase, 'STAGED');
  const g = fixture(); g.controls.stuckPendingAfterUpdate = true;
  await assert.rejects(g.step('stage'), /UPDATE_PENDING/); assert.equal(g.report.rollback, undefined);
  assert.equal(g.report.rollbackFailure, 'UPDATE_PENDING'); assert.equal(g.report.cumulativeUsage.configWrites, 1);
  const h = fixture(); await h.open(); h.current.environmentVariables.ORIGINAL_VALUE = 'foreign';
  await assert.rejects(h.step('close'), /FOREIGN_CONFIGURATION/); assert.equal(h.calls.filter(call => call.args?.[1] === 'PUT').length, 2);
});

test('rollback restores original code and environment using only the two exact private objects', async () => {
  const f = fixture(); await f.open(); const result = await f.step('rollback');
  assert.equal(result.phase, 'ROLLED_BACK'); assert.deepEqual(f.current, f.baseline);
  assert.equal(result.cumulativeUsage.configWrites, 3); assert.equal(result.cumulativeUsage.objectPuts, 1);
  assert.ok(f.calls.filter(call => call.object).every(call => [f.previous.sha256, f.candidate.sha256].includes(call.object)));
  assert.deepEqual(result.historyUsage, f.basePlan.historyUsage);
});

test('fixed read, probe, reserve and budget limits cannot be reset or borrowed from owner cleanup', async () => {
  for (const changes of [{ maxReads: 121 }, { maxProbes: 41 }, { normalReadLimit: 85 }, { readLimit: 109 }, { ownerCleanupReadReserve: 11 }]) {
    const f = fixture(); await assert.rejects(f.step('stage', changes), /SCOPE_INVALID/); assert.equal(f.calls.length, 0);
  }
  for (const changes of [{ historyUsage: undefined }, { priorUsage: undefined }]) {
    const f = fixture(); await assert.rejects(f.step('stage', changes), /HISTORY_REQUIRED/); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await assert.rejects(f.step('stage', { priorUsage: { ...f.basePlan.priorUsage, configReads: 83 } }), /USAGE_LIMIT/);
  assert.equal(f.calls.length, 0);
  const g = fixture(); g.controls.bill = '161'; await assert.rejects(g.step('stage'), /BUDGET_NOT_VERIFIED/);
  assert.equal(g.report.cumulativeUsage.configWrites, 0); assert.equal(g.report.cumulativeUsage.objectPuts, 0);
  const h = fixture(); await h.open(); h.advance(3500001);
  const count = h.calls.length; await assert.rejects(h.step('close'), /PLAN_EXPIRED/); assert.equal(h.calls.length, count);
});

test('exact restoration may consume the recovery allowance despite stale observations but preserves owner cleanup reads', async () => {
  const f = fixture(); await f.open();
  const result = await f.step('close', { priorUsage: { ...f.report.cumulativeUsage, configReads: 105 },
    usage: { ...f.basePlan.usage, checkedAt: new Date(f.now - 3600000).toISOString() },
    bucketPrivacy: { ...f.basePlan.bucketPrivacy, checkedAt: new Date(f.now - 3600000).toISOString() }, billCny: 161 });
  assert.equal(result.phase, 'CLOSED_READONLY'); assert.equal(result.cumulativeUsage.configReads, 108);
  assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables);
  const g = fixture(); await g.open(); const previousCalls = g.calls.length;
  await assert.rejects(g.step('rollback', { priorUsage: { ...g.report.cumulativeUsage, configReads: 107 } }), /USAGE_LIMIT/);
  assert.equal(g.calls.length, previousCalls);
});

test('unknown restoration is only reconciled from the original checkpoint and is never resubmitted', async () => {
  const f = fixture(); await f.open(); f.controls.unappliedUpdate = true;
  await assert.rejects(f.step('close'), /UPDATE_NOT_RECONCILED/);
  assert.equal(f.report.phase, 'RESTORE_REQUESTED'); assert.equal(f.report.restoreResponseUnknown, true);
  const writes = f.calls.filter(call => call.args?.[1] === 'PUT').length;
  await assert.rejects(f.step('close'), /RESTORE_ALREADY_ATTEMPTED/);
  assert.equal(f.report.phase, 'RESTORE_REQUESTED');
  await assert.rejects(f.step('close'), /RESTORE_ALREADY_ATTEMPTED/);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'PUT').length, writes);
  const g = fixture(); await g.open(); g.controls.badRuntime = true;
  await assert.rejects(g.step('rollback'), /READONLY_RESTORE_NOT_VERIFIED/);
  assert.deepEqual(g.current, g.baseline); g.controls.badRuntime = false;
  const restored = await g.step('rollback');
  assert.equal(restored.phase, 'ROLLED_BACK'); assert.equal(restored.readOnlyAlreadyRestored, true);
  assert.equal(g.calls.filter(call => call.args?.[1] === 'PUT').length, 3);
});

test('pre-staged transport verifies the exact object pair and closes without artifact reads or any object PUT', async () => {
  for (const putAttempts of [0, 1]) {
    const f = preStagedFixture(putAttempts), history = structuredClone(f.basePlan.historyUsage);
    const staged = await f.step('stage');
    assert.equal(staged.phase, 'STAGED'); assert.equal(staged.objectPuts, 0); assert.equal(staged.runUsage.objectPuts, 0);
    assert.equal(staged.cumulativeUsage.objectPuts, putAttempts);
    assert.equal(staged.packageTransport, 'PRESTAGED_READ_ONLY_V1');
    assert.deepEqual(staged.preStagedObject, f.basePlan.preStagedObject); assert.match(staged.preStagedObjectDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.calls.filter(call => call.object).map(call => [call.object, call.method, call.query]), [
      [f.previous.sha256, 'GET', ''], [f.previous.sha256, 'GET', 'acl'], [f.candidate.sha256, 'GET', ''], [f.candidate.sha256, 'GET', 'acl'],
    ]);
    assert.equal(staged.cumulativeUsage.objectGets, 4);
    await f.step('activate'); const closed = await f.step('close');
    assert.equal(closed.phase, 'CLOSED_READONLY'); assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables);
    assert.equal(f.current.codeChecksum, f.candidate.crc64); assert.equal(closed.cumulativeUsage.objectPuts, putAttempts);
    assert.equal(closed.objectPuts, 0); assert.equal(closed.runUsage.objectPuts, 0); assert.deepEqual(closed.historyUsage, history);
    assert.equal(closed.preStagedObjectDigest, staged.preStagedObjectDigest);
    assert.ok(!f.calls.some(call => call.candidateRead || call.object && call.method !== 'GET'));
  }
});

test('missing or corrupt pre-staged bytes, wrong CRC and public ACL never trigger a download, replacement PUT or function write', async () => {
  for (const mutate of [f => f.objects.delete(f.candidate.sha256), f => f.objects.set(f.candidate.sha256, Buffer.alloc(f.candidate.bytes, 120)),
    f => { f.controls.wrongCrc = true; }, f => { f.controls.publicObject = true; }]) {
    const f = preStagedFixture(1); mutate(f); await assert.rejects(f.step('stage'));
    assert.equal(f.report.cumulativeUsage.configWrites, 0); assert.equal(f.report.cumulativeUsage.objectPuts, 1);
    assert.equal(f.report.runUsage.objectPuts, 0); assert.deepEqual(f.current, f.baseline);
    assert.ok(!f.calls.some(call => call.candidateRead || call.object && call.method !== 'GET'));
    assert.ok(f.report.cumulativeUsage.configReads > f.basePlan.priorUsage.configReads);
  }
});

test('pre-staged receipt schema, candidate identity, original time and inherited upload count are mandatory before IO', async () => {
  const mutations = [p => { p.packageTransport = 'UNKNOWN'; }, p => { p.packageTransport = null; }, p => { p.preStagedObject = undefined; },
    p => { p.preStagedObject.protocol = 'UNVERIFIED'; }, p => { p.preStagedObject.extra = true; }, p => { delete p.preStagedObject.verifiedAt; },
    p => { p.preStagedObject.sha256 = 'a'.repeat(64); }, p => { p.preStagedObject.bytes++; }, p => { p.preStagedObject.bytes = String(p.candidate.bytes); },
    p => { p.preStagedObject.crc64 = '9999'; }, p => { delete p.candidate.crc64; }, p => { p.preStagedObject.putAttempts = 2; },
    p => { p.preStagedObject.putAttempts = '1'; }, p => { p.preStagedObject.verifiedAt = 'invalid'; },
    p => { p.preStagedObject.verifiedAt = new Date(p.issuedAt + 1).toISOString(); },
    p => { p.preStagedObject.verifiedAt = new Date(p.issuedAt - 3600001).toISOString(); },
    p => { p.priorUsage.objectPuts = 0; }, p => { p.preStagedObjectDigest = 'a'.repeat(64); }, p => { p.packageTransport = undefined; }];
  for (const mutate of mutations) {
    const f = preStagedFixture(1), changed = structuredClone(f.basePlan); mutate(changed);
    await assert.rejects(f.step('stage', changed)); assert.equal(f.calls.length, 0);
  }
  const f = preStagedFixture(0); f.basePlan.preStagedObject.verifiedAt = new Date(f.basePlan.issuedAt - 3600000).toISOString();
  await f.step('stage'); assert.equal(f.report.phase, 'STAGED');
});

test('pre-staged receipt cannot change during activation or restoration, and reserved cost stays exactly 39', async () => {
  for (const mode of ['activate', 'close', 'rollback']) {
    const f = preStagedFixture(1); await f.step('stage'); if (mode !== 'activate') await f.step('activate');
    const count = f.calls.length, changed = { ...f.basePlan.preStagedObject, verifiedAt: new Date(f.basePlan.issuedAt).toISOString() };
    await assert.rejects(f.step(mode, { preStagedObject: changed }), /PRESTAGED_CHECKPOINT_CHANGED/);
    assert.equal(f.calls.length, count);
  }
  for (const reserve of [37, 38, 40]) {
    const f = preStagedFixture(); await assert.rejects(f.step('stage', { priorReserveCny: reserve }), /SCOPE_INVALID/); assert.equal(f.calls.length, 0);
  }
  const f = preStagedFixture(); f.controls.bill = '159'; await assert.rejects(f.step('stage'), /BUDGET_NOT_VERIFIED/);
  assert.equal(f.report.cumulativeUsage.configWrites, 0); assert.equal(f.report.cumulativeUsage.objectPuts, 0);
  const legacy = fixture(); legacy.controls.bill = '159'; await legacy.step('stage'); assert.equal(legacy.report.phase, 'STAGED');
});

test('pre-staged rollback and unknown updates remain read-only for objects without requiring later fresh usage', async () => {
  const f = preStagedFixture(1); f.controls.lostUpdate = true; await f.open();
  assert.equal(f.report.updateResponseUnknown, true); f.advance(1000);
  const rolledBack = await f.step('rollback', { usage: { ...f.basePlan.usage, checkedAt: new Date(f.now - 3600000).toISOString() },
    bucketPrivacy: { ...f.basePlan.bucketPrivacy, checkedAt: new Date(f.now - 3600000).toISOString() }, billCny: 159 });
  assert.equal(rolledBack.phase, 'ROLLED_BACK'); assert.deepEqual(f.current, f.baseline);
  assert.equal(rolledBack.cumulativeUsage.objectPuts, 1); assert.equal(rolledBack.runUsage.objectPuts, 0);
  assert.ok(!f.calls.some(call => call.candidateRead || call.object && call.method !== 'GET'));
  const g = preStagedFixture(1); await g.open(); g.controls.unappliedUpdate = true;
  await assert.rejects(g.step('close'), /UPDATE_NOT_RECONCILED/); const count = g.calls.filter(call => call.args?.[1] === 'PUT').length;
  await assert.rejects(g.step('close'), /RESTORE_ALREADY_ATTEMPTED/);
  assert.equal(g.calls.filter(call => call.args?.[1] === 'PUT').length, count);
  assert.equal(g.report.cumulativeUsage.objectPuts, 1); assert.equal(g.report.runUsage.objectPuts, 0);
});

test('workflow pre_staged flag strictly matches the decrypted transport and is never accepted for another scope', () => {
  const f = preStagedFixture(); assert.equal(validatePilotPackageTransport(f.basePlan, 'true'), true);
  assert.throws(() => validatePilotPackageTransport(f.basePlan, 'false'), /INPUT_MISMATCH/);
  for (const value of ['TRUE', '', null, true, 1]) assert.throws(() => validatePilotPackageTransport(f.basePlan, value), /INPUT_MISMATCH/);
  const legacy = fixture(); assert.equal(validatePilotPackageTransport(legacy.basePlan, 'false'), false);
  assert.throws(() => validatePilotPackageTransport(legacy.basePlan, 'true'), /INPUT_MISMATCH/);
  for (const scope of ['INVITED_DEVELOPMENT_PILOT_V1', 'INVITED_PUBLICATION_PILOT_V1'])
    assert.throws(() => validatePilotPackageTransport({ ...f.basePlan, scope }, 'true'), /TRANSPORT_INVALID/);
});

test('actual local pre-stage receipt carries its upload into cloud verification and safe close without retransmission', async () => {
  const f=fixture(),localCalls=[];let saved;
  const local=await runServiceCodePrestage({plan:{protocol:'SERVICE_CODE_PRESTAGE_V1',authorized:true,attemptNumber:2,
    operationId:'00000000-0000-4000-8000-000000000071',approvalDigest:'a'.repeat(64),closedAttemptDigest:'b'.repeat(64),
    candidate:{sha256:f.candidate.sha256,bytes:f.candidate.bytes},issuedAt:f.now,deadline:f.now+600000,
    maxPuts:1,maxObjectReads:3,maxAclReads:2,priorReserveCny:39,maxIncrementCny:2,monthlyCny:200,billCny:3.25,
    bucketPrivacy:f.basePlan.bucketPrivacy},bytes:f.candidateBytes,now:()=>f.now,io:{
      save:async state=>{saved=structuredClone(state);},
      readObject:async pkg=>{localCalls.push('GET');return f.objects.has(pkg.sha256)?{status:200,bytes:f.objects.get(pkg.sha256),crc64:f.candidate.crc64}:{status:404,serviceCode:'NoSuchKey'};},
      putObject:async(pkg,bytes,options)=>{assert.equal(saved.putAttempts,1);assert.equal(options.forbidOverwrite,true);localCalls.push('PUT');f.objects.set(pkg.sha256,Buffer.from(bytes));throw Object.assign(Error('synthetic lost response'),{name:'TimeoutError'});},
      readAcl:async()=>{localCalls.push('ACL');return{status:200,grant:'private'};},
    }});
  assert.deepEqual(localCalls,['GET','PUT','GET','ACL']);assert.deepEqual(local.checkpoint.failures,['TRANSFER_TIMEOUT']);
  f.basePlan.packageTransport='PRESTAGED_READ_ONLY_V1';f.basePlan.preStagedObject=local.receipt;f.basePlan.priorReserveCny=39;
  f.basePlan.issuedAt=f.now;f.basePlan.priorUsage={...f.basePlan.priorUsage,configReads:f.basePlan.priorUsage.configReads+3,objectGets:3,objectPuts:1};
  f.controls.forbidObjectPut=true;f.controls.forbidCandidateRead=true;
  const history=structuredClone(f.basePlan.historyUsage);await f.step('stage');await f.step('activate');const closed=await f.step('close');
  assert.equal(closed.phase,'CLOSED_READONLY');assert.equal(closed.cumulativeUsage.objectPuts,1);
  assert.equal(closed.runUsage.objectPuts,0);assert.deepEqual(closed.historyUsage,history);
  assert.ok(!f.calls.some(call=>call.candidateRead||call.object&&call.method!=='GET'));
});
