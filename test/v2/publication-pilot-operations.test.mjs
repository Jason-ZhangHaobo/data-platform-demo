// Synthetic operator IO only. No CLI, network, account, timer or paid job runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runPublicationPilotOperation, markUnacceptedPilotFailure } from '../../scripts/deploy-development-pilot.mjs';
import { functionDigest } from '../../scripts/refresh-v2-spark-readiness.mjs';
import { publicationPilotTimerNames } from '../../scripts/publication-pilot-timers.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const failure = safeCode => Object.assign(new Error(safeCode), { safeCode });
function fixture() {
  let now = Date.parse('2026-10-27T08:00:00Z');
  const previousBytes = Buffer.from('synthetic previous control package'), candidateBytes = Buffer.from('synthetic reviewed publication package');
  const previous = { sha256: sha(previousBytes), bytes: previousBytes.length, crc64: '1234' };
  const candidate = { sha256: sha(candidateBytes), bytes: candidateBytes.length, crc64: '5678' };
  const baseline = { functionName: 'dataplatform-v2-synthetic-api', runtime: 'custom.debian12', cpu: 0.25,
    memorySize: 512, instanceConcurrency: 8, codeChecksum: previous.crc64, codeSize: previous.bytes,
    timeout: 120, internetAccess: true, environmentVariables: {
      V2_LOCAL_DEVELOPMENT: 'false', V2_PROVISIONING_ONLY: 'true', V2_PRIVATE_SMOKE_ENABLED: 'true',
      V2_FC_PUBLIC_HTTP_ENABLED: 'true', V2_FC_PUBLIC_READ_ONLY: 'true', V2_DURABLE_SQL_AGENT_ENABLED: 'true',
      V2_AGENT_DRIVER_MODE: 'OSS_EVENTS', V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: '40', V2_MODEL_MONTHLY_BUDGET_CNY: '50',
      V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid', OSS_BUCKET: 'synthetic-private-bucket',
      V2_SPARK_EXECUTOR_SECRET: 'synthetic-unchanged-queue-secret-only-123456789', ORIGINAL_VALUE: 'preserve-me',
    } };
  let current = structuredClone(baseline), lastReport, activeReport, saved, lastPlan;
  const objects = new Map([[previous.sha256, previousBytes]]), timers = new Map();
  const unrelated = { triggerName: 'synthetic-existing-oss', triggerType: 'oss', triggerConfig: '{}' };
  timers.set(unrelated.triggerName, structuredClone(unrelated));
  const calls = [], controls = {};
  const basePlan = { scope: 'INVITED_PUBLICATION_PILOT_V1', controlName: baseline.functionName,
    maxModelCalls: 0, maxSparkRuns: 2, maxIncrementCny: 5, monthlyCny: 200, priorReserveCny: 32,
    maxReads: 120, maxProbes: 40, normalReadLimit: 84, readLimit: 108, ownerCleanupReadReserve: 12, issuedAt: now - 1000, deadline: now + 3500000,
    baselineDigest: functionDigest(baseline), previous, candidate, triggerNames: [...publicationPilotTimerNames],
    schedulerSecret: 'synthetic-new-release-signing-key-only-123456789',
    target: { taskId: '00000000-0000-4000-8000-000000000001', packageDigest: 'a'.repeat(64) },
    usage: { month: '2026-10', checkedAt: new Date(now).toISOString(), sparkRuns: 20, modelCny: 5 },
    billCny: 2.25, bucketPrivacy: { bucketHash: sha(baseline.environmentVariables.OSS_BUCKET),
      aclPrivate: true, policyNotPublic: true, publicAccessBlocked: true, checkedAt: new Date(now).toISOString() },
    priorUsage: { configReads: 12, activeHttp: 0, configWrites: 0, objectGets: 0, objectPuts: 0, triggerCreates: 0, triggerDeletes: 0, permissionProbes: 0 } };
  const io = {
    now: () => now, wait: async () => {},
    save: report => { saved = structuredClone(report); },
    readCandidate: async () => candidateBytes,
    command: async (args, body) => {
      assert.deepEqual(saved.cumulativeUsage, activeReport.cumulativeUsage, 'usage must be saved before every effect');
      calls.push({ args: [...args], body: structuredClone(body), permissionProbe: activeReport.permissionProbe?.outcome === 'REQUESTED' });
      if (args[0] === 'bssopenapi') return { Success: true, Data: { PageNum: 1, PageSize: 300, TotalCount: 1,
        BillingCycle: '2026-10', Items: { Item: [{ Currency: 'CNY', PretaxAmount: controls.bill ?? '2.25' }] } } };
      assert.equal(args[0], 'fc');
      const [method, path] = args.slice(1);
      if (method === 'GET' && path.endsWith('/concurrency')) return { reservedConcurrency: 1 };
      if (method === 'GET' && path.endsWith('/scaling-config')) return { minInstances: 0 };
      if (path.endsWith('/triggers')) {
        if (method === 'GET') return { triggers: [...timers.values()].map(value => structuredClone(value)) };
        assert.equal(method, 'POST'); assert.ok(publicationPilotTimerNames.includes(body.triggerName));
        if (controls.failedCreate === body.triggerName) throw failure('SYNTHETIC_CREATE_FAILURE');
        timers.set(body.triggerName, structuredClone(body));
        if (controls.lostCreate === body.triggerName) throw failure('CLOUD_REQUEST_UNCONFIRMED');
        return structuredClone(body);
      }
      if (path.includes('/triggers/')) {
        const name = path.split('/').at(-1); assert.ok(publicationPilotTimerNames.includes(name));
        if (method === 'GET') { if (!timers.has(name)) throw failure('TRIGGER_NOT_FOUND'); return structuredClone(timers.get(name)); }
        assert.equal(method, 'DELETE');
        if (!timers.has(name)) throw failure(controls.denyMissingDelete ? 'ACCESS_DENIED' : 'TRIGGER_NOT_FOUND');
        if (!controls.stuckDelete) timers.delete(name);
        if (controls.lostDelete === name || controls.stuckDelete) throw failure('CLOUD_REQUEST_UNCONFIRMED');
        return {};
      }
      assert.equal(path, `/2023-03-30/functions/${baseline.functionName}`);
      if (method === 'GET') {
        if (controls.readSnapshots?.length) return structuredClone(controls.readSnapshots.shift());
        return structuredClone(current);
      }
      assert.equal(method, 'PUT');
      assert.ok(Object.keys(body).every(key => ['code', 'environmentVariables'].includes(key)));
      const prior = structuredClone(current);
      if (body.code) {
        const pkg = body.code.checksum === previous.crc64 ? previous : candidate;
        current.codeChecksum = pkg.crc64; current.codeSize = pkg.bytes;
      }
      if (body.environmentVariables) current.environmentVariables = structuredClone(body.environmentVariables);
      if (controls.pendingAfterUpdate) {
        controls.pendingAfterUpdate = false;
        controls.readSnapshots = [{ ...prior, state: 'Active', lastUpdateStatus: 'InProgress' },
          { ...current, state: 'Active', lastUpdateStatus: 'InProgress' }];
      }
      if (controls.stuckPendingAfterUpdate) {
        current = { ...prior, state: 'Active', lastUpdateStatus: 'InProgress' };
      }
      if (controls.lostUpdate) throw failure('CLOUD_REQUEST_UNCONFIRMED');
      return structuredClone(current);
    },
    object: async (pkg, method, bytes, query) => {
      assert.deepEqual(saved.cumulativeUsage, activeReport.cumulativeUsage);
      calls.push({ object: pkg.sha256, method, query });
      if (query === 'acl') return new Response('<AccessControlPolicy><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>');
      if (method === 'PUT') { objects.set(pkg.sha256, bytes); return new Response('', { status: 200 }); }
      if (!objects.has(pkg.sha256)) return new Response('', { status: 404 });
      return new Response(objects.get(pkg.sha256), { headers: { 'x-oss-hash-crc64ecma': pkg.crc64 } });
    },
    http: async path => {
      assert.deepEqual(saved.cumulativeUsage, activeReport.cumulativeUsage);
      calls.push({ http: path });
      if (controls.badRuntime) return { status: 503, body: {} };
      const e = current.environmentVariables;
      if (path.endsWith('/status')) return { status: 200, body: { spark: { healthVerified: true }, agentDevelopment: { durableEnabled: true } } };
      return { status: 200, body: { authenticated: false, readOnly: true,
        ...(e.V2_FC_PUBLIC_WRITE_SCOPE === 'PUBLICATION_ONLY' ? { publicationOnly: true, publicationExpiresAt: e.V2_PUBLIC_PUBLICATION_EXPIRES_AT } : {}) } };
    },
  };
  async function step(mode, changes = {}) {
    const plan = { ...structuredClone(lastPlan ?? basePlan), mode,
      ...(lastReport ? { phase: lastReport.phase, baseline: lastReport.baseline,
        stagedDigest: lastReport.staged && functionDigest(lastReport.staged), permissionProbe: lastReport.permissionProbe,
        candidate: lastReport.candidate, activated: lastReport.activated, timerRecords: lastReport.timerRecords,
        timerPreparedAt: lastReport.timerPreparedAt, priorUsage: lastReport.cumulativeUsage } : {}), ...changes };
    const report = { phase: 'STARTED', configReads: 1, identityReads: 1, configWrites: 0, objectGets: 0, objectPuts: 0 };
    activeReport = report; lastPlan = plan; lastReport = report;
    await runPublicationPilotOperation(plan, structuredClone(current), report, io);
    return report;
  }
  async function open() {
    await step('stage');
    await step('activate', { target: { ...basePlan.target, verificationId: '00000000-0000-4000-8000-000000000002' } });
  }
  return { step, open, basePlan, baseline, calls, controls, timers, unrelated, previous, candidate,
    get current() { return current; }, get report() { return lastReport; }, get plan() { return lastPlan; },
    advance: ms => { now += ms; } };
}

