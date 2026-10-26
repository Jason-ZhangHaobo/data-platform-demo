// Repair an already-retained read-only entry. Only code + instance concurrency
// change atomically; DNS, TLS, environment, triggers, instance quota stay intact.
import {codeUpdateBoundaryHash} from './control-code-update.mjs';
import {readonlyConfigIntegrity,readonlyFunctionState,readonlyTriggerState,readonlyDomainState} from './invited-readonly-config.mjs';
import {readonlyProbesFor,readonlyEntryProbeAccepted,readonlyProbeDiagnostic} from './invited-readonly-entry.mjs';
const check=(v,c)=>{if(!v)throw Object.assign(new Error(c),{safeCode:c});};
const matches=(state,pkg,concurrency)=>String(state.function.codeChecksum)===pkg.crc64&&state.function.codeSize===pkg.bytes&&state.function.instanceConcurrency===concurrency;
const normalizedHash=state=>codeUpdateBoundaryHash({...state,function:{...state.function,instanceConcurrency:1}});
export async function repairReadonlyBrowser({config,change,webIndexSha256,publicSite},adapter,{load,save,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),rollbackOnly=false,beginCleanup=()=>{}}){
 check(config.readonlyConcurrencyRepair===true&&readonlyConfigIntegrity(change)&&change.expectedCode.sha256===config.previous.sha256,'BROWSER_REPAIR_BASELINE_INVALID');
 let cp=load(),validated=false;
 const report={scope:'RETAINED_READONLY_BROWSER_REPAIR',executionPassed:false,entryRetained:true,modelCallsRequested:0,sparkRunsRequested:0};
 const persist=()=>save(structuredClone(cp));
 const active=()=>check(now()<config.expiresAt-60000,'BROWSER_REPAIR_WINDOW_EXPIRED');
 const inspect=async()=>{active();const s=await adapter.readState();check(normalizedHash(s)===cp.boundaryHash&&[1,8].includes(s.function.instanceConcurrency),'BROWSER_REPAIR_FOREIGN_CONFIGURATION');return s;};
 const body=(p,n)=>({code:{ossBucketName:config.bucket,ossObjectName:p.key,checksum:p.crc64},instanceConcurrency:n});
 const rollback=async()=>{
  beginCleanup();let s=await inspect();
  if(matches(s,config.previous,1)){cp.phase='ROLLED_BACK';report.rollbackVerified=true;persist();return;}
  check(cp.candidateReceipt&&matches(s,cp.candidateReceipt,8)&&!cp.rollbackRequested,'BROWSER_REPAIR_FOREIGN_OR_UNKNOWN_ROLLBACK');
  cp.rollbackRequested=true;persist();try{await adapter.updateCode(body(config.previous,1));}catch{cp.rollbackResponseUnknown=true;persist();}
  s=await inspect();check(matches(s,config.previous,1),'BROWSER_REPAIR_ROLLBACK_UNCONFIRMED');cp.phase='ROLLED_BACK';report.rollbackVerified=true;persist();
 };
 try{
  active();const id=await adapter.identity();check(String(id.AccountId)===config.account&&String(id.Arn??'').startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`),'BROWSER_REPAIR_IDENTITY_INVALID');
  if(cp){
   check(cp.operationId===config.operationId&&cp.operatorSource===config.operatorSource&&cp.previousSha===config.previous.sha256&&cp.candidateSha===config.candidate.sha256,'BROWSER_REPAIR_CHECKPOINT_MISMATCH');validated=true;
   if(cp.phase==='VERIFIED'){report.executionPassed=true;return report;}
   check(rollbackOnly,'BROWSER_REPAIR_UNKNOWN_OUTCOME_RECONCILE_ONLY');if(cp.updateRequested)await rollback();return report;
  }
  check(!rollbackOnly,'BROWSER_REPAIR_CHECKPOINT_REQUIRED');
  const s=await adapter.readState();
  check(readonlyFunctionState(change,s.function)==='OPENED'&&readonlyTriggerState(change,s.triggers)==='OWNED'&&s.concurrency.reservedConcurrency===1&&s.scaling.minInstances===0&&s.function.instanceConcurrency===1&&s.function.cpu===0.25&&s.function.memorySize===512,'BROWSER_REPAIR_RETAINED_ENTRY_DRIFT');
  check(readonlyDomainState(change,await adapter.readDomain())==='OPENED','BROWSER_REPAIR_DOMAIN_DRIFT');
  const bill=await adapter.budget();check(bill.complete&&bill.currentCycle&&bill.observedCny+bill.unsettledReservedCny+2<200,'BROWSER_REPAIR_BUDGET_UNCONFIRMED');
  cp={operationId:config.operationId,operatorSource:config.operatorSource,previousSha:config.previous.sha256,candidateSha:config.candidate.sha256,boundaryHash:normalizedHash(s),phase:'BASELINE',runtime:[],probes:[]};validated=true;persist();
  const backup=await adapter.recoverRollback(config.previous);check(backup.safelyRetained&&backup.sha256===config.previous.sha256,'BROWSER_REPAIR_BACKUP_UNCONFIRMED');
  for(const kind of ['previous','candidate']){const p=config[kind],r=await adapter.ensurePackage(kind,p);check(r.sha256===p.sha256&&r.bytes===p.bytes&&r.objectKey===p.key&&r.readbackVerified&&r.privateVerified&&r.immutable&&/^\d+$/.test(r.crc64)&&(!p.crc64||r.crc64===p.crc64),'BROWSER_REPAIR_OBJECT_UNCONFIRMED');cp[kind+'Receipt']={...r,key:p.key};persist();}
  check(matches(await inspect(),config.previous,1),'BROWSER_REPAIR_CODE_DRIFT');
  cp.updateRequested=true;cp.phase='UPDATE_REQUESTED';persist();
  try{await adapter.updateCode(body(cp.candidateReceipt,8));}catch{cp.updateResponseUnknown=true;persist();}
  check(matches(await inspect(),cp.candidateReceipt,8),'BROWSER_REPAIR_UPDATE_UNCONFIRMED');
  for(let n=0;n<3;n++){
   cp.runtime.push({requested:true});persist();const value=await adapter.invoke({operation:'PRIVATE_STATUS_V1'});
   const ready=value?.protocol==='shuduo-v2-private-smoke-v1'&&value?.httpHandling?.mode==='SERIAL_STATEFUL_PARALLEL_STATIC_V1'&&value.ingress?.publicHttpEnabled===true&&value.ingress.publicReadOnly===true&&value.metadata?.healthy===true&&value.persistence?.healthy===true&&value.persistence.dataState?.healthy===true;
   Object.assign(cp.runtime[n],{ready,modeReady:value?.httpHandling?.mode==='SERIAL_STATEFUL_PARALLEL_STATIC_V1',ingressReady:value?.ingress?.publicHttpEnabled===true&&value.ingress.publicReadOnly===true,metadataHealthy:value?.metadata?.healthy===true,persistenceHealthy:value?.persistence?.healthy===true&&value.persistence.dataState?.healthy===true});persist();if(ready)break;
   check(n===0||JSON.stringify(cp.runtime[n])!==JSON.stringify(cp.runtime[n-1]),'BROWSER_REPAIR_RUNTIME_NO_PROGRESS');
   check(n<2,'BROWSER_REPAIR_RUNTIME_UNCONFIRMED');await wait(2000);
  }
  for(const probe of readonlyProbesFor(change.authorization)){
   cp.probes.push({id:probe.id,requested:true});persist();const r=await adapter.probe(probe);
   if(!readonlyEntryProbeAccepted(r,probe,{webIndexSha256,publicSite})){report.failureDiagnostic=readonlyProbeDiagnostic(r,probe,{webIndexSha256,publicSite});check(false,'BROWSER_REPAIR_HTTP_NOT_VERIFIED');}
   Object.assign(cp.probes.at(-1),{status:r.status,accepted:true});persist();
  }
  check(matches(await inspect(),cp.candidateReceipt,8),'BROWSER_REPAIR_FINAL_CODE_CHANGED');check(readonlyDomainState(change,await adapter.readDomain())==='OPENED','BROWSER_REPAIR_FINAL_DOMAIN_DRIFT');
  cp.phase='VERIFIED';persist();report.executionPassed=true;
 }catch(e){report.failure=e.safeCode??'BROWSER_REPAIR_UNCONFIRMED';if(e.safeDiagnostic)report.failureDiagnostic=e.safeDiagnostic;if(validated&&cp?.updateRequested&&cp.phase!=='VERIFIED'){try{await rollback();}catch(r){report.rollbackFailure=r.safeCode??'BROWSER_REPAIR_ROLLBACK_UNCONFIRMED';}}}
 finally{if(validated){report.phase=cp.phase;report.runtime=cp.runtime;report.probes=cp.probes;} }
 return report;
}
