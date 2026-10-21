import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditConfig, recipientKey, sealReport } from './audit-v2-oidc-readonly.mjs';
import { verifyV2MonthlyBillPages } from './verify-v2-monthly-bill-pages.mjs';

const fail = code => Object.assign(new Error(code), { safeCode:code });
const requireThat = (condition,code) => { if (!condition) throw fail(code); };
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v=>JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])) : value ?? null);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const functionFields = ['codeChecksum','codeSize','environmentVariables','runtime','handler','role','timeout','cpu','memorySize','diskSize','instanceConcurrency','internetAccess','vpcConfig','customRuntimeConfig','layers','nasConfig','ossMountConfig','logConfig'];
const functionHash = value => digest(Object.fromEntries(functionFields.map(k=>[k,value[k] ?? null])));
const triggerHash = list => digest([...list].sort((a,b)=>a.triggerName.localeCompare(b.triggerName)));
export const triggerConfiguration = Object.freeze({authType:'function',methods:['GET','POST'],disableURLInternet:false});
const description = 'Temporary signed read-only boundary acceptance; remove after this run';
const targetHash = config => digest([config.account,config.region,config.functionName]);
const verifyIdentity = (config,identity) => requireThat(String(identity.AccountId)===config.account && String(identity.Arn ?? '').startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`),'IDENTITY_MISMATCH');
export function acceptanceConfig(env) {
  requireThat(env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_ACTIONS === 'true','MAIN_ACTIONS_ONLY');
  requireThat(/^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? '') && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''),'RUN_IDENTITY_INVALID');
  requireThat(env.V2_ACCEPTANCE_SOURCE_REVISION===env.GITHUB_SHA,'REVIEWED_SOURCE_MISMATCH');
  requireThat(/^\d{1,30}$/.test(env.V2_EXPECTED_CODE_CHECKSUM ?? ''),'EXPECTED_CODE_REQUIRED');
  requireThat(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(env.V2_HTTP_AUTHORIZATION_EXPIRES_AT ?? '') && Number.isFinite(Date.parse(env.V2_HTTP_AUTHORIZATION_EXPIRES_AT)),'AUTHORIZATION_EXPIRY_REQUIRED');
  requireThat(env.V2_HTTP_ACCEPTANCE_AUTHORIZED === 'ONE_TEMPORARY_SIGNED_TRIGGER_MAX_20_READS','EXPLICIT_ACCEPTANCE_SCOPE_REQUIRED');
  return {...auditConfig(env),expectedChecksum:env.V2_EXPECTED_CODE_CHECKSUM,triggerName:`shuduo-http-boundary-${env.GITHUB_RUN_ID}`,authorizationExpiresAt:Date.parse(env.V2_HTTP_AUTHORIZATION_EXPIRES_AT)};
}
export const boundaryCases = Object.freeze([
  {id:'unsigned',method:'GET',path:'/api/v2/status',signed:false},
  {id:'signed-baseline',method:'GET',path:'/api/v2/status'},
  {id:'invoke-path',method:'POST',path:'/invoke'},
  {id:'forged-event',method:'POST',path:'/invoke',headers:[['x-fc-control-path','/invoke']]},
  {id:'mixed-case',method:'POST',path:'/invoke',headers:[['X-Fc-Control-Path','/invoke']]},
  {id:'duplicate-control',method:'POST',path:'/invoke',headers:[['x-fc-control-path','/invoke'],['x-fc-control-path','/http-invoke']]},
  {id:'conflicting-markers',method:'POST',path:'/invoke',headers:[['x-fc-control-path','/invoke'],['x-fc-request-type','InvokeFunction']]},
  {id:'forwarded-host',method:'POST',path:'/invoke',headers:[['x-forwarded-host','localhost'],['x-fc-control-path','/invoke']]},
  {id:'guessed-hop',method:'POST',path:'/invoke',headers:[['x-shuduo-process-hop','0'.repeat(64)]]},
  {id:'encoded-path',method:'POST',path:'/%69nvoke'},
  {id:'dot-path',method:'POST',path:'/./invoke'},
  {id:'double-slash',method:'POST',path:'//invoke'},
  {id:'query-path',method:'POST',path:'/invoke?operation=PRIVATE_STATUS_V1'},
  {id:'internal-scheduler',method:'POST',path:'/api/v2/internal/scheduler/tick'},
]);
const checkedList = async (adapter, config) => {
  const result=await adapter.fc('GET','/triggers');
  requireThat(Array.isArray(result?.triggers) && !result.nextToken && result.triggers.length<=3,'TRIGGER_LIST_UNCONFIRMED');
  requireThat(new Set(result.triggers.map(t=>t.triggerName)).size===result.triggers.length,'DUPLICATE_TRIGGER_RECORD');
  return result.triggers;
};
const ownsTrigger = (trigger,config) => {
  let parsed;try { parsed=typeof trigger.triggerConfig==='string'?JSON.parse(trigger.triggerConfig):trigger.triggerConfig; } catch {return false;}
  return trigger.triggerName===config.triggerName && trigger.triggerType==='http' && trigger.qualifier==='LATEST' && trigger.description===description && Object.entries(triggerConfiguration).every(([k,v])=>canonical(parsed?.[k])===canonical(v));
};
export async function cleanupAcceptance(config, adapter, checkpoint) {
  requireThat(checkpoint.targetHash===targetHash(config) && checkpoint.triggerName===config.triggerName,'CLEANUP_TARGET_MISMATCH');
  const list=await checkedList(adapter,config), found=list.find(t=>t.triggerName===config.triggerName);
  if (found) {
    requireThat(ownsTrigger(found,config),'CLEANUP_TRIGGER_DRIFT');
    try { await adapter.fc('DELETE',`/triggers/${config.triggerName}`); } catch { /* Unknown delete outcome must be read, never blindly retried. */ }
  }
  const remaining=await checkedList(adapter,config);
  requireThat(!remaining.some(t=>t.triggerName===config.triggerName),'CLEANUP_NOT_CONFIRMED');
  requireThat(triggerHash(remaining)===checkpoint.originalTriggersHash,'ORIGINAL_TRIGGERS_CHANGED');
  requireThat(functionHash(await adapter.fc('GET',''))===checkpoint.functionHash,'FUNCTION_CHANGED');
  return {triggerAbsent:true,originalTriggersUnchanged:true,functionUnchanged:true};
}
export async function runHttpAcceptance(config,adapter,{now=Date.now,save=()=>{},load=()=>undefined}={}) {
  let checkpoint=load();
  const report={scope:'SIGNED_HTTP_BOUNDARY_ONLY',passed:false,requests:0,results:[],modelCalls:0,sparkRuns:0,publicApplicationEnabled:false,cleanup:{triggerAbsent:false}};
  try {
    const identity=await adapter.identity();
    verifyIdentity(config,identity);
    if (checkpoint) { report.recoveryOnly=true;report.cleanup=await cleanupAcceptance(config,adapter,checkpoint);return report; }
    requireThat(config.authorizationExpiresAt-now()>=600000,'AUTHORIZATION_WINDOW_TOO_SHORT');
    const before=await adapter.fc('GET',''), env=before.environmentVariables ?? {};
    requireThat(before.functionName===config.functionName && String(before.codeChecksum)===config.expectedChecksum,'FUNCTION_CODE_DRIFT');
    requireThat(env.V2_FC_PUBLIC_HTTP_ENABLED!=='true' && env.V2_PROVISIONING_ONLY==='true' && env.V2_PRIVATE_SMOKE_ENABLED==='true','PRIVATE_GATE_DRIFT');
    requireThat(before.cpu===0.25 && before.memorySize===512 && before.instanceConcurrency===1 && before.timeout<=120,'CAPACITY_DRIFT');
    const original=await checkedList(adapter,config);
    requireThat(original.length===2 && original.every(t=>t.triggerType==='oss'),'ORIGINAL_TRIGGER_BOUNDARY_CHANGED');
    const cycle=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date(now()));
    const bill=verifyV2MonthlyBillPages(await adapter.billPages(cycle),199);
    requireThat(bill.ok && bill.billingCycle===cycle,'BUDGET_NOT_VERIFIED');
    report.billingCycle=cycle;report.billCnyBefore=bill.spendCny;report.reservedCny=1;
    requireThat(config.authorizationExpiresAt-now()>=600000,'AUTHORIZATION_WINDOW_TOO_SHORT');
    report.requests++;
    const baseline=await adapter.privateStatus();
    requireThat(baseline?.ingress?.mode==='FC_CONTROL_PATH' && baseline.ingress.publicHttpEnabled===false,'PRIVATE_CONTROL_BASELINE_FAILED');
    requireThat(config.authorizationExpiresAt-now()>=600000,'AUTHORIZATION_WINDOW_TOO_SHORT');
    checkpoint={targetHash:targetHash(config),triggerName:config.triggerName,functionHash:functionHash(before),originalTriggersHash:triggerHash(original),startedAt:now(),requests:report.requests};
    save(checkpoint); // Must be durable before the first resource mutation.
    await adapter.fc('POST','/triggers',{triggerName:config.triggerName,triggerType:'http',qualifier:'LATEST',description,triggerConfig:JSON.stringify(triggerConfiguration)});
    const created=(await checkedList(adapter,config)).find(t=>t.triggerName===config.triggerName);
    requireThat(created && ownsTrigger(created,config),'CREATED_TRIGGER_UNCONFIRMED');
    const endpoint=new URL(created.httpTrigger?.urlInternet ?? '');
    requireThat(endpoint.protocol==='https:' && endpoint.hostname.endsWith(`.${config.region}.fcapp.run`) && !endpoint.username && !endpoint.password && !endpoint.port && endpoint.pathname==='/' && !endpoint.search && !endpoint.hash,'TRIGGER_ENDPOINT_INVALID');
    for (const probe of boundaryCases) {
      requireThat(report.requests<20 && now()-checkpoint.startedAt<600000 && now()<config.authorizationExpiresAt-300000,'ACCEPTANCE_LIMIT_REACHED');
      checkpoint.requests=++report.requests; save(checkpoint);
      const value=await adapter.probe(endpoint.origin,probe);
      const result={id:probe.id,status:value.status,code:typeof value.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(value.code)?value.code:'UNCONFIRMED',responseHash:value.responseHash,bytes:value.bytes};
      report.results.push(result);
      requireThat(value.privateProtocol!==true,'PRIVATE_OPERATION_EXPOSED');
      requireThat(probe.signed===false ? [401,403].includes(value.status) : value.status===404 && value.code==='INGRESS_DENIED','HTTP_BOUNDARY_NOT_VERIFIED');
    }
    report.passed=true;
  } catch(e) { report.failure=e.safeCode ?? 'ACCEPTANCE_UNCONFIRMED'; }
  finally {
    if (checkpoint && !report.recoveryOnly) {
      try { report.cleanup=await cleanupAcceptance(config,adapter,checkpoint); }
      catch(e) { report.cleanup={triggerAbsent:false,code:e.safeCode ?? 'CLEANUP_UNCONFIRMED'};report.passed=false; }
    }
  }
  return report;
}

const directory='.runtime/http-boundary-acceptance';
const checkpointPath=`${directory}/checkpoint.json`, reportPath=`${directory}/report.json`;
function adapterFor(config,env) {
  const call=(args,body) => {
    try {
      const out=execFileSync('aliyun',[...args,'--region',config.region,'--connect-timeout','5','--read-timeout','40','--retry-count','0',...(body===undefined?[]:['--body-file','/dev/stdin'])],{
        input:body===undefined?undefined:JSON.stringify(body),encoding:'utf8',timeout:50000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe'],
        env:{...env,ALIBABA_CLOUD_IGNORE_PROFILE:'TRUE',ALIBABA_CLOUD_PROFILE_MODE:'StsToken'},
      });
      let value=JSON.parse(out||'{}');if(typeof value==='string')value=JSON.parse(value);return value;
    } catch {throw fail('CLOUD_REQUEST_UNCONFIRMED');}
  };
  const base=`/2023-03-30/functions/${config.functionName}`;
  return {
    identity:()=>call(['sts','GetCallerIdentity']),
    fc:(method,suffix,body)=>call(['fc',method,base+suffix],body),
    privateStatus:()=>call(['fc','POST',base+'/invocations','--header','Content-Type=application/octet-stream'],{operation:'PRIVATE_STATUS_V1'}),
    billPages:cycle=>{
      const pages=[];for(let n=1;n<=10;n++){
        const page=call(['bssopenapi','QueryBill','--BillingCycle',cycle,'--PageNum',String(n),'--PageSize','300']);pages.push(page);
        requireThat(page?.Success===true && Number.isSafeInteger(Number(page?.Data?.TotalCount)),'BILL_READ_UNCONFIRMED');
        if(n*300>=Number(page.Data.TotalCount))return pages;
      }throw fail('BILL_PAGE_LIMIT');
    },
    probe:(url,probe)=>{
      try {return JSON.parse(execFileSync('python3',['scripts/probe-v2-http-boundary.py'],{input:JSON.stringify({url,probe}),encoding:'utf8',timeout:45000,maxBuffer:256*1024,stdio:['pipe','pipe','pipe'],env}));}
      catch {throw fail('HTTP_PROBE_UNCONFIRMED');}
    },
  };
}
export async function acceptanceMain(env=process.env,mode=process.argv[2]) {
  const config=acceptanceConfig(env),key=recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const write=(path,value)=>writeFileSync(path,JSON.stringify(value)+'\n',{mode:0o600});
  const load=()=>existsSync(checkpointPath)?JSON.parse(readFileSync(checkpointPath,'utf8')):undefined;
  if(mode==='--seal') {
    const report=existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')):{passed:false,failure:'EXECUTION_REPORT_MISSING'};
    write('v2-http-acceptance.sealed.json',sealReport({...report,checkpoint:load()},key,{protocol:'shuduo-http-acceptance/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}));return;
  }
  requireThat(env.ALIBABA_CLOUD_ACCESS_KEY_ID && env.ALIBABA_CLOUD_ACCESS_KEY_SECRET && env.ALIBABA_CLOUD_SECURITY_TOKEN,'OIDC_STS_REQUIRED');
  const adapter=adapterFor(config,env);
  if(mode==='--cleanup') {
    if(!load())return;
    const report=existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')):{passed:false,failure:'EXECUTION_INTERRUPTED'};
    try {verifyIdentity(config,await adapter.identity());report.cleanup=await cleanupAcceptance(config,adapter,load());}
    catch(e){report.cleanup={triggerAbsent:false,code:e.safeCode ?? 'CLEANUP_UNCONFIRMED'};report.passed=false;}
    write(reportPath,report);requireThat(report.cleanup.triggerAbsent,'CLEANUP_NOT_CONFIRMED');return;
  }
  requireThat(mode===undefined,'UNSUPPORTED_MODE');
  const report=await runHttpAcceptance(config,adapter,{load,save:cp=>write(checkpointPath,cp)});
  write(reportPath,report);
  requireThat(report.passed && report.cleanup.triggerAbsent,'ACCEPTANCE_NOT_PASSED');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {await acceptanceMain();process.stdout.write('Bounded acceptance step finished; details retained for encrypted export.\n');}
  catch(e){process.stderr.write((e.safeCode ?? 'ACCEPTANCE_UNCONFIRMED')+'\n');process.exitCode=1;}
}