test('stage freezes code without opening writes; activate binds the reviewed version without uploading again', async () => {
  const f = fixture(); const staged = await f.step('stage');
  assert.equal(staged.phase, 'STAGED'); assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables);
  assert.equal(staged.cumulativeUsage.objectPuts, 1); assert.equal(staged.cumulativeUsage.configWrites, 1);
  assert.equal(Object.hasOwn(f.plan.target, 'verificationId'), false);
  const activated = await f.step('activate', { target: { ...f.basePlan.target, verificationId: '00000000-0000-4000-8000-000000000002' } });
  assert.equal(activated.phase, 'OPENED'); assert.equal(activated.cumulativeUsage.objectPuts, 1);
  assert.equal(activated.cumulativeUsage.configWrites, 2); assert.equal(f.current.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE, 'PUBLICATION_ONLY');
  assert.equal(f.current.environmentVariables.V2_MODEL_MONTHLY_BUDGET_CNY, '50');
  assert.equal(f.current.environmentVariables.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT, '22');
  assert.ok(activated.cumulativeUsage.configReads > staged.cumulativeUsage.configReads);
  const updates = f.calls.filter(call => call.args?.[1] === 'PUT');
  assert.deepEqual(Object.keys(updates[0].body), ['code']); assert.deepEqual(Object.keys(updates[1].body), ['environmentVariables']);
});

