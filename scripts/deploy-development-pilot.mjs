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
import { publicationPilotTimers, publicationPilotTimerNames } from './publication-pilot-timers.mjs';
import { publicServiceConfig } from '../src/v2/public-service-access.mjs';

const check = (v, code) => { if (!v) throw Object.assign(new Error(code), { safeCode: code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => isDeepStrictEqual(functionSnapshot(a), functionSnapshot(b));
// This receipt authorizes only GET-based verification, never a replacement PUT.
export function validatePilotPackageTransport(plan, workflowPreStaged) {
  const preStaged = plan?.packageTransport === 'PRESTAGED_READ_ONLY_V1';
  check(plan && (plan.packageTransport === undefined || preStaged) &&
    (!preStaged || plan.scope === 'INVITED_SERVICE_CONSUMPTION_PILOT_V1'), 'PILOT_PACKAGE_TRANSPORT_INVALID');
  if (workflowPreStaged !== undefined) check(['true', 'false'].includes(workflowPreStaged) &&
    (workflowPreStaged === 'true') === preStaged, 'PILOT_PRESTAGED_INPUT_MISMATCH');
  if (!preStaged) {
    check(!Object.hasOwn(plan, 'preStagedObject') && !Object.hasOwn(plan, 'preStagedObjectDigest'), 'PILOT_PRESTAGED_RECEIPT_UNEXPECTED');
    return false;
  }
  const receipt = plan.preStagedObject, keys = ['protocol', 'sha256', 'bytes', 'crc64', 'verifiedAt', 'putAttempts'];
  check(receipt && typeof receipt === 'object' && !Array.isArray(receipt) && Object.keys(receipt).length === keys.length &&
    keys.every(key => Object.hasOwn(receipt, key)) && receipt.protocol === 'VERIFIED_PRIVATE_CODE_OBJECT_V1' &&
    typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256) && receipt.sha256 === plan.candidate?.sha256 &&
    Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= 67108864 && receipt.bytes === plan.candidate?.bytes &&
    typeof receipt.crc64 === 'string' && /^\d+$/.test(receipt.crc64) && receipt.crc64 === plan.candidate?.crc64 &&
    [0, 1].includes(receipt.putAttempts) && Number.isSafeInteger(plan.issuedAt) && typeof receipt.verifiedAt === 'string' &&
    Number.isFinite(Date.parse(receipt.verifiedAt)) && Date.parse(receipt.verifiedAt) <= plan.issuedAt &&
    plan.issuedAt - Date.parse(receipt.verifiedAt) <= 3600000, 'PILOT_PRESTAGED_RECEIPT_INVALID');
  return true;
}
export function pilotEnvironment(before, plan, now = Date.now()) {
  validatePilotPackageTransport(plan);
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

// Pure plan validation only. Publication execution and timer IO remain separate;
// no existing development-pilot authority or environment is implicitly reused.
export function publicationPilotEnvironment(before, plan, now = Date.now()) {
  validatePilotPackageTransport(plan);
  const e = before?.environmentVariables, usage = plan?.usage;
  const expectedTriggerNames = Array.from({ length: 4 }, (_, i) => `shuduo-release-pilot-20261027-${i + 1}`);
  check(plan?.scope === 'INVITED_PUBLICATION_PILOT_V1' && plan.maxModelCalls === 0 && plan.maxSparkRuns === 2 && plan.maxIncrementCny === 5 && plan.monthlyCny === 200 && plan.priorReserveCny === 32, 'PUBLICATION_PILOT_SCOPE_INVALID');
  check(Number.isSafeInteger(now) && Number.isSafeInteger(plan.issuedAt) && Number.isSafeInteger(plan.deadline) && plan.issuedAt <= now && plan.deadline > now && plan.deadline - plan.issuedAt <= 3600000, 'DEPLOYMENT_WINDOW_INVALID');
  check(before?.runtime === 'custom.debian12' && before.cpu === 0.25 && before.memorySize === 512 && before.instanceConcurrency === 8 &&
    typeof before.functionName === 'string' && /^dataplatform-v2-[a-z0-9-]{1,60}$/.test(before.functionName) && plan.controlName === before.functionName &&
    e?.V2_LOCAL_DEVELOPMENT === 'false' && e.V2_PROVISIONING_ONLY === 'true' && e.V2_PRIVATE_SMOKE_ENABLED === 'true' && e.V2_FC_PUBLIC_HTTP_ENABLED === 'true' && e.V2_FC_PUBLIC_READ_ONLY === 'true' && !e.V2_FC_PUBLIC_WRITE_SCOPE &&
    e.V2_DURABLE_SQL_AGENT_ENABLED === 'true' && e.V2_AGENT_DRIVER_MODE === 'OSS_EVENTS' && e.V2_PRIVATE_RELEASE_ENABLED !== 'true' &&
    typeof e.V2_BOOTSTRAP_ADMIN_EMAIL === 'string' && e.V2_BOOTSTRAP_ADMIN_EMAIL.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.V2_BOOTSTRAP_ADMIN_EMAIL) &&
    typeof e.OSS_BUCKET === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(e.OSS_BUCKET), 'READONLY_PUBLICATION_BASELINE_REQUIRED');
  check(functionDigest(before) === plan.baselineDigest && typeof plan.previous?.crc64 === 'string' && /^\d+$/.test(plan.previous.crc64) &&
    String(before.codeChecksum) === plan.previous.crc64 && Number.isSafeInteger(plan.previous.bytes) && plan.previous.bytes > 0 && before.codeSize === plan.previous.bytes, 'PILOT_BASELINE_CHANGED');
  const target = plan.target;
  check(target && !Array.isArray(target) && Object.keys(target).length === 3 &&
    ['taskId', 'verificationId'].every(k => typeof target[k] === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target[k])) &&
    typeof target.packageDigest === 'string' && /^[a-f0-9]{64}$/.test(target.packageDigest), 'PUBLICATION_TARGET_INVALID');
  check(isDeepStrictEqual(plan.triggerNames, expectedTriggerNames), 'PUBLICATION_TRIGGER_SCOPE_INVALID');
  check(typeof plan.schedulerSecret === 'string' && plan.schedulerSecret.length >= 32 && plan.schedulerSecret.length <= 512 && !/\s/.test(plan.schedulerSecret) &&
    plan.schedulerSecret !== e.V2_SCHEDULER_TICK_SECRET && plan.schedulerSecret !== e.V2_SPARK_EXECUTOR_SECRET, 'PUBLICATION_SCHEDULER_SECRET_INVALID');
  check(usage?.month === new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(now)) &&
    Date.parse(usage.checkedAt) <= now && now - Date.parse(usage.checkedAt) < 3600000 && Number.isSafeInteger(usage.sparkRuns) && usage.sparkRuns >= 0 && Number.isFinite(usage.modelCny) && usage.modelCny >= 0, 'CURRENT_USAGE_REQUIRED');
  check(Number.isFinite(plan.billCny) && plan.billCny >= 0 && plan.billCny + plan.priorReserveCny + plan.maxIncrementCny < plan.monthlyCny, 'PILOT_BUDGET_INVALID');
  check(plan.bucketPrivacy?.bucketHash === sha(e.OSS_BUCKET) && plan.bucketPrivacy.aclPrivate === true && plan.bucketPrivacy.policyNotPublic === true && plan.bucketPrivacy.publicAccessBlocked === true &&
    Date.parse(plan.bucketPrivacy.checkedAt) <= now && now - Date.parse(plan.bucketPrivacy.checkedAt) < 3600000, 'PRIVATE_BUCKET_REQUIRED');
  const existingRunLimit = Number(e.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT), runLimit = usage.sparkRuns + 2;
  check(Number.isSafeInteger(existingRunLimit) && Number.isSafeInteger(runLimit) && existingRunLimit >= runLimit &&
    typeof e.V2_MODEL_MONTHLY_BUDGET_CNY === 'string' && e.V2_MODEL_MONTHLY_BUDGET_CNY.trim() !== '' && Number.isFinite(Number(e.V2_MODEL_MONTHLY_BUDGET_CNY)) && Number(e.V2_MODEL_MONTHLY_BUDGET_CNY) >= 0,
  'PILOT_EXISTING_QUOTA_INSUFFICIENT');
  return { ...e, V2_FC_PUBLIC_READ_ONLY: 'false', V2_FC_PUBLIC_WRITE_SCOPE: 'PUBLICATION_ONLY',
    V2_PUBLIC_PUBLICATION_TASK_ID: target.taskId, V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: target.packageDigest, V2_PUBLIC_PUBLICATION_VERIFICATION_ID: target.verificationId,
    V2_PUBLIC_PUBLICATION_STARTS_AT: new Date(now).toISOString(), V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(now + 2 * 3600000).toISOString(),
    V2_PRIVATE_RELEASE_ENABLED: 'true', V2_PRIVATE_RELEASE_TRIGGER_NAMES: plan.triggerNames.join(','), V2_SCHEDULER_TICK_SECRET: plan.schedulerSecret,
    V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: String(runLimit), V2_ACCOUNT_MONTHLY_SPEND_CNY: String(plan.billCny) };
}
// Service consumption reuses an already-published snapshot. This scope carries
// no scheduler authority and must not change compute budgets or runtime drivers.
export function validateServicePilotReserve(plan, preStaged = validatePilotPackageTransport(plan)) {
  const continuation = plan?.cloudTransferContinuation;
  if (continuation === undefined)
    return preStaged ? [39, 41].includes(plan.priorReserveCny) : plan.priorReserveCny === 37;
  const keys = ['protocol','attemptNumber','previousAttemptNumber','previousPhase','closedAttemptDigest','approvalDigest',
    'historyUsageDigest','candidateSha256','buildRunId','artifactId','previousReserveCny','failedAttemptReserveCny','maxPuts'];
  check(!preStaged && plan.scope === 'INVITED_SERVICE_CONSUMPTION_PILOT_V1' &&
    continuation && typeof continuation === 'object' && !Array.isArray(continuation) &&
    Object.keys(continuation).length === keys.length && keys.every(key => Object.hasOwn(continuation, key)) &&
    continuation.protocol === 'SERVICE_CLOUD_TRANSFER_CONTINUATION_V1' && continuation.attemptNumber === 4 &&
    continuation.previousAttemptNumber === 3 && continuation.previousPhase === 'CLOSED_BEFORE_ACTIVATION' &&
    ['closedAttemptDigest','approvalDigest','historyUsageDigest'].every(key => /^[a-f0-9]{64}$/.test(continuation[key] ?? '')) &&
    plan.historyUsage && publicationUsageKeys.every(key => Number.isSafeInteger(plan.historyUsage[key]) && plan.historyUsage[key] >= 0) &&
    continuation.historyUsageDigest === timerHash(plan.historyUsage) &&
    continuation.candidateSha256 === plan.candidate?.sha256 && /^[a-f0-9]{64}$/.test(continuation.candidateSha256 ?? '') &&
    continuation.buildRunId === plan.buildRunId && /^\d+$/.test(continuation.buildRunId ?? '') &&
    continuation.artifactId === plan.artifactId && /^\d+$/.test(continuation.artifactId ?? '') &&
    continuation.previousReserveCny === 41 && continuation.failedAttemptReserveCny === 2 && continuation.maxPuts === 1 &&
    plan.priorReserveCny === continuation.previousReserveCny + continuation.failedAttemptReserveCny,
    'SERVICE_CLOUD_TRANSFER_CONTINUATION_INVALID');
  return true;
}
function servicePilotBaseline(before, plan, now) {
  const e = before?.environmentVariables;
  const preStaged = validatePilotPackageTransport(plan);
  check(plan?.scope === 'INVITED_SERVICE_CONSUMPTION_PILOT_V1' && plan.maxModelCalls === 0 && plan.maxSparkRuns === 0 &&
    plan.maxIncrementCny === 2 && plan.monthlyCny === 200 && validateServicePilotReserve(plan, preStaged), 'SERVICE_PILOT_SCOPE_INVALID');
  check(!['triggerNames', 'timerRecords', 'timerPreparedAt', 'schedulerSecret', 'permissionProbe', 'releaseId', 'stageCheckpoint'].some(key => Object.hasOwn(plan, key)), 'SERVICE_TIMER_AUTHORITY_FORBIDDEN');
  check(Number.isSafeInteger(now) && Number.isSafeInteger(plan.issuedAt) && Number.isSafeInteger(plan.deadline) &&
    plan.issuedAt <= now && plan.deadline > now && plan.deadline - plan.issuedAt <= 3600000, 'DEPLOYMENT_WINDOW_INVALID');
  check(before?.runtime === 'custom.debian12' && before.cpu === 0.25 && before.memorySize === 512 && before.instanceConcurrency === 8 &&
    typeof before.functionName === 'string' && /^dataplatform-v2-[a-z0-9-]{1,60}$/.test(before.functionName) && plan.controlName === before.functionName &&
    e?.V2_LOCAL_DEVELOPMENT === 'false' && e.V2_PROVISIONING_ONLY === 'true' && e.V2_PRIVATE_SMOKE_ENABLED === 'true' &&
    e.V2_PRIVATE_DATA_SERVICES_ENABLED === 'true' && e.V2_FC_PUBLIC_HTTP_ENABLED === 'true' && e.V2_FC_PUBLIC_READ_ONLY === 'true' &&
    !e.V2_FC_PUBLIC_WRITE_SCOPE && e.V2_PRIVATE_RELEASE_ENABLED !== 'true' &&
    typeof e.V2_BOOTSTRAP_ADMIN_EMAIL === 'string' && e.V2_BOOTSTRAP_ADMIN_EMAIL.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.V2_BOOTSTRAP_ADMIN_EMAIL) &&
    typeof e.OSS_BUCKET === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(e.OSS_BUCKET), 'READONLY_SERVICE_BASELINE_REQUIRED');
  check(functionDigest(before) === plan.baselineDigest && typeof plan.previous?.crc64 === 'string' && /^\d+$/.test(plan.previous.crc64) &&
    String(before.codeChecksum) === plan.previous.crc64 && Number.isSafeInteger(plan.previous.bytes) && plan.previous.bytes > 0 &&
    before.codeSize === plan.previous.bytes, 'PILOT_BASELINE_CHANGED');
  check([plan.previous, plan.candidate].every(pkg => pkg && typeof pkg.sha256 === 'string' && /^[a-f0-9]{64}$/.test(pkg.sha256) &&
    Number.isSafeInteger(pkg.bytes) && pkg.bytes > 0 && pkg.bytes <= 67108864 &&
    (pkg.crc64 === undefined || (typeof pkg.crc64 === 'string' && /^\d+$/.test(pkg.crc64)))) &&
    plan.previous.sha256 !== plan.candidate.sha256, 'SERVICE_EXACT_CODE_OBJECTS_REQUIRED');
  const target = plan.target;
  check(target && typeof target === 'object' && !Array.isArray(target) && Object.keys(target).length === 3 &&
    ['taskId', 'sourceReleaseRunId'].every(key => typeof target[key] === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target[key])) &&
    typeof target.packageDigest === 'string' && /^[a-f0-9]{64}$/.test(target.packageDigest) &&
    ['taskId', 'packageDigest', 'sourceReleaseRunId'].every(key => target[key] === plan.servicePlan?.[key]), 'SERVICE_TARGET_INVALID');
  const next = { ...e, V2_FC_PUBLIC_READ_ONLY: 'false', V2_FC_PUBLIC_WRITE_SCOPE: 'SERVICE_CONSUMPTION_ONLY',
    V2_PUBLIC_SERVICE_PLAN: JSON.stringify(plan.servicePlan), V2_PUBLIC_SERVICE_STARTS_AT: new Date(now).toISOString(),
    V2_PUBLIC_SERVICE_EXPIRES_AT: new Date(now + 2 * 3600000).toISOString(), V2_ACCOUNT_MONTHLY_SPEND_CNY: String(plan.billCny) };
  try { check(publicServiceConfig(next)?.scope === 'SERVICE_CONSUMPTION_ONLY', 'SERVICE_PLAN_INVALID'); }
  catch { check(false, 'SERVICE_PLAN_INVALID'); }
  return next;
}
export function serviceConsumptionPilotEnvironment(before, plan, now = Date.now()) {
  const next = servicePilotBaseline(before, plan, now), e = before.environmentVariables, usage = plan.usage;
  check(usage?.month === new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(now)) &&
    Date.parse(usage.checkedAt) <= now && now - Date.parse(usage.checkedAt) < 3600000 && Number.isSafeInteger(usage.sparkRuns) && usage.sparkRuns >= 0 &&
    Number.isFinite(usage.modelCny) && usage.modelCny >= 0, 'CURRENT_USAGE_REQUIRED');
  check(Number.isFinite(plan.billCny) && plan.billCny >= 0 && plan.billCny + plan.priorReserveCny + plan.maxIncrementCny < plan.monthlyCny, 'PILOT_BUDGET_INVALID');
  check(plan.bucketPrivacy?.bucketHash === sha(e.OSS_BUCKET) && plan.bucketPrivacy.aclPrivate === true && plan.bucketPrivacy.policyNotPublic === true &&
    plan.bucketPrivacy.publicAccessBlocked === true && Date.parse(plan.bucketPrivacy.checkedAt) <= now && now - Date.parse(plan.bucketPrivacy.checkedAt) < 3600000, 'PRIVATE_BUCKET_REQUIRED');
  return next;
}
export function restoredPilotEnvironment(current, baseline, activated, candidate) {
  check(same(current, { ...baseline, environmentVariables: activated, codeChecksum: candidate.crc64, codeSize: candidate.bytes }), 'PILOT_FOREIGN_CONFIGURATION');
  return { ...baseline.environmentVariables };
}

