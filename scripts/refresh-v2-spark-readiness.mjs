// One signed, independently asserted Worker result; environment-pointer only.
// This operator never submits jobs, invokes a model, uploads code or changes IAM.
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { auditConfig, recipientKey, sealReport, auditErrorDetails } from './audit-v2-oidc-readonly.mjs';
import { queueConfigFromEnvironment, verifyQueuedSparkJob, verifyQueuedSparkResult } from '../src/v2/remote-spark-queue.mjs';
import { privateSparkSmokePayload } from '../src/v2/spark-worker-private-smoke.mjs';

const scope = 'shuduo-spark-ready-refresh/v1';
const keyName = 'V2_SPARK_QUEUE_READY_JOB_ID';
const check = (v, code) => { if (!v) throw Object.assign(new Error(code), { safeCode: code }); };
const canonical = v => JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map(x => JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))])) : v ?? null);
const digest = v => createHash('sha256').update(canonical(v)).digest('hex');
const volatile = new Set(['requestId', 'RequestId', 'createdTime', 'lastModifiedTime', 'state', 'stateReason', 'stateReasonCode', 'lastUpdateStatus', 'lastUpdateStatusReason', 'lastUpdateStatusReasonCode']);
export const functionSnapshot = fn => Object.fromEntries(Object.entries(fn).filter(([k]) => !volatile.has(k)));
export const functionDigest = fn => digest(functionSnapshot(fn));
const active = fn => (!fn.state || fn.state === 'Active') && (!fn.lastUpdateStatus || fn.lastUpdateStatus === 'Successful');
const transportKey = secret => createHash('sha256').update(`${scope}\n${secret}`).digest();

export function sealReadinessProof(proof, secret) {
  const key = transportKey(secret), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(scope));
  const body = Buffer.concat([cipher.update(JSON.stringify(proof)), cipher.final()]);
  key.fill(0);
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') })).toString('base64');
}
export function openReadinessProof(encoded, secret) {
  check(typeof encoded === 'string' && encoded.length <= 30000, 'PROOF_TRANSPORT_INVALID');
  const key = transportKey(secret);
  try {
    const box = JSON.parse(Buffer.from(encoded, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(box.body, 'base64')), cipher.final()]));
  } catch { throw Object.assign(new Error('PROOF_AUTHENTICATION_FAILED'), { safeCode: 'PROOF_AUTHENTICATION_FAILED' }); }
  finally { key.fill(0); }
}

export async function inspectReadiness({ api, controlName, workerName }) {
  check(controlName !== workerName && [controlName, workerName].every(n => /^dataplatform-v2-[a-z0-9-]{1,60}$/.test(n ?? '')), 'TARGET_INVALID');
  const control = await api('GET', `/2023-03-30/functions/${controlName}`);
  const worker = await api('GET', `/2023-03-30/functions/${workerName}`);
  const env = control.environmentVariables;
  check(control.functionName === controlName && active(control) && control.runtime === 'custom.debian12' && control.instanceConcurrency === 8 && control.cpu === 0.25 && control.memorySize === 512 &&
    env?.V2_FC_PUBLIC_HTTP_ENABLED === 'true' && env.V2_FC_PUBLIC_READ_ONLY === 'true' && env.V2_LOCAL_DEVELOPMENT === 'false' && env.V2_PROVISIONING_ONLY === 'true', 'READONLY_CONTROL_BOUNDARY_MISMATCH');
  const config = queueConfigFromEnvironment(env);
  check(config?.readyJobId, 'READY_CONFIGURATION_MISSING');
  check(worker.functionName === workerName && active(worker) && worker.cpu === 1 && worker.memorySize === 2048 && worker.timeout === 180 && worker.instanceConcurrency === 1 && worker.internetAccess === false &&
    worker.environmentVariables?.V2_SPARK_WORKER_RUN_TIMEOUT_MS === '120000' && worker.environmentVariables.V2_SPARK_WORKER_SECRET === config.sharedSecret, 'WORKER_BOUNDARY_MISMATCH');
  for (const name of [controlName, workerName]) {
    const concurrency = await api('GET', `/2023-03-30/functions/${name}/concurrency`);
    const scaling = await api('GET', `/2023-03-30/functions/${name}/scaling-config`);
    check(concurrency.reservedConcurrency === 1 && scaling.minInstances === 0, 'RESOURCE_QUOTA_MISMATCH');
  }
  return { control, worker, boundaryDigest: functionDigest(control), workerDigest: functionDigest(worker) };
}

