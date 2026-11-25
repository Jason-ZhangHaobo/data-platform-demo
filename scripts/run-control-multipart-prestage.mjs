import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { auditConfig, recipientKey, sealReport } from './audit-v2-oidc-readonly.mjs';
import { functionDigest, openReadinessProof } from './refresh-v2-spark-readiness.mjs';
import { controlPackageObject } from './render-v2-control-package-policy.mjs';
import { buildControlMultipartManifest, transferControlMultipart, cleanupControlMultipart } from './control-multipart-transfer.mjs';

const scope = 'CONTROL_CODE_MULTIPART_PRESTAGE_V1';
const cleanupScope = 'CONTROL_CODE_MULTIPART_CLEANUP_V1';
const hash = value => createHash('sha256').update(value).digest('hex');
const sha256 = /^[a-f0-9]{64}$/, revision = /^[a-f0-9]{40}$/, runId = /^[1-9]\d{5,19}$/;
const partBytes = 4 * 1024 * 1024;
function check(valid, code) {
  if (!valid) throw Object.assign(Error(code), {safeCode: code});
}

export function validateRunner(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1' &&
    revision.test(env.GITHUB_SHA) && runId.test(env.GITHUB_RUN_ID), 'PROTECTED_SINGLE_DISPATCH_REQUIRED');
  check(runId.test(env.V2_MULTIPART_BUILD_RUN) && runId.test(env.V2_MULTIPART_ARTIFACT_ID) &&
    ['true','false'].includes(env.V2_MULTIPART_CLEANUP_ONLY ?? 'false') &&
    typeof env.V2_MULTIPART_PLAN === 'string' && env.V2_MULTIPART_PLAN.length <= 30000 &&
    /^[A-Za-z0-9+/]+=*$/.test(env.V2_MULTIPART_PLAN), 'FROZEN_ARTIFACT_INPUT_REQUIRED');
  recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
  return auditConfig(env);
}

export function validateTransferPlan(plan, env, config, current, now) {
  const cleaning = env.V2_MULTIPART_CLEANUP_ONLY === 'true';
  check(plan?.scope === (cleaning ? cleanupScope : scope) && /^[a-f0-9]{32}$/.test(plan.operationId) &&
    plan.operatorSource === env.GITHUB_SHA && revision.test(plan.applicationSource) &&
    plan.controlName === config.functionName && plan.buildRunId === env.V2_MULTIPART_BUILD_RUN &&
    plan.artifactId === env.V2_MULTIPART_ARTIFACT_ID && sha256.test(plan.approvalDigest) &&
    plan.recipientKeyDigest === hash(env.V2_AUDIT_RECIPIENT_KEY), 'MULTIPART_PLAN_BINDING_INVALID');
  check(Number.isSafeInteger(plan.issuedAt) && Number.isSafeInteger(plan.deadline) &&
    plan.issuedAt <= now && now + (cleaning ? 5000 : 120000) < plan.deadline && plan.deadline-plan.issuedAt <= 3600000,
    'MULTIPART_WINDOW_INVALID');
  const c = plan.candidate, p = plan.previous, vars = current.environmentVariables;
  check(sha256.test(c?.sha256) && sha256.test(p?.sha256) && c.sha256 !== p.sha256 &&
    Number.isSafeInteger(c.bytes) && Math.ceil(c.bytes / partBytes) === 12 && /^\d{1,20}$/.test(c.crc64) &&
    Number.isSafeInteger(p.bytes) && p.bytes > 0 && /^\d{1,20}$/.test(p.crc64), 'MULTIPART_PACKAGE_INVALID');
  check(plan.baselineDigest === functionDigest(current) && current.codeSize === p.bytes &&
    String(current.codeChecksum) === p.crc64 && (!current.state || current.state === 'Active') &&
    (!current.lastUpdateStatus || current.lastUpdateStatus === 'Successful') &&
    vars?.V2_FC_PUBLIC_READ_ONLY === 'true' && !vars.V2_FC_PUBLIC_WRITE_SCOPE &&
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(vars.OSS_BUCKET) &&
    plan.bucketHash === hash(vars.OSS_BUCKET), 'MULTIPART_READONLY_BASELINE_CHANGED');
  const pre = plan.preflight, at = Date.parse(pre?.checkedAt);
  check(Number.isFinite(at) && at <= plan.issuedAt && now-at < 3600000 &&
    pre.versioning === 'UNVERSIONED' && pre.candidateAbsent === true && pre.activeUploads === 0 &&
    pre.privacyVerified === true && Number.isFinite(pre.billCny) && pre.billCny >= 0 &&
    pre.retainedReserveCny === 90 && pre.maxIncrementCny === 2 && pre.monthlyLimitCny === 200 &&
    pre.billCny + pre.retainedReserveCny + pre.maxIncrementCny <= pre.monthlyLimitCny,
    'MULTIPART_OWNER_PREFLIGHT_INVALID');
  if (cleaning) {
    const started = Date.parse(plan.startedAt);
    check(plan.priorRunTerminal === true && runId.test(plan.priorRunId) && plan.priorRunId !== env.GITHUB_RUN_ID &&
      typeof plan.priorAbortAttempted === 'boolean' && /^[A-Za-z0-9_-]{8,160}$/.test(plan.uploadId) &&
      Number.isFinite(started) && started >= at && started <= now && plan.deadline-started <= 3600000,
      'MULTIPART_CLEANUP_PLAN_INVALID');
  }
}

