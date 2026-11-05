import {randomUUID} from 'node:crypto';
import {serviceHash} from './data-services.mjs';
import {servicePlanSourceBinding} from './service-plan-request.mjs';
import {bindServicePlanProposal,servicePlanDraftMatches} from './service-plan-proposal.mjs';
import {privateServiceAgentMode,assertServiceAgentActor,assertServiceAgentWindow,assertServiceAgentBill} from './private-service-agent-policy.mjs';
import {safeModelDiagnostic,modelFailure} from './model-diagnostics.mjs';

const fail=(code,message,status=409)=>Object.assign(Error(message),{status,code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const same=(a,b)=>serviceHash(a)===serviceHash(b);
const terminal=new Set(['SUCCEEDED','FAILED','CANCELLED','APPLIED']);
const usageOf=(usage,reserved)=>{
 const total=usage?.total_tokens,input=usage?.prompt_tokens??usage?.input_tokens,output=usage?.completion_tokens??usage?.output_tokens;
 if(!Number.isSafeInteger(total)||total<1||input!==undefined&&(!Number.isSafeInteger(input)||input<0||input>total)||output!==undefined&&(!Number.isSafeInteger(output)||output<0||output>total)||
  input!==undefined&&output!==undefined&&input+output!==total)return {usage:{total_tokens:reserved},estimated:true,spent:reserved};
 return {usage:{total_tokens:total,...(input===undefined?{}:{prompt_tokens:input}),...(output===undefined?{}:{completion_tokens:output})},estimated:false,spent:total};
};
const frozenFrom=context=>({sourceKind:context.sourceKind,sourceAttribution:context.sourceAttribution??null,sourceContext:context.sourceContext,releaseRun:context.releaseRuns[0]});

// One explicit advance owns one durable model boundary. This engine does not
// imply an installed event driver, nor does any GET start or retry a model.
export function createDurableServiceAgent({store,project,config,contextFor,assertVersions,validateProposal,createDraft,draftDetail,
 planner,persist,assertBudget,budgetOverview,now=Date.now,modelLeaseMs=90000}){
 if(![contextFor,assertVersions,validateProposal,createDraft,draftDetail,persist,assertBudget,budgetOverview].every(fn=>typeof fn==='function')||
  !Number.isSafeInteger(modelLeaseMs)||modelLeaseMs<1||modelLeaseMs>90000)throw Error('持久服务规划依赖或租约不合法');
 const active=new Map(),kind='service_agent_plan',stamp=()=>new Date(now()).toISOString();
 const get=id=>store.get(kind,id,project);
 const change=(task,patch)=>store.update(kind,task.id,project,patch,{expectedVersion:task.version});
 const namespace=(actor,key)=>`${project}:private-service-agent-plan:${actor}:${key}`;
 const original=(id,actorId)=>{
  const task=get(id),user=store.get('auth_user',actorId,project),role=user?.memberships?.find(item=>item.projectId===project)?.role;
  if(user?.status!=='ACTIVE'||!['ADMIN','ENGINEER','PRODUCT_MANAGER'].includes(role)||!task||task.executionMode!==privateServiceAgentMode||task.scope!=='PRIVATE_CLOUD_TEST'||task.projectId!==project||task.submittedBy!==actorId)
   throw fail('SERVICE_AGENT_ACCESS_DENIED','规划任务仅属于原创建者和项目',403);
  servicePlanSourceBinding(task.sourceBinding);
  if(serviceHash({sourceBinding:task.sourceBinding,frozenSource:task.frozenSource,resourceVersions:task.resourceVersions,services:task.services})!==task.contextHash||
   task.proposal&&serviceHash(task.proposal)!==task.proposalHash)throw fail('SERVICE_AGENT_RECORD_CHANGED','原规划的来源或方案摘要不一致');
  return task;
 };
 const checkedContext=(task,current=false)=>{
  const context=contextFor(task.submittedBy,task.sourceBinding);
  if(!same(frozenFrom(context),task.frozenSource))throw fail('SERVICE_AGENT_CONTEXT_CHANGED','原交付包口径、来源类型或发布版本已经变化');
  assertVersions(task.submittedBy,task.sourceBinding,task.selectedVersions??task.resourceVersions,current);
  return {binding:task.sourceBinding,sourceContext:task.frozenSource.sourceContext,releaseRuns:[task.frozenSource.releaseRun],services:task.services,resourceVersions:task.resourceVersions};
 };
 const visible=(task,actorId)=>{
  original(task.id,actorId);let sourceCheck='VERIFIED',sourceCheckCode;
  try{checkedContext(task);}catch(error){if(![403,404,409,422].includes(error.status))throw error;sourceCheck='UNAVAILABLE';sourceCheckCode='SERVICE_PLAN_SOURCE_UNAVAILABLE';}
  const {durable,submittedBy,services,frozenSource,policyFingerprint,...value}=task;
  return {...value,sourceCheck,...(sourceCheckCode?{sourceCheckCode}:{}),recovery:{supported:true,driver:'EXPLICIT_ADVANCE',backgroundDispatcherVerified:false,
   confirmationRequired:task.stage==='MODEL_OUTCOME_UNKNOWN',modelLeaseExpiresAt:durable?.leaseExpiresAt,
   leaseExpired:task.stage==='MODEL_IN_FLIGHT'&&Date.parse(durable?.leaseExpiresAt)<=now()}};
 };
 const windowRecord=()=>{
  const records=store.list('service_agent_window',project).filter(item=>item.profileId===config?.id);
  if(records.length>1)throw fail('SERVICE_AGENT_PROFILE_CHANGED','规划窗口记录不唯一，执行保持关闭');
  return records[0];
 };
 const assertPolicy=task=>{
  assertServiceAgentWindow(config,now());assertServiceAgentActor(config,task?.submittedBy??config.actorId,store,project);
  if(task&&(task.pilotId!==config.id||task.policyFingerprint!==config.fingerprint||!same(task.sourceBinding,config.sourceBinding)))
   throw fail('SERVICE_AGENT_PROFILE_CHANGED','原任务不属于当前已核定窗口；原记录和预算保持不变');
  const prior=windowRecord();if(prior&&prior.fingerprint!==config.fingerprint)throw fail('SERVICE_AGENT_PROFILE_CHANGED','同一规划窗口不能改写额度、期限或来源');
 };
 const stats=()=>store.list(kind,project).filter(task=>task.executionMode===privateServiceAgentMode&&task.pilotId===config?.id)
  .reduce((value,task)=>({plans:value.plans+1,calls:value.calls+task.attempts.length,tokens:value.tokens+task.usedTokens}),{plans:0,calls:0,tokens:0});
 const remaining=()=>{const value=stats();return Math.min(config.requestTokenLimit,config.tokenBudget-value.tokens,Math.floor((config.maxModelCostCny*1000000-value.tokens*200)/200));};
 const bill=additional=>assertServiceAgentBill(config,now(),budgetOverview(),additional*200/1000000);
 const leaseOwned=(id,token)=>{const task=get(id);return task?.stage==='MODEL_IN_FLIGHT'&&task.status==='RUNNING'&&task.durable?.leaseToken===token;};
 const finish=async(task,patch)=>{const value=change(task,patch);await persist();return value;};
 const replaceAttempt=(task,patch)=>task.attempts.map((value,index)=>index===task.attempts.length-1?{...value,...patch}:value);
 async function unknown(task,diagnostic=safeModelDiagnostic(modelFailure('MODEL_INTERRUPTED','LEASE'))){
  active.get(task.id)?.abort();
  return finish(task,{status:'INTERRUPTED',stage:'MODEL_OUTCOME_UNKNOWN',error:'模型结果尚未确认；次数和预算预留已保留，不会自动重复调用。',
   attempts:replaceAttempt(task,{status:'MODEL_OUTCOME_UNKNOWN',usageEstimated:true,diagnostic}),durable:{}});
 }
 async function notSent(task,diagnostic){
  active.get(task.id)?.abort();
  return finish(task,{status:'INTERRUPTED',stage:'MODEL_NOT_SENT',error:'模型请求在发送前停止；原尝试和保守预留保留，处理原因后可显式继续。',
   attempts:replaceAttempt(task,{status:'MODEL_NOT_SENT',usageEstimated:true,diagnostic}),durable:{}});
 }
 async function create({message,sourceBinding,actorId,requestId}){
  const binding=servicePlanSourceBinding(sourceBinding);
  if(typeof message!=='string'||message.trim().length<4||message.trim().length>2000||!uuid(requestId))throw fail('SERVICE_AGENT_INPUT_INVALID','规划需求和原请求UUID不合法',422);
  message=message.trim();const signature=serviceHash({message,sourceBinding:binding}),key=namespace(actorId,requestId),existing=store.deduplicatedId(key);
  if(existing){store.deduplicate(key,signature,()=>{throw Error('existing record required');});await persist();return visible(original(existing,actorId),actorId);}
  assertPolicy();if(actorId!==config.actorId||!same(binding,config.sourceBinding))throw fail('SERVICE_AGENT_SOURCE_DENIED','当前账号或来源不属于此规划窗口',403);
  const context=contextFor(actorId,binding),frozenSource=frozenFrom(context),resourceVersions=context.resourceVersions,services=context.services;
  const record=store.deduplicate(key,signature,()=>{
   assertPolicy();if(stats().plans>=config.maxPlans)throw fail('SERVICE_AGENT_PLAN_LIMIT','本窗口任务名额已用完；请恢复原请求',429);
   if(!windowRecord())store.create('service_agent_window',project,{profileId:config.id,fingerprint:config.fingerprint});
   // The store owns generated document ids; locate immutable window identities
   // by profileId, not by assuming create accepts a caller-supplied id.
   return store.create(kind,project,{message,sourceBinding:binding,sourceContext:context.sourceContext,sourceKind:context.sourceKind,
    ...(context.sourceAttribution?{sourceAttribution:context.sourceAttribution}:{}),resourceVersions,resourcesTruncated:context.resourcesTruncated,services,frozenSource,
    contextHash:serviceHash({sourceBinding:binding,frozenSource,resourceVersions,services}),submittedBy:actorId,requestId,pilotId:config.id,policyFingerprint:config.fingerprint,
    executionMode:privateServiceAgentMode,scope:'PRIVATE_CLOUD_TEST',mode:'LIVE_MODEL',requestedModel:config.model,executionWindow:{startsAt:config.startsAt,expiresAt:config.expiresAt},completionScope:'DATA_SERVICE_DESIGN',fullLifecycleE2E:false,agentIndependentE2E:false,publicDeployed:false,
    status:'QUEUED',stage:'READY_FOR_MODEL',attempts:[],usedTokens:0,requestTokenLimit:config.requestTokenLimit,tokenBudget:config.tokenBudget,maxAttempts:config.maxModelCalls,durable:{}});
  });
  await persist();return visible(original(record.id,actorId),actorId);
 }
 async function advance(id,actorId,{expectedVersion,confirmModelRetry=false}={}){
  let task=original(id,actorId);
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==task.version||typeof confirmModelRetry!=='boolean')throw fail('STALE_SERVICE_AGENT_VERSION','请读取原任务最新版本后再推进');
  if(terminal.has(task.status))return visible(task,actorId);
  if(task.stage==='MODEL_IN_FLIGHT'){
   if(Date.parse(task.durable?.leaseExpiresAt)>now())return visible(task,actorId);
   task=await unknown(task);return visible(task,actorId);
  }
  if(task.stage==='MODEL_OUTCOME_UNKNOWN'&&!confirmModelRetry)throw fail('SERVICE_AGENT_RETRY_CONFIRMATION_REQUIRED','上一次模型结果可能已收费，需明确确认后才能在剩余额度内重试');
  if(!['READY_FOR_MODEL','MODEL_NOT_SENT','MODEL_OUTCOME_UNKNOWN'].includes(task.stage))throw fail('SERVICE_AGENT_STAGE_INVALID','原任务阶段不支持模型推进');
  assertPolicy(task);const context=checkedContext(task,true),value=stats(),reserved=remaining();
  if(value.calls>=config.maxModelCalls||reserved<1024)throw fail('SERVICE_AGENT_EXECUTION_LIMIT','原窗口的模型次数、Token或费用额度已用完',429);
  bill(reserved);
  const token=randomUUID(),controller=new AbortController();active.set(task.id,controller);
  task=change(task,{status:'RUNNING',stage:'MODEL_IN_FLIGHT',error:undefined,usedTokens:task.usedTokens+reserved,
   attempts:[...task.attempts,{attempt:task.attempts.length+1,status:'MODEL_IN_FLIGHT',startedAt:stamp(),model:'unconfirmed',usage:{total_tokens:reserved},usageEstimated:true}],
   durable:{leaseToken:token,leaseExpiresAt:new Date(Math.min(now()+modelLeaseMs,Date.parse(config.expiresAt))).toISOString()}});
  try{await persist();}catch{
   active.delete(task.id);controller.abort();
   try{await notSent(get(task.id),safeModelDiagnostic(modelFailure('MODEL_RESERVATION_INVALID','PREPARE')));}catch{}
   throw fail('SERVICE_AGENT_RESERVATION_UNCONFIRMED','模型预留持久化尚未确认，未发送请求；请查询原任务',503);
  }
  let abort;const interrupted=new Promise((_,reject)=>{abort=()=>reject(modelFailure('MODEL_INTERRUPTED','LEASE'));controller.signal.addEventListener('abort',abort,{once:true});});
  const watchdog=setTimeout(()=>controller.abort(),Math.max(1,Math.min(modelLeaseMs,Date.parse(task.durable.leaseExpiresAt)-now())));watchdog.unref?.();
  let generated;
  try{
   const work=Promise.resolve().then(()=>{
    if(!leaseOwned(id,token)||controller.signal.aborted||now()>=Date.parse(task.durable.leaseExpiresAt))throw modelFailure('MODEL_INTERRUPTED','LEASE');
    try{assertPolicy(task);checkedContext(task,true);bill(0);assertBudget({taskId:id,attempt:task.attempts.length,leaseToken:token});}
    catch(error){const diagnostic=safeModelDiagnostic(error);if(diagnostic.phase==='PREPARE'&&diagnostic.requestMayHaveBeenSent===false)throw error;throw modelFailure('MODEL_CONFIG_INVALID','PREPARE');}
    return planner({message:task.message,services:context.services,releaseRuns:context.releaseRuns,sourceContext:context.sourceContext,signal:controller.signal,remainingBudget:reserved,
     modelBudgetReservation:{taskId:id,attempt:task.attempts.length,leaseToken:token}});
   });
   generated=await Promise.race([work,interrupted]);
  }catch(error){
   if(leaseOwned(id,token)){
    const diagnostic=safeModelDiagnostic(error);
    if(diagnostic.phase==='PREPARE'&&diagnostic.requestMayHaveBeenSent===false)await notSent(get(id),diagnostic);else await unknown(get(id),diagnostic);
   }
   return visible(original(id,actorId),actorId);
  }finally{clearTimeout(watchdog);controller.signal.removeEventListener('abort',abort);if(active.get(id)===controller)active.delete(id);}
  if(!leaseOwned(id,token))return visible(original(id,actorId),actorId);
  task=get(id);if(now()>=Date.parse(task.durable.leaseExpiresAt))return visible(await unknown(task),actorId);
  const measured=usageOf(generated?.usage,reserved),completed={usedTokens:task.usedTokens-reserved+measured.spent,durable:{},
   attempts:replaceAttempt(task,{status:'GENERATED',model:typeof generated?.model==='string'&&/^[A-Za-z0-9_.:/-]{1,100}$/.test(generated.model)?generated.model:'unconfirmed',usage:measured.usage,usageEstimated:measured.estimated,finishedAt:stamp()})};
  try{
   assertServiceAgentActor(config,actorId,store,project);checkedContext(task,true);
   if(generated.model!==task.requestedModel)throw fail('SERVICE_AGENT_MODEL_CHANGED','模型身份与原窗口不一致');
   if(measured.spent>reserved)throw fail('SERVICE_AGENT_TOKEN_LIMIT','模型用量超过原预留');
   const proposal=validateProposal(generated.plan),selectedVersions=bindServicePlanProposal(proposal,context);
   assertVersions(actorId,task.sourceBinding,selectedVersions,true);
   task=await finish(task,{...completed,status:'SUCCEEDED',stage:'SUCCEEDED',proposal,proposalHash:serviceHash(proposal),selectedVersions,
    explanation:typeof generated.explanation==='string'?generated.explanation.slice(0,1200):'',finishedAt:stamp()});
  }catch(error){
   // A checkpoint may have committed before a failed flush. Keep the original
   // result and its billing; never replace it with another paid attempt.
   const current=get(id);if(current.status==='SUCCEEDED')throw fail('SERVICE_AGENT_RESULT_UNCONFIRMED','方案检查点未确认，请读取原任务；未重新调用模型',503);
   task=await finish(current,{...completed,status:'FAILED',stage:'FAILED',error:'模型已返回，但原来源、固定版本或方案核验未通过；未创建接口。',errorCode:/^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'SERVICE_AGENT_PROPOSAL_INVALID',finishedAt:stamp()});
  }
  return visible(task,actorId);
 }
 async function cancel(id,actorId){
  const task=original(id,actorId);if(terminal.has(task.status))return visible(task,actorId);
  active.get(id)?.abort();return visible(await finish(task,{status:'CANCELLED',stage:'CANCELLED',durable:{},attempts:task.stage==='MODEL_IN_FLIGHT'?replaceAttempt(task,{status:'MODEL_OUTCOME_UNKNOWN',usageEstimated:true}):task.attempts,finishedAt:stamp()}),actorId);
 }
 async function apply(id,actorId,proposalHash){
  let task=original(id,actorId);assertPolicy(task);checkedContext(task);
  if(!['SUCCEEDED','APPLIED'].includes(task.status)||!task.proposal||proposalHash!==task.proposalHash)throw fail('SERVICE_AGENT_REVIEW_CHANGED','仅可确认当前完整方案摘要对应的草稿');
  const key=`${project}:private-service-agent-apply:${id}`,signature=serviceHash({actorId,sourceBinding:task.sourceBinding,proposalHash});
  const prior=store.deduplicatedId(key);
  if(!prior)assertVersions(actorId,task.sourceBinding,task.selectedVersions??[],true);
  const applied=store.deduplicate(key,signature,()=>createDraft(task.proposal,actorId)),service=draftDetail(applied.id,actorId);
  if(!servicePlanDraftMatches(service,task.proposal,task.sourceBinding))throw fail('APPLIED_SERVICE_CHANGED','原草稿已被修改，当前版本不能冒充原应用结果');
  if(task.status!=='APPLIED')task=change(task,{status:'APPLIED',stage:'APPLIED',serviceId:service.id,appliedVersionId:service.currentVersion.id,appliedConfigHash:service.currentVersion.configHash});
  await persist();return service;
 }
 return {configured:Boolean(config),create,advance,cancel,apply,
  read:(id,actorId)=>visible(original(id,actorId),actorId),
  request:(key,actorId)=>{if(!uuid(key))throw fail('SERVICE_AGENT_REQUEST_INVALID','原请求UUID不合法',422);const id=store.deduplicatedId(namespace(actorId,key));if(!id)throw fail('SERVICE_AGENT_REQUEST_NOT_FOUND','原请求尚未找到',404);return visible(original(id,actorId),actorId);},
  list:(binding,actorId)=>{binding=servicePlanSourceBinding(binding);return store.list(kind,project).filter(task=>task.executionMode===privateServiceAgentMode&&task.submittedBy===actorId&&same(task.sourceBinding,binding)).map(task=>visible(original(task.id,actorId),actorId));},
  shutdown:()=>{for(const value of active.values())value.abort();active.clear();}};
}
