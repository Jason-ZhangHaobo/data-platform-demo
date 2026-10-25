import {execFileSync} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate,createHash} from 'node:crypto';
import {Resolver,resolveCname,resolveNs,resolve4} from 'node:dns/promises';
import {acceptanceConfig,adapterFor,runHttpAcceptance,cleanupAcceptance,functionHash,checkedList,ownsTrigger} from './accept-v2-http-boundary.mjs';
import {recipientKey,sealReport} from './audit-v2-oidc-readonly.mjs';
import {DOMAIN_BINDING_AUTHORIZATION,signedAccessLimits,verifyCertificateMaterial,domainBindingPlan,runDomainBinding,rollbackDomainBinding} from './v2-domain-binding-plan.mjs';

const fail=code=>Object.assign(new Error(code),{safeCode:code});
const check=(value,code)=>{if(!value)throw fail(code);};
const dir='.runtime/https-binding-acceptance';
const read=name=>existsSync(`${dir}/${name}.json`)?JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8')):undefined;
const save=(name,value)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value)+'\n',{mode:0o600});
export function domainReadbackShape(value,plan){
 const v=value?.value??{},expected=plan.desired,shape=x=>x===null?'null':Array.isArray(x)?{type:'array',length:x.length}:x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,y])=>[k,shape(y)])):typeof x;
 let certificateMatches=false;try{certificateMatches=createHash('sha256').update(new X509Certificate(v.certConfig?.certificate).raw).digest('hex')===expected.certificateSha256;}catch{}
 return{status:value?.status,code:value?.code,rootKeys:Object.keys(v),accountMatches:String(v.accountId)===plan.target.account,domainMatches:v.domainName===expected.domainName,protocol:['HTTP','HTTPS','HTTP,HTTPS'].includes(v.protocol)?v.protocol:'UNCONFIRMED',authType:['anonymous','function','jwt'].includes(v.authConfig?.authType)?v.authConfig.authType:'UNCONFIRMED',authInfoEmpty:[undefined,null,'','{}'].includes(v.authConfig?.authInfo),certNameMatches:v.certConfig?.certName===expected.certName,certificateMatches,
  tls:{minVersion:/^TLSv1\.[0-3]$/.test(v.tlsConfig?.minVersion??'')?v.tlsConfig.minVersion:'UNCONFIRMED',maxVersion:/^TLSv1\.[0-3]$/.test(v.tlsConfig?.maxVersion??'')?v.tlsConfig.maxVersion:'UNCONFIRMED',cipherSuites:Array.isArray(v.tlsConfig?.cipherSuites)?v.tlsConfig.cipherSuites.map(s=>/^TLS_[A-Z0-9_]{1,80}$/.test(s)?s:'UNEXPECTED'):[]},routeConfigKeys:Object.keys(v.routeConfig??{}),routes:(v.routeConfig?.routes??[]).map(r=>({path:expected.routeConfig.routes.some(e=>e.path===r.path)?r.path:'UNEXPECTED',methods:Array.isArray(r.methods)?r.methods.map(m=>['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(m)?m:'UNEXPECTED'):[],qualifierMatches:r.qualifier==='LATEST',functionMatches:r.functionName===plan.target.functionName,keys:Object.keys(r),rewriteConfig:shape(r.rewriteConfig)})),cors:shape(v.corsConfig),waf:shape(v.wafConfig),wafEnabled:v.wafConfig?.enableWAF};
}
export const domainProbes=Object.freeze([
 {id:'signed-baseline',method:'GET',path:'/api/v2/status'},
 {id:'unsigned',method:'GET',path:'/api/v2/status',signed:false},
 {id:'forged-event',method:'POST',path:'/api/v2/status',headers:[['x-fc-control-path','/invoke']]},
 {id:'duplicate-control',method:'POST',path:'/api/v2/status',headers:[['x-fc-control-path','/invoke'],['X-Fc-Control-Path','/http-invoke']]},
 {id:'guessed-hop',method:'GET',path:'/api/v2/status',headers:[['x-shuduo-process-hop','0'.repeat(64)]]},
 {id:'internal-scheduler',method:'POST',path:'/api/v2/internal/scheduler/tick'},
 {id:'root-closed',method:'GET',path:'/'},
 {id:'unmapped-invoke',method:'POST',path:'/invoke',unmapped:true},
]);
export function domainProbeAccepted(value,probe,leafSha256){
 if(value?.privateProtocol===true||value?.certificateSha256!==leafSha256||!['TLSv1.2','TLSv1.3'].includes(value?.tlsVersion))return false;
 if(probe.signed===false)return [401,403].includes(value.status)||(value.status===400&&value.authenticationRejected===true&&(value.code==='MissingRequiredHeader'||(value.code==='InvalidArgument'&&value.gatewayCategory==='EMPTY_AUTHORIZATION')));
 if(probe.unmapped)return value.status===404&&value.code==='DomainRouteNotFound';
 return value.status===404&&value.code==='INGRESS_DENIED';
}
export function nextDomainMetadataCount(counts,operation){
 const limits={get:10,create:1,delete:1};
 check(Object.hasOwn(limits,operation)&&Object.entries(limits).every(([k,limit])=>Number.isInteger(counts?.[k])&&counts[k]>=0&&counts[k]<=limit),'DOMAIN_METADATA_COUNT_INVALID');
 check(counts[operation]<limits[operation],'DOMAIN_METADATA_LIMIT_REACHED');
 return{get:counts.get,create:counts.create,delete:counts.delete,[operation]:counts[operation]+1};
}
export function httpsConfig(env,now=Date.now()){
 const stage=signedAccessLimits(env.V2_HTTPS_AUTHORIZATION),p0bSignedStage=Boolean(stage);
 check(env.GITHUB_ACTIONS==='true'&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_SHA===env.V2_HTTPS_SOURCE_SHA&&(env.V2_HTTPS_AUTHORIZATION===DOMAIN_BINDING_AUTHORIZATION||p0bSignedStage),'HTTPS_SCOPE_NOT_AUTHORIZED');
 let input;try{input=JSON.parse(env.V2_HTTPS_BINDING_INPUT);}catch{throw fail('HTTPS_INPUT_INVALID');}
 check(input.sourceRevision===env.GITHUB_SHA&&input.domainName==='shuduoai.cn'&&(p0bSignedStage?input.priorRequests===stage.historical:[3,5].includes(input.priorRequests))&&/^\d{1,20}$/.test(input.restoreRunId??''),'HTTPS_TARGET_MISMATCH');
 if(p0bSignedStage)check(/^[a-f0-9]{64}$/.test(input.priorControlAcceptanceDigest??'')&&/^\d{1,20}$/.test(input.priorControlRunId??''),'P0B_PRIOR_ACCEPTANCE_REQUIRED');
 if(stage?.resume)check(/^[a-f0-9]{64}$/.test(input.priorHttpsAcceptanceDigest??'')&&/^\d{1,20}$/.test(input.priorHttpsRunId??'')&&input.priorHttpsRunId!==env.GITHUB_RUN_ID,'P0B_PRIOR_HTTPS_REQUIRED');
 const start=Date.parse(input.authorizedAt),end=Date.parse(input.expiresAt);
 check(Number.isFinite(start)&&start<=now&&end-start>0&&end-start<=3600000,'HTTPS_PERMISSION_WINDOW_INVALID');
 const material={certificate:input.certificate,privateKey:input.privateKey};
 const plan=domainBindingPlan({...input,authorization:env.V2_HTTPS_AUTHORIZATION,certificate:verifyCertificateMaterial(material,now)},start);
 const recoveryMode=env.V2_HTTPS_RECOVERY_MODE??'NONE';
 check(['NONE','INSPECT_EXISTING','ROLLBACK_EXISTING'].includes(recoveryMode),'HTTPS_RECOVERY_MODE_INVALID');
 if(recoveryMode!=='NONE'){
  const r=input.recovery,c=r?.checkpoint,n=r?.counts;
  check(stage?.reuseDefault===true&&/^[a-f0-9]{64}$/.test(r?.originalEvidenceDigest??'')&&/^\d{1,20}$/.test(r?.originalRunId??'')&&r.originalRunId!==env.GITHUB_RUN_ID
   &&r.expectedDesiredHash===plan.desiredHash&&c?.operationId===plan.operationId&&c.desiredHash===plan.desiredHash&&c.domainName==='shuduoai.cn'&&c.baselineAbsent===true
   &&Number.isInteger(n?.get)&&n.get>=4&&n.get<=(recoveryMode==='ROLLBACK_EXISTING'?8:9)&&n.create===1&&n.delete===0&&end-now>=180000,'HTTPS_RECOVERY_SCOPE_INVALID');
 }
 const cloudEnv={...env,ALIBABA_CLOUD_REGION_ID:input.region,V2_DEPLOY_ROLE_ARN:input.roleArn,V2_DEPLOY_OIDC_PROVIDER_ARN:input.providerArn,V2_FUNCTION_NAME:input.functionName,
  V2_EXPECTED_CODE_CHECKSUM:input.expectedChecksum,V2_ACCEPTANCE_SOURCE_REVISION:input.sourceRevision,V2_HTTP_ACCEPTANCE_AUTHORIZED:p0bSignedStage?env.V2_HTTPS_AUTHORIZATION:'ONE_TEMPORARY_SIGNED_TRIGGER_MAX_20_READS',
  V2_HTTP_PRIOR_FUNCTION_HASH:input.priorFunctionHash,V2_HTTP_PRIOR_TRIGGERS_HASH:input.priorOriginalTriggersHash,
  V2_HTTP_PRIOR_HTTPS_RUN_ID:input.priorHttpsRunId,V2_HTTP_PRIOR_HTTPS_DIGEST:input.priorHttpsAcceptanceDigest,
  V2_HTTP_AUTHORIZATION_EXPIRES_AT:input.expiresAt,V2_HTTP_PREVIOUS_READS:String(input.priorRequests),V2_HTTP_RESTORE_RUN_ID:input.restoreRunId,V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE'};
 const config={...acceptanceConfig(cloudEnv),domainBindingAuthorization:DOMAIN_BINDING_AUTHORIZATION};
 return{plan,material,config,cloudEnv,roleArn:input.roleArn,providerArn:input.providerArn,recoveryMode,recovery:input.recovery};
}
function transport(env,operation,body){
 try{return JSON.parse(execFileSync('python3',['scripts/transport-v2-domain-signed.py'],{input:JSON.stringify({authorization:DOMAIN_BINDING_AUTHORIZATION,domainName:'shuduoai.cn',operation,body}),env,encoding:'utf8',timeout:30000,maxBuffer:1048576,stdio:['pipe','pipe','pipe']}));}
 catch{throw fail('DOMAIN_TRANSPORT_UNCONFIRMED');}
}
export async function waitExactDns(plan,{now=Date.now,lookupNs=resolveNs,lookup4=resolve4,publicLookup=resolveCname,resolverFactory=()=>new Resolver({timeout:1500,tries:1}),wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const stage=Boolean(signedAccessLimits(plan.requestScope));
 const exact=values=>check(Array.isArray(values)&&values.length===1&&values[0].replace(/\.$/,'').toLowerCase()===plan.dns.value,'DNS_TARGET_CONFLICT');
 const pending=error=>['ENOTFOUND','ENODATA','EAI_AGAIN','ETIMEOUT','ESERVFAIL'].includes(error.code);
 check(now()<Date.parse(plan.expiresAt)-300000,'HTTPS_WINDOW_EXPIRED');
 const authorities=[];
 if(stage){
  const names=await lookupNs(plan.target.domainName);check(Array.isArray(names)&&names.length>0&&names.length<=4,'DNS_AUTHORITY_NOT_VERIFIED');
  for(const name of names){const addresses=await lookup4(name);check(addresses.length>0,'DNS_AUTHORITY_NOT_VERIFIED');const resolver=resolverFactory();resolver.setServers([addresses[0]]);authorities.push(resolver);}
 }
 for(let attempt=0;attempt<(stage?72:24);attempt++){
  check(now()<Date.parse(plan.expiresAt)-300000,'HTTPS_WINDOW_EXPIRED');
  let published=true;
  for(const resolver of authorities){try{exact(await resolver.resolveCname(plan.target.domainName));}catch(error){if(!pending(error))throw error;published=false;}}
  // Do not poll the recursive resolver before publication: an early negative
  // answer may be cached longer than the handoff. Actual public DNS is still
  // required, and TLS probes never override DNS or connect to a substituted IP.
  if(published){try{exact(await publicLookup(plan.target.domainName));return true;}catch(error){if(!pending(error))throw error;}}
  await wait(10000);
 }
 throw fail('DNS_HANDOFF_NOT_OBSERVED');
}

export async function httpsBindingMain(env=process.env,mode=process.argv[2]){
 const {plan,material,config,cloudEnv,roleArn,providerArn,recoveryMode,recovery}=httpsConfig(env),key=recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
 if(mode==='--prepare'){
  check(env.GITHUB_ENV,'GITHUB_ENV_REQUIRED');
  for(const value of [plan.target.account,plan.target.role,plan.target.functionName,roleArn,providerArn])process.stdout.write(`::add-mask::${value}\n`);
  appendFileSync(env.GITHUB_ENV,`V2_HTTPS_ROLE_ARN=${roleArn}\nV2_HTTPS_PROVIDER_ARN=${providerArn}\n`);return;
 }
 mkdirSync(dir,{recursive:true,mode:0o700});
 if(mode==='--restore-recovery'){
  check(recoveryMode!=='NONE'&&!read('domain-checkpoint')&&!read('domain-api-count'),'HTTPS_RECOVERY_ALREADY_RESTORED');
  save('domain-checkpoint',recovery.checkpoint);save('domain-api-count',recovery.counts);return;
 }
 if(mode==='--seal'||mode==='--handoff'){
  if(recoveryMode!=='NONE'){
   check(mode==='--seal','RECOVERY_NO_HANDOFF');
   const report={scope:'SIGNED_DOMAIN_CLEANUP_RECOVERY',operationId:plan.operationId,targetHash:plan.desiredHash,recoveryMode,originalRunId:recovery.originalRunId,originalEvidenceDigest:recovery.originalEvidenceDigest,inspection:read('inspection'),cleanup:read('cleanup'),domainApiCounts:read('domain-api-count')??recovery.counts,domainCheckpoint:read('domain-checkpoint'),domainRequests:0,newRequests:0,cumulativeRequests:47,modelCalls:0,sparkRuns:0,publicApplicationEnabled:false};
   writeFileSync('v2-https-binding.sealed.json',JSON.stringify(sealReport(report,key,{protocol:'shuduo-https-binding/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}))+'\n',{mode:0o600});return;
  }
  const stage=signedAccessLimits(plan.requestScope);
  const report={scope:'SIGNED_HTTPS_DOMAIN_BINDING',operationId:plan.operationId,targetHash:plan.desiredHash,domain:read('domain'),boundary:read('boundary'),httpCheckpoint:read('http-checkpoint'),domainCheckpoint:read('domain-checkpoint'),cleanup:read('cleanup')};
  const reusedBoundaryValid=!stage?.reuseDefault||(report.boundary?.scope==='SIGNED_DOMAIN_PREPARATION_ONLY'&&report.boundary.defaultBoundaryReused===true&&report.boundary.newRequests===0&&report.boundary.results?.length===0&&report.boundary.priorBoundaryEvidence?.runId===config.priorHttpsRunId&&report.boundary.priorBoundaryEvidence.digest===config.priorHttpsAcceptanceDigest);
  if(mode==='--handoff'){
   check(report.boundary?.passed===true&&report.boundary.cleanup?.deferredForSameDomainBatch===true&&report.boundary.priorRequests===config.previousReads&&report.httpCheckpoint?.requests===config.previousReads+(stage?.defaultNew??15)&&report.httpCheckpoint.requests<=config.maxRequests,'BOUNDARY_HANDOFF_NOT_READY');
   check(reusedBoundaryValid,'REUSED_BOUNDARY_HANDOFF_MISMATCH');
  }
  report.passed=report.domain?.passed===true&&report.boundary?.passed===true&&reusedBoundaryValid&&report.cleanup?.triggerAbsent===true&&report.cleanup.functionUnchanged===true&&report.cleanup.originalTriggersUnchanged===true&&!report.cleanup?.domainRollbackFailure;
  if(config.p0bSignedStage){
   report.requestBudget={historical:stage.historical,defaultNewLimit:stage.defaultNew,domainNewLimit:8,cumulativeLimit:stage.totalMax};
   report.domainRequests=read('probe-count')?.requests??0;report.cumulativeRequests=(report.boundary?.requests??stage.historical)+report.domainRequests;
   report.domainApiCounts=read('domain-api-count')??{get:0,create:0,delete:0};
   check(report.cumulativeRequests<=stage.totalMax&&report.domainRequests<=8,'P0B_REPORTED_LIMIT_EXCEEDED');
  }
  writeFileSync(mode==='--handoff'?'v2-https-handoff.sealed.json':'v2-https-binding.sealed.json',JSON.stringify(sealReport(report,key,{protocol:'shuduo-https-binding/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}))+'\n',{mode:0o600});return;
 }
 check(cloudEnv.ALIBABA_CLOUD_ACCESS_KEY_ID&&cloudEnv.ALIBABA_CLOUD_ACCESS_KEY_SECRET&&cloudEnv.ALIBABA_CLOUD_SECURITY_TOKEN,'OIDC_STS_REQUIRED');
 const http=adapterFor(config,cloudEnv);
 const domainCall=(operation,body)=>{
  if(config.p0bSignedStage){
   const counts=nextDomainMetadataCount(read('domain-api-count')??{get:0,create:0,delete:0},operation);
   save('domain-api-count',counts);
  }
  return transport(cloudEnv,operation,body);
 };
 const domain={get:()=>domainCall('get'),create:body=>domainCall('create',body),delete:()=>domainCall('delete')};
 if(recoveryMode!=='NONE'){
  check(read('domain-checkpoint')&&read('domain-api-count'),'RECOVERY_CHECKPOINT_REQUIRED');
  if(mode==='--inspect-existing'){
   check(recoveryMode==='INSPECT_EXISTING'&&!read('inspection'),'RECOVERY_INSPECTION_NOT_ALLOWED');
   const value=await domain.get();save('inspection',domainReadbackShape(value,plan));check(value?.status===200,'RECOVERY_READ_NOT_CONFIRMED');return;
  }
  if(mode==='--cleanup'){
   if(recoveryMode==='INSPECT_EXISTING'){save('cleanup',{inspectionOnly:true,noDomainMutation:true});return;}
   const cleanup={};try{cleanup.domainRollback=await rollbackDomainBinding(plan,domain,read('domain-checkpoint'),{save:cp=>save('domain-checkpoint',cp)});}catch(error){cleanup.failure=error.safeCode??'RECOVERY_ROLLBACK_UNCONFIRMED';}
   save('cleanup',cleanup);check(cleanup.domainRollback?.domainAbsent===true,'RECOVERY_ROLLBACK_NOT_CONFIRMED');return;
  }
  throw fail('RECOVERY_OPERATION_NOT_ALLOWED');
 }
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
   check(Number.isSafeInteger(count)&&count>=0&&count<=plan.limits.domainProbes,'DOMAIN_PROBE_COUNT_INVALID');
   const probes=[];
   Object.assign(domain,{
    preflight:async()=>{
     const f=await http.fc('GET',''),items=await checkedList(http,config),cp=read('http-checkpoint');
     return{defaultBoundaryVerified:read('boundary')?.passed===true,publicApplicationEnabled:f.environmentVariables?.V2_FC_PUBLIC_HTTP_ENABLED==='true',sameSignedTriggerPresent:items.some(t=>ownsTrigger(t,config)),functionUnchanged:functionHash(f)===cp?.functionHash,budgetVerified:read('boundary')?.reservedCny===plan.limits.reservedCny,dnsExact:await waitExactDns(plan)};
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