test('missing review identity or mismatched staged snapshot cannot activate', async () => {
  const f = fixture(); await f.step('stage');
  await assert.rejects(f.step('activate'), { safeCode: 'PUBLICATION_TARGET_INVALID' });
  assert.equal(f.calls.filter(call => call.args?.[1] === 'PUT').length, 1);
  const g = fixture(); await g.step('stage'); g.current.cpu = 1;
  await assert.rejects(g.step('activate', { target: { ...g.basePlan.target, verificationId: '00000000-0000-4000-8000-000000000002' } }), /SNAPSHOT_REQUIRED/);
  assert.equal(g.calls.filter(call => call.args?.[1] === 'PUT').length, 1);
});

test('timers retain exact signed bodies; unknown creates/deletes reconcile without retry and unrelated triggers survive', async () => {
  const f = fixture(); await f.open();
  f.controls.lostCreate = publicationPilotTimerNames[1];
  const created = await f.step('timers', { releaseId: '00000000-0000-4000-8000-000000000003' });
  assert.equal(created.phase, 'TIMERS_CREATED'); assert.equal(created.cumulativeUsage.triggerCreates, 4);
  assert.equal(created.timerRecords.length, 4); assert.ok(created.timerRecords.every(timer => timer.bodyHash && timer.state === 'CREATED'));
  assert.equal(created.timerRecords[1].createResponseUnknown, true);
  const bodySnapshot = created.timerRecords.map(timer => timer.body);
  f.controls.lostDelete = publicationPilotTimerNames[0];
  const cleaned = await f.step('cleanup-timers');
  assert.equal(cleaned.phase, 'TIMERS_CLEANED'); assert.equal(cleaned.cumulativeUsage.triggerDeletes, 4);
  assert.deepEqual(cleaned.timerRecords.map(timer => timer.body), bodySnapshot);
  assert.deepEqual([...f.timers.values()], [f.unrelated]);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'POST').length, 4);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'DELETE' && !call.permissionProbe).length, 4);
  const closed = await f.step('close');
  assert.equal(closed.phase, 'CLOSED_READONLY'); assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables);
  assert.equal(f.current.codeChecksum, f.candidate.crc64); assert.equal(closed.cumulativeUsage.triggerDeletes, 4);
  assert.equal(closed.timersAbsenceVerified, true);
});