const publicationScope = 'INVITED_PUBLICATION_PILOT_V1';
const serviceConsumptionScope = 'INVITED_SERVICE_CONSUMPTION_PILOT_V1';
const publicationModes = ['stage', 'resume-stage', 'activate', 'timers', 'cleanup-timers', 'close', 'rollback'];
const serviceConsumptionModes = ['stage', 'activate', 'close', 'rollback'];
const publicationUsageKeys = ['configReads', 'activeHttp', 'configWrites', 'objectGets', 'objectPuts', 'triggerCreates', 'triggerDeletes', 'permissionProbes'];
// FC 3.0 can return explicit null for these optional lifecycle fields.
const stableFunction = value => (value.state == null || value.state === 'Active') &&
  (value.lastUpdateStatus == null || value.lastUpdateStatus === 'Successful');
const pendingFunction = value => value.lastUpdateStatus === 'InProgress' || ['Pending', 'Creating', 'Updating'].includes(value.state);
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value)
  ? value.map(item => JSON.parse(canonical(item)))
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value ?? null);
const timerHash = value => sha(canonical(value));
function assertPilotTimer(actual, record) {
  check(actual && actual.triggerName === record.name && record.bodyHash === timerHash(record.body), 'PUBLICATION_TIMER_OWNERSHIP_MISMATCH');
  let config;
  try { config = typeof actual.triggerConfig === 'string' ? JSON.parse(actual.triggerConfig) : actual.triggerConfig; }
  catch { check(false, 'PUBLICATION_TIMER_CONFIG_INVALID'); }
  const expected = { ...record.body, triggerConfig: JSON.parse(record.body.triggerConfig) };
  check(isDeepStrictEqual({ triggerName: actual.triggerName, triggerType: actual.triggerType, qualifier: actual.qualifier,
    description: actual.description, triggerConfig: config }, expected) &&
    [actual.sourceArn, actual.invocationRole].every(value => value === undefined || value === null || value === ''), 'PUBLICATION_TIMER_OWNERSHIP_MISMATCH');
}