export function signedTransferRequest({bucket, key, credentials}, {op, uploadId, part, body, signal}, date = new Date().toUTCString()) {
  check(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) &&
    /^data-platform-demo\/v2\/control-plane\/[a-f0-9]{64}\.zip$/.test(key), 'MULTIPART_TARGET_INVALID');
  check(credentials?.accessKeyId && credentials.accessKeySecret && credentials.securityToken, 'TEMPORARY_IDENTITY_REQUIRED');
  const methods = {init:'POST', part:'PUT', parts:'GET', complete:'POST', abort:'DELETE', get:'GET', acl:'GET'};
  check(Object.hasOwn(methods, op), 'MULTIPART_OPERATION_INVALID');
  if (['part','parts','complete','abort'].includes(op))
    check(/^[A-Za-z0-9_-]{8,160}$/.test(uploadId), 'MULTIPART_SESSION_INVALID');
  let query = '', type = '', md5 = '';
  const headers = {'x-oss-security-token': credentials.securityToken};
  switch(op) {
    case 'init':
      query = 'uploads'; type = 'application/zip'; break;
    case 'acl':
      query = 'acl'; break;
    case 'part':
      check(Number.isInteger(part) && part >= 1 && part <= 12 &&
        Buffer.isBuffer(body) && body.length > 0 && body.length <= partBytes, 'MULTIPART_PART_INVALID');
      query = 'partNumber='+part+'&uploadId='+uploadId;
      break;
    case 'complete':
      check(Buffer.isBuffer(body) && body.length > 0 && body.length <= 8192, 'MULTIPART_COMPLETION_INVALID');
      headers['x-oss-forbid-overwrite'] = 'true'; type = 'application/xml';
      query = 'uploadId='+uploadId; break;
    case 'abort': case 'parts':
      query = 'uploadId='+uploadId; break;
  }
  if (op === 'part' || op === 'complete') md5 = createHash('md5').update(body).digest('base64');
  else check(body === undefined, 'MULTIPART_BODY_INVALID');
  const path = '/'+key+(query?'?'+query:'');
  const canonical = Object.keys(headers).sort().map(k=>k+':'+headers[k]+'\n').join('');
  const message = [methods[op], md5, type, date, canonical+'/'+bucket+path].join('\n');
  headers.Authorization = 'OSS '+credentials.accessKeyId+':'+createHmac('sha1',credentials.accessKeySecret).update(message).digest('base64');
  headers.Date = date;
  if (type) headers['Content-Type'] = type;
  if (md5) headers['Content-MD5'] = md5;
  return {url:'https://'+bucket+'.oss-cn-hangzhou.aliyuncs.com'+path,
    options:{method:methods[op],headers,redirect:'error',signal,...(body ? {body} : {})}};
}