export function validateReadinessProof(proof, control, now = Date.now()) {
  const env = control.environmentVariables, config = queueConfigFromEnvironment(env);
  check(proof?.scope === scope && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now && proof.expiresAt <= now + 900000 && Number.isSafeInteger(proof.issuedAt) && proof.issuedAt <= now && now - proof.issuedAt <= 900000, 'PROOF_WINDOW_INVALID');
  check(proof.oldReadyJobId === config.readyJobId && proof.boundaryDigest === functionDigest(control), 'CONTROL_CHANGED_SINCE_PREFLIGHT');
  const job = proof.job, payload = verifyQueuedSparkJob(job, config, now, { allowExpired: true });
  const expected = privateSparkSmokePayload({ requestId: job.jobId, submittedAt: payload.submittedAt });
  check(job.jobId !== config.readyJobId && isDeepStrictEqual(payload, expected), 'FIXED_SMOKE_PAYLOAD_REQUIRED');
  const result = verifyQueuedSparkResult(proof.envelope, job.jobId, config);
  const completed = Date.parse(proof.envelope.completedAt), submitted = Date.parse(payload.submittedAt);
  check(Number.isFinite(completed) && completed >= submitted && completed <= now + 60000 && now - completed <= 1800000 && completed - submitted <= 300000, 'FRESH_COMPLETION_REQUIRED');
  check(result.status === 'SUCCEEDED' && result.engine === 'Apache Spark' && result.engineVersion === '3.5.9' && result.mainSqlExecuted === true && result.validation?.passed === true, 'WORKER_RESULT_NOT_SUCCESSFUL');
  check(Array.isArray(result.rows) && result.rows.length === 1, 'INDEPENDENT_ROW_COUNT_FAILED');
  const row = result.rows[0];
  for (const [key, value] of Object.entries(expected.context.expected[0])) check(row[key] === value, 'INDEPENDENT_VALUE_ASSERTION_FAILED');
  return { readyJobId: job.jobId, signed: true, independentAssertions: 6, completedAt: proof.envelope.completedAt };
}

export async function refreshReadiness({ proof, control, api, verifyRuntime, wait = ms => new Promise(r => setTimeout(r, ms)), record = () => {}, now = Date.now }) {
  const verified = validateReadinessProof(proof, control, now());
  // Runner capability is not ingress authorization: it becomes true when
  // Spark verifies. Read-only access is checked using the actual session API.
  // Anonymous capability projection intentionally omits internal verifiedAt.
  // New pointer identity is verified via FC config, not inferred from that API.
  const ready = r => r?.spark?.available === true && r.spark.healthVerified === true && r.readOnlyObserved === true && r.publicReady === false;
  const path = `/2023-03-30/functions/${control.functionName}`;
  check(functionDigest(await api('GET', path)) === functionDigest(control), 'CONTROL_CHANGED_BEFORE_WRITE');
  const desired = { ...control.environmentVariables, [keyName]: verified.readyJobId };
  const expected = functionSnapshot({ ...control, environmentVariables: desired });
  record({ phase: 'UPDATE_REQUESTED', verified, previousReadyJobId: control.environmentVariables[keyName] });
  let responseUnknown = false;
  try { await api('PUT', path, { environmentVariables: desired }); } catch { responseUnknown = true; }
  // A lost PUT response is reconciled, never resubmitted.
  let current;
  for (let n = 0; n < 8; n++) {
    current = await api('GET', path);
    check(isDeepStrictEqual(functionSnapshot(current), expected), 'POINTER_UPDATE_UNCONFIRMED');
    if (active(current)) break;
    check(n < 7, 'FUNCTION_UPDATE_PENDING'); await wait(4000);
  }
  record({ phase: 'CONFIGURATION_VERIFIED', verified, responseUnknown });
  let runtime;
  for (let n = 0; n < 3; n++) {
    runtime = await verifyRuntime();
    if (ready(runtime)) break;
    if (n < 2) await wait(5000);
  }
  const runtimeVerified = ready(runtime);
  check(functionDigest(await api('GET', path)) === digest(expected), 'POSTCHECK_CONFIGURATION_DRIFT');
  const report = { phase: runtimeVerified ? 'VERIFIED' : 'RUNTIME_NOT_READY', ...verified, configurationVerified: true, runtimeVerified, responseUnknown, modelCalls: 0, submittedSparkJobs: 0, changedEnvironmentKeys: [keyName], runtime };
  record(report);
  return report;
}

