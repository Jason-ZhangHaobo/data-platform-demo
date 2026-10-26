// Fixed code -> read-only entry -> owned rollback sequence. IAM activation and
// revocation stay with the existing owner coordinator. No background polling,
// credential loading, automatic execution, domain creation or DNS operations.
import {createHash,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {controlCloudAdapter} from './control-code-transport.mjs';
import {runControlCodeUpdate} from './control-code-update.mjs';
import {openingScope,publicSitePatch} from './invited-opening-scopes.mjs';
import {prepareInvitedReadonlyConfig} from './invited-readonly-config.mjs';
import {readonlyEntryPlan,runReadonlyEntry} from './invited-readonly-entry.mjs';
import {createReadonlyEntryCloudAdapter,readReadonlyHttpsProbe,readonlyDefaultEndpoint} from './invited-entry-cloud-adapter.mjs';
import {repairReadonlyBrowser} from './readonly-browser-repair.mjs';

const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{safeCode:code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runInvitedOpening({config,metadata,retainedPlan,webIndexSha256},{env,storage,usage,now=Date.now,exec=execFileSync,codeOptions={},entryOptions={},cleanupOnly=false}){
 const scope=openingScope(env?.V2_READONLY_OPENING_APPROVED,config.history);
 check(env?.GITHUB_ACTIONS==='true'&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_SHA===config.operatorSource,'OPENING_PROTECTED_MAIN_REQUIRED');
 check(config.authorization===scope.codeAuthorization,'OPENING_CODE_SCOPE_REQUIRED');
 check(typeof storage?.load==='function'&&typeof storage?.save==='function'&&typeof usage?.reserve==='function','OPENING_STORAGE_REQUIRED');
 const originalUsage=usage.snapshot();
 check(originalUsage.authorization===scope.authorization&&originalUsage.operationId===config.operationId&&originalUsage.operatorSource===config.operatorSource&&originalUsage.issuedAt===config.issuedAt&&originalUsage.expiresAt===config.expiresAt,'OPENING_USAGE_BINDING_MISMATCH');
 if(scope.filingRepair)publicSitePatch(metadata.publicSite);
 check(retainedPlan?.target?.account===config.account&&retainedPlan.target.region===config.region&&retainedPlan.target.functionName===config.functionName&&retainedPlan.target.role===config.role,'OPENING_DOMAIN_TARGET_MISMATCH');
 check(/^[a-f0-9]{64}$/.test(webIndexSha256??''),'OPENING_HTML_IDENTITY_REQUIRED');
 const scopeHash=digest({config,retainedPlan,webIndexSha256,publicSite:metadata.publicSite});
 let stage=storage.load('stage'),finalCodeState;
 if(stage)check(stage.scopeHash===scopeHash&&stage.operationId===config.operationId,'OPENING_STAGE_CHECKPOINT_MISMATCH');
 else{stage={scopeHash,operationId:config.operationId};storage.save('stage',stage);}
 const report={scope:scope.authorization,executionPassed:false,invitedUserAccepted:false,externalCleanupRequired:true,modelCallsRequested:0,sparkRunsRequested:0};
 const beginCleanup=()=>usage.beginCleanup();
 const adapter=controlCloudAdapter(config,metadata,{...codeOptions,exec,env,now,beforeRequest:name=>usage.reserve(name),loadTransport:()=>storage.load('transport'),saveTransport:value=>storage.save('transport',value)});
 if(config.readonlyConcurrencyRepair){
  const change=metadata.retainedReadonlyChange;
  let defaultEndpoint;
  const originalRead=adapter.readState;
  adapter.readState=async()=>{const state=await originalRead();const trigger=state.triggers.find(t=>t.triggerName===change?.triggerBody?.triggerName);defaultEndpoint=readonlyDefaultEndpoint(trigger?.httpTrigger?.urlInternet);return state;};
  adapter.readDomain=async()=>{
   check(now()<config.expiresAt,'OPENING_WINDOW_EXPIRED');usage.reserve('DOMAIN_READ');
   const raw=exec('python3',['scripts/transport-v2-domain-signed.py'],{input:JSON.stringify({authorization:scope.authorization,domainName:'shuduoai.cn',operation:'get'}),encoding:'utf8',timeout:30000,maxBuffer:1048576,stdio:['pipe','pipe','pipe'],env});
   const value=JSON.parse(raw);check(value.status===200,'OPENING_DOMAIN_READ_UNCONFIRMED');return value.value;
  };
  adapter.probe=probe=>{check(now()<config.expiresAt,'OPENING_WINDOW_EXPIRED');usage.reserve('HTTP_PROBE');return readReadonlyHttpsProbe(probe.target==='domain'?'https://shuduoai.cn':defaultEndpoint,probe,retainedPlan.desired.certificateSha256,{...entryOptions,authorization:scope.authorization});};
  const result=await repairReadonlyBrowser({config,change,webIndexSha256,publicSite:metadata.publicSite},adapter,{now,load:()=>storage.load('code'),save:v=>storage.save('code',v),rollbackOnly:cleanupOnly,beginCleanup});
  storage.save('code-report',result);
  if(result.executionPassed)storage.save('entry',{phase:'VERIFIED',scope:'RETAINED_READONLY_BROWSER_REPAIR',probes:result.probes,entryRoutingChanged:false});
  Object.assign(report,result,usage.counts());storage.save('stage-report',report);return report;
 }
 const readState=adapter.readState;
 adapter.readState=async()=>{
  finalCodeState=await readState();
  if(scope.filingRepair&&!cleanupOnly&&!stage.change){
   const e=finalCodeState.function?.environmentVariables??{};
   stage.filingInspection={icp:e.V2_SITE_ICP_NUMBER===metadata.publicSite.icpNumber?'MATCH':e.V2_SITE_ICP_NUMBER?'DIFFERENT':'MISSING',registeredName:e.V2_SITE_REGISTERED_NAME===metadata.publicSite.registeredName?'MATCH':e.V2_SITE_REGISTERED_NAME?'DIFFERENT':'MISSING'};
   storage.save('stage',structuredClone(stage));
  }
  return finalCodeState;
 };
 const codeStorage={now,load:()=>storage.load('code'),save:value=>storage.save('code',value),beginCleanup};
 const saveStage=()=>storage.save('stage',structuredClone(stage));
 let codeVerified=storage.load('code')?.phase==='VERIFIED';
 try{
  if(cleanupOnly){
   const entry=storage.load('entry');
   if(entry?.phase==='VERIFIED'){
    report.entryRetained=true;report.previouslyRetained=true;return report;
   }
   beginCleanup();
   check(stage.change&&entry,'OPENING_RECOVER_CODE_ONLY');
  }else if(!stage.change){
   check(originalUsage.phase==='ACTIVE','OPENING_CLEANUP_ONLY');
   report.code=await runControlCodeUpdate(config,adapter,codeStorage);
   codeVerified=report.code.passed===true;
   storage.save('code-report',report.code);
   check(codeVerified,'OPENING_CODE_NOT_VERIFIED');
   const site=metadata.publicSite,e=finalCodeState?.function?.environmentVariables;
   // Do not silently add more environment mutations to the approved four-key
   // patch. A missing/incorrect filing display stops before opening the entry.
   if(!scope.filingRepair)check(site&&typeof site.icpNumber==='string'&&site.icpNumber.length>0&&typeof site.registeredName==='string'&&site.registeredName.length>0&&e?.V2_SITE_ICP_NUMBER===site.icpNumber&&e.V2_SITE_REGISTERED_NAME===site.registeredName,'OPENING_FILING_DISPLAY_NOT_CONFIGURED');
   usage.reserve('DOMAIN_READ');
   const raw=exec('python3',['scripts/transport-v2-domain-signed.py'],{input:JSON.stringify({authorization:scope.authorization,domainName:'shuduoai.cn',operation:'get'}),encoding:'utf8',timeout:Math.min(30000,Math.max(1,config.expiresAt-now())),maxBuffer:1048576,stdio:['pipe','pipe','pipe'],env});
   let response;try{response=JSON.parse(raw);}catch{check(false,'OPENING_DOMAIN_READ_UNCONFIRMED');}
   check(response.status===200,'OPENING_DOMAIN_READ_UNCONFIRMED');
   const leaf=new X509Certificate(response.value?.certConfig?.certificate);
   check(Date.parse(leaf.validFrom)<=now()&&Date.parse(leaf.validTo)>config.expiresAt,'OPENING_CERTIFICATE_WINDOW_INVALID');
   const cp=storage.load('code');
   stage.change=prepareInvitedReadonlyConfig({state:finalCodeState,domain:response.value,retainedPlan,operationId:config.operationId,authorization:scope.authorization,history:config.history,publicSite:site,
    expectedCode:{applicationSource:config.applicationSource,sha256:config.candidate.sha256,bytes:config.candidate.bytes},
    privateCodeEvidence:{report:{...report.code,operationId:config.operationId},checkpoint:cp,transport:storage.load('transport')}});
   stage.entryPlan=readonlyEntryPlan({authorization:scope.authorization,history:config.history,publicSite:site,operationId:config.operationId,operatorSource:config.operatorSource,webIndexSha256,
    issuedAt:new Date(config.issuedAt).toISOString(),expiresAt:new Date(config.expiresAt).toISOString(),seed:usage.counts()},now());
   saveStage();
  }else{
   check(stage.entryPlan?.operationId===config.operationId&&stage.entryPlan.operatorSource===config.operatorSource,'OPENING_ENTRY_PLAN_MISMATCH');
   check(stage.entryPlan.authorization===scope.authorization&&(!scope.filingRepair||digest(stage.change.publicSite)===digest(metadata.publicSite)),'OPENING_REPAIR_SCOPE_CHANGED');
   const cp=storage.load('entry');
   check(usage.counts().configurationReads>=(cp?.configurationReads??stage.entryPlan.seed.configurationReads)&&usage.counts().newRequests===(cp?.newRequests??stage.entryPlan.seed.newRequests),'OPENING_USAGE_RECONCILIATION_REQUIRED');
   // A process interrupted during cleanup must not re-open or re-probe.
   check(originalUsage.phase!=='CLEANUP'||['ROLLING_BACK','ROLLED_BACK','NEEDS_ATTENTION'].includes(cp?.phase),'OPENING_CLEANUP_ONLY');
  }
  const entry=createReadonlyEntryCloudAdapter({...entryOptions,plan:stage.entryPlan,change:stage.change,exec,env,now,beforeRequest:name=>usage.reserve(name)});
  report.entry=await runReadonlyEntry(stage.entryPlan,stage.change,entry,{now,load:()=>storage.load('entry'),save:value=>storage.save('entry',value),beginCleanup,rollbackOnly:cleanupOnly});
  storage.save('entry-report',report.entry);
  report.executionPassed=report.entry.passed===true;
  report.entryRetained=report.entry.entryRetained===true;
  if(!report.executionPassed)check(false,'OPENING_ENTRY_NOT_VERIFIED');
 }catch(error){
  report.failure=error.safeCode??'OPENING_EXECUTION_UNCONFIRMED';
  // Once a prior entry was accepted, a later diagnostic error is not authority
  // to remove it. An incomplete/foreign configuration also forbids replacing
  // its code with an older package that could expose an unsafe public entry.
  const entry=storage.load('entry'),rollback=entry?.rollback;
  const noEntryWrites=!entry||Object.keys(entry.writes??{}).length===0;
  const entryRestored=rollback?.functionRestored===true&&rollback.domainRestored===true&&rollback.triggerAbsent===true;
  const code=storage.load('code'),mayRestore=codeVerified||(cleanupOnly&&code?.updateRequested===true);
  if(mayRestore&&entry?.phase!=='VERIFIED'&&(noEntryWrites||entryRestored)){
   try{beginCleanup();report.codeRollback=await runControlCodeUpdate(config,adapter,{...codeStorage,rollbackOnly:true});}
   catch(cleanup){report.codeRollbackFailure=cleanup.safeCode??'OPENING_CODE_ROLLBACK_UNCONFIRMED';}
  }else if(codeVerified&&entry?.phase!=='VERIFIED')report.codeRollbackDeferred='ENTRY_NOT_FULLY_RESTORED';
 }finally{
  Object.assign(report,usage.counts());
  storage.save('stage-report',report);
 }
 return report;
}
