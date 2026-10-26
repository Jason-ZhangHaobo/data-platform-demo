// Code-only update policy. Transport and IAM orchestration are separate; this
// module has no credentials, file writes, network calls or automatic execution.
import {createHash} from 'node:crypto';
import {controlPackageObject} from './render-v2-control-package-policy.mjs';
import {INVITED_READONLY_CODE_SCOPE,INVITED_READONLY_FILING_CODE_SCOPE} from './invited-opening-scopes.mjs';
export {INVITED_READONLY_CODE_SCOPE,INVITED_READONLY_FILING_CODE_SCOPE};
const fail=code=>Object.assign(new Error(code),{safeCode:code});
const check=(v,c)=>{if(!v)throw fail(c);};
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v??null);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const fields=['functionName','runtime','handler','role','timeout','cpu','memorySize','diskSize','instanceConcurrency','internetAccess','vpcConfig','customRuntimeConfig','layers','nasConfig','ossMountConfig','logConfig','environmentVariables'];
export const codeUpdateBoundaryHash=state=>hash({function:Object.fromEntries(fields.map(k=>[k,state.function?.[k]??null])),triggers:[...(state.triggers??[])].sort((a,b)=>a.triggerName.localeCompare(b.triggerName)),concurrency:state.concurrency,scaling:state.scaling});
const codeMatches=(f,p)=>String(f?.codeChecksum)===p.crc64&&Number(f?.codeSize)===p.bytes;
export function codeUpdateLimits(authorization){
 if(authorization==='P0A_PRIVATE_CODE_ONLY')return{previousInvocations:11,maxInvocations:8,maxUpdateAttempts:2,maxRollbackAttempts:1};
 // A separate code-only substep of the proposed opening grant. This is not
 // permission to open HTTP or reset the 55 historical acceptance requests.
 if(authorization===INVITED_READONLY_CODE_SCOPE)return{previousInvocations:55,maxInvocations:6,maxUpdateAttempts:1,maxRollbackAttempts:1,maxConfigurationReads:30};
 if(authorization===INVITED_READONLY_FILING_CODE_SCOPE)return{previousInvocations:61,maxInvocations:6,maxUpdateAttempts:1,maxRollbackAttempts:1,maxConfigurationReads:30};
 throw fail('CODE_UPDATE_NOT_AUTHORIZED');
}
export const codeUpdateProbes=Object.freeze([
 {id:'private-status',body:{operation:'PRIVATE_STATUS_V1'}},
 {id:'application-status',body:{operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2/status'}},
 {id:'anonymous-session',body:{operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2/auth/session'}},
 {id:'anonymous-agent-lookup',body:{operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2/agent/requests/p0a-readonly-absent'}},
 {id:'anonymous-services',body:{operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2/data-services/sources'}},
]);
export function codeUpdateConfig(input,now=Date.now()){
 const limits=codeUpdateLimits(input?.authorization);
 check(/^[a-f0-9]{32}$/.test(input.operationId??'')&&/^[a-f0-9]{40}$/.test(input.applicationSource??'')&&/^[a-f0-9]{40}$/.test(input.operatorSource??''),'CODE_UPDATE_IDENTITY_INVALID');
 check(/^\d{12,20}$/.test(input.account??'')&&/^[a-z0-9-]{1,64}$/.test(input.role??'')&&/^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(input.functionName??'')&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket??'')&&input.region==='cn-hangzhou','CODE_UPDATE_TARGET_INVALID');
 const expiresAt=Date.parse(input.expiresAt);check(Number.isFinite(expiresAt)&&expiresAt-now>=300000&&expiresAt-now<=3600000&&input.previousInvocations===limits.previousInvocations,'CODE_UPDATE_LIMITS_INVALID');
 for(const p of [input.previous,input.candidate])check(/^[a-f0-9]{64}$/.test(p?.sha256??'')&&Number.isSafeInteger(p.bytes)&&p.bytes>0&&p.bytes<=73400320,'CODE_PACKAGE_INVALID');
 check(input.previous.sha256!==input.candidate.sha256&&/^\d{1,30}$/.test(input.previous.crc64??''),'ROLLBACK_IDENTITY_INVALID');
 return{authorization:input.authorization,operationId:input.operationId,applicationSource:input.applicationSource,operatorSource:input.operatorSource,account:input.account,role:input.role,functionName:input.functionName,bucket:input.bucket,region:input.region,issuedAt:now,expiresAt,
  previous:{sha256:input.previous.sha256,bytes:input.previous.bytes,crc64:input.previous.crc64,key:controlPackageObject(input.previous.sha256)},candidate:{sha256:input.candidate.sha256,bytes:input.candidate.bytes,key:controlPackageObject(input.candidate.sha256)},...limits};
}
function verifiedReceipt(receipt,pkg){
 check(receipt?.sha256===pkg.sha256&&receipt.bytes===pkg.bytes&&receipt.objectKey===pkg.key&&/^\d{1,30}$/.test(receipt.crc64??'')&&receipt.readbackVerified===true&&receipt.privateVerified===true&&receipt.immutable===true,'CODE_OBJECT_NOT_VERIFIED');
 if(pkg.crc64)check(receipt.crc64===pkg.crc64,'ROLLBACK_CHECKSUM_MISMATCH');
 return{sha256:receipt.sha256,bytes:receipt.bytes,key:pkg.key,crc64:receipt.crc64};
}
function assertProbe(id,value){
 if(id==='private-status')check(value?.protocol==='shuduo-v2-private-smoke-v1'&&value.ingress?.mode==='FC_CONTROL_PATH'&&value.ingress.publicHttpEnabled===false&&value.metadata?.healthy===true&&value.persistence?.healthy===true&&value.persistence.dataState?.healthy===true&&value.publicReady===false,'PRIVATE_STATUS_NOT_VERIFIED');
 else {
  check(value?.protocol==='shuduo-private-application-http/v1','APPLICATION_PROTOCOL_NOT_VERIFIED');
  if(id==='application-status')check(value?.status===200&&value.body?.mode==='PUBLIC_INVITATION'&&value.body.publicReady===false&&value.body.authentication?.publicSessionEnforced===true&&value.body.spark?.isolation==='REMOTE_FUNCTION','APPLICATION_STATUS_NOT_VERIFIED');
  else if(id==='anonymous-session')check(value?.status===200&&value.body?.authenticated===false,'ANONYMOUS_SESSION_NOT_VERIFIED');
  else check([401,403].includes(value?.status),'UNAUTHENTICATED_READ_NOT_REJECTED');
 }
}
export async function runControlCodeUpdate(config,adapter,{load,save,now=Date.now,rollbackOnly=false,beginCleanup=()=>{}}={}){
 codeUpdateLimits(config?.authorization);
 check(Number.isSafeInteger(config.issuedAt)&&config.issuedAt<=now()&&Number.isSafeInteger(config.expiresAt),'CODE_UPDATE_LIMITS_INVALID');
 const normalized=codeUpdateConfig({...config,expiresAt:new Date(config.expiresAt).toISOString()},config.issuedAt);
 check(canonical(config)===canonical(normalized),'CODE_UPDATE_CONFIG_CHANGED');
 config=normalized;
 const opening=[INVITED_READONLY_CODE_SCOPE,INVITED_READONLY_FILING_CODE_SCOPE].includes(config.authorization);
 check(!rollbackOnly||opening,'OUTER_ROLLBACK_SCOPE_INVALID');
 if(opening)check(now()<config.expiresAt-60000,'UPDATE_WINDOW_EXPIRED');
 check(typeof load==='function'&&typeof save==='function','DURABLE_UPDATE_CHECKPOINT_REQUIRED');
 let cp=structuredClone(await load()),checkpointValidated=false,mayNeedRollback=false;
 const report={scope:'PRIVATE_CONTROL_CODE_ONLY',requestScope:config.authorization,passed:false,applicationSource:config.applicationSource,operatorSource:config.operatorSource,modelCalls:0,sparkRuns:0,publicEnabled:false};
 const withinWindow=()=>check(now()<config.expiresAt-60000,'UPDATE_WINDOW_EXPIRED');
 const write=async()=>save(structuredClone(cp));
 const inspect=async()=>{const s=await adapter.readState();check(codeUpdateBoundaryHash(s)===cp.boundaryHash,'PROTECTED_STATE_DRIFT');return s;};
 const invoke=async(probe)=>{
  withinWindow();check(cp.invocations<config.maxInvocations,'UPDATE_INVOKE_LIMIT');cp.invocations++;await write();
  const value=await adapter.invoke(probe.body);assertProbe(probe.id,value);return{id:probe.id,passed:true};
 };
 const codeBody=pkg=>({code:{ossBucketName:config.bucket,ossObjectName:pkg.key,checksum:pkg.crc64}});
 const rollback=async()=>{
  await beginCleanup();
  const current=await inspect();
  if(codeMatches(current.function,config.previous)){report.originalCodePresent=true;if(cp.rollbackRequested){report.rollbackVerified=true;cp.phase='ROLLED_BACK';await write();}return;}
  check(cp.candidateReceipt&&codeMatches(current.function,cp.candidateReceipt),'FOREIGN_CODE_DO_NOT_ROLLBACK');
  withinWindow();check(!cp.rollbackRequested,'ROLLBACK_OUTCOME_REQUIRES_READBACK');
  check(cp.previousReceipt&&cp.rollbackAttempts<config.maxRollbackAttempts,'ROLLBACK_NOT_READY');
  cp.rollbackRequested=true;cp.rollbackAttempts++;await write();
  try{await adapter.updateCode(codeBody(cp.previousReceipt));}catch{cp.rollbackResponseUnknown=true;await write();}
  const restored=await inspect();check(codeMatches(restored.function,config.previous),'ROLLBACK_NOT_CONFIRMED');
  report.originalCodePresent=true;report.rollbackVerified=true;cp.phase='ROLLED_BACK';await write();
 };
 try{
  const identity=await adapter.identity();check(String(identity.AccountId)===config.account&&String(identity.Arn??'').startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`),'UPDATE_IDENTITY_MISMATCH');
  check(!rollbackOnly||cp,'OUTER_ROLLBACK_CHECKPOINT_REQUIRED');
  if(cp){
   check(cp.configHash===hash(config)&&cp.operationId===config.operationId&&cp.targetHash===hash([config.account,config.region,config.functionName,config.bucket])&&cp.candidateSha===config.candidate.sha256&&cp.previousSha===config.previous.sha256,'UPDATE_CHECKPOINT_MISMATCH');
   check(Number.isSafeInteger(cp.invocations)&&cp.invocations>=0&&cp.invocations<=config.maxInvocations&&Number.isSafeInteger(cp.updateAttempts)&&cp.updateAttempts>=0&&cp.updateAttempts<=config.maxUpdateAttempts&&Number.isSafeInteger(cp.rollbackAttempts)&&cp.rollbackAttempts>=0&&cp.rollbackAttempts<=config.maxRollbackAttempts&&Array.isArray(cp.probes)&&cp.probes.length<=codeUpdateProbes.length&&cp.probes.every((p,i)=>p.id===codeUpdateProbes[i].id&&p.passed===true),'UPDATE_CHECKPOINT_INVALID');
   check(['BASELINE_VERIFIED','PACKAGES_VERIFIED','UPDATE_REQUESTED','UPDATED','VERIFIED','ROLLED_BACK'].includes(cp.phase)&&/^[a-f0-9]{64}$/.test(cp.boundaryHash??''),'UPDATE_CHECKPOINT_INVALID');
   for(const [name,pkg] of [['previousReceipt',config.previous],['candidateReceipt',config.candidate]]){
    const receipt=cp[name];
    if(receipt)check(receipt.sha256===pkg.sha256&&receipt.bytes===pkg.bytes&&receipt.key===pkg.key&&/^\d{1,30}$/.test(receipt.crc64??'')&&(!pkg.crc64||receipt.crc64===pkg.crc64),'UPDATE_CHECKPOINT_RECEIPT_INVALID');
   }
   check(!cp.updateRequested||(cp.previousReceipt&&cp.candidateReceipt&&cp.updateAttempts>0),'UPDATE_CHECKPOINT_INVALID');
   check(!cp.rollbackRequested||(cp.updateRequested&&cp.rollbackAttempts===1),'UPDATE_CHECKPOINT_INVALID');
   checkpointValidated=true;mayNeedRollback=cp.updateRequested===true;
   report.recovery=true;
   // The entry stage may fail after code verification succeeded. Use the same
   // original checkpoint and one rollback allowance; never relabel VERIFIED as
   // UPDATED or create a second operation to gain another write.
   if(rollbackOnly){
    check(cp.updateRequested&&cp.previousReceipt&&cp.candidateReceipt,'OUTER_ROLLBACK_NOT_READY');
    await rollback();return report;
   }
   if(cp.phase==='VERIFIED'){
    const s=await inspect();check(cp.candidateReceipt&&codeMatches(s.function,cp.candidateReceipt)&&cp.probes?.length===codeUpdateProbes.length,'VERIFIED_UPDATE_DRIFT');
    report.passed=true;report.reusedVerifiedResult=true;return report;
   }
   if(cp.rollbackRequested||cp.phase==='ROLLED_BACK'){await rollback();return report;}
   check(cp.updateRequested&&cp.candidateReceipt,'PREUPDATE_CHECKPOINT_RECONCILIATION_REQUIRED');
  }else{
   withinWindow();const state=await adapter.readState(),f=state.function,e=f?.environmentVariables??{};
   check(f?.functionName===config.functionName&&codeMatches(f,config.previous),'DEPLOYED_CODE_BASELINE_MISMATCH');
   check(e.V2_FC_PUBLIC_HTTP_ENABLED!=='true'&&e.V2_PROVISIONING_ONLY==='true'&&e.V2_PRIVATE_SMOKE_ENABLED==='true'&&f.cpu===0.25&&f.memorySize===512&&f.instanceConcurrency===1&&f.timeout<=120,'PRIVATE_CONFIGURATION_MISMATCH');
   check(Array.isArray(state.triggers)&&state.triggers.length===2&&state.triggers.every(t=>t.triggerType==='oss')&&state.concurrency?.reservedConcurrency===1&&state.scaling?.minInstances===0,'PRIVATE_RESOURCE_BOUNDARY_MISMATCH');
   const budget=await adapter.budget();check(budget?.currentCycle===true&&budget.complete===true&&Number.isFinite(budget.observedCny)&&budget.observedCny>=0&&Number.isFinite(budget.unsettledReservedCny)&&budget.unsettledReservedCny>=0&&budget.observedCny+budget.unsettledReservedCny+2<200,'PRIVATE_UPDATE_BUDGET_NOT_VERIFIED');
   cp={configHash:hash(config),operationId:config.operationId,targetHash:hash([config.account,config.region,config.functionName,config.bucket]),candidateSha:config.candidate.sha256,previousSha:config.previous.sha256,boundaryHash:codeUpdateBoundaryHash(state),invocations:0,updateAttempts:0,rollbackAttempts:0,phase:'BASELINE_VERIFIED',probes:[]};checkpointValidated=true;await write();
   const backup=await adapter.recoverRollback(config.previous);
   check(backup?.sha256===config.previous.sha256&&backup.bytes===config.previous.bytes&&backup.codeChecksum===config.previous.crc64&&backup.safelyRetained===true,'ROLLBACK_BYTES_NOT_VERIFIED');
   cp.previousReceipt=verifiedReceipt(await adapter.ensurePackage('previous',config.previous),config.previous);await write();
   cp.candidateReceipt=verifiedReceipt(await adapter.ensurePackage('candidate',config.candidate),config.candidate);cp.phase='PACKAGES_VERIFIED';await write();
   await invoke(codeUpdateProbes[0]);
   const fresh=await inspect();check(codeMatches(fresh.function,config.previous),'BASELINE_CHANGED_BEFORE_UPDATE');
   withinWindow();check(cp.updateAttempts<config.maxUpdateAttempts,'CODE_UPDATE_ATTEMPT_LIMIT');
   cp.updateRequested=true;cp.updateAttempts++;cp.phase='UPDATE_REQUESTED';await write();
   mayNeedRollback=true;
   try{await adapter.updateCode(codeBody(cp.candidateReceipt));}catch{cp.updateResponseUnknown=true;await write();}
  }
  const actual=await inspect();
  check(codeMatches(actual.function,cp.candidateReceipt),'UPDATE_OUTCOME_REQUIRES_READBACK');
  cp.phase='UPDATED';await write();
  for(const probe of codeUpdateProbes.slice(cp.probes.length)){
   cp.probes.push(await invoke(probe));await write();
  }
  const final=await inspect();check(codeMatches(final.function,cp.candidateReceipt),'CODE_CHANGED_DURING_VERIFICATION');
  cp.phase='VERIFIED';await write();report.passed=true;
 }catch(error){
  report.failure=error.safeCode??'CONTROL_UPDATE_UNCONFIRMED';
  if(error.safeDiagnostic)report.failureDiagnostic=error.safeDiagnostic;
  if(checkpointValidated&&mayNeedRollback&&cp?.phase!=='VERIFIED'){
   try{await rollback();}catch(e){report.rollbackFailure=e.safeCode??'ROLLBACK_UNCONFIRMED';}
  }
 }finally{
  if(cp){report.newInvocations=cp.invocations;report.cumulativeInvocations=config.previousInvocations+cp.invocations;report.updateAttempts=cp.updateAttempts;report.rollbackAttempts=cp.rollbackAttempts;}
 }
 return report;
}
