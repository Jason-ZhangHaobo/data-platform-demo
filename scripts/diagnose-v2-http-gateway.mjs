import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acceptanceConfig,adapterFor,checkedList,ownsTrigger,cleanupAcceptance,functionHash,triggerHash,triggerConfiguration} from './accept-v2-http-boundary.mjs';
import {recipientKey,sealReport} from './audit-v2-oidc-readonly.mjs';
import {verifyV2MonthlyBillPages} from './verify-v2-monthly-bill-pages.mjs';
const fail=c=>Object.assign(new Error(c),{safeCode:c});
const check=(v,c)=>{if(!v)throw fail(c);};
export const diagnosticProbes=Object.freeze([
 {id:'signed-baseline',method:'GET',path:'/api/v2/status'},
 {id:'unsigned-modern',method:'GET',path:'/api/v2/status',signed:false},
 {id:'unsigned-plain',method:'GET',path:'/api/v2/status',signed:false,timestampMode:'omit'},
]);
export function diagnosticConfig(env,now=Date.now()){
 check(env.V2_HTTP_DIAGNOSTIC_AUTHORIZED==='THREE_READONLY_GATEWAY_PROBES','DIAGNOSTIC_APPROVAL_REQUIRED');
 let target;try{target=JSON.parse(env.V2_HTTP_DIAGNOSTIC_TARGET);}catch{throw fail('DIAGNOSTIC_TARGET_INVALID');}
 check(target.priorRequests===8&&/^\d{1,20}$/.test(target.restoreRunId??''),'DIAGNOSTIC_HISTORY_INVALID');
 const start=Date.parse(target.authorizedAt),end=Date.parse(target.expiresAt);
 check(Number.isFinite(start)&&start<=now&&end-start>0&&end-start<=1800000,'DIAGNOSTIC_WINDOW_INVALID');
 const cloudEnv={...env,ALIBABA_CLOUD_REGION_ID:target.region,V2_DEPLOY_ROLE_ARN:target.roleArn,V2_DEPLOY_OIDC_PROVIDER_ARN:target.providerArn,V2_FUNCTION_NAME:target.functionName,
  V2_EXPECTED_CODE_CHECKSUM:target.expectedChecksum,V2_ACCEPTANCE_SOURCE_REVISION:env.V2_DIAGNOSTIC_SOURCE_SHA,
  V2_HTTP_ACCEPTANCE_AUTHORIZED:'ONE_TEMPORARY_SIGNED_TRIGGER_MAX_20_READS',V2_HTTP_AUTHORIZATION_EXPIRES_AT:target.expiresAt,
  V2_HTTP_PREVIOUS_READS:'8',V2_HTTP_RESTORE_RUN_ID:target.restoreRunId,V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE'};
 const config=acceptanceConfig(cloudEnv);
 check(target.sourceRevision===env.GITHUB_SHA,'DIAGNOSTIC_SOURCE_MISMATCH');
 return{config,cloudEnv,roleArn:target.roleArn,providerArn:target.providerArn};
}
export async function runGatewayDiagnostic(config,adapter,{now=Date.now,load,save}){
 let checkpoint=load();const report={scope:'HTTP_GATEWAY_DIAGNOSTIC_ONLY',diagnosisCollected:false,boundaryAccepted:false,priorRequests:8,requests:8,newRequests:0,results:[],modelCalls:0,sparkRuns:0,cleanup:{triggerAbsent:false}};
 try{
  check(config.previousReads===8,'DIAGNOSTIC_COUNTER_INVALID');
  const identity=await adapter.identity();check(String(identity.AccountId)===config.account&&String(identity.Arn??'').startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`),'IDENTITY_MISMATCH');
  if(checkpoint){report.recoveryOnly=true;report.requests=checkpoint.requests;report.cleanup=await cleanupAcceptance(config,adapter,checkpoint);return report;}
  check(config.authorizationExpiresAt-now()>=300000,'DIAGNOSTIC_WINDOW_TOO_SHORT');
  const f=await adapter.fc('GET',''),e=f.environmentVariables??{},original=await checkedList(adapter,config);
  check(f.functionName===config.functionName&&String(f.codeChecksum)===config.expectedChecksum&&f.cpu===0.25&&f.memorySize===512&&f.instanceConcurrency===1&&f.timeout<=120,'FUNCTION_BASELINE_DRIFT');
  check(e.V2_FC_PUBLIC_HTTP_ENABLED!=='true'&&e.V2_PRIVATE_SMOKE_ENABLED==='true'&&e.V2_PROVISIONING_ONLY==='true','PRIVATE_GATE_DRIFT');
  check(original.length===2&&original.every(t=>t.triggerType==='oss'),'TRIGGER_BASELINE_DRIFT');
  const cycle=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date(now()));
  const bill=verifyV2MonthlyBillPages(await adapter.billPages(cycle),199);check(bill.ok&&bill.billingCycle===cycle,'BUDGET_NOT_VERIFIED');report.billCnyBefore=bill.spendCny;
  check(config.authorizationExpiresAt-now()>=300000,'DIAGNOSTIC_WINDOW_TOO_SHORT');
  checkpoint={targetHash:createHash('sha256').update(JSON.stringify([config.account,config.region,config.functionName])).digest('hex'),triggerName:config.triggerName,functionHash:functionHash(f),originalTriggersHash:triggerHash(original),requests:8};save(checkpoint);
  await adapter.fc('POST','/triggers',{triggerName:config.triggerName,triggerType:'http',qualifier:'LATEST',description:'Temporary signed read-only boundary acceptance; remove after this run',triggerConfig:JSON.stringify(triggerConfiguration)});
  const created=(await checkedList(adapter,config)).find(t=>ownsTrigger(t,config));check(created,'TRIGGER_CREATE_UNCONFIRMED');
  const endpoint=new URL(created.httpTrigger?.urlInternet??'');check(endpoint.protocol==='https:'&&endpoint.hostname.endsWith(`.${config.region}.fcapp.run`)&&!endpoint.username&&!endpoint.password&&!endpoint.port&&endpoint.pathname==='/'&&!endpoint.search&&!endpoint.hash,'ENDPOINT_INVALID');
  for(const probe of diagnosticProbes){
   check(report.newRequests<3&&config.authorizationExpiresAt-now()>=180000,'DIAGNOSTIC_LIMIT');checkpoint.requests=++report.requests;report.newRequests++;save(checkpoint);
   const result=await adapter.diagnose(endpoint.origin,probe);
   check(Number.isInteger(result.status)&&result.status>=100&&result.status<=599&&/^[a-f0-9]{64}$/.test(result.responseHash??''),'DIAGNOSTIC_RESPONSE_INVALID');
   const detail=result.gatewayDiagnostic;
   report.results.push({id:probe.id,status:result.status,code:/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(result.code??'')?result.code:'UNCONFIRMED',responseHash:result.responseHash,bytes:result.bytes,
    ...(detail&&typeof detail.message==='string'&&detail.message.length<=512?{gatewayDiagnostic:{message:detail.message,truncated:detail.truncated===true,requestIdHash:/^[a-f0-9]{64}$/.test(detail.requestIdHash??'')?detail.requestIdHash:null}}:{})});
   check(result.privateProtocol!==true,'PRIVATE_PROTOCOL_EXPOSED');
   if(probe.id==='signed-baseline')check(result.status===404&&result.code==='INGRESS_DENIED','SIGNED_BASELINE_UNCONFIRMED');
  }
  report.diagnosisCollected=true;
 }catch(error){report.failure=error.safeCode??'DIAGNOSTIC_UNCONFIRMED';}
 finally{if(checkpoint&&!report.recoveryOnly){try{report.cleanup=await cleanupAcceptance(config,adapter,checkpoint);}catch(error){report.cleanup={triggerAbsent:false,code:error.safeCode??'CLEANUP_UNCONFIRMED'};report.diagnosisCollected=false;}}}
 return report;
}
const directory='.runtime/http-gateway-diagnostic';
export async function diagnosticMain(env=process.env,mode=process.argv[2]){
 const {config,cloudEnv,roleArn,providerArn}=diagnosticConfig(env),key=recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
 if(mode==='--prepare'){
  check(env.GITHUB_ENV,'GITHUB_ENV_REQUIRED');for(const value of [config.account,config.role,config.functionName,roleArn,providerArn])process.stdout.write(`::add-mask::${value}\n`);
  appendFileSync(env.GITHUB_ENV,`V2_DIAGNOSTIC_ROLE_ARN=${roleArn}\nV2_DIAGNOSTIC_PROVIDER_ARN=${providerArn}\n`);return;
 }
 mkdirSync(directory,{recursive:true,mode:0o700});
 const read=name=>existsSync(`${directory}/${name}.json`)?JSON.parse(readFileSync(`${directory}/${name}.json`,'utf8')):undefined;
 const write=(name,value)=>writeFileSync(`${directory}/${name}.json`,JSON.stringify(value)+'\n',{mode:0o600});
 if(mode==='--seal'){
  writeFileSync('v2-http-diagnostic.sealed.json',JSON.stringify(sealReport({...read('report'),checkpoint:read('checkpoint')},key,{protocol:'shuduo-http-diagnostic/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}))+'\n',{mode:0o600});return;
 }
 check(env.ALIBABA_CLOUD_ACCESS_KEY_ID&&env.ALIBABA_CLOUD_ACCESS_KEY_SECRET&&env.ALIBABA_CLOUD_SECURITY_TOKEN,'OIDC_STS_REQUIRED');
 const adapter=adapterFor(config,cloudEnv);
 if(mode==='--cleanup'){
  if(!read('checkpoint'))return;
  const report=read('report')??{diagnosisCollected:false,boundaryAccepted:false};
  try{report.cleanup=await cleanupAcceptance(config,adapter,read('checkpoint'));}catch(error){report.cleanup={triggerAbsent:false,code:error.safeCode??'CLEANUP_UNCONFIRMED'};report.diagnosisCollected=false;}
  write('report',report);check(report.cleanup.triggerAbsent,'CLEANUP_UNCONFIRMED');return;
 }
 check(mode===undefined&&!read('report'),'DIAGNOSTIC_ALREADY_EXECUTED');
 adapter.diagnose=(url,probe)=>{try{return JSON.parse(execFileSync('python3',['scripts/probe-v2-http-boundary.py'],{input:JSON.stringify({url,probe,diagnosticAuthorization:'THREE_READONLY_GATEWAY_PROBES'}),env:cloudEnv,encoding:'utf8',timeout:45000,maxBuffer:65536,stdio:['pipe','pipe','pipe']}));}catch{throw fail('DIAGNOSTIC_PROBE_UNCONFIRMED');}};
 const report=await runGatewayDiagnostic(config,adapter,{load:()=>read('checkpoint'),save:value=>write('checkpoint',value)});write('report',report);
 check(report.diagnosisCollected&&report.cleanup.triggerAbsent,'DIAGNOSTIC_NOT_COMPLETED');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await diagnosticMain();process.stdout.write('Bounded diagnostic step finished; details retained for encrypted export.\n');}catch(error){process.stderr.write((error.safeCode??'DIAGNOSTIC_UNCONFIRMED')+'\n');process.exitCode=1;}
}
