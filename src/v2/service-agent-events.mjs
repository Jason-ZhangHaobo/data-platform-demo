import {createAgentEventDriver} from './agent-event-driver.mjs';

const fail=(code,message,status=409)=>Object.assign(Error(message),{code,status});
const safeCode=error=>/^[A-Z][A-Z0-9_]{2,64}$/.test(error?.code??'')?error.code:'SERVICE_AGENT_EVENT_FAILED';

// Narrow adapter for one service-planning model boundary. Reuses the existing
// signed OSS outbox/consumer; it never applies a draft, runs Spark or publishes.
export function createServiceAgentEvents({store,project,engine,profile,transport,config,persist,now=Date.now}){
 if(profile?.driver!=='OSS_EVENTS')throw fail('SERVICE_AGENT_EVENT_DISABLED','事件执行模式未启用',503);
 const grantFor=id=>store.list('agent_background',project).find(g=>g.taskKind==='service_agent_plan'&&g.taskId===id);
 const duration=()=>{
  const remaining=Math.min(15*60000,Date.parse(profile.expiresAt)-now());
  if(remaining<60000)throw fail('SERVICE_AGENT_EVENT_WINDOW_TOO_SHORT','原窗口剩余不足一分钟，未登记新的模型事件');
  return remaining;
 };
 const bridge={prepareResume:async(id,options)=>{
  const task=store.get('service_agent_plan',id,project);
  if(!task)throw fail('SERVICE_AGENT_ACCESS_DENIED','原规划不可用',404);
  await engine.prepareEventResume(id,task.submittedBy,options);
 }};
 const dispatcher={tick:async({requestId,taskId})=>{
  const wake=store.get('agent_wake',requestId,project),g=grantFor(taskId),task=store.get('service_agent_plan',taskId,project);
  if(wake?.taskKind!=='service_agent_plan'||wake.taskId!==taskId||wake.grantId!==g?.id||g?.status!=='ACTIVE'||!task)
   return {state:'STEP_FAILED',code:'SERVICE_AGENT_EVENT_BINDING_INVALID'};
  if(task.stage==='MODEL_IN_FLIGHT'){
   if(task.version!==wake.taskVersion+1)return {state:'STALE'};
   if(Date.parse(task.durable?.leaseExpiresAt)>now())return {state:'BUSY'};
  }else if(task.version!==wake.taskVersion)return {state:'STALE'};
  try{
   const confirmModelRetry=task.stage==='MODEL_OUTCOME_UNKNOWN'&&g.review?.taskVersion===task.version&&g.review.confirmModelRetry===true;
   const result=await engine.advance(task.id,task.submittedBy,{expectedVersion:task.version,confirmModelRetry});
   return {state:'ADVANCED',taskId:result.id,status:result.status,stage:result.stage};
  }catch(error){return error.code==='SERVICE_AGENT_MODEL_BUSY'?{state:'BUSY'}:{state:'STEP_FAILED',code:safeCode(error)};}
 }};
 const driver=createAgentEventDriver({store,project,engine:bridge,dispatcher,transport,config,persist,now,taskKind:'service_agent_plan',
  assertExecutionScope:(task,boundary)=>engine.assertEventScope(task,boundary),
  assertCancelScope:task=>engine.eventTask(task.id,task.submittedBy)});
 async function advance(id,actorId,options){
  const original=engine.eventTask(id,actorId);
  if(!Number.isSafeInteger(options?.expectedVersion)||options.expectedVersion!==original.version||options.confirmModelRetry!==undefined&&typeof options.confirmModelRetry!=='boolean')
   throw fail('STALE_SERVICE_AGENT_VERSION','请读取原任务最新版本后再推进');
  if(['SUCCEEDED','FAILED','CANCELLED','APPLIED'].includes(original.status))return engine.read(id,actorId);
  // Reconcile only the old lease. This branch can mark UNKNOWN, never send a
  // second model or silently turn that reconciliation into consent to retry.
  if(original.stage==='MODEL_IN_FLIGHT')return engine.advance(id,actorId,options);
  const task=engine.reviewEventAdvance(id,actorId,options),developmentBoundary=engine.eventBoundary(task),durationMs=duration();
  let grant=grantFor(id);
  if(grant?.status==='ACTIVE'&&grant.delivery==='ACKNOWLEDGED'&&task.stage==='READY_FOR_MODEL'){
   await driver.resume(id,actorId,{...options,durationMs,developmentBoundary});
   return engine.read(id,actorId);
  }
  if(!grant||grant.status==='ACTIVE'){
   await driver.enable(id,actorId,{expectedVersion:task.version,maxEvents:profile.maxModelCalls,durationMs,developmentBoundary});
   grant=grantFor(id);
   if(grant?.status==='ACTIVE')return engine.read(id,actorId);
  }
  await driver.resume(id,actorId,{...options,durationMs,developmentBoundary});
  return engine.read(id,actorId);
 }
 return {advance,status:driver.status,consume:driver.consume,
  cancel:async(id,actorId)=>{const task=engine.eventTask(id,actorId);await engine.cancel(id,actorId);if(task.eventMode==='OSS_EVENTS')await driver.cancel(id,actorId);return engine.read(id,actorId);}};
}
