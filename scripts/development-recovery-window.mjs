// Environment-only acceptance scope. Never uploads code, invokes a function,
// creates a timer or grants IAM. Business work uses the existing invited API.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { functionDigest, functionSnapshot } from './refresh-v2-spark-readiness.mjs';
import { verifyV2MonthlyBillPages } from './verify-v2-monthly-bill-pages.mjs';
import { publicDevelopmentConfig } from '../src/v2/public-development-access.mjs';

export const developmentRecoveryScope = 'INVITED_DEVELOPMENT_RECOVERY_WINDOW_V1';
export const developmentRecoveryModes = ['activate', 'recycle', 'close', 'rollback'];
export const recoveryUsageKeys = ['configReads', 'activeHttp', 'configWrites', 'objectGets', 'objectPuts', 'triggerCreates', 'triggerDeletes', 'permissionProbes'];
const check = (v, code) => { if (!v) throw Object.assign(new Error(code), { safeCode: code }); };
const canonical = v => JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map(x => JSON.parse(canonical(x)))
  : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))])) : v ?? null);
export const recoveryDigest = v => createHash('sha256').update(canonical(v)).digest('hex');
const hash = v => /^[a-f0-9]{64}$/.test(v ?? '');
const uuid = v => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v ?? '');
const same = (a, b) => isDeepStrictEqual(functionSnapshot(a), functionSnapshot(b));
const stable = f => (f.state == null || f.state === 'Active') && (f.lastUpdateStatus == null || f.lastUpdateStatus === 'Successful');
const pending = f => f.lastUpdateStatus === 'InProgress' || ['Pending', 'Creating', 'Updating'].includes(f.state);
const sameKeys = (v, keys) => v && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const month = now => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(now));
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) < 3600000;