test('an absent uncertain creation is not recreated and partial created timers are cleaned up', async () => {
  const f = fixture(); await f.open(); f.controls.failedCreate = publicationPilotTimerNames[1];
  await assert.rejects(f.step('timers', { releaseId: '00000000-0000-4000-8000-000000000003' }), /CREATE_UNCONFIRMED/);
  assert.equal(f.report.cumulativeUsage.triggerCreates, 2); assert.equal(f.report.cumulativeUsage.triggerDeletes, 1);
  assert.equal(f.report.timersCleaned, true); assert.deepEqual([...f.timers.values()], [f.unrelated]);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'POST').length, 2);
  assert.equal(f.report.rollback, 'VERIFIED'); assert.equal(f.report.rollbackTarget, 'STAGED_READONLY');
  assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables);
  const closed = await f.step('close'); assert.equal(closed.readOnlyAlreadyRestored, true);
  assert.equal(closed.cumulativeUsage.configWrites, 3);
});

test('foreign same-name timer or tampered saved body prevents deletion', async () => {
  const f = fixture(); await f.open(); await f.step('timers', { releaseId: '00000000-0000-4000-8000-000000000003' });
  f.timers.get(publicationPilotTimerNames[2]).description = 'synthetic foreign change';
  await assert.rejects(f.step('cleanup-timers'), /OWNERSHIP_MISMATCH/);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'DELETE' && !call.permissionProbe).length, 0);
  const g = fixture(); await g.open(); await g.step('timers', { releaseId: '00000000-0000-4000-8000-000000000003' });
  const records = structuredClone(g.report.timerRecords); records[0].body.description = 'tampered';
  await assert.rejects(g.step('cleanup-timers', { timerRecords: records }), /OWNERSHIP_MISMATCH/);
  assert.equal(g.calls.filter(call => call.args?.[1] === 'DELETE' && !call.permissionProbe).length, 0);
});

test('unknown delete still present is not retried and retained in its original checkpoint', async () => {
  const f = fixture(); await f.open(); await f.step('timers', { releaseId: '00000000-0000-4000-8000-000000000003' });
  f.controls.stuckDelete = true;
  await assert.rejects(f.step('cleanup-timers'), /DELETE_UNCONFIRMED/);
  assert.equal(f.report.cumulativeUsage.triggerDeletes, 1); assert.equal(f.report.timerRecords[0].state, 'DELETE_REQUESTED');
  await assert.rejects(f.step('cleanup-timers'), /DELETE_ALREADY_ATTEMPTED/);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'DELETE' && !call.permissionProbe).length, 1);
});

test('budget and inherited limits are enforced without resetting usage or opening writes', async () => {
  const f = fixture(); f.controls.bill = '163';
  await assert.rejects(f.step('stage'), /BUDGET_NOT_VERIFIED/);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'PUT').length, 0);
  const g = fixture();
  await assert.rejects(g.step('stage', { priorUsage: { ...g.basePlan.priorUsage, configReads: 119 } }), /USAGE_LIMIT/);
  assert.equal(g.calls.length, 0);
  const h = fixture(); await assert.rejects(h.step('stage', { priorUsage: undefined }), /USAGE_HISTORY_REQUIRED/);
  assert.equal(h.calls.length, 0);
});

