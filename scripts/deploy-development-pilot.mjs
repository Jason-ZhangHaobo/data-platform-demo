// Exact, temporary rollout of the already-reviewed development-only scope.
// No model invocation, Spark submission, trigger, domain, IAM or capacity writes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { functionSnapshot, functionDigest, openReadinessProof } from './refresh-v2-spark-readiness.mjs';
import { recipientKey, sealReport, auditConfig, auditErrorDetails } from './audit-v2-oidc-readonly.mjs';
import { privateOssRequest, boundedBytes, safeOssFailure } from './control-code-transport.mjs';
import { controlPackageObject } from './render-v2-control-package-policy.mjs';
import { verifyV2MonthlyBillPages } from './verify-v2-monthly-bill-pages.mjs';

const check = (v, code) => { if (!v) throw Object.assign(new Error(code), { safeCode: code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => isDeepStrictEqual(functionSnapshot(a), functionSnapshot(b));
export function pilotEnvironment(before, plan, now = Date.now()) {
  const e = before.environmentVariables, usage = plan.usage;
  check(plan.scope === 'INVITED_DEVELOPMENT_PILOT_V1' && plan.maxModelCalls === 3 && plan.maxSparkRuns === 4 && plan.maxIncrementCny === 5 && plan.monthlyCny === 200, 'PILOT_SCOPE_INVALID');
  check(plan.issuedAt <= now && plan.deadline > now && plan.deadline - plan.issuedAt <= 3600000, 'DEPLOYMENT_WINDOW_INVALID');
  check(before.runtime === 'custom.debian12' && before.cpu === 0.25 && before.memorySize === 512 && before.instanceConcurrency === 8 &&
    e?.V2_LOCAL_DEVELOPMENT === 'false' && e.V2_PROVISIONING_ONLY === 'true' && e.V2_FC_PUBLIC_HTTP_ENABLED === 'true' && e.V2_FC_PUBLIC_READ_ONLY === 'true' && !e.V2_FC_PUBLIC_WRITE_SCOPE && e.V2_DURABLE_SQL_AGENT_ENABLED === 'true' && e.V2_AGENT_DRIVER_MODE === 'OSS_EVENTS', 'READONLY_BASELINE_REQUIRED');
  check(functionDigest(before) === plan.baselineDigest && String(before.codeChecksum) === plan.previous.crc64 && before.codeSize === plan.previous.bytes, 'PILOT_BASELINE_CHANGED');
  check(usage?.month === new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(now)) &&
    Date.parse(usage.checkedAt) <= now && now - Date.parse(usage.checkedAt) < 3600000 && Number.isInteger(usage.sparkRuns) && usage.sparkRuns >= 0 && Number.isFinite(usage.modelCny) && usage.modelCny >= 0, 'CURRENT_USAGE_REQUIRED');
  check(Number.isFinite(plan.billCny) && plan.billCny >= 0 && plan.priorReserveCny === 27 && plan.billCny + 27 + 5 < 200, 'PILOT_BUDGET_INVALID');
  check(plan.bucketPrivacy?.bucketHash === sha(before.environmentVariables.OSS_BUCKET) && plan.bucketPrivacy.aclPrivate === true && plan.bucketPrivacy.policyNotPublic === true && plan.bucketPrivacy.publicAccessBlocked === true && Date.parse(plan.bucketPrivacy.checkedAt) <= now && now - Date.parse(plan.bucketPrivacy.checkedAt) < 3600000, 'PRIVATE_BUCKET_REQUIRED');
  const runLimit = Math.min(Number(e.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT ?? 200), usage.sparkRuns + 4);
  const modelLimit = Math.min(Number(e.V2_MODEL_MONTHLY_BUDGET_CNY ?? 50), Math.ceil((usage.modelCny + 4) * 100) / 100);
  check(runLimit >= usage.sparkRuns + 4 && modelLimit >= usage.modelCny + 3, 'PILOT_EXISTING_QUOTA_INSUFFICIENT');
  return { ...e, V2_FC_PUBLIC_READ_ONLY: 'false', V2_FC_PUBLIC_WRITE_SCOPE: 'DEVELOPMENT_ONLY',
    V2_PUBLIC_DEVELOPMENT_STARTS_AT: new Date(now).toISOString(), V2_PUBLIC_DEVELOPMENT_EXPIRES_AT: new Date(now + 2 * 3600000).toISOString(),
    V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: String(runLimit), V2_MODEL_MONTHLY_BUDGET_CNY: String(modelLimit), V2_ACCOUNT_MONTHLY_SPEND_CNY: String(plan.billCny) };
}
export function restoredPilotEnvironment(current, baseline, activated, candidate) {
  check(same(current, { ...baseline, environmentVariables: activated, codeChecksum: candidate.crc64, codeSize: candidate.bytes }), 'PILOT_FOREIGN_CONFIGURATION');
  return { ...baseline.environmentVariables };
}

async function main(env = process.env) {
  const config = auditConfig(env), recipient = recipientKey(env.V2_AUDIT_RECIPIENT_KEY), dir = mkdtempSync(join(tmpdir(), 'shuduo-dev-pilot-'));
  const report = { scope: 'INVITED_DEVELOPMENT_PILOT_V1', phase: 'STARTED', configReads: 0, configWrites: 0, objectGets: 0, objectPuts: 0, modelCalls: 0, sparkRuns: 0 };
  const save = () => writeFileSync('v2-development-pilot.sealed.json', JSON.stringify(sealReport(report, recipient, { protocol: 'shuduo-development-pilot/v1', sourceRevision: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID })) + '\n', { mode: 0o600 });
  const command = args => { try { return JSON.parse(execFileSync('aliyun', [...args, '--region', config.region, '--connect-timeout', '8', '--read-timeout', '40', '--retry-count', '0'], { encoding: 'utf8', timeout: 50000, maxBuffer: 2097152, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ALIBABA_CLOUD_IGNORE_PROFILE: 'TRUE', ALIBABA_CLOUD_PROFILE_MODE: 'StsToken' } })); }
    catch (e) { report.diagnostic = auditErrorDetails(e); throw Object.assign(new Error('CLOUD_REQUEST_UNCONFIRMED'), { safeCode: 'CLOUD_REQUEST_UNCONFIRMED' }); } };
  const path = `/2023-03-30/functions/${config.functionName}`;
  const read = () => { report.configReads++; save(); return command(['fc', 'GET', path]); };
  const put = body => { const file = join(dir, 'update.json'); writeFileSync(file, JSON.stringify(body), { mode: 0o600 }); report.configWrites++; save(); return command(['fc', 'PUT', path, '--body-file', file]); };
  const settle = async expected => { for (let n = 0; n < 8; n++) { const f = read(); check(same(f, expected), 'UPDATE_NOT_RECONCILED'); if ((!f.state || f.state === 'Active') && (!f.lastUpdateStatus || f.lastUpdateStatus === 'Successful')) return f; check(n < 7, 'UPDATE_PENDING'); await new Promise(r => setTimeout(r, 3000)); } };
  let plan, baseline, activated, candidate;
  try {
    check(env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1', 'PROTECTED_SINGLE_RUN_REQUIRED');
    const id = command(['sts', 'GetCallerIdentity']);
    check(String(id.AccountId) === config.account && String(id.Arn).startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`), 'IDENTITY_MISMATCH');
    const before = read(); report.initial = before;
    plan = openReadinessProof(env.V2_PILOT_PLAN, before.environmentVariables?.V2_SPARK_EXECUTOR_SECRET);
    check(plan.scope === report.scope && plan.controlName === config.functionName && plan.operatorSource === env.GITHUB_SHA && plan.mode === env.V2_PILOT_MODE && ['deploy', 'close', 'rollback'].includes(plan.mode), 'PLAN_IDENTITY_MISMATCH');
    check(plan.issuedAt <= Date.now() && plan.deadline > Date.now() && plan.deadline - plan.issuedAt <= 3600000, 'PLAN_EXPIRED');
    const credentials = { accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN };
    const bucket = before.environmentVariables.OSS_BUCKET;
    const object = async (pkg, method = 'GET', bytes, query = '') => {
      check(Date.now() < plan.deadline - 60000 && [plan.previous.sha256, plan.candidate.sha256].includes(pkg.sha256), 'OBJECT_OUTSIDE_WINDOW_OR_SCOPE');
      const key = controlPackageObject(pkg.sha256);
      if (method === 'PUT') report.objectPuts++; else report.objectGets++; save();
      const req = privateOssRequest({ bucket, region: config.region, credentials, key, method, body: bytes, query });
      return fetch(req.url, { ...req.options, signal: AbortSignal.timeout(method === 'PUT' ? 300000 : 120000) });
    };
    const verifyObject = async (pkg, bytes) => {
      let response = await object(pkg);
      if (response.status === 404 && bytes) {
        await response.body?.cancel(); check(report.objectPuts === 0, 'PUT_ALREADY_ATTEMPTED');
        try { const putResponse = await object(pkg, 'PUT', bytes); report.putDiagnostic = putResponse.ok ? { status: putResponse.status } : await safeOssFailure(putResponse); await putResponse.body?.cancel().catch(() => {}); }
        catch (e) { report.putDiagnostic = { code: e.name === 'TimeoutError' ? 'UPLOAD_TIMEOUT' : 'UPLOAD_UNCONFIRMED' }; }
        save(); response = await object(pkg); // Never repeat an uncertain upload.
      }
      const crc64 = response.headers.get('x-oss-hash-crc64ecma'), raw = await boundedBytes(response, pkg.bytes);
      check(raw.length === pkg.bytes && sha(raw) === pkg.sha256 && /^\d+$/.test(crc64 ?? '') && (!pkg.crc64 || crc64 === pkg.crc64), 'PACKAGE_BYTES_OR_CHECKSUM_INVALID');
      const acl = await object(pkg, 'GET', undefined, 'acl');
      check(acl.ok && /<Grant>(private|default)<\/Grant>/.test(await acl.text()), 'PACKAGE_PRIVACY_UNCONFIRMED');
      return { ...pkg, crc64 };
    };
    const packageBody = pkg => ({ ossBucketName: bucket, ossObjectName: controlPackageObject(pkg.sha256), checksum: pkg.crc64 });
    if (plan.mode === 'deploy') {
      baseline = before; report.baseline = baseline;
      check(env.V2_PILOT_BUILD_RUN === plan.buildRunId && env.V2_PILOT_ARTIFACT_ID === plan.artifactId, 'ARTIFACT_BINDING_INVALID');
      const bytes = readFileSync('.candidate/v2-function.zip');
      check(bytes.length === plan.candidate.bytes && sha(bytes) === plan.candidate.sha256, 'CANDIDATE_NOT_FROZEN');
      // Bill is checked again on the cloud operator before any mutation.
      const cycle = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date()), pages = [];
      for (let n = 1; n <= 10; n++) { const p = command(['bssopenapi', 'QueryBill', '--BillingCycle', cycle, '--PageNum', String(n), '--PageSize', '300']); pages.push(p); if (n * 300 >= Number(p.Data?.TotalCount)) break; }
      const bill = verifyV2MonthlyBillPages(pages, 200); check(bill.ok && bill.billingCycle === cycle && Number(bill.spendCny) + 32 < 200, 'MONTHLY_BUDGET_NOT_VERIFIED');
      plan.billCny = Number(bill.spendCny); report.bill = bill;
      pilotEnvironment(baseline, plan);
      for (const suffix of ['/concurrency', '/scaling-config']) { report.configReads++; save(); const v = command(['fc', 'GET', path + suffix, ...(suffix === '/scaling-config' ? ['--qualifier', 'LATEST'] : [])]); check(suffix === '/concurrency' ? v.reservedConcurrency === 1 : v.minInstances === 0, 'EXISTING_CAPACITY_MISMATCH'); }
      report.previous = await verifyObject(plan.previous); candidate = await verifyObject(plan.candidate, bytes); report.candidate = candidate;
      check(same(read(), baseline), 'CONFIGURATION_CHANGED_BEFORE_DEPLOY');
      activated = pilotEnvironment(baseline, plan); report.activated = activated; report.phase = 'UPDATE_REQUESTED'; save();
      try { put({ code: packageBody(candidate), environmentVariables: activated }); } catch { report.updateResponseUnknown = true; save(); }
      const expected = { ...baseline, codeChecksum: candidate.crc64, codeSize: candidate.bytes, environmentVariables: activated };
      await settle(expected);
      let ready = false;
      for (let n = 0; n < 3; n++) {
        const response = await fetch('https://shuduoai.cn/api/v2/auth/session', { redirect: 'error', signal: AbortSignal.timeout(30000) });
        const session = await response.json();
        const statusResponse = await fetch('https://shuduoai.cn/api/v2/status', { redirect: 'error', signal: AbortSignal.timeout(30000) }); const status = await statusResponse.json();
        ready = response.status === 200 && session.authenticated === false && session.readOnly === true && session.developmentOnly === true && session.developmentExpiresAt === activated.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT && statusResponse.status === 200 && status.spark?.healthVerified === true && status.agentDevelopment?.durableEnabled === true;
        report.runtime = { ready, readOnlyAnonymous: session.readOnly, developmentOnly: session.developmentOnly, sparkReady: status.spark?.healthVerified, driverReady: status.agentDevelopment?.eventBackgroundAvailable, expiresAt: session.developmentExpiresAt }; save();
        if (ready) break; if (n < 2) await new Promise(r => setTimeout(r, 3000));
      }
      check(ready, 'PILOT_RUNTIME_NOT_VERIFIED'); report.phase = 'OPENED';
    } else {
      baseline = plan.baseline; activated = plan.activated; candidate = plan.candidate;
      check(baseline?.functionName === config.functionName, 'CLEANUP_TARGET_INVALID');
      const restored = restoredPilotEnvironment(before, baseline, activated, candidate);
      report.phase = 'RESTORE_REQUESTED'; report.baseline = baseline; report.candidate = candidate; report.activated = activated; save();
      if (plan.mode === 'rollback') await verifyObject(plan.previous);
      try { put({ environmentVariables: restored, ...(plan.mode === 'rollback' ? { code: packageBody(plan.previous) } : {}) }); } catch { report.restoreResponseUnknown = true; }
      await settle({ ...baseline, ...(plan.mode === 'close' ? { codeChecksum: candidate.crc64, codeSize: candidate.bytes } : {}) });
      const r = await fetch('https://shuduoai.cn/api/v2/auth/session', { redirect: 'error', signal: AbortSignal.timeout(30000) }); const session = await r.json();
      check(r.status === 200 && session.readOnly === true && session.developmentOnly !== true, 'READONLY_RESTORE_NOT_VERIFIED'); report.phase = plan.mode === 'close' ? 'CLOSED_READONLY' : 'ROLLED_BACK';
    }
  } catch (e) {
    report.failure = e.safeCode ?? 'PILOT_OPERATION_UNCONFIRMED'; process.exitCode = 1;
    if (plan?.mode === 'deploy' && report.phase === 'UPDATE_REQUESTED' && baseline && candidate) {
      try {
        const current = read();
        if (same(current, baseline)) report.rollback = 'ALREADY_BASELINE';
        else {
          restoredPilotEnvironment(current, baseline, activated, candidate);
          report.rollbackRequested = true; save();
          try { put({ code: { ossBucketName: baseline.environmentVariables.OSS_BUCKET, ossObjectName: controlPackageObject(plan.previous.sha256), checksum: plan.previous.crc64 }, environmentVariables: baseline.environmentVariables }); } catch { report.rollbackResponseUnknown = true; }
          await settle(baseline); report.rollback = 'VERIFIED';
        }
      } catch (r) { report.rollbackFailure = r.safeCode ?? 'ROLLBACK_UNCONFIRMED'; }
    }
  } finally { save(); rmSync(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ phase: report.phase, ok: !report.failure, failure: report.failure, rollback: report.rollback, rollbackFailure: report.rollbackFailure, encryptedEvidence: true, modelCalls: 0, sparkRuns: 0 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