export function validateDevelopmentRecoveryPlan(plan, now = Date.now()) {
  const resumed=plan?.resumeExistingTask;
  if(resumed!==undefined)check(sameKeys(resumed,['protocol','taskId','originalStartsAt','originalDeadline','retainedAttempts','approvalDigest','priorCodeReads','priorCodeHttp'])&&
    resumed.protocol==='ORIGINAL_TASK_WINDOW_CONTINUATION_V1'&&uuid(resumed.taskId)&&resumed.retainedAttempts===1&&
    resumed.approvalDigest===plan.binding?.approvalDigest&&Date.parse(resumed.originalStartsAt)===plan.issuedAt&&Date.parse(resumed.originalDeadline)===plan.deadline&&
    Number.isSafeInteger(resumed.priorCodeReads)&&resumed.priorCodeReads>=0&&resumed.priorCodeReads<=78&&
    Number.isSafeInteger(resumed.priorCodeHttp)&&resumed.priorCodeHttp>=0&&resumed.priorCodeHttp<=48,'ORIGINAL_TASK_CONTINUATION_INVALID');
  check(plan?.scope === developmentRecoveryScope && developmentRecoveryModes.includes(plan.mode) &&
    plan.contextId === 'stock-cash-t1' && plan.maxNewTasks === (resumed?0:1) && plan.maxModelCalls === (resumed?2:3) && plan.maxSparkRuns === 4 &&
    plan.maxIncrementCny === 5 && plan.monthlyCny === 200 && plan.maxReads === (resumed?102-resumed.priorCodeReads:120) &&
    plan.maxProbes === (resumed?54-resumed.priorCodeHttp:60) && plan.maxWrites === (resumed?3:4),
  'RECOVERY_SCOPE_INVALID');
  check(!['candidate', 'previous', 'packageTransport', 'preStagedObject', 'buildRunId', 'artifactId', 'servicePlan', 'target',
    'triggerNames', 'timerRecords', 'schedulerSecret', 'permissionProbe', 'releaseId'].some(k => Object.hasOwn(plan, k)), 'RECOVERY_EXTRA_AUTHORITY_FORBIDDEN');
  check(Number.isSafeInteger(plan.issuedAt) && Number.isSafeInteger(plan.deadline) && plan.issuedAt <= now &&
    plan.deadline > plan.issuedAt && plan.deadline - plan.issuedAt <= 7200000 &&
    (['close', 'rollback'].includes(plan.mode) || plan.deadline > now), 'RECOVERY_WINDOW_INVALID');
  const b = plan.binding;
  check(sameKeys(b, ['protocol', 'approvalDigest', 'predecessorDigest', 'historyDigest', 'applicationSha256', 'workerDigest', 'priorReserveCny']) &&
    b.protocol === 'DEVELOPMENT_RECOVERY_CONTINUATION_V1' &&
    ['approvalDigest', 'predecessorDigest', 'historyDigest', 'applicationSha256', 'workerDigest'].every(k => hash(b[k])) &&
    Number.isFinite(b.priorReserveCny) && b.priorReserveCny >= 0 && b.priorReserveCny === plan.priorReserveCny &&
    sameKeys(plan.historyUsage, recoveryUsageKeys) && recoveryUsageKeys.every(k => Number.isSafeInteger(plan.historyUsage[k]) && plan.historyUsage[k] >= 0) &&
    b.historyDigest === recoveryDigest(plan.historyUsage), 'RECOVERY_CONTINUATION_INVALID');
  check(sameKeys(plan.priorUsage, recoveryUsageKeys) && recoveryUsageKeys.every(k => Number.isSafeInteger(plan.priorUsage[k]) && plan.priorUsage[k] >= 0) &&
    ['objectGets', 'objectPuts', 'triggerCreates', 'triggerDeletes', 'permissionProbes'].every(k => plan.priorUsage[k] === 0) &&
    plan.priorUsage.configReads <= plan.maxReads && plan.priorUsage.activeHttp <= plan.maxProbes && plan.priorUsage.configWrites <= plan.maxWrites, 'RECOVERY_USAGE_INVALID');
  const f = plan.baseline, e = f?.environmentVariables, pkg = plan.application;
  check(f?.functionName === plan.controlName && /^dataplatform-v2-[a-z0-9-]{1,60}$/.test(plan.controlName ?? '') &&
    functionDigest(f) === plan.baselineDigest && f.runtime === 'custom.debian12' && f.cpu === 0.25 && f.memorySize === 512 &&
    f.instanceConcurrency === 8 && Number.isFinite(f.timeout) && f.timeout <= 120 &&
    sameKeys(pkg, ['sha256', 'bytes', 'crc64']) && hash(pkg.sha256) && pkg.sha256 === b.applicationSha256 &&
    Number.isSafeInteger(pkg.bytes) && pkg.bytes > 0 && pkg.bytes <= 67108864 && /^\d+$/.test(pkg.crc64 ?? '') &&
    f.codeSize === pkg.bytes && String(f.codeChecksum) === pkg.crc64 &&
    e?.V2_LOCAL_DEVELOPMENT === 'false' && e.V2_PROVISIONING_ONLY === 'true' && e.V2_FC_PUBLIC_HTTP_ENABLED === 'true' &&
    e.V2_FC_PUBLIC_READ_ONLY === 'true' && !e.V2_FC_PUBLIC_WRITE_SCOPE && e.V2_PRIVATE_RELEASE_ENABLED !== 'true' &&
    e.V2_DURABLE_SQL_AGENT_ENABLED === 'true' && e.V2_AGENT_DRIVER_MODE === 'OSS_EVENTS' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.V2_BOOTSTRAP_ADMIN_EMAIL ?? ''), 'RECOVERY_READONLY_BASELINE_REQUIRED');
  if (plan.mode === 'activate') check(plan.phase === undefined && plan.activated === undefined && plan.reloaded === undefined && plan.priorUsage.configWrites === 0,
    'RECOVERY_ACTIVATION_CHECKPOINT_INVALID');
  else {
    const a = plan.activated, starts = Date.parse(a?.V2_PUBLIC_DEVELOPMENT_STARTS_AT);
    const checked=resumed?Date.parse(plan.activationCheckedAt):starts;
    check(Number.isFinite(starts) && starts >= plan.issuedAt && starts < plan.deadline && Number.isFinite(checked)&&checked<=now&&
      isDeepStrictEqual(a, developmentRecoveryEnvironment(plan, checked)), 'RECOVERY_ACTIVE_SNAPSHOT_INVALID');
    if (plan.reloaded !== undefined) check(isDeepStrictEqual(plan.reloaded, { ...a, V2_RECOVERY_PILOT_NONCE: plan.recoveryNonce }) &&
      /^[a-f0-9]{32}$/.test(plan.recoveryNonce ?? ''), 'RECOVERY_RELOAD_SNAPSHOT_INVALID');
    if (plan.mode === 'recycle') {
      const c = plan.phaseBoundary;
      check(plan.phase === 'OPENED' && plan.reloaded === undefined && plan.priorUsage.configWrites === 1 &&
        /^[a-f0-9]{32}$/.test(plan.recoveryNonce ?? '') && plan.recoveryNonce !== a.V2_RECOVERY_PILOT_NONCE &&
        sameKeys(c, ['taskId', 'revisionId', 'runId', 'bootId', 'contextId', 'status', 'modelPending', 'sparkPending', 'evidenceDigest']) &&
        ['taskId', 'revisionId', 'runId', 'bootId'].every(k => uuid(c[k])) && c.contextId === plan.contextId &&
        c.status === 'VERIFIED' && c.modelPending === false && c.sparkPending === false && hash(c.evidenceDigest), 'RECOVERY_PHASE_BOUNDARY_REQUIRED');
    } else check(['OPENED', 'RELOAD_CONFIGURATION_VERIFIED', 'RESTORE_REQUESTED', 'RESTORE_UNCONFIRMED'].includes(plan.phase) &&
      plan.priorUsage.configWrites >= 1, 'RECOVERY_CLOSE_CHECKPOINT_INVALID');
  }
  return true;
}