// Shared narrow IO seam for one publication or service-consumption batch.
// Callers authenticate the sealed plan and protected-main identity first;
// tests use synthetic IO only. Service mode never enters timer operations.
export async function runPublicationPilotOperation(plan, before, report, io) {
  const now = io.now ?? Date.now, wait = io.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const serviceOnly = plan.scope === serviceConsumptionScope;
  const preStaged = validatePilotPackageTransport(plan);
  const preStagedObjectDigest = preStaged ? sha(canonical(plan.preStagedObject)) : undefined;
  if (preStaged && (plan.mode !== 'stage' || Object.hasOwn(plan, 'preStagedObjectDigest')))
    check(plan.preStagedObjectDigest === preStagedObjectDigest, 'PILOT_PRESTAGED_CHECKPOINT_CHANGED');
  check((serviceOnly ? serviceConsumptionModes : publicationModes).includes(plan.mode) &&
    (serviceOnly ? plan.maxModelCalls === 0 && plan.maxSparkRuns === 0 && plan.maxIncrementCny === 2 && validateServicePilotReserve(plan, preStaged)
      : plan.scope === publicationScope && plan.maxModelCalls === 0 && plan.maxSparkRuns === 2 && plan.maxIncrementCny === 5 && plan.priorReserveCny === 32) && plan.monthlyCny === 200 &&
    plan.maxReads === 120 && plan.maxProbes === 40 && plan.normalReadLimit === 84 && plan.readLimit === 108 && plan.ownerCleanupReadReserve === 12 &&
    (serviceOnly || isDeepStrictEqual(plan.triggerNames, publicationPilotTimerNames)), serviceOnly ? 'SERVICE_PILOT_SCOPE_INVALID' : 'PUBLICATION_PILOT_SCOPE_INVALID');
  if (serviceOnly) check(!['triggerNames', 'timerRecords', 'timerPreparedAt', 'schedulerSecret', 'permissionProbe', 'releaseId', 'stageCheckpoint'].some(key => Object.hasOwn(plan, key)), 'SERVICE_TIMER_AUTHORITY_FORBIDDEN');
  check(Number.isSafeInteger(plan.issuedAt) && Number.isSafeInteger(plan.deadline) && plan.issuedAt <= now() && plan.deadline > now() &&
    plan.deadline - plan.issuedAt <= 3600000, 'PLAN_EXPIRED');
  check(plan.controlName === before.functionName && /^dataplatform-v2-[a-z0-9-]{1,60}$/.test(plan.controlName), 'PUBLICATION_TARGET_INVALID');
  check(plan.priorUsage && publicationUsageKeys.every(key => Number.isSafeInteger(plan.priorUsage[key]) && plan.priorUsage[key] >= 0), 'PUBLICATION_USAGE_HISTORY_REQUIRED');
  if (preStaged) check(plan.priorUsage.objectPuts === plan.preStagedObject.putAttempts, 'PILOT_PRESTAGED_PUT_HISTORY_CHANGED');
  if (serviceOnly) {
    check(plan.historyUsage && publicationUsageKeys.every(key => Number.isSafeInteger(plan.historyUsage[key]) && plan.historyUsage[key] >= 0), 'SERVICE_PRIOR_BATCH_HISTORY_REQUIRED');
    check(['triggerCreates', 'triggerDeletes', 'permissionProbes'].every(key => plan.priorUsage[key] === 0), 'SERVICE_TIMER_AUTHORITY_FORBIDDEN');
  }
  const usage = { ...plan.priorUsage };
  let cleanupReading = ['cleanup-timers', 'close', 'rollback'].includes(plan.mode);
  // GetCallerIdentity and the function GET needed to open the plan are already
  // recorded before their calls by main; include them in the inherited total.
  usage.configReads += report.configReads + (report.identityReads ?? 0);
  check(usage.configReads <= (cleanupReading ? plan.readLimit : plan.normalReadLimit) && usage.activeHttp <= 40 && usage.configWrites <= 4 && usage.objectPuts <= 1 && usage.triggerCreates <= 4 && usage.triggerDeletes <= 4 && usage.permissionProbes <= 1, 'PUBLICATION_USAGE_LIMIT');
  const path = `/2023-03-30/functions/${plan.controlName}`;
  Object.assign(report, { scope: plan.scope, mode: plan.mode, issuedAt: plan.issuedAt, deadline: plan.deadline,
    priorUsage: structuredClone(plan.priorUsage), cumulativeUsage: usage, target: plan.target, releaseId: plan.releaseId, previous: plan.previous,
    baseline: ['stage', 'resume-stage'].includes(plan.mode) ? before : plan.baseline, candidate: plan.candidate,
    activated: plan.activated,
    ...(preStaged ? { packageTransport: plan.packageTransport, preStagedObject: structuredClone(plan.preStagedObject), preStagedObjectDigest } : {}),
    ...(serviceOnly && ['close', 'rollback'].includes(plan.mode) && plan.phase === 'RESTORE_REQUESTED' ? { phase: 'RESTORE_REQUESTED' } : {}),
    ...(serviceOnly ? { servicePlanDigest: sha(canonical(plan.servicePlan)), historyUsage: structuredClone(plan.historyUsage),
      ...(plan.cloudTransferContinuation ? { cloudTransferContinuation: structuredClone(plan.cloudTransferContinuation) } : {}) }
      : { permissionProbe: plan.permissionProbe, timerRecords: structuredClone(plan.timerRecords ?? []), timerPreparedAt: plan.timerPreparedAt }) });
  const save = () => {
    report.runUsage = Object.fromEntries(publicationUsageKeys.map(key => [key, usage[key] - plan.priorUsage[key]]));
    io.save(report);
  };
  const spend = kind => {
    check(now() < plan.deadline, 'PLAN_EXPIRED');
    if (preStaged) check(kind !== 'objectPuts', 'PILOT_PRESTAGED_OBJECT_PUT_FORBIDDEN');
    if (serviceOnly) check(!['triggerCreates', 'triggerDeletes', 'permissionProbes'].includes(kind), 'SERVICE_TIMER_AUTHORITY_FORBIDDEN');
    const limit = { configReads: cleanupReading ? plan.readLimit : plan.normalReadLimit, activeHttp: 40, configWrites: 4, objectPuts: 1, triggerCreates: 4, triggerDeletes: 4, permissionProbes: 1 }[kind];
    check(limit === undefined || usage[kind] < limit, 'PUBLICATION_USAGE_LIMIT');
    usage[kind]++; report[kind] = (report[kind] ?? 0) + 1; save();
  };
  const call = (kind, args, body) => {
    if (serviceOnly) check(!args.some(arg => typeof arg === 'string' && arg.includes('/triggers')), 'SERVICE_TIMER_AUTHORITY_FORBIDDEN');
    spend(kind); return io.command(args, body);
  };
  const read = () => call('configReads', ['fc', 'GET', path]);
  const put = body => call('configWrites', ['fc', 'PUT', path], body);
  const settle = async expected => {
    for (let n = 0; n < 6; n++) {
      const current = await read();
      const known = [expected, report.baseline, stagedSnapshot(), ...(report.activated ? [openedSnapshot()] : [])];
      check(known.some(snapshot => same(current, snapshot)), stableFunction(current) ? 'PILOT_FOREIGN_CONFIGURATION' : 'UPDATE_UNRECOGNIZED_PENDING');
      if (stableFunction(current) && same(current, expected)) return current;
      if (stableFunction(current)) { check(n < 5, 'UPDATE_NOT_RECONCILED'); await wait(3000); continue; }
      check(pendingFunction(current), 'UPDATE_NOT_SUCCESSFUL');
      check(n < 5, 'UPDATE_PENDING'); await wait(3000);
    }
  };
  const bill = async () => {
    const cycle = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(now())), pages = [];
    for (let n = 1; n <= 10; n++) {
      const page = await call('configReads', ['bssopenapi', 'QueryBill', '--BillingCycle', cycle, '--PageNum', String(n), '--PageSize', '300']);
      pages.push(page); if (n * 300 >= Number(page.Data?.TotalCount)) break;
    }
    const verified = verifyV2MonthlyBillPages(pages, 200);
    check(verified.ok && verified.billingCycle === cycle && Number(verified.spendCny) + plan.priorReserveCny + plan.maxIncrementCny < 200, 'MONTHLY_BUDGET_NOT_VERIFIED');
    plan.billCny = Number(verified.spendCny); report.bill = verified; save();
  };
  const runtime = async opened => {
    for (let n = 0; n < 3; n++) {
      spend('activeHttp'); const access = await io.http('/api/v2/auth/session');
      spend('activeHttp'); const status = await io.http('/api/v2/status');
      const ready = access.status === 200 && access.body.authenticated === false && access.body.readOnly === true &&
        (opened ? serviceOnly ? access.body.consumptionOnly === true && access.body.publicationOnly !== true && access.body.developmentOnly !== true &&
            access.body.consumptionExpiresAt === report.activated.V2_PUBLIC_SERVICE_EXPIRES_AT
          : access.body.publicationOnly === true && access.body.publicationExpiresAt === report.activated.V2_PUBLIC_PUBLICATION_EXPIRES_AT
          : access.body.publicationOnly !== true && access.body.developmentOnly !== true && access.body.consumptionOnly !== true) && status.status === 200 &&
        (!opened || serviceOnly || (status.body.spark?.healthVerified === true && status.body.agentDevelopment?.durableEnabled === true));
      report.runtime = { ready, readOnlyAnonymous: access.body.readOnly, publicationOnly: access.body.publicationOnly === true,
        consumptionOnly: access.body.consumptionOnly === true, sparkReady: status.body.spark?.healthVerified === true,
        expiresAt: serviceOnly ? access.body.consumptionExpiresAt : access.body.publicationExpiresAt }; save();
      if (ready) return;
      if (n < 2) await wait(3000);
    }
    check(false, opened ? 'PILOT_RUNTIME_NOT_VERIFIED' : 'READONLY_RESTORE_NOT_VERIFIED');
  };
  const object = async (pkg, method = 'GET', bytes, query = '') => {
    if (preStaged) check(method === 'GET' && bytes === undefined, 'PILOT_PRESTAGED_OBJECT_PUT_FORBIDDEN');
    check(now() < plan.deadline - 60000 && [plan.previous.sha256, plan.candidate.sha256].includes(pkg.sha256), 'OBJECT_OUTSIDE_WINDOW_OR_SCOPE');
    if (method === 'GET') spend('configReads');
    spend(method === 'PUT' ? 'objectPuts' : 'objectGets');
    return io.object(pkg, method, bytes, query);
  };
  const verifyObject = async (pkg, bytes) => {
    let response = await object(pkg);
    if (response.status === 404 && bytes) {
      await response.body?.cancel();
      try { const uploaded = await object(pkg, 'PUT', bytes); report.putDiagnostic = uploaded.ok ? { status: uploaded.status } : await safeOssFailure(uploaded); await uploaded.body?.cancel(); }
      catch (error) { report.putDiagnostic = { code: error.safeCode ?? 'UPLOAD_UNCONFIRMED' }; }
      save(); response = await object(pkg); // Never repeat an uncertain PUT.
    }
    const crc64 = response.headers.get('x-oss-hash-crc64ecma'), raw = await boundedBytes(response, pkg.bytes);
    check(raw.length === pkg.bytes && sha(raw) === pkg.sha256 && /^\d+$/.test(crc64 ?? '') && (!pkg.crc64 || pkg.crc64 === crc64), 'PACKAGE_BYTES_OR_CHECKSUM_INVALID');
    const acl = await object(pkg, 'GET', undefined, 'acl');
    check(acl.ok && /<Grant>(private|default)<\/Grant>/.test(await acl.text()), 'PACKAGE_PRIVACY_UNCONFIRMED');
    return { ...pkg, crc64 };
  };
  const packageBody = pkg => ({ ossBucketName: report.baseline.environmentVariables.OSS_BUCKET, ossObjectName: controlPackageObject(pkg.sha256), checksum: pkg.crc64 });
  const stagedSnapshot = () => ({ ...report.baseline, codeChecksum: report.candidate.crc64, codeSize: report.candidate.bytes });
  const openedSnapshot = () => ({ ...stagedSnapshot(), environmentVariables: report.activated });
  const assertBaseline = () => {
    const b = report.baseline, e = b?.environmentVariables;
    if (serviceOnly) {
      // Fresh usage/privacy is required before new staging or opening. Closing
      // an exact known snapshot must not depend on a stale billing observation.
      (['close', 'rollback'].includes(plan.mode) ? servicePilotBaseline : serviceConsumptionPilotEnvironment)(b, plan, now());
      if (plan.mode !== 'stage') check(plan.servicePlanDigest === report.servicePlanDigest, 'SERVICE_PLAN_CHECKPOINT_MISMATCH');
      return;
    }
    check(b && functionDigest(b) === plan.baselineDigest && b.functionName === plan.controlName && b.runtime === 'custom.debian12' && b.cpu === 0.25 && b.memorySize === 512 && b.instanceConcurrency === 8 &&
      String(b.codeChecksum) === plan.previous.crc64 && b.codeSize === plan.previous.bytes && e?.V2_LOCAL_DEVELOPMENT === 'false' && e.V2_PROVISIONING_ONLY === 'true' && e.V2_PRIVATE_SMOKE_ENABLED === 'true' &&
      e.V2_FC_PUBLIC_HTTP_ENABLED === 'true' && e.V2_FC_PUBLIC_READ_ONLY === 'true' && !e.V2_FC_PUBLIC_WRITE_SCOPE && e.V2_PRIVATE_RELEASE_ENABLED !== 'true' && e.V2_DURABLE_SQL_AGENT_ENABLED === 'true' && e.V2_AGENT_DRIVER_MODE === 'OSS_EVENTS', 'READONLY_PUBLICATION_BASELINE_REQUIRED');
    check(plan.target && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.target.taskId ?? '') && /^[a-f0-9]{64}$/.test(plan.target.packageDigest ?? ''), 'PUBLICATION_TARGET_INVALID');
  };
  const assertOpened = current => {
    const e = report.activated;
    if (serviceOnly) {
      const startsAt = Date.parse(e?.V2_PUBLIC_SERVICE_STARTS_AT);
      check(typeof e?.V2_ACCOUNT_MONTHLY_SPEND_CNY === 'string' && e.V2_ACCOUNT_MONTHLY_SPEND_CNY.trim() !== '' &&
        Number.isFinite(Number(e.V2_ACCOUNT_MONTHLY_SPEND_CNY)) && Number(e.V2_ACCOUNT_MONTHLY_SPEND_CNY) >= 0, 'SERVICE_ACTIVE_SNAPSHOT_MISMATCH');
      const expected = servicePilotBaseline(report.baseline, { ...plan, billCny: Number(e.V2_ACCOUNT_MONTHLY_SPEND_CNY) }, startsAt);
      check(isDeepStrictEqual(e, expected) && same(current, openedSnapshot()), 'SERVICE_ACTIVE_SNAPSHOT_MISMATCH');
      return;
    }
    check(e && e.V2_FC_PUBLIC_WRITE_SCOPE === 'PUBLICATION_ONLY' && e.V2_PUBLIC_PUBLICATION_TASK_ID === plan.target.taskId &&
      e.V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST === plan.target.packageDigest && e.V2_PUBLIC_PUBLICATION_VERIFICATION_ID === plan.target.verificationId &&
      e.V2_SCHEDULER_TICK_SECRET === plan.schedulerSecret && e.V2_PRIVATE_RELEASE_TRIGGER_NAMES === plan.triggerNames.join(',') &&
      e.V2_PRIVATE_RELEASE_ENABLED === 'true' && Number.isFinite(Date.parse(e.V2_PUBLIC_PUBLICATION_EXPIRES_AT)) && same(current, openedSnapshot()), 'PUBLICATION_ACTIVE_SNAPSHOT_MISMATCH');
  };
  const triggerPath = name => { check(plan.triggerNames.includes(name), 'PUBLICATION_TRIGGER_SCOPE_INVALID'); return `${path}/triggers/${name}`; };
  const getTimer = async name => {
    try { return await call('configReads', ['fc', 'GET', triggerPath(name)]); }
    catch (error) { if (error.safeCode === 'TRIGGER_NOT_FOUND') return undefined; throw error; }
  };
  const listTimers = async () => {
    const response = await call('configReads', ['fc', 'GET', `${path}/triggers`, '--limit', '100']);
    check(Array.isArray(response?.triggers) && !response.nextToken && response.triggers.every(t => typeof t?.triggerName === 'string') &&
      new Set(response.triggers.map(t => t.triggerName)).size === response.triggers.length, 'PUBLICATION_TRIGGER_LIST_UNCONFIRMED');
    return response.triggers;
  };
  const probeMissingTimerDeletion = async () => {
    check(usage.permissionProbes === 0, 'PUBLICATION_PERMISSION_PROBE_ALREADY_USED');
    const listed = await listTimers();
    check(!listed.some(timer => plan.triggerNames.includes(timer.triggerName)), 'PUBLICATION_TIMERS_ALREADY_EXIST');
    for (const name of plan.triggerNames) check(!(await getTimer(name)), 'PUBLICATION_TIMERS_ALREADY_EXIST');
    report.permissionProbe = { name: plan.triggerNames[0], outcome: 'REQUESTED', confirmedAbsent: true, provesExistingDeletion: false };
    spend('activeHttp'); spend('permissionProbes'); // Not a configuration read or an actual timer deletion.
    try {
      await io.command(['fc', 'DELETE', triggerPath(plan.triggerNames[0])]);
      report.permissionProbe.outcome = 'UNCONFIRMED'; save();
      check(false, 'PUBLICATION_DELETE_PERMISSION_NOT_CONFIRMED');
    } catch (error) {
      report.permissionProbe.outcome = error.safeCode === 'TRIGGER_NOT_FOUND' ? 'TRIGGER_NOT_FOUND' : 'UNCONFIRMED';
      report.permissionProbe.diagnostic = error.safeCode ?? 'CLOUD_REQUEST_UNCONFIRMED'; save();
      check(error.safeCode === 'TRIGGER_NOT_FOUND', 'PUBLICATION_DELETE_PERMISSION_NOT_CONFIRMED');
    }
  };
  const validateRecords = () => {
    check(Number.isSafeInteger(report.timerPreparedAt) && report.timerRecords.length === 4 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.releaseId ?? ''), 'PUBLICATION_TIMER_CHECKPOINT_REQUIRED');
    const expected = publicationPilotTimers({ plan, target: { controlName: plan.controlName }, releaseId: plan.releaseId,
      secret: plan.schedulerSecret, now: report.timerPreparedAt, deadline: Math.min(plan.deadline, Date.parse(report.activated.V2_PUBLIC_PUBLICATION_EXPIRES_AT)) });
    expected.forEach((entry, index) => {
      const saved = report.timerRecords[index];
      check(saved.name === entry.name && isDeepStrictEqual(saved.body, entry.body) && saved.bodyHash === timerHash(entry.body) &&
        ['PREPARED', 'CREATE_REQUESTED', 'CREATED', 'DELETE_REQUESTED', 'DELETED', 'ABSENT'].includes(saved.state), 'PUBLICATION_TIMER_OWNERSHIP_MISMATCH');
    });
  };
  const cleanupTimers = async () => {
    validateRecords();
    // Validate every extant candidate before deleting any timer; never touch an
    // unrelated trigger or retry an uncertain DeleteTrigger invocation.
    const current = [];
    for (const record of report.timerRecords) {
      const actual = await getTimer(record.name);
      if (actual) assertPilotTimer(actual, record);
      current.push(actual);
    }
    for (const [index, record] of report.timerRecords.entries()) {
      if (!current[index]) { record.state = 'ABSENT'; save(); continue; }
      check(['CREATE_REQUESTED', 'CREATED'].includes(record.state), 'PUBLICATION_TIMER_DELETE_ALREADY_ATTEMPTED');
      record.state = 'DELETE_REQUESTED'; save();
      try { await call('triggerDeletes', ['fc', 'DELETE', triggerPath(record.name)]); }
      catch (error) { record.deleteResponseUnknown = true; record.deleteDiagnostic = error.safeCode ?? 'DELETE_UNCONFIRMED'; save(); }
      const remains = await getTimer(record.name);
      if (remains) { assertPilotTimer(remains, record); check(false, 'PUBLICATION_TIMER_DELETE_UNCONFIRMED'); }
      record.state = 'DELETED'; save();
    }
    report.timersCleaned = true; save();
  };
  save(); assertBaseline();
  try {
    if (!['stage', 'resume-stage'].includes(plan.mode)) {
      check(plan.stagedDigest === functionDigest(stagedSnapshot()), 'PUBLICATION_STAGED_SNAPSHOT_REQUIRED');
      report.staged = stagedSnapshot();
      if (!serviceOnly) check(usage.permissionProbes === 1 && plan.permissionProbe?.name === plan.triggerNames[0] &&
        plan.permissionProbe.outcome === 'TRIGGER_NOT_FOUND' && plan.permissionProbe.confirmedAbsent === true && plan.permissionProbe.provesExistingDeletion === false,
      'PUBLICATION_DELETE_PERMISSION_NOT_CONFIRMED');
    }
    if (['stage', 'resume-stage'].includes(plan.mode)) {
      const resume = plan.mode === 'resume-stage', checkpoint = plan.stageCheckpoint;
      check(plan.priorUsage.configWrites === 0 && plan.priorUsage.triggerCreates === 0 &&
        (resume ? plan.priorUsage.objectPuts === 1 && plan.priorUsage.permissionProbes === 1 &&
          checkpoint?.phase === 'STARTED' && checkpoint.failure === 'UPDATE_NOT_SUCCESSFUL' && checkpoint.configWrites === 0 &&
          checkpoint.objectPuts === 1 && checkpoint.permissionProbes === 1 && checkpoint.updateResponseUnknown !== true &&
          /^\d+$/.test(checkpoint.runId ?? '') && /^[a-f0-9]{64}$/.test(checkpoint.reportDigest ?? '') &&
          plan.permissionProbe?.outcome === 'TRIGGER_NOT_FOUND' && plan.permissionProbe.confirmedAbsent === true &&
          /^\d+$/.test(plan.candidate.crc64 ?? '') : preStaged ? plan.priorUsage.objectPuts === plan.preStagedObject.putAttempts : plan.priorUsage.objectPuts === 0), 'PUBLICATION_STAGE_ALREADY_ATTEMPTED');
      check(same(before, report.baseline), 'PILOT_BASELINE_CHANGED');
      check(plan.bucketPrivacy?.bucketHash === sha(before.environmentVariables.OSS_BUCKET) && plan.bucketPrivacy.aclPrivate === true && plan.bucketPrivacy.policyNotPublic === true && plan.bucketPrivacy.publicAccessBlocked === true &&
        Date.parse(plan.bucketPrivacy.checkedAt) <= now() && now() - Date.parse(plan.bucketPrivacy.checkedAt) < 3600000, 'PRIVATE_BUCKET_REQUIRED');
      if (!resume && !serviceOnly) await probeMissingTimerDeletion(); // Service consumption carries no trigger authority.
      await bill();
      for (const suffix of ['/concurrency', '/scaling-config']) {
        const value = await call('configReads', ['fc', 'GET', path + suffix, ...(suffix === '/scaling-config' ? ['--qualifier', 'LATEST'] : [])]);
        check(suffix === '/concurrency' ? value.reservedConcurrency === 1 : value.minInstances === 0, 'EXISTING_CAPACITY_MISMATCH');
      }
      if (preStaged) {
        report.previous = await verifyObject(plan.previous); report.candidate = await verifyObject(plan.candidate);
      } else if (resume) {
        report.previous = plan.previous; report.candidate = await verifyObject(plan.candidate);
      } else {
        const bytes = await io.readCandidate(); check(bytes.length === plan.candidate.bytes && sha(bytes) === plan.candidate.sha256, 'CANDIDATE_NOT_FROZEN');
        report.previous = await verifyObject(plan.previous); report.candidate = await verifyObject(plan.candidate, bytes);
      }
      save();
      await settle(report.baseline);
      report.phase = 'STAGE_REQUESTED'; save();
      try { await put({ code: packageBody(report.candidate) }); } catch { report.updateResponseUnknown = true; save(); }
      report.staged = await settle(stagedSnapshot()); await runtime(false); report.phase = 'STAGED';
    } else if (plan.mode === 'activate') {
      check(plan.phase === 'STAGED' && same(before, stagedSnapshot()), 'PUBLICATION_STAGED_SNAPSHOT_REQUIRED');
      await bill();
      report.activated = (serviceOnly ? serviceConsumptionPilotEnvironment : publicationPilotEnvironment)(report.baseline, plan, now());
      await settle(stagedSnapshot());
      report.phase = 'ACTIVATION_REQUESTED'; save();
      try { await put({ environmentVariables: report.activated }); } catch { report.updateResponseUnknown = true; save(); }
      await settle(openedSnapshot()); await runtime(true); report.phase = 'OPENED';
    } else if (plan.mode === 'timers') {
      check(['OPENED', 'TIMERS_PREPARED', 'TIMERS_REQUESTED'].includes(plan.phase), 'PUBLICATION_OPEN_CHECKPOINT_REQUIRED');
      assertOpened(before); await bill();
      const listed = await listTimers();
      if (!report.timerRecords.length) {
        check(usage.triggerCreates === 0 && !listed.some(t => plan.triggerNames.includes(t.triggerName)), 'PUBLICATION_TIMERS_ALREADY_EXIST');
        report.timerPreparedAt = now();
        report.timerRecords = publicationPilotTimers({ plan, target: { controlName: plan.controlName }, releaseId: plan.releaseId,
          secret: plan.schedulerSecret, now: report.timerPreparedAt, deadline: Math.min(plan.deadline, Date.parse(report.activated.V2_PUBLIC_PUBLICATION_EXPIRES_AT)) })
          .map(entry => ({ ...entry, bodyHash: timerHash(entry.body), state: 'PREPARED' }));
        report.phase = 'TIMERS_PREPARED'; save();
      }
      validateRecords(); assertOpened(await read());
      for (const record of report.timerRecords) {
        const existing = await getTimer(record.name);
        if (existing) { check(record.state !== 'PREPARED', 'PUBLICATION_TIMERS_ALREADY_EXIST'); assertPilotTimer(existing, record); record.state = 'CREATED'; save(); continue; }
        check(record.state === 'PREPARED', 'PUBLICATION_TIMER_CREATE_UNCONFIRMED');
        check(now() < Date.parse(record.triggerTime) - 10000, 'PUBLICATION_TIMER_START_TOO_CLOSE');
        record.state = 'CREATE_REQUESTED'; report.phase = 'TIMERS_REQUESTED'; save();
        try { await call('triggerCreates', ['fc', 'POST', `${path}/triggers`], record.body); }
        catch (error) { record.createResponseUnknown = true; record.createDiagnostic = error.safeCode ?? 'CREATE_UNCONFIRMED'; save(); }
        const actual = await getTimer(record.name); check(actual, 'PUBLICATION_TIMER_CREATE_UNCONFIRMED'); assertPilotTimer(actual, record);
        record.state = 'CREATED'; save();
      }
      report.phase = 'TIMERS_CREATED';
    } else if (plan.mode === 'cleanup-timers') {
      if (!same(before, stagedSnapshot())) assertOpened(before);
      await cleanupTimers(); report.phase = 'TIMERS_CLEANED';
    } else {
      const staged = stagedSnapshot();
      const restoredAfterUnknown = serviceOnly && plan.phase === 'RESTORE_REQUESTED' &&
        same(before, plan.mode === 'rollback' ? report.baseline : staged);
      if (serviceOnly && plan.phase === 'RESTORE_REQUESTED') check(restoredAfterUnknown, 'SERVICE_RESTORE_ALREADY_ATTEMPTED');
      check(restoredAfterUnknown || same(before, staged) || (report.activated && same(before, openedSnapshot())), 'PILOT_FOREIGN_CONFIGURATION');
      if (serviceOnly) {
        if (!restoredAfterUnknown && !same(before, staged)) assertOpened(before);
      } else {
        if (report.timerRecords.length) await cleanupTimers();
        else check(usage.triggerCreates === 0, 'PUBLICATION_TIMER_CHECKPOINT_REQUIRED');
        const listed = await listTimers(); check(!listed.some(t => plan.triggerNames.includes(t.triggerName)), 'PUBLICATION_TIMERS_NOT_CLEANED');
      }
      if (plan.mode === 'rollback') await verifyObject(plan.previous);
      report.phase = 'RESTORE_REQUESTED'; save();
      if (!restoredAfterUnknown && (plan.mode === 'rollback' || !same(before, staged))) {
        try { await put({ environmentVariables: report.baseline.environmentVariables, ...(plan.mode === 'rollback' ? { code: packageBody(plan.previous) } : {}) }); }
        catch { report.restoreResponseUnknown = true; save(); }
      } else { report.readOnlyAlreadyRestored = true; save(); }
      await settle(plan.mode === 'rollback' ? report.baseline : staged); await runtime(false);
      if (!serviceOnly) {
        check(!(await listTimers()).some(timer => plan.triggerNames.includes(timer.triggerName)), 'PUBLICATION_TIMERS_NOT_CLEANED');
        report.timersAbsenceVerified = true;
      }
      report.phase = plan.mode === 'rollback' ? 'ROLLED_BACK' : 'CLOSED_READONLY';
    }
    save(); return report;
  } catch (error) {
    report.failure = error.safeCode ?? 'PUBLICATION_OPERATION_UNCONFIRMED'; save();
    cleanupReading = true; // Reserve 24 reads for cloud recovery and 12 for owner cleanup.
    // Preparation failures do not mutate the function. Once an activation or
    // timer write has begun, restore only a matching snapshot, never foreign state.
    if (plan.mode === 'timers' && report.timerRecords.length) {
      try { await cleanupTimers(); } catch (cleanup) { report.timerCleanupFailure = cleanup.safeCode ?? 'TIMER_CLEANUP_UNCONFIRMED'; save(); }
    }
    const staging = ['stage', 'resume-stage'].includes(plan.mode);
    if ((staging && report.phase === 'STAGE_REQUESTED') || (plan.mode === 'activate' && report.phase === 'ACTIVATION_REQUESTED') || plan.mode === 'timers') {
      try {
        let current = await read(); const restore = staging ? report.baseline : stagedSnapshot();
        report.rollbackTarget = staging ? 'ORIGINAL_READONLY' : 'STAGED_READONLY';
        if (!stableFunction(current)) {
          const pendingTarget = staging ? stagedSnapshot() : openedSnapshot();
          current = await settle(pendingTarget); // Never call a pending old snapshot a completed rollback.
        }
        if (same(current, restore) && stableFunction(current)) report.rollback = 'ALREADY_BASELINE';
        else {
          check(same(current, staging ? stagedSnapshot() : openedSnapshot()), 'PILOT_FOREIGN_CONFIGURATION');
          report.rollbackRequested = true; save();
          try { await put({ environmentVariables: restore.environmentVariables, ...(staging ? { code: packageBody(plan.previous) } : {}) }); }
          catch { report.rollbackResponseUnknown = true; save(); }
          await settle(restore); report.rollback = 'VERIFIED';
        }
      } catch (rollback) { report.rollbackFailure = rollback.safeCode ?? 'ROLLBACK_UNCONFIRMED'; }
      save();
    }
    throw error;
  }
}