async function main(env = process.env) {
  const config = auditConfig(env), key = recipientKey(env.V2_AUDIT_RECIPIENT_KEY), dir = mkdtempSync(join(tmpdir(), 'shuduo-ready-'));
  const report = { scope, modelCalls: 0, submittedSparkJobs: 0, writes: 0, reads: 0 };
  const save = () => writeFileSync('v2-readiness-refresh.sealed.json', JSON.stringify(sealReport(report, key, { sourceRevision: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID })) + '\n', { mode: 0o600 });
  const call = args => {
    try { return JSON.parse(execFileSync('aliyun', [...args, '--region', config.region, '--connect-timeout', '8', '--read-timeout', '35', '--retry-count', '0'], { encoding: 'utf8', timeout: 45000, maxBuffer: 2097152, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ALIBABA_CLOUD_IGNORE_PROFILE: 'TRUE', ALIBABA_CLOUD_PROFILE_MODE: 'StsToken' } })); }
    catch (e) { report.diagnostic = auditErrorDetails(e); throw Object.assign(new Error('CLOUD_REQUEST_UNCONFIRMED'), { safeCode: 'CLOUD_REQUEST_UNCONFIRMED' }); }
  };
  const api = async (method, path, body) => {
    check(method === 'GET' || (method === 'PUT' && path === `/2023-03-30/functions/${config.functionName}` && Object.keys(body ?? {}).join() === 'environmentVariables'), 'OPERATION_FORBIDDEN');
    const args = ['fc', method, path];
    if (body) { const file = join(dir, 'update.json'); writeFileSync(file, JSON.stringify(body), { mode: 0o600 }); args.push('--body-file', file); report.writes++; } else report.reads++;
    save(); return call(args);
  };
  try {
    check(env.GITHUB_RUN_ATTEMPT === '1' && ['inspect', 'refresh'].includes(env.V2_READY_PHASE), 'MANUAL_RERUN_FORBIDDEN');
    const identity = call(['sts', 'GetCallerIdentity']);
    check(String(identity.AccountId) === config.account && String(identity.Arn).startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`), 'IDENTITY_MISMATCH');
    const baseline = await inspectReadiness({ api, controlName: config.functionName, workerName: env.V2_SPARK_WORKER_FUNCTION_NAME });
    report.baseline = baseline; report.checkedAt = new Date().toISOString();
    if (env.V2_READY_PHASE === 'inspect') report.phase = 'INSPECTED';
    else {
      const proof = openReadinessProof(env.V2_READY_PROOF, baseline.control.environmentVariables.V2_SPARK_EXECUTOR_SECRET);
      check(proof.workerDigest === baseline.workerDigest, 'WORKER_CHANGED_SINCE_PREFLIGHT');
      report.result = await refreshReadiness({ proof, control: baseline.control, api, record: cp => { report.checkpoint = cp; save(); }, verifyRuntime: async () => {
        const response = await fetch('https://shuduoai.cn/api/v2/status', { redirect: 'error', signal: AbortSignal.timeout(30000) });
        check(response.status === 200 && /json/i.test(response.headers.get('content-type') ?? ''), 'RUNTIME_RESPONSE_INVALID');
        const value = await response.json();
        const session = await fetch('https://shuduoai.cn/api/v2/auth/session', { redirect: 'error', signal: AbortSignal.timeout(30000) });
        check(session.status === 200 && /json/i.test(session.headers.get('content-type') ?? ''), 'RUNTIME_RESPONSE_INVALID');
        const access = await session.json();
        return { ...value, readOnlyObserved: access.authenticated === false && access.readOnly === true };
      } });
      check(report.result.runtimeVerified, 'RUNTIME_NOT_READY'); report.phase = 'VERIFIED';
    }
  } catch (e) { report.failure = e.safeCode ?? 'READINESS_REFRESH_UNCONFIRMED'; process.exitCode = 1; }
  finally { save(); rmSync(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ phase: report.phase ?? report.checkpoint?.phase ?? 'FAILED', ok: !report.failure, failure: report.failure, encryptedEvidence: true, modelCalls: 0, submittedSparkJobs: 0 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