function run(env) {
  const config = validateRunner(env), recipient = recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
  const report = {phase:'STARTED',configWrites:0,modelCalls:0,sparkRuns:0};
  const save = () => {
    const envelope = sealReport(report,recipient,{protocol:'shuduo-control-multipart/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID});
    const path = 'v2-control-multipart.sealed.json';
    writeFileSync(path+'.tmp',JSON.stringify(envelope)+'\n',{mode:0o600}); renameSync(path+'.tmp',path);
  };
  function readCloud(args) {
    try {
      return JSON.parse(execFileSync('aliyun',[...args,'--region',config.region,'--connect-timeout','8','--read-timeout','30','--retry-count','0'],
        {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:40000,maxBuffer:2097152,
          env:{...env,ALIBABA_CLOUD_IGNORE_PROFILE:'TRUE',ALIBABA_CLOUD_PROFILE_MODE:'StsToken'}}));
    } catch { throw Object.assign(Error('CLOUD_READ_UNCONFIRMED'),{safeCode:'CLOUD_READ_UNCONFIRMED'}); }
  }
  return (async () => {
    save();
    try {
      const id = readCloud(['sts','GetCallerIdentity']);
      check(String(id.AccountId) === config.account && id.Arn?.startsWith('acs:ram::'+config.account+':assumed-role/'+config.role+'/'),
        'DEPLOYMENT_IDENTITY_MISMATCH');
      const current = readCloud(['fc','GET','/2023-03-30/functions/'+config.functionName]);
      const secret = current.environmentVariables?.V2_SPARK_EXECUTOR_SECRET;
      check(typeof secret==='string' && secret.length>=32, 'PLAN_SECRET_UNAVAILABLE');
      const plan = openReadinessProof(env.V2_MULTIPART_PLAN,secret);
      validateTransferPlan(plan,env,config,current,Date.now());
      report.operationId=plan.operationId; report.candidateSha256=plan.candidate.sha256;
      report.phase='PLAN_VERIFIED'; save();
      const bucket=current.environmentVariables.OSS_BUCKET,key=controlPackageObject(plan.candidate.sha256);
      const credentials={accessKeyId:env.ALIBABA_CLOUD_ACCESS_KEY_ID,accessKeySecret:env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,securityToken:env.ALIBABA_CLOUD_SECURITY_TOKEN};
      const request=args=>{const {url,options}=signedTransferRequest({bucket,key,credentials},args); return fetch(url,options);};
      if (plan.scope===cleanupScope) {
        const prior = JSON.parse(execFileSync('gh',['api','repos/'+env.GITHUB_REPOSITORY+'/actions/runs/'+plan.priorRunId],
          {encoding:'utf8',stdio:['ignore','pipe','pipe'],env,timeout:20000,maxBuffer:524288}));
        check(String(prior.id)===plan.priorRunId && prior.event==='workflow_dispatch' && prior.status==='completed' &&
          prior.head_sha===plan.operatorSource && prior.head_branch==='main' && prior.run_attempt===1 &&
          prior.path==='.github/workflows/prestage-v2-control-multipart.yml','ORIGINAL_MULTIPART_RUN_NOT_TERMINAL');
        await cleanupControlMultipart({bucket,key,uploadId:plan.uploadId,priorAbortAttempted:plan.priorAbortAttempted,
          deadline:plan.deadline,request,save:state=>{report.cleanup={...state,priorRunId:plan.priorRunId};save();}});
        report.phase='CLEANUP_CONFIRMED';
      } else {
        const path='.candidate/v2-function.zip', stat=lstatSync(path);
        check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1 && stat.size===plan.candidate.bytes, 'FROZEN_ZIP_INVALID');
        const bytes=readFileSync(path), manifest=buildControlMultipartManifest(bytes,plan.candidate.crc64);
        check(manifest.sha256===plan.candidate.sha256 && manifest.bytes===plan.candidate.bytes, 'FROZEN_ZIP_MISMATCH');
        report.receipt=await transferControlMultipart({bytes,manifest,bucket,key,deadline:plan.deadline,versioning:plan.preflight.versioning,
          request,save:state=>{report.transfer=state;save();}});
        report.phase='OBJECT_VERIFIED';
      }
      save();
      console.log(JSON.stringify({phase:report.phase,configWrites:0,modelCalls:0,sparkRuns:0}));
    } catch(error) {
      report.phase='FAILED';
      report.failure=/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.safeCode??'') ? error.safeCode : 'TRANSFER_UNCONFIRMED';
      save();console.log(JSON.stringify({phase:report.phase,failure:report.failure}));process.exitCode=1;
    }
  })();
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2]==='validate-inputs') {
      const config=validateRunner(process.env);
      for(const value of [config.account,config.role,config.functionName,process.env.V2_DEPLOY_ROLE_ARN,process.env.V2_DEPLOY_OIDC_PROVIDER_ARN,process.env.V2_MULTIPART_PLAN])
        console.log('::add-mask::'+value);
    } else if (process.argv[2]==='transfer') await run(process.env);
    else throw Error('UNKNOWN_MODE');
  } catch { console.error('Control package prestage input or evidence unavailable.');process.exitCode=1; }
}
