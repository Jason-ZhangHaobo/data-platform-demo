import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAliyunErrorCode } from './extract-aliyun-error-code.mjs';

const fail = code => Object.assign(new Error(code), { safeCode: code });
export function auditConfig(env) {
  const role = /^acs:ram::(\d{12,20}):role\/([a-z0-9-]{1,64})$/.exec(env.V2_DEPLOY_ROLE_ARN ?? '');
  const provider = /^acs:ram::(\d{12,20}):oidc-provider\/[A-Za-z0-9_-]{1,64}$/.exec(env.V2_DEPLOY_OIDC_PROVIDER_ARN ?? '');
  if (!role || !provider || provider[1] !== role[1] || !/^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(env.V2_FUNCTION_NAME ?? '') || env.ALIBABA_CLOUD_REGION_ID !== 'cn-hangzhou')
    throw fail('AUDIT_CONFIG_INVALID');
  return { account: role[1], role: role[2], functionName: env.V2_FUNCTION_NAME, region: env.ALIBABA_CLOUD_REGION_ID };
}
export function recipientKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 1500 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fail('AUDIT_RECIPIENT_INVALID');
  let key;
  try { key = createPublicKey({ key: Buffer.from(encoded, 'base64'), type: 'spki', format: 'der' }); } catch { throw fail('AUDIT_RECIPIENT_INVALID'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw fail('AUDIT_RECIPIENT_INVALID');
  return key;
}
export function auditErrorDetails(error) {
  const texts = [String(error?.stdout ?? ''), String(error?.stderr ?? '')];
  let serviceCode = extractAliyunErrorCode(...texts);
  // Some CLI releases wrap errors in an envelope. Inspect code fields only;
  // never retain messages, suggestions, requests, headers or raw responses.
  for (const text of texts) {
    if (serviceCode !== 'UNKNOWN_ALIYUN_ERROR') break;
    try {
      const queue = [{ value: JSON.parse(text), depth: 0 }];
      for (let i = 0; i < queue.length && i < 12; i++) {
        const { value, depth } = queue[i];
        if (!value || typeof value !== 'object') continue;
        const code = [value.Code, value.code, value.ErrorCode, value.error_code].find(v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,127}$/.test(v));
        if (code) { serviceCode = code; break; }
        if (depth < 2) for (const name of ['error','Error','data','Data','response'])
          if (value[name] && typeof value[name] === 'object') queue.push({value:value[name],depth:depth+1});
      }
    } catch {}
  }
  const text = texts.join('\n');
  const cliArgumentRejected = /unknown flag|flag provided but not defined|unrecognized option|unknown command/i.test(text);
  const networkTimeoutObserved = /\b(?:i\/o timeout|timed out|context deadline exceeded|timeout awaiting|(?:read|request|connect(?:ion)?) timeout)\b/i.test(text);
  const transport = cliArgumentRejected ? 'CLI_ARGUMENT'
    : networkTimeoutObserved ? 'TIMEOUT'
    : /no such host|name resolution|connection reset|connection refused|TLS handshake|unexpected EOF/i.test(text) ? 'NETWORK'
    : 'UNCLASSIFIED';
  return { serviceCode, transport, cliArgumentRejected, networkTimeoutObserved, exitStatus: Number.isInteger(error?.status) ? error.status : null };
}
export function classifyAuditError(error) {
  if (['TRIGGER_PAGE_INCOMPLETE', 'TRIGGER_RESPONSE_UNCONFIRMED', 'WRONG_FUNCTION'].includes(error?.safeCode)) return error.safeCode;
  const text = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  const detail = auditErrorDetails(error);
  if (/missing parameter SecurityToken/i.test(text)) return 'MISSING_SECURITY_TOKEN';
  if (/AccessDenied|Forbidden|not authorized|PermissionDenied|没有权限|无权限/i.test(text) || /NoPermission|NoPrivilege|Unauthorized|NotAuthorized|OperationDenied|InsufficientPermission/i.test(detail.serviceCode)) return 'ACCESS_DENIED';
  if (/Expired|InvalidSecurityToken/i.test(text)) return 'CREDENTIAL_UNAVAILABLE';
  if (/FunctionNotFound|ResourceNotFound/i.test(text)) return 'RESOURCE_NOT_FOUND';
  if (error?.signal || error?.code === 'ETIMEDOUT') return 'BOUNDED_TIMEOUT';
  if (detail.transport === 'TIMEOUT') return 'BOUNDED_TIMEOUT';
  if (detail.transport === 'NETWORK') return 'TRANSPORT_UNAVAILABLE';
  if (detail.transport === 'CLI_ARGUMENT') return 'CLI_ARGUMENT_REJECTED';
  return 'READ_UNCONFIRMED';
}
export function runReadAudit(config, call) {
  const report = { scope: 'READ_ONLY_NO_INVOCATION', identity: 'NOT_CHECKED', function: { state: 'NOT_CHECKED' }, triggers: { state: 'NOT_CHECKED' }, cloudWrites: 0, modelCalls: 0, sparkRuns: 0, writePermissionsVerified: false };
  let identity;
  try { identity = call(['sts', 'GetCallerIdentity']); } catch (e) { report.identity = classifyAuditError(e); return report; }
  if (String(identity.AccountId) !== config.account || !String(identity.Arn ?? '').startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`)) {
    report.identity = 'IDENTITY_MISMATCH'; return report;
  }
  report.identity = 'VERIFIED';
  const path = `/2023-03-30/functions/${config.functionName}`;
  try {
    const f = call(['fc', 'GET', path]);
    if (f.functionName !== config.functionName) throw fail('WRONG_FUNCTION');
    const env = f.environmentVariables ?? {};
    report.function = { state: 'VERIFIED', codeChecksum: String(f.codeChecksum ?? ''), codeSize: f.codeSize,
      runtime: f.runtime, cpu: f.cpu, memorySize: f.memorySize, concurrency: f.instanceConcurrency,
      publicHttpEnabled: env.V2_FC_PUBLIC_HTTP_ENABLED === 'true', privateSmokeEnabled: env.V2_PRIVATE_SMOKE_ENABLED === 'true',
      driverMode: ['DISABLED', 'PRIVATE_TICK', 'OSS_EVENTS'].includes(env.V2_AGENT_DRIVER_MODE) ? env.V2_AGENT_DRIVER_MODE : 'UNCONFIRMED',
      credentialsPresent: { mysql: Boolean(env.V2_MYSQL_PASSWORD), model: Boolean(env.DASHSCOPE_API_KEY), worker: Boolean(env.V2_SPARK_EXECUTOR_SECRET) } };
  } catch (e) { report.function = { state: classifyAuditError(e) }; return report; }
  let triggerShape;
  try {
    const items = [], seenTokens = new Set(), seenNames = new Set();
    let nextToken;
    for (let page = 0; page < 3; page++) {
      const result = call(['fc', 'GET', path + '/triggers' + (nextToken ? '?nextToken=' + encodeURIComponent(nextToken) : '')]);
      triggerShape = { object: Boolean(result && typeof result === 'object'), array: Array.isArray(result),
        hasTriggerArray: Array.isArray(result?.triggers), hasNextToken: Boolean(result?.nextToken),
        hasErrorCode: Boolean(result?.Code || result?.code || result?.ErrorCode),
        triggerCount: Array.isArray(result?.triggers) ? result.triggers.length : null };
      if (triggerShape.hasErrorCode) throw new Error(String(result.Code ?? result.code ?? result.ErrorCode));
      if (!Array.isArray(result?.triggers) || items.length + result.triggers.length > 20) throw fail('TRIGGER_RESPONSE_UNCONFIRMED');
      for (const t of result.triggers) {
        if (!t || typeof t.triggerName !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(t.triggerName)) throw fail('TRIGGER_RESPONSE_UNCONFIRMED');
        if (seenNames.has(t.triggerName)) throw fail('TRIGGER_PAGE_INCOMPLETE');
        seenNames.add(t.triggerName); items.push(t);
      }
      nextToken = result.nextToken;
      if (!nextToken) break;
      if (typeof nextToken !== 'string' || nextToken.length > 1024 || seenTokens.has(nextToken) || page === 2) throw fail('TRIGGER_PAGE_INCOMPLETE');
      seenTokens.add(nextToken);
    }
    report.triggers = { state: 'VERIFIED', items: items.map(t => ({
      nameHash: createHash('sha256').update(t.triggerName).digest('hex'),
      type: ['oss', 'http', 'timer'].includes(t.triggerType) ? t.triggerType : 'OTHER',
    })) };
  } catch (e) { report.triggers = { state: classifyAuditError(e), ...(triggerShape ? { responseShape: triggerShape } : { commandFailed: true, ...auditErrorDetails(e) }) }; }
  return report;
}
export function sealReport(report, key, provenance) {
  const aes = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', aes, iv);
  const aad = JSON.stringify({ protocol: 'shuduo-read-audit/v1', ...provenance });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(report), 'utf8'), cipher.final()]);
  const wrappedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aes);
  aes.fill(0);
  return { aad, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), wrappedKey: wrappedKey.toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function auditReadDeadline(args) {
  return args[0] === 'fc' && args[1] === 'GET' && /\/triggers(?:\?|$)/.test(args[2] ?? '')
    ? { readSeconds: 40, processMs: 50000 }
    : { readSeconds: 12, processMs: 25000 };
}
export function auditMain(env = process.env) {
  // Validate before obtaining a cloud response. No model/database secrets needed.
  const config = auditConfig(env), key = recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
  if (!env.ALIBABA_CLOUD_ACCESS_KEY_ID || !env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || !env.ALIBABA_CLOUD_SECURITY_TOKEN) throw fail('OIDC_STS_REQUIRED');
  const call = args => {
    const deadline = auditReadDeadline(args);
    return JSON.parse(execFileSync('aliyun', [...args, '--region', config.region, '--connect-timeout', '5', '--read-timeout', String(deadline.readSeconds), '--retry-count', '0'], {
      encoding: 'utf8', timeout: deadline.processMs, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, ALIBABA_CLOUD_IGNORE_PROFILE: 'TRUE', ALIBABA_CLOUD_PROFILE_MODE: 'StsToken' },
    }));
  };
  const report = { ...runReadAudit(config, call), checkedAt: new Date().toISOString() };
  const sealed = sealReport(report, key, { sourceRevision: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID });
  writeFileSync('v2-readonly-audit.sealed.json', JSON.stringify(sealed) + '\n', { mode: 0o600 });
  process.stdout.write('Encrypted read audit saved; no invocation or mutation performed.\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { auditMain(); } catch (e) { process.stderr.write((e.safeCode ?? 'AUDIT_UNCONFIRMED') + '\n'); process.exitCode = 1; }
}