test('unknown configuration response is read back once, while foreign drift is never overwritten', async () => {
  const f = fixture(); f.controls.lostUpdate = true;
  await f.open(); assert.equal(f.report.updateResponseUnknown, true);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'PUT').length, 2);
  f.current.environmentVariables.ORIGINAL_VALUE = 'foreign';
  await assert.rejects(f.step('close'), /FOREIGN_CONFIGURATION/);
  assert.equal(f.calls.filter(call => call.args?.[1] === 'PUT').length, 2);
});

test('failed stage or activation runtime verification restores only the matching pre-step snapshot', async () => {
  const f = fixture(); f.controls.badRuntime = true;
  await assert.rejects(f.step('stage'), /READONLY_RESTORE_NOT_VERIFIED/);
  assert.equal(f.report.rollback, 'VERIFIED'); assert.equal(f.report.rollbackTarget, 'ORIGINAL_READONLY');
  assert.deepEqual(f.current, f.baseline); assert.equal(f.report.cumulativeUsage.configWrites, 2);
  const g = fixture(); await g.step('stage'); g.controls.badRuntime = true;
  await assert.rejects(g.step('activate', { target: { ...g.basePlan.target, verificationId: '00000000-0000-4000-8000-000000000002' } }), /PILOT_RUNTIME_NOT_VERIFIED/);
  assert.equal(g.report.rollback, 'VERIFIED'); assert.equal(g.report.rollbackTarget, 'STAGED_READONLY');
  assert.deepEqual(g.current.environmentVariables, g.baseline.environmentVariables);
  assert.equal(g.current.codeChecksum, g.candidate.crc64); assert.equal(g.report.cumulativeUsage.configWrites, 3);
});

test('late timer setup cannot renew the original deadline and closes the publication window without creating timers', async () => {
  const f = fixture(); await f.open(); const deadline = f.plan.deadline;
  f.advance(2400000);
  await assert.rejects(f.step('timers', { releaseId: '00000000-0000-4000-8000-000000000003' }), /CLEANUP_WINDOW_INSUFFICIENT/);
  assert.equal(f.report.cumulativeUsage.triggerCreates, 0);
  assert.equal(f.report.deadline, deadline); assert.equal(f.report.rollback, 'VERIFIED');
  assert.deepEqual(f.current.environmentVariables, f.baseline.environmentVariables);
});

test('rollback restores original code and environment without new model or Spark requests', async () => {
  const f = fixture(); await f.open(); const result = await f.step('rollback');
  assert.equal(result.phase, 'ROLLED_BACK'); assert.deepEqual(f.current, f.baseline);
  assert.ok(!f.calls.some(call => call.args?.[2]?.includes('/invoke') || call.args?.[0] === 'ram'));
  assert.equal(f.timers.size, 1);
  assert.equal(result.timersAbsenceVerified, true);
});

test('stage missing-target deletion preflight precedes all writes and never claims actual deletion proof', async () => {
  const f = fixture(); await f.step('stage');
  const probeIndex = f.calls.findIndex(call => call.permissionProbe && call.args?.[1] === 'DELETE');
  const writeIndex = f.calls.findIndex(call => call.args?.[1] === 'PUT' || call.method === 'PUT');
  assert.ok(probeIndex >= 0 && probeIndex < writeIndex);
  assert.equal(f.calls.slice(0, probeIndex).filter(call => call.args?.[1] === 'GET' && call.args[2].includes('/triggers/')).length, 4);
  assert.equal(f.report.cumulativeUsage.permissionProbes, 1);
  assert.equal(f.report.cumulativeUsage.activeHttp, 3);
  assert.equal(f.report.cumulativeUsage.triggerDeletes, 0);
  assert.equal(f.report.permissionProbe.outcome, 'TRIGGER_NOT_FOUND');
  assert.equal(f.report.permissionProbe.provesExistingDeletion, false);
  const g = fixture(); g.controls.denyMissingDelete = true;
  await assert.rejects(g.step('stage'), /DELETE_PERMISSION_NOT_CONFIRMED/);
  assert.equal(g.report.phase, 'STARTED'); assert.equal(g.report.cumulativeUsage.configWrites, 0);
  assert.equal(g.report.cumulativeUsage.triggerCreates, 0); assert.equal(g.report.cumulativeUsage.objectPuts, 0);
  assert.equal(g.report.cumulativeUsage.permissionProbes, 1); assert.deepEqual(g.current, g.baseline);
  const h = fixture(); h.timers.set(publicationPilotTimerNames[3], { triggerName: publicationPilotTimerNames[3], triggerType: 'timer' });
  await assert.rejects(h.step('stage'), /TIMERS_ALREADY_EXIST/);
  assert.equal(h.calls.filter(call => call.args?.[1] === 'DELETE').length, 0);
});

