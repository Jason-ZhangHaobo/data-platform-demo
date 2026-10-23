import {execFileSync} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveCname} from 'node:dns/promises';
import {acceptanceConfig,adapterFor,runHttpAcceptance,cleanupAcceptance,functionHash,checkedList,ownsTrigger} from './accept-v2-http-boundary.mjs';
import {recipientKey,sealReport} from './audit-v2-oidc-readonly.mjs';
import {DOMAIN_BINDING_AUTHORIZATION,verifyCertificateMaterial,domainBindingPlan,runDomainBinding,rollbackDomainBinding} from './v2-domain-binding-plan.mjs';

const fail=code=>Object.assign(new Error(code),{safeCode:code});
const check=(value,code)=>{if(!value)throw fail(code);};
const dir='.runtime/https-binding-acceptance';
const read=name=>existsSync(`${dir}/${name}.json`)?JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8')):undefined;
const save=(name,value)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value)+'\n',{mode:0o600});
export const domainProbes=Object.freeze([
 {id:'unsigned',method:'GET',path:'/api/v2/status',signed:false},
 {id:'signed-baseline',method:'GET',path:'/api/v2/status'},
 {id:'forged-event',method:'POST',path:'/api/v2/status',headers:[['x-fc-control-path','/invoke']]},
 {id:'duplicate-control',method:'POST',path:'/api/v2/status',headers:[['x-fc-control-path','/invoke'],['X-Fc-Control-Path','/http-invoke']]},
 {id:'guessed-hop',method:'GET',path:'/api/v2/status',headers:[['x-shuduo-process-hop','0'.repeat(64)]]},
 {id:'internal-scheduler',method:'POST',path:'/api/v2/internal/scheduler/tick'},
 {id:'root-closed',method:'GET',path:'/'},
 {id:'unmapped-invoke',method:'POST',path:'/invoke',unmapped:true},
]);
export function domainProbeAccepted(value,probe,leafSha256){
 if(value?.privateProtocol===true||value?.certificateSha256!==leafSha256||!['TLSv1.2','TLSv1.3'].includes(value?.tlsVersion))return false;
 if(probe.signed===false)return [401,403].includes(value.status)||(value.status===400&&value.code==='MissingRequiredHeader'&&value.authenticationRejected===true);
 if(probe.unmapped)return value.status===404&&value.code==='DomainRouteNotFound';
 return value.status===404&&value.code==='INGRESS_DENIED';
}
export function httpsConfig(env,now=Date.now()){
 check(env.GITHUB_ACTIONS==='true'&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_SHA===env.V2_HTTPS_SOURCE_SHA&&env.V2_HTTPS_AUTHORIZATION===DOMAIN_BINDING_AUTHORIZATION,'HTTPS_SCOPE_NOT_AUTHORIZED');
 let input;try{input=JSON.parse(env.V2_HTTPS_BINDING_INPUT);}catch{throw fail('HTTPS_INPUT_INVALID');}
 check(input.sourceRevision===env.GITHUB_SHA&&input.domainName==='shuduoai.cn'&&[3,5].includes(input.priorRequests)&&/^\d{1,20}$/.test(input.restoreRunId??''),'HTTPS_TARGET_MISMATCH');
 const start=Date.parse(input.authorizedAt),end=Date.parse(input.expiresAt);
 check(Number.isFinite(start)&&start<=now&&end-start>0&&end-start<=3600000,'HTTPS_PERMISSION_WINDOW_INVALID');
 const material={certificate:input.certificate,privateKey:input.privateKey};
 const plan=domainBindingPlan({...input,authorization:DOMAIN_BINDING_AUTHORIZATION,certificate:verifyCertificateMaterial(material,now)},start);
 const cloudEnv={...env,ALIBABA_CLOUD_REGION_ID:input.region,V2_DEPLOY_ROLE_ARN:input.roleArn,V2_DEPLOY_OIDC_PROVIDER_ARN:input.providerArn,V2_FUNCTION_NAME:input.functionName,
  V2_EXPECTED_CODE_CHECKSUM:input.expectedChecksum,V2_ACCEPTANCE_SOURCE_REVISION:input.sourceRevision,V2_HTTP_ACCEPTANCE_AUTHORIZED:'ONE_TEMPORARY_SIGNED_TRIGGER_MAX_20_READS',
  V2_HTTP_AUTHORIZATION_EXPIRES_AT:input.expiresAt,V2_HTTP_PREVIOUS_READS:String(input.priorRequests),V2_HTTP_RESTORE_RUN_ID:input.restoreRunId,V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE'};
 const config={...acceptanceConfig(cloudEnv),domainBindingAuthorization:DOMAIN_BINDING_AUTHORIZATION};
 return{plan,material,config,cloudEnv,roleArn:input.roleArn,providerArn:input.providerArn};
}
function transport(env,operation,body){
 try{return JSON.parse(execFileSync('python3',['scripts/transport-v2-domain-signed.py'],{input:JSON.stringify({authorization:DOMAIN_BINDING_AUTHORIZATION,domainName:'shuduoai.cn',operation,body}),env,encoding:'utf8',timeout:30000,maxBuffer:1048576,stdio:['pipe','pipe','pipe']}));}
 catch{throw fail('DOMAIN_TRANSPORT_UNCONFIRMED');}
}
async function waitExactDns(plan){
 for(let attempt=0;attempt<24;attempt++){
  check(Date.now()<Date.parse(plan.expiresAt)-300000,'HTTPS_WINDOW_EXPIRED');
  try{const values=await resolveCname(plan.target.domainName);check(values.length===1&&values[0].replace(/\.$/,'').toLowerCase()===plan.dns.value,'DNS_TARGET_CONFLICT');return true;}
  catch(error){if(!['ENOTFOUND','ENODATA','EAI_AGAIN','ETIMEOUT','ESERVFAIL'].includes(error.code))throw error;}
  await new Promise(r=>setTimeout(r,10000));
 }
 throw fail('DNS_HANDOFF_NOT_OBSERVED');
}

export async function httpsBindingMain(env=process.env,mode=process.argv[2]){
 const {plan,material,config,cloudEnv,roleArn,providerArn}=httpsConfig(env),key=recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
 if(mode==='--prepare'){
  check(env.GITHUB_ENV,'GITHUB_ENV_REQUIRED');
  for(const value of [plan.target.account,plan.target.role,plan.target.functionName,roleArn,providerArn])process.stdout.write(`::add-mask::${value}\n`);
  appendFileSync(env.GITHUB_ENV,`V2_HTTPS_ROLE_ARN=${roleArn}\nV2_HTTPS_PROVIDER_ARN=${providerArn}\n`);return;
 }
 mkdirSync(dir,{recursive:true,mode:0o700});
 if(mode==='--seal'||mode==='--handoff'){
  const report={scope:'SIGNED_HTTPS_DOMAIN_BINDING',operationId:plan.operationId,targetHash:plan.desiredHash,domain:read('domain'),boundary:read('boundary'),httpCheckpoint:read('http-checkpoint'),domainCheckpoint:read('domain-checkpoint'),cleanup:read('cleanup')};
  if(mode==='--handoff')check(report.boundary?.passed===true&&report.boundary.cleanup?.deferredForSameDomainBatch===true&&report.boundary.priorRequests===config.previousReads&&report.httpCheckpoint?.requests===config.previousReads+15&&report.httpCheckpoint.requests<=20,'BOUNDARY_HANDOFF_NOT_READY');
  report.passed=report.domain?.passed===true&&report.boundary?.passed===true&&report.cleanup?.triggerAbsent===true&&report.cleanup.functionUnchanged===true&&report.cleanup.originalTriggersUnchanged===true&&!report.cleanup?.domainRollbackFailure;
  writeFileSync(mode==='--handoff'?'v2-https-handoff.sealed.json':'v2-https-binding.sealed.json',JSON.stringify(sealReport(report,key,{protocol:'shuduo-https-binding/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}))+'\n',{mode:0o600});return;
 }
 check(cloudEnv.ALIBABA_CLOUD_ACCESS_KEY_ID&&cloudEnv.ALIBABA_CLOUD_ACCESS_KEY_SECRET&&cloudEnv.ALIBABA_CLOUD_SECURITY_TOKEN,'OIDC_STS_REQUIRED');
 const http=adapterFor(config,cloudEnv),domain={get:()=>transport(cloudEnv,'get'),create:body=>transport(cloudEnv,'create',body),delete:()=>transport(cloudEnv,'delete')};
 if(mode==='--boundary'){
  check(!read('boundary'),'BOUNDARY_ALREADY_EXECUTED');
  const result=await runHttpAcceptance(config,http,{load:()=>read('http-checkpoint'),save:cp=>save('http-checkpoint',cp),deferForDomain:true});
  save('boundary',result);check(result.passed&&result.cleanup?.deferredForSameDomainBatch,'DEFAULT_BOUNDARY_NOT_VERIFIED');return;
 }
 if(mode==='--bind'){
  check(!read('domain'),'DOMAIN_ALREADY_EXECUTED');
  check(read('boundary')?.passed===true&&read('boundary').cleanup?.deferredForSameDomainBatch===true,'DEFAULT_BOUNDARY_NOT_VERIFIED');
  try{
   await waitExactDns(plan);
   const identity=await http.identity();check(String(identity.AccountId)===plan.target.account&&String(identity.Arn??'').startsWith(`acs:ram::${plan.target.account}:assumed-role/${plan.target.role}/`),'IDENTITY_MISMATCH');
   let count=read('probe-count')?.requests??0;
   const probes=[];
   Object.assign(domain,{
    preflight:async()=>{
     const f=await http.fc('GET',''),items=await checkedList(http,config),cp=read('http-checkpoint');
     return{defaultBoundaryVerified:read('boundary')?.passed===true,publicApplicationEnabled:f.environmentVariables?.V2_FC_PUBLIC_HTTP_ENABLED==='true',sameSignedTriggerPresent:items.some(t=>ownsTrigger(t,config)),functionUnchanged:functionHash(f)===cp?.functionHash,budgetVerified:read('boundary')?.reservedCny===1,dnsExact:await waitExactDns(plan)};
    },
    verifyDomain:async limit=>{
     for(const probe of domainProbes){
      check(count<limit&&Date.now()<Date.parse(plan.expiresAt)-300000,'DOMAIN_PROBE_LIMIT');
      save('probe-count',{requests:++count});
      let value;try{value=JSON.parse(execFileSync('python3',['scripts/probe-v2-http-boundary.py'],{input:JSON.stringify({url:'https://shuduoai.cn',domainAuthorization:DOMAIN_BINDING_AUTHORIZATION,probe}),env:cloudEnv,encoding:'utf8',timeout:45000,maxBuffer:65536,stdio:['pipe','pipe','pipe']}));}catch{throw fail('DOMAIN_PROBE_UNCONFIRMED');}
      probes.push({id:probe.id,status:value.status,code:value.code,tlsVersion:value.tlsVersion,certificateMatched:value.certificateSha256===plan.desired.certificateSha256,accepted:domainProbeAccepted(value,probe,plan.desired.certificateSha256)});save('probes',probes);
      check(probes.at(-1).accepted,'DOMAIN_BOUNDARY_NOT_VERIFIED');
     }
     return{tlsVerified:true,boundaryVerified:true,privateOperationExposed:false,requests:count};
    },
   });
   const result=await runDomainBinding(plan,material,domain,{load:()=>read('domain-checkpoint'),save:cp=>save('domain-checkpoint',cp)});
   save('domain',{...result,probes});check(result.passed,'DOMAIN_BINDING_NOT_VERIFIED');
  }catch(error){if(!read('domain'))save('domain',{passed:false,failure:error.safeCode??'DOMAIN_BINDING_UNCONFIRMED'});throw error;}
  return;
 }
 if(mode==='--cleanup'){
  const cleanup={triggerAbsent:!read('http-checkpoint')};
  try{if(read('http-checkpoint'))Object.assign(cleanup,await cleanupAcceptance(config,http,read('http-checkpoint')));}
  catch(error){cleanup.triggerAbsent=false;cleanup.failure=error.safeCode??'HTTP_CLEANUP_UNCONFIRMED';}
  if(read('domain-checkpoint')&&(!read('domain')?.passed||!cleanup.triggerAbsent)){
   try{cleanup.domainRollback=await rollbackDomainBinding(plan,domain,read('domain-checkpoint'),{save:cp=>save('domain-checkpoint',cp)});}
   catch(error){cleanup.domainRollbackFailure=error.safeCode??'DOMAIN_ROLLBACK_UNCONFIRMED';}
  }
  save('cleanup',cleanup);check(cleanup.triggerAbsent&&!cleanup.domainRollbackFailure,'HTTPS_CLEANUP_UNCONFIRMED');return;
 }
 throw fail('HTTPS_MODE_INVALID');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await httpsBindingMain();process.stdout.write('Bounded HTTPS stage finished; private evidence retained for encryption.\n');}
 catch(error){process.stderr.write((error.safeCode??'HTTPS_OPERATION_UNCONFIRMED')+'\n');process.exitCode=1;}
}
