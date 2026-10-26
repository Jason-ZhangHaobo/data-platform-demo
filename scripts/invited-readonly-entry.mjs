// Dedicated entry sequence, not a general cloud workflow engine. Adapters must
// make exactly one request per method, with no internal retries or logging of
// environment/cookie/certificate material. This file never loads credentials.
import {createHash} from 'node:crypto';
import {readonlyConfigIntegrity,readonlyFunctionState,readonlyDomainState,readonlyTriggerState,verifyInvitedReadonlyConfig} from './invited-readonly-config.mjs';
import {READONLY_ENTRY_SCOPE,READONLY_FILING_SCOPE,openingScope,publicSitePatch} from './invited-opening-scopes.mjs';
export {READONLY_ENTRY_SCOPE,READONLY_FILING_SCOPE};

const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v??null);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{safeCode:code});};
const writes=['createTrigger','updateDomain','openFunction','closeFunction','restoreDomain','deleteTrigger'];
export const readonlyEntryProbes=Object.freeze([
 {id:'default-disabled',target:'default',method:'GET',path:'/'},
 {id:'entry-html',target:'domain',method:'GET',path:'/v2/'},
 {id:'anonymous-session',target:'domain',method:'GET',path:'/api/v2/auth/session'},
 {id:'readonly-agent',target:'domain',method:'POST',path:'/api/v2/agent/tasks',body:{}},
 {id:'readonly-publish',target:'domain',method:'POST',path:'/api/v2/releases',body:{}},
 {id:'private-internal',target:'domain',method:'POST',path:'/api/v2/internal/scheduler/tick',body:{}},
 {id:'unmapped-invoke',target:'domain',method:'POST',path:'/invoke',body:{}},
 {id:'foreign-origin',target:'domain',method:'POST',path:'/api/v2/auth/login',headers:{Origin:'https://foreign.example.invalid'},body:{}},
 {id:'invalid-login',target:'domain',method:'POST',path:'/api/v2/auth/login',body:{email:'readonly-probe@example.invalid',password:'SyntheticWrong#2026'}},
]);
export function readonlyProbesFor(authorization){
 return openingScope(authorization).filingRepair?[...readonlyEntryProbes,{id:'filing-display',target:'domain',method:'GET',path:'/api/v2/status'}]:readonlyEntryProbes;
}

// Proposed revised allowance: must receive a NEW explicit human grant. The
// earlier 30-read card and old signed-domain grants cannot activate this scope.
export function readonlyEntryPlan(input,now=Date.now()){
 let scope;try{scope=openingScope(input?.authorization);}catch{check(false,'READONLY_ENTRY_NEW_GRANT_REQUIRED');}
 if(scope.filingRepair)publicSitePatch(input.publicSite);
 check(/^[a-f0-9]{32}$/.test(input.operationId??'')&&/^[a-f0-9]{40}$/.test(input.operatorSource??'')&&/^[a-f0-9]{64}$/.test(input.webIndexSha256??''),'READONLY_ENTRY_IDENTITY_INVALID');
 const issuedAt=Date.parse(input.issuedAt),expiresAt=Date.parse(input.expiresAt);
 check(Number.isFinite(issuedAt)&&issuedAt<=now&&Number.isFinite(expiresAt)&&expiresAt-issuedAt<=3600000&&expiresAt-now>=300000,'READONLY_ENTRY_WINDOW_INVALID');
 const seed=input.seed;
 check(seed?.newRequests===6&&Number.isSafeInteger(seed.configurationReads)&&seed.configurationReads>=17&&seed.configurationReads<=46,'READONLY_ENTRY_SEED_INVALID');
 return{authorization:scope.authorization,...(scope.filingRepair?{publicSite:structuredClone(input.publicSite)}:{}),operationId:input.operationId,operatorSource:input.operatorSource,webIndexSha256:input.webIndexSha256,issuedAt,expiresAt,
  seed:{newRequests:6,configurationReads:seed.configurationReads},
  limits:{historicalRequests:scope.historicalRequests,...(scope.filingRepair?{historicalConfigurationReads:58}:{}),newRequests:60,configurationReads:80,cleanupReadReserve:20,eachEntryWrite:1,incrementalCny:2,monthlyCny:200}};
}