test('only known old or new pending snapshots are awaited; a stuck async update is never reported restored', async () => {
  const f = fixture(); f.controls.pendingAfterUpdate = true; await f.step('stage');
  assert.equal(f.report.phase, 'STAGED'); assert.equal(f.report.cumulativeUsage.configWrites, 1);
  const g = fixture(); g.controls.stuckPendingAfterUpdate = true;
  await assert.rejects(g.step('stage'), /UPDATE_PENDING/);
  assert.equal(g.report.rollback, undefined); assert.equal(g.report.rollbackFailure, 'UPDATE_PENDING');
  assert.equal(g.report.cumulativeUsage.configWrites, 1);
});

test('nullable lifecycle fields retain strict snapshot verification', async () => {
  for (const lifecycle of [{state:null,lastUpdateStatus:null},{state:'Active',lastUpdateStatus:null},{state:null,lastUpdateStatus:'Successful'}]) {
    const f=fixture(); f.controls.readSnapshots=[{...f.baseline,...lifecycle}];
    const staged=await f.step('stage'); assert.equal(staged.phase,'STAGED');
    assert.equal(staged.cumulativeUsage.configWrites,1);
  }
  const g=fixture();g.controls.readSnapshots=[{...g.baseline,state:'Active',lastUpdateStatus:'Failed'}];
  await assert.rejects(g.step('stage'),/UPDATE_NOT_SUCCESSFUL/);assert.equal(g.report.cumulativeUsage.configWrites,0);
});

test('a zero-function-write stage failure resumes the verified object without re-upload or permission re-probe', async () => {
  const f=fixture();f.controls.readSnapshots=[{...f.baseline,state:'Active',lastUpdateStatus:'Failed'}];
  await assert.rejects(f.step('stage'),/UPDATE_NOT_SUCCESSFUL/);
  const failed=structuredClone(f.report);
  const staged=await f.step('resume-stage',{stageCheckpoint:{runId:'12345',reportDigest:'b'.repeat(64),phase:failed.phase,
    failure:failed.failure,configWrites:failed.cumulativeUsage.configWrites,objectPuts:failed.cumulativeUsage.objectPuts,
    permissionProbes:failed.cumulativeUsage.permissionProbes}});
  assert.equal(staged.phase,'STAGED');assert.equal(staged.cumulativeUsage.objectPuts,1);
  assert.equal(staged.cumulativeUsage.permissionProbes,1);assert.equal(staged.cumulativeUsage.configWrites,1);
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
  assert.equal(f.calls.filter(c=>c.permissionProbe&&c.args?.[1]==='DELETE').length,1);
  assert.ok(staged.cumulativeUsage.configReads>failed.cumulativeUsage.configReads);
  const g=fixture();await g.step('stage');
  await assert.rejects(g.step('resume-stage',{stageCheckpoint:{runId:'12345',reportDigest:'b'.repeat(64),phase:'STARTED',failure:'UPDATE_NOT_SUCCESSFUL',configWrites:0,objectPuts:1,permissionProbes:1}}),/READONLY_PUBLICATION_BASELINE_REQUIRED/);
});

test('normal operations stop at 84 reads but cleanup keeps its 24-read reserve and owner keeps 12', async () => {
  const f = fixture();
  await assert.rejects(f.step('stage', { priorUsage: { ...f.basePlan.priorUsage, configReads: 83 } }), /USAGE_LIMIT/);
  assert.equal(f.calls.length, 0);
  const g = fixture(); await g.open();
  const closed = await g.step('close', { priorUsage: { ...g.report.cumulativeUsage, configReads: 84 } });
  assert.equal(closed.phase, 'CLOSED_READONLY'); assert.ok(closed.cumulativeUsage.configReads > 84);
  assert.ok(closed.cumulativeUsage.configReads <= 108); assert.equal(closed.timersAbsenceVerified, true);
});