// A sealed plan can authenticate yet fail its execution guards (for example,
// the job started after expiry). Preserve the two bootstrap reads, not a false
// accepted-plan checkpoint. Never erase a counter after any subsequent IO.
export function markUnacceptedPilotFailure(report) {
  const zero = ['configWrites', 'objectGets', 'objectPuts', 'activeHttp', 'triggerCreates', 'triggerDeletes', 'permissionProbes', 'modelCalls', 'sparkRuns'];
  if (report.cumulativeUsage !== undefined || typeof report.failure !== 'string' ||
      !['identityReads', 'configReads'].every(key => Number.isSafeInteger(report[key]) && report[key] >= 0 && report[key] <= 1) ||
      !zero.every(key => report[key] === 0)) return false;
  report.scope = 'UNVERIFIED'; report.planVerified = false; report.phase = 'PRE_PLAN_FAILED';
  return true;
}

async function main(env = process.env) {
  const config = auditConfig(env), recipient = recipientKey(env.V2_AUDIT_RECIPIENT_KEY), dir = mkdtempSync(join(tmpdir(), 'shuduo-dev-pilot-'));
  const report = { scope: 'UNVERIFIED', phase: 'STARTED', planVerified: false, mode: env.V2_PILOT_MODE,
    identityReads: 0, configReads: 0, configWrites: 0, objectGets: 0, objectPuts: 0, activeHttp: 0,
    triggerCreates: 0, triggerDeletes: 0, permissionProbes: 0, modelCalls: 0, sparkRuns: 0 };
  const save = () => writeFileSync('v2-development-pilot.sealed.json', JSON.stringify(sealReport(report, recipient, { protocol: 'shuduo-development-pilot/v1', sourceRevision: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID })) + '\n', { mode: 0o600 });
  const command = args => { try { return JSON.parse(execFileSync('aliyun', [...args, '--region', config.region, '--connect-timeout', '8', '--read-timeout', '40', '--retry-count', '0'], { encoding: 'utf8', timeout: 50000, maxBuffer: 2097152, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ALIBABA_CLOUD_IGNORE_PROFILE: 'TRUE', ALIBABA_CLOUD_PROFILE_MODE: 'StsToken' } })); }
    catch (e) {
      report.diagnostic = auditErrorDetails(e);
      const missingTimer = args[0] === 'fc' && ['GET', 'DELETE'].includes(args[1]) && /^\/2023-03-30\/functions\/[^/]+\/triggers\/shuduo-release-pilot-20261027-[1-4]$/.test(args[2] ?? '') && report.diagnostic.serviceCode === 'TriggerNotFound';
      throw Object.assign(new Error(missingTimer ? 'TRIGGER_NOT_FOUND' : 'CLOUD_REQUEST_UNCONFIRMED'), { safeCode: missingTimer ? 'TRIGGER_NOT_FOUND' : 'CLOUD_REQUEST_UNCONFIRMED' });
    } };
  const path = `/2023-03-30/functions/${config.functionName}`;
  const read = () => { report.configReads++; save(); return command(['fc', 'GET', path]); };
  const put = body => { const file = join(dir, 'update.json'); writeFileSync(file, JSON.stringify(body), { mode: 0o600 }); report.configWrites++; save(); return command(['fc', 'PUT', path, '--body-file', file]); };
  const settle = async expected => { for (let n = 0; n < 8; n++) { const f = read(); check(same(f, expected), 'UPDATE_NOT_RECONCILED'); if ((!f.state || f.state === 'Active') && (!f.lastUpdateStatus || f.lastUpdateStatus === 'Successful')) return f; check(n < 7, 'UPDATE_PENDING'); await new Promise(r => setTimeout(r, 3000)); } };
  let plan, baseline, activated, candidate;
  try {
    check(env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1', 'PROTECTED_SINGLE_RUN_REQUIRED');
    report.identityReads++; save();
    const id = command(['sts', 'GetCallerIdentity']);
    check(String(id.AccountId) === config.account && String(id.Arn).startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`), 'IDENTITY_MISMATCH');
    const before = read(); report.initial = before;
    plan = openReadinessProof(env.V2_PILOT_PLAN, before.environmentVariables?.V2_SPARK_EXECUTOR_SECRET);
    const preStaged = validatePilotPackageTransport(plan, env.V2_PILOT_PRE_STAGED ?? 'false');
    check(['INVITED_DEVELOPMENT_PILOT_V1', publicationScope, serviceConsumptionScope].includes(plan.scope) && plan.controlName === config.functionName && plan.operatorSource === env.GITHUB_SHA && plan.mode === env.V2_PILOT_MODE &&
      (plan.scope === publicationScope ? publicationModes : plan.scope === serviceConsumptionScope ? serviceConsumptionModes : ['deploy', 'close', 'rollback']).includes(plan.mode), 'PLAN_IDENTITY_MISMATCH');
    check(plan.issuedAt <= Date.now() && plan.deadline > Date.now() && plan.deadline - plan.issuedAt <= 3600000, 'PLAN_EXPIRED');
    report.scope = plan.scope; report.planVerified = true; save();
    const credentials = { accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN };
    const bucket = before.environmentVariables.OSS_BUCKET;
    if ([publicationScope, serviceConsumptionScope].includes(plan.scope)) {
      await runPublicationPilotOperation(plan, before, report, {
        save,
        command: (args, body) => {
          if (body === undefined) return command(args);
          const file = join(dir, 'publication-request.json'); writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
          return command([...args, '--body-file', file]);
        },
        readCandidate: () => {
          check(!preStaged, 'PILOT_PRESTAGED_CANDIDATE_READ_FORBIDDEN');
          check(env.V2_PILOT_BUILD_RUN === plan.buildRunId && env.V2_PILOT_ARTIFACT_ID === plan.artifactId, 'ARTIFACT_BINDING_INVALID');
          return readFileSync('.candidate/v2-function.zip');
        },
        object: (pkg, method, bytes, query) => {
          if (preStaged) check(method === 'GET' && bytes === undefined, 'PILOT_PRESTAGED_OBJECT_PUT_FORBIDDEN');
          const request = privateOssRequest({ bucket, region: config.region, credentials, key: controlPackageObject(pkg.sha256), method, body: bytes, query });
          return fetch(request.url, { ...request.options, signal: AbortSignal.timeout(method === 'PUT' ? 300000 : 120000) });
        },
        http: async endpoint => {
          check(['/api/v2/auth/session', '/api/v2/status'].includes(endpoint), 'PUBLICATION_HTTP_SCOPE_INVALID');
          const response = await fetch('https://shuduoai.cn' + endpoint, { redirect: 'error', signal: AbortSignal.timeout(30000) });
          check(/json/i.test(response.headers.get('content-type') ?? ''), 'PUBLICATION_HTTP_RESPONSE_INVALID');
          return { status: response.status, body: await response.json() };
        },
      });
      console.log(JSON.stringify({ phase: report.phase, ok: true, encryptedEvidence: true, modelCalls: 0, sparkRuns: 0 }));
      return;
    }
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
    markUnacceptedPilotFailure(report);
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