export function readonlyEntryProbeAccepted(result,probe,plan){
 if(!result||result.tlsTrusted!==true||result.endpointMatched!==true||result.hasSetCookie===true||result.privateProtocol===true)return false;
 if(probe.target==='domain'&&result.certificateMatched!==true)return false;
 const body=result.body;
 switch(probe.id){
  case 'default-disabled':return result.status===403;
  case 'entry-html':return result.status===200&&result.contentType?.startsWith('text/html')&&result.attachment!==true&&result.bodySha256===plan.webIndexSha256;
  case 'anonymous-session':return result.status===200&&body?.authenticated===false&&body?.readOnly===true;
  case 'readonly-agent':case 'readonly-publish':return result.status===403&&body?.code==='PUBLIC_READ_ONLY';
  case 'private-internal':return result.status===404&&body?.code==='INGRESS_DENIED';
  case 'unmapped-invoke':return result.status===404&&result.serviceCode==='DomainRouteNotFound';
  case 'foreign-origin':return result.status===403&&body?.message==='请求来源不允许';
  case 'invalid-login':return result.status===401&&body?.code==='INVALID_LOGIN';
  case 'filing-display':return result.status===200&&body?.site?.icpNumber===plan.publicSite?.icpNumber&&body?.site?.registeredName===plan.publicSite?.registeredName;
  default:return false;
 }
}

export function readonlyProbeDiagnostic(result,probe,plan){
 // Record enough to distinguish edge rejection, stale application gates and
 // content mismatch, but never retain bodies, cookies, headers or PEM.
 const status=Number.isInteger(result?.status)&&result.status>=100&&result.status<=599?result.status:0;
 const expectedStatus=({'default-disabled':403,'entry-html':200,'anonymous-session':200,'readonly-agent':403,'readonly-publish':403,'private-internal':404,'unmapped-invoke':404,'foreign-origin':403,'invalid-login':401,'filing-display':200})[probe.id];
 const reasons=[];
 if(result?.tlsTrusted!==true)reasons.push('TLS_NOT_VERIFIED');
 if(result?.endpointMatched!==true)reasons.push('ENDPOINT_NOT_VERIFIED');
 if(probe.target==='domain'&&result?.certificateMatched!==true)reasons.push('CERTIFICATE_NOT_MATCHED');
 if(result?.hasSetCookie===true)reasons.push('UNEXPECTED_COOKIE');
 if(result?.privateProtocol===true)reasons.push('PRIVATE_PROTOCOL_EXPOSED');
 if(status!==expectedStatus)reasons.push('HTTP_STATUS_MISMATCH');
 const type=String(result?.contentType??'').split(';')[0].trim().toLowerCase();
 if(probe.id==='entry-html'){
  if(!String(result?.contentType??'').startsWith('text/html'))reasons.push('CONTENT_TYPE_MISMATCH');
  if(result?.bodySha256!==plan.webIndexSha256)reasons.push('HTML_DIGEST_MISMATCH');
  if(result?.attachment===true)reasons.push('ATTACHMENT_RESPONSE');
 }
 if(!readonlyEntryProbeAccepted(result,probe,plan)&&!reasons.length)reasons.push('APPLICATION_CONTRACT_MISMATCH');
 const code=result?.body?.code??result?.serviceCode;
 const knownCodes=['INGRESS_DENIED','PUBLIC_READ_ONLY','INVALID_LOGIN','DomainRouteNotFound','FunctionNotFound','AccessDenied','FunctionAccessDenied','FunctionNotReady','ServiceUnavailable','InternalServerError'];
 return{probeId:probe.id,status,expectedStatus,reasons,tlsTrusted:result?.tlsTrusted===true,endpointMatched:result?.endpointMatched===true,certificateMatched:result?.certificateMatched===true,
  contentType:['text/html','application/json','text/plain','application/octet-stream'].includes(type)?type:type?'OTHER':'MISSING',
  bytes:Number.isSafeInteger(result?.bytes)&&result.bytes>=0&&result.bytes<=65536?result.bytes:null,
  bodySha256:/^[a-f0-9]{64}$/.test(result?.bodySha256??'')?result.bodySha256:null,
  ...(probe.id==='entry-html'?{expectedBodySha256:plan.webIndexSha256}:{}),
  applicationCode:knownCodes.includes(code)?code:typeof code==='string'?'OTHER':'MISSING'};
}