test('activate carries only the derived staged digest, never a second full function snapshot', async () => {
  const f = fixture(); await f.open(); assert.equal(Object.hasOwn(f.plan, 'staged'), false);
  assert.equal(f.plan.stagedDigest, functionDigest(f.report.staged));
});

test('pre-plan failures have an explicitly zero-write sealed report contract for owner cleanup', () => {
  const source = readFileSync(new URL('../../scripts/deploy-development-pilot.mjs', import.meta.url), 'utf8');
  assert.match(source, /scope: 'UNVERIFIED', phase: 'STARTED', planVerified: false, mode: env\.V2_PILOT_MODE/);
  assert.match(source, /triggerCreates: 0, triggerDeletes: 0, permissionProbes: 0, modelCalls: 0, sparkRuns: 0/);
  assert.match(source, /markUnacceptedPilotFailure\(report\)/);
  assert.match(source, /sourceRevision: env\.GITHUB_SHA, runId: env\.GITHUB_RUN_ID/);
});

test('expired or invalid initial publication plans retain only bootstrap reads in PRE_PLAN_FAILED', async () => {
  for (const change of [{ deadline: Date.parse('2026-10-27T07:59:59Z') }, { maxSparkRuns: 3 }, { priorUsage: undefined }]) {
    const f = fixture(), report = { scope: 'INVITED_PUBLICATION_PILOT_V1', phase: 'STARTED', planVerified: true, mode: 'stage',
      identityReads: 1, configReads: 1, configWrites: 0, objectGets: 0, objectPuts: 0, activeHttp: 0,
      triggerCreates: 0, triggerDeletes: 0, permissionProbes: 0, modelCalls: 0, sparkRuns: 0 };
    let ioCalls = 0;
    try {
      await runPublicationPilotOperation({ ...f.basePlan, mode: 'stage', ...change }, f.baseline, report,
        { now: () => Date.parse('2026-10-27T08:00:00Z'), command: () => { ioCalls++; }, save: () => { ioCalls++; } });
      assert.fail('guard must reject');
    } catch (error) { report.failure = error.safeCode; }
    const originalFailure = report.failure;
    assert.equal(markUnacceptedPilotFailure(report), true); assert.equal(ioCalls, 0);
    assert.equal(report.scope, 'UNVERIFIED'); assert.equal(report.phase, 'PRE_PLAN_FAILED');
    assert.equal(report.planVerified, false); assert.equal(report.mode, 'stage');
    assert.equal(report.identityReads, 1); assert.equal(report.configReads, 1);
    assert.equal(report.failure, originalFailure); assert.equal(report.cumulativeUsage, undefined);
  }
});

test('pre-plan normalization never discards accepted usage, additional reads, probes or writes', () => {
  const base = { scope: 'INVITED_PUBLICATION_PILOT_V1', phase: 'STARTED', planVerified: true, mode: 'stage', failure: 'SYNTHETIC_FAILURE',
    identityReads: 1, configReads: 1, configWrites: 0, objectGets: 0, objectPuts: 0, activeHttp: 0,
    triggerCreates: 0, triggerDeletes: 0, permissionProbes: 0, modelCalls: 0, sparkRuns: 0 };
  for (const change of [{ cumulativeUsage: {} }, { configReads: 2 }, { identityReads: 2 }, { configReads: undefined },
    ...['configWrites', 'objectGets', 'objectPuts', 'activeHttp', 'triggerCreates', 'triggerDeletes', 'permissionProbes', 'modelCalls', 'sparkRuns'].map(key => ({ [key]: 1 })),
    { objectPuts: undefined }]) {
    const report = { ...base, ...change }, original = structuredClone(report);
    assert.equal(markUnacceptedPilotFailure(report), false); assert.deepEqual(report, original);
  }
});

test('workflow downloads frozen code only for deploy or stage and preserves encrypted evidence', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy-v2-development-pilot.yml', import.meta.url), 'utf8');
  assert.match(workflow, /options: \[deploy, stage, resume-stage, activate, timers, cleanup-timers, close, rollback\]/);
  assert.match(workflow, /if: inputs\.mode == 'deploy' \|\| inputs\.mode == 'stage'/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /path: v2-development-pilot\.sealed\.json/);
  assert.match(workflow, /cancel-in-progress: false/);
});