export function developmentRecoveryEnvironment(plan, now = Date.now()) {
  const e = plan.baseline?.environmentVariables, u = plan.usage, pricing = plan.modelPricing;
  check(u?.month === month(now) && fresh(u.checkedAt, now) && Number.isSafeInteger(u.sparkRuns) && u.sparkRuns >= 0 &&
    Number.isFinite(u.modelCny) && u.modelCny >= 0, 'RECOVERY_CURRENT_USAGE_REQUIRED');
  check(pricing?.model === e.V2_MODEL && fresh(pricing.checkedAt, now) && pricing.available === true &&
    Number.isFinite(pricing.maxBatchCny) && pricing.maxBatchCny > 0 && pricing.maxBatchCny <= 4 && hash(pricing.evidenceDigest), 'RECOVERY_MODEL_PRICE_REQUIRED');
  check(Number.isFinite(plan.billCny) && plan.billCny >= 0 && plan.billCny + plan.priorReserveCny + 5 < 200, 'RECOVERY_BUDGET_INVALID');
  const runs = u.sparkRuns + 4, model = Math.ceil((u.modelCny + pricing.maxBatchCny) * 100) / 100;
  check(typeof e.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT === 'string' && Number.isSafeInteger(Number(e.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT)) &&
    Number(e.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT) >= runs && typeof e.V2_MODEL_MONTHLY_BUDGET_CNY === 'string' &&
    e.V2_MODEL_MONTHLY_BUDGET_CNY.trim() !== '' && Number.isFinite(Number(e.V2_MODEL_MONTHLY_BUDGET_CNY)) &&
    Number(e.V2_MODEL_MONTHLY_BUDGET_CNY) >= model, 'RECOVERY_EXISTING_QUOTA_INSUFFICIENT');
  const env = { ...e, V2_FC_PUBLIC_READ_ONLY: 'false', V2_FC_PUBLIC_WRITE_SCOPE: 'DEVELOPMENT_ONLY',
    V2_PUBLIC_DEVELOPMENT_STARTS_AT: plan.resumeExistingTask?.originalStartsAt??new Date(now).toISOString(), V2_PUBLIC_DEVELOPMENT_EXPIRES_AT: new Date(plan.deadline).toISOString(),
    V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: String(runs), V2_MODEL_MONTHLY_BUDGET_CNY: String(model),
    V2_ACCOUNT_MONTHLY_SPEND_CNY: String(plan.billCny) };
  publicDevelopmentConfig(env);
  return env;
}