export async function runReadonlyEntry(plan,change,adapter,{load,save,now=Date.now,beginCleanup=()=>{},rollbackOnly=false}={}){
 check(typeof load==='function'&&typeof save==='function','READONLY_ENTRY_CHECKPOINT_REQUIRED');
 check(readonlyConfigIntegrity(change)&&change.operationId===plan?.operationId,'READONLY_ENTRY_CHANGE_INVALID');
 check(plan.seed?.configurationReads>=change.codeConfigurationReads,'READONLY_ENTRY_PRIOR_USAGE_MISSING');
 const normalized=readonlyEntryPlan({...plan,issuedAt:new Date(plan.issuedAt).toISOString(),expiresAt:new Date(plan.expiresAt).toISOString()},plan.issuedAt);
 check(canonical(plan)===canonical(normalized),'READONLY_ENTRY_PLAN_CHANGED');
 check((change.authorization??READONLY_ENTRY_SCOPE)===plan.authorization,'READONLY_ENTRY_SCOPE_CHANGED');
 if(openingScope(plan.authorization).filingRepair)check(canonical(change.publicSite)===canonical(plan.publicSite),'READONLY_ENTRY_PUBLIC_SITE_CHANGED');
 const probes=readonlyProbesFor(plan.authorization);
 check(now()<plan.expiresAt,'READONLY_ENTRY_WINDOW_EXPIRED');
 let cp=structuredClone(await load()),validated=false,cleanup=false,retainedOnEntry=false,lastAction;
 const report={scope:'INVITED_READONLY_ENTRY',passed:false,entryRetained:false,invitedUserAccepted:false,modelCallsRequested:0,sparkRunsRequested:0,externalCleanupRequired:true};
 const persist=()=>save(structuredClone(cp));
 const reserve=async(kind)=>{
  check(now()<plan.expiresAt,'READONLY_ENTRY_WINDOW_EXPIRED');
  if(kind==='configurationReads'){
   check(cp.configurationReads<plan.limits.configurationReads,'READONLY_ENTRY_READ_LIMIT');
   if(!cleanup)check(cp.configurationReads+1+plan.limits.cleanupReadReserve<=plan.limits.configurationReads,'READONLY_ENTRY_CLEANUP_RESERVE');
   cp.configurationReads++;
  }else if(kind==='newRequests'){
   check(cp.newRequests<plan.limits.newRequests,'READONLY_ENTRY_REQUEST_LIMIT');cp.newRequests++;
  }else{
   check(writes.includes(kind)&&!cp.writes[kind],'READONLY_ENTRY_WRITE_ALREADY_REQUESTED');
   if(!cleanup)check(now()<plan.expiresAt-300000,'READONLY_ENTRY_CLEANUP_TIME_RESERVE');
   cp.writes[kind]=true;
  }
  await persist();
 };
 const read=async name=>{lastAction=name;await reserve('configurationReads');return adapter[name]();};
 const writeOnce=async(name,body)=>{
  if(cp.writes[name])return;
  lastAction=name;
  await reserve(name);
  try{await adapter[name](structuredClone(body));}catch{cp.unknownWrites[name]=true;await persist();}
 };
 const readAll=async()=>{
  const fn=await read('readFunction'),domain=await read('readDomain'),triggers=await read('listTriggers');
  const concurrency=await read('readConcurrency'),scaling=await read('readScaling');
  return{state:{function:fn,triggers,concurrency,scaling},domain};
 };
 const rollback=async()=>{
  await beginCleanup();
  cleanup=true;cp.phase='ROLLING_BACK';await persist();
  const result={functionRestored:false,domainRestored:false,triggerAbsent:false,issues:[]};
  // Reconcile each resource independently. A foreign domain must not prevent
  // closing our unchanged function, nor justify overwriting that foreign domain.
  try{
   let fn=await read('readFunction'),status=readonlyFunctionState(change,fn);
   if(status==='OPENED'){
    check(cp.writes.openFunction,'READONLY_UNOWNED_OPEN_FUNCTION');
    await writeOnce('closeFunction',change.rollbackFunctionBody);
    fn=await read('readFunction');status=readonlyFunctionState(change,fn);
   }
   check(status!=='FOREIGN','READONLY_FUNCTION_DRIFT_DO_NOT_OVERWRITE');
   check(status==='BASELINE','READONLY_FUNCTION_RESTORE_UNCONFIRMED');result.functionRestored=true;
  }catch(e){result.issues.push(e.safeCode??'READONLY_FUNCTION_READ_FAILED');}
  try{
   let domain=await read('readDomain'),status=readonlyDomainState(change,domain);
   if(status==='OPENED'){
    check(cp.writes.updateDomain,'READONLY_UNOWNED_OPEN_DOMAIN');
    await writeOnce('restoreDomain',change.rollbackDomainBody);
    domain=await read('readDomain');status=readonlyDomainState(change,domain);
   }
   check(status!=='FOREIGN','READONLY_DOMAIN_DRIFT_DO_NOT_OVERWRITE');
   check(status==='BASELINE','READONLY_DOMAIN_RESTORE_UNCONFIRMED');result.domainRestored=true;
  }catch(e){result.issues.push(e.safeCode??'READONLY_DOMAIN_READ_FAILED');}
  try{
   let triggers=await read('listTriggers'),status=readonlyTriggerState(change,triggers);
   if(status==='OWNED'){
    check(cp.writes.createTrigger,'READONLY_UNOWNED_TRIGGER');
    await writeOnce('deleteTrigger',change.triggerBody.triggerName);
    triggers=await read('listTriggers');status=readonlyTriggerState(change,triggers);
   }
   check(status!=='FOREIGN','READONLY_TRIGGER_DRIFT_DO_NOT_DELETE');
   check(status==='ABSENT','READONLY_TRIGGER_REMOVAL_UNCONFIRMED');result.triggerAbsent=true;
  }catch(e){result.issues.push(e.safeCode??'READONLY_TRIGGER_READ_FAILED');}
  result.entryClosed=result.functionRestored||result.domainRestored||result.triggerAbsent;
  cp.rollback=result;cp.phase=result.functionRestored&&result.domainRestored&&result.triggerAbsent?'ROLLED_BACK':'NEEDS_ATTENTION';
  await persist();return result;
 };
 try{
  check(!rollbackOnly||cp,'READONLY_CLEANUP_CHECKPOINT_REQUIRED');
  if(cp){
   check(cp.version===1&&cp.planHash===hash(plan)&&cp.changeHash===change.changeHash,'READONLY_ENTRY_CHECKPOINT_MISMATCH');
   check(Number.isSafeInteger(cp.configurationReads)&&cp.configurationReads>=plan.seed.configurationReads&&cp.configurationReads<=plan.limits.configurationReads&&Number.isSafeInteger(cp.newRequests)&&cp.newRequests>=plan.seed.newRequests&&cp.newRequests<=plan.limits.newRequests,'READONLY_ENTRY_COUNTER_INVALID');
   check(cp.writes&&cp.unknownWrites&&Object.keys(cp.writes).every(k=>writes.includes(k)&&cp.writes[k]===true)&&Object.keys(cp.unknownWrites).every(k=>cp.writes[k]&&cp.unknownWrites[k]===true),'READONLY_ENTRY_WRITES_INVALID');
   check(['ACTIVE','VERIFIED','ROLLING_BACK','ROLLED_BACK','NEEDS_ATTENTION'].includes(cp.phase)&&Array.isArray(cp.probes)&&cp.probes.length<=probes.length&&cp.probes.every((p,i)=>p.id===probes[i].id&&p.accepted===true),'READONLY_ENTRY_PHASE_INVALID');
   check(cp.probeAttempts&&Object.entries(cp.probeAttempts).every(([id,count])=>{
    const index=probes.findIndex(p=>p.id===id),probe=probes[index];
    return index>=0&&index<=cp.probes.length&&Number.isSafeInteger(count)&&count>=1&&count<=(probe.method==='GET'?2:1);
   })&&cp.probes.every(p=>cp.probeAttempts[p.id]>=1),'READONLY_ENTRY_PROBE_LEDGER_INVALID');
   check(cp.newRequests===plan.seed.newRequests+Object.values(cp.probeAttempts).reduce((a,b)=>a+b,0),'READONLY_ENTRY_COUNTER_INVALID');
   for(const [later,earlier] of [['updateDomain','createTrigger'],['openFunction','updateDomain'],['closeFunction','openFunction'],['restoreDomain','updateDomain'],['deleteTrigger','createTrigger']])
    check(!cp.writes[later]||cp.writes[earlier],'READONLY_ENTRY_WRITE_ORDER_INVALID');
   if(cp.phase==='VERIFIED')check(cp.probes.length===probes.length&&cp.writes.openFunction&&!cp.writes.closeFunction&&!cp.writes.restoreDomain&&!cp.writes.deleteTrigger,'READONLY_ENTRY_VERIFIED_CHECKPOINT_INVALID');
  }else{
   check(plan.limits.configurationReads-plan.seed.configurationReads>=34,'READONLY_ENTRY_BUDGET_TOO_SMALL');
   cp={version:1,planHash:hash(plan),changeHash:change.changeHash,phase:'ACTIVE',newRequests:plan.seed.newRequests,configurationReads:plan.seed.configurationReads,writes:{},unknownWrites:{},probes:[],probeAttempts:{}};
   await persist();
  }
  validated=true;
  retainedOnEntry=cp.phase==='VERIFIED';
  if(cp.phase==='ROLLED_BACK'){report.rollback=cp.rollback;report.previouslyRolledBack=true;return report;}
  if(['ROLLING_BACK','NEEDS_ATTENTION'].includes(cp.phase)){report.rollback=await rollback();return report;}
  if(rollbackOnly){
   if(retainedOnEntry){report.entryRetained=true;report.previouslyRetained=true;return report;}
   if(Object.keys(cp.writes).length)report.rollback=await rollback();
   return report;
  }
  const current=await readAll();
  if(cp.phase==='VERIFIED'){
   check(verifyInvitedReadonlyConfig(change,current),'READONLY_RETAINED_ENTRY_DRIFT');
   report.passed=true;report.entryRetained=true;report.reusedVerifiedEvidence=true;return report;
  }
  const fnState=readonlyFunctionState(change,current.state.function),domainState=readonlyDomainState(change,current.domain),triggerState=readonlyTriggerState(change,current.state.triggers);
  check(fnState==='BASELINE'||(fnState==='OPENED'&&cp.writes.openFunction),'READONLY_FUNCTION_BASELINE_DRIFT');
  check(domainState==='BASELINE'||(domainState==='OPENED'&&cp.writes.updateDomain),'READONLY_DOMAIN_BASELINE_DRIFT');
  check(triggerState==='ABSENT'||(triggerState==='OWNED'&&cp.writes.createTrigger),'READONLY_TRIGGER_BASELINE_DRIFT');
  check(canonical(current.state.concurrency)===canonical(change.resourceConfiguration.concurrency)&&canonical(current.state.scaling)===canonical(change.resourceConfiguration.scaling),'READONLY_CAPACITY_DRIFT');
  if(triggerState==='ABSENT'){
   check(!cp.writes.createTrigger,'READONLY_TRIGGER_CREATE_UNCONFIRMED');
   await writeOnce('createTrigger',change.triggerBody);
   check(readonlyTriggerState(change,await read('listTriggers'))==='OWNED','READONLY_TRIGGER_CREATE_UNCONFIRMED');
  }
  if(domainState==='BASELINE'){
   check(!cp.writes.updateDomain,'READONLY_DOMAIN_UPDATE_UNCONFIRMED');
   await writeOnce('updateDomain',change.domainBody);
   check(readonlyDomainState(change,await read('readDomain'))==='OPENED','READONLY_DOMAIN_UPDATE_UNCONFIRMED');
  }
  if(fnState==='BASELINE'){
   check(!cp.writes.openFunction,'READONLY_FUNCTION_OPEN_UNCONFIRMED');
   check(readonlyFunctionState(change,await read('readFunction'))==='BASELINE','READONLY_FUNCTION_CHANGED_BEFORE_OPEN');
   await writeOnce('openFunction',change.functionBody);
   check(readonlyFunctionState(change,await read('readFunction'))==='OPENED','READONLY_FUNCTION_OPEN_UNCONFIRMED');
  }
  for(const probe of probes.slice(cp.probes.length)){
   lastAction=probe.id;
   const attempts=cp.probeAttempts[probe.id]??0;
   check(attempts===0||(attempts===1&&probe.method==='GET'),'READONLY_PROBE_OUTCOME_UNKNOWN');
   cp.probeAttempts[probe.id]=attempts+1;
   await reserve('newRequests');
   const result=await adapter.probe(structuredClone(probe));
   if(['readonly-agent','readonly-publish'].includes(probe.id)&&result?.status>=200&&result.status<300)
    report.possibleUnexpectedWrite=true;
   if(!readonlyEntryProbeAccepted(result,probe,plan)){
    cp.failedProbe=readonlyProbeDiagnostic(result,probe,plan);
    report.failureDiagnostic=structuredClone(cp.failedProbe);
    await persist();
    check(false,'READONLY_ENTRY_PROBE_REJECTED');
   }
   cp.probes.push({id:probe.id,status:result.status,accepted:true});await persist();
  }
  check(verifyInvitedReadonlyConfig(change,await readAll()),'READONLY_FINAL_CONFIGURATION_DRIFT');
  cp.phase='VERIFIED';await persist();report.passed=true;report.entryRetained=true;
 }catch(error){
  report.failure=error.safeCode??'READONLY_ENTRY_UNCONFIRMED';
  report.failureAt=lastAction??'checkpoint';
  if(validated&&!retainedOnEntry&&Object.keys(cp.writes).length){
   try{report.rollback=await rollback();}catch(e){report.rollbackFailure=e.safeCode??'READONLY_ENTRY_ROLLBACK_UNCONFIRMED';}
  }
 }finally{
  if(cp&&validated){
   report.newRequests=cp.newRequests;report.cumulativeRequests=plan.limits.historicalRequests+cp.newRequests;
   report.configurationReads=cp.configurationReads;report.entryWriteRequests={...cp.writes};report.phase=cp.phase;
  }
 }
 return report;
}