export async function runDevelopmentRecoveryOperation(plan, before, report, io) {
  const now = io.now ?? Date.now, wait = io.wait ?? (ms => new Promise(r => setTimeout(r, ms)));
  validateDevelopmentRecoveryPlan(plan, now());
  const usage = { ...plan.priorUsage };
  usage.configReads += (report.configReads ?? 0) + (report.identityReads ?? 0);
  const cleanup = ['close', 'rollback'].includes(plan.mode), path = `/2023-03-30/functions/${plan.controlName}`;
  const normalReadLimit=plan.resumeExistingTask?plan.maxReads-12:100;
  let restoring = cleanup;
  const expected = e => ({ ...plan.baseline, environmentVariables: e });
  Object.assign(report, { scope: plan.scope, mode: plan.mode, issuedAt: plan.issuedAt, deadline: plan.deadline, binding: plan.binding,
    baseline: plan.baseline, baselineDigest: plan.baselineDigest, application: plan.application, historyUsage: plan.historyUsage,
    priorUsage: plan.priorUsage, cumulativeUsage: usage, activated: plan.activated, reloaded: plan.reloaded,
    phaseBoundary: plan.phaseBoundary, recoveryNonce: plan.recoveryNonce, activationCheckedAt:plan.activationCheckedAt,modelCalls: 0, sparkRuns: 0 });
  const save = () => { report.runUsage = Object.fromEntries(recoveryUsageKeys.map(k => [k, usage[k] - plan.priorUsage[k]])); io.save(report); };
  const spend = kind => {
    check(restoring || now() < plan.deadline, 'RECOVERY_WINDOW_EXPIRED');
    check(usage.configReads <= (restoring ? plan.maxReads : normalReadLimit) && usage.activeHttp <= plan.maxProbes && usage.configWrites <= plan.maxWrites, 'RECOVERY_USAGE_LIMIT');
    check(usage[kind] < ({ configReads: restoring ? plan.maxReads : normalReadLimit, activeHttp: plan.maxProbes, configWrites: restoring ? plan.maxWrites : 2 })[kind], 'RECOVERY_USAGE_LIMIT');
    usage[kind]++; report[kind] = (report[kind] ?? 0) + 1; save();
  };
  const read = () => { spend('configReads'); return io.command(['fc', 'GET', path]); };
  const put = async env => { spend('configWrites'); return io.command(['fc', 'PUT', path], { environmentVariables: env }); };
  const known = () => [plan.baseline, ...(report.activated ? [expected(report.activated)] : []), ...(report.reloaded ? [expected(report.reloaded)] : [])];
  const settle = async target => {
    for (let n = 0; n < 6; n++) {
      const current = await read();
      check(known().some(s => same(s, current)), 'RECOVERY_FOREIGN_CONFIGURATION');
      if (stable(current) && same(current, target)) return current;
      check(stable(current) || pending(current), 'RECOVERY_UPDATE_FAILED');
      check(n < 5, 'RECOVERY_UPDATE_UNCONFIRMED'); await wait(3000);
    }
  };
  const runtime = async opened => {
    for (let n = 0; n < 3; n++) {
      try {
        spend('activeHttp'); const session = await io.http('/api/v2/auth/session');
        spend('activeHttp'); const status = await io.http('/api/v2/status');
        const ready = session.status === 200 && session.body.authenticated === false && session.body.readOnly === true &&
          session.body.publicationOnly !== true && session.body.consumptionOnly !== true &&
          (opened ? session.body.developmentOnly === true && session.body.developmentExpiresAt === report.activated.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT &&
            status.body.spark?.healthVerified === true && status.body.agentDevelopment?.durableEnabled === true && status.body.agentDevelopment?.eventBackgroundAvailable === true
            : session.body.developmentOnly !== true) && status.status === 200;
        report.runtime = { ready, readOnlyAnonymous: session.body.readOnly, developmentOnly: session.body.developmentOnly === true,
          sparkReady: status.body.spark?.healthVerified === true, driverReady: status.body.agentDevelopment?.eventBackgroundAvailable === true }; save();
        if (ready) return;
      } catch (e) {
        if (!['TypeError', 'AbortError', 'TimeoutError', 'SyntaxError'].includes(e.name) && e.safeCode !== 'PUBLICATION_HTTP_RESPONSE_INVALID') throw e;
        report.runtimeReadFailures = [...(report.runtimeReadFailures ?? []), { attempt: n + 1, kind: e.name }]; save();
      }
      if (n < 2) await wait(3000);
    }
    check(false, 'RECOVERY_RUNTIME_UNCONFIRMED');
  };
  let mutationRequested = false;
  try {
    check(stable(before) && known().some(s => same(s, before)), 'RECOVERY_FOREIGN_CONFIGURATION');
    if (plan.mode === 'activate') {
      check(same(before, plan.baseline), 'RECOVERY_BASELINE_CHANGED');
      const pages = [], cycle = month(now());
      for (let page = 1; page <= 10; page++) {
        spend('configReads'); const result = await io.command(['bssopenapi', 'QueryBill', '--BillingCycle', cycle, '--PageNum', String(page), '--PageSize', '300']);
        pages.push(result); if (page * 300 >= Number(result.Data?.TotalCount)) break;
      }
      const bill = verifyV2MonthlyBillPages(pages, 200);
      check(bill.ok && bill.billingCycle === cycle && Number(bill.spendCny) + plan.priorReserveCny + 5 < 200, 'RECOVERY_BUDGET_INVALID');
      plan.billCny = Number(bill.spendCny); report.bill = bill;
      report.activationCheckedAt=new Date(now()).toISOString();
      report.activated = developmentRecoveryEnvironment(plan, now());
    } else if (plan.mode === 'recycle') {
      check(same(before, expected(plan.activated)), 'RECOVERY_ACTIVE_CHANGED');
      report.reloaded = { ...plan.activated, V2_RECOVERY_PILOT_NONCE: plan.recoveryNonce };
    } else {
      if (same(before, plan.baseline)) { await runtime(false); report.phase = 'CLOSED_READONLY'; save(); return report; }
      check(same(before, expected(plan.reloaded ?? plan.activated)), 'RECOVERY_ACTIVE_CHANGED');
      check(plan.phase !== 'RESTORE_REQUESTED' && plan.phase !== 'RESTORE_UNCONFIRMED', 'RECOVERY_RESTORE_ALREADY_ATTEMPTED');
    }
    const desired = cleanup ? plan.baseline.environmentVariables : report.reloaded ?? report.activated;
    check(same(await read(), before), 'RECOVERY_CONFIGURATION_CHANGED_BEFORE_WRITE');
    report.phase = cleanup ? 'RESTORE_REQUESTED' : plan.mode === 'recycle' ? 'RELOAD_REQUESTED' : 'ACTIVATION_REQUESTED'; save();
    mutationRequested = true;
    try { await put(desired); } catch (e) { if (e.safeCode === 'RECOVERY_USAGE_LIMIT') throw e; report.updateResponseUnknown = true; save(); }
    await settle(expected(desired)); await runtime(!cleanup);
    report.phase = cleanup ? 'CLOSED_READONLY' : plan.mode === 'recycle' ? 'RELOAD_CONFIGURATION_VERIFIED' : 'OPENED';
    save(); return report;
  } catch (e) {
    report.failure = e.safeCode ?? 'RECOVERY_OPERATION_UNCONFIRMED';
    if (mutationRequested && !cleanup) {
      restoring = true;
      try {
        const current = await read();
        if (stable(current) && same(current, plan.baseline)) report.restoration = 'ALREADY_BASELINE';
        else {
          check(stable(current) && known().some(s => same(s, current)), 'RECOVERY_FOREIGN_CONFIGURATION');
          // One necessary readonly restoration, never a repeated uncertain PUT.
          report.phase = 'RESTORE_REQUESTED'; save();
          spend('configWrites');
          try { await io.command(['fc', 'PUT', path], { environmentVariables: plan.baseline.environmentVariables }); }
          catch { report.restoreResponseUnknown = true; save(); }
          await settle(plan.baseline); await runtime(false); report.restoration = 'VERIFIED';
        }
      } catch (r) { report.restoreFailure = r.safeCode ?? 'RECOVERY_RESTORE_UNCONFIRMED'; report.phase = 'RESTORE_UNCONFIRMED'; }
    }
    save(); throw e;
  }
}
