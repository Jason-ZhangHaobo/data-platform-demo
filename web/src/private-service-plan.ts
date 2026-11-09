import {sameServicePlanSource,validServicePlanSource} from './service-plan-source.ts';
import type {ServicePlanSource,SourcePlan} from './service-plan-source.ts';
import type {ServiceSourceBinding} from './service-source-binding.ts';

export type ServicePlanningAccess={enabled:boolean;reason?:'BOUNDARY_CHANGED'|'NOT_STARTED'|'EXPIRED';id?:string;sourceBinding?:ServicePlanSource;model?:string;driver?:'EXPLICIT_ADVANCE'|'OSS_EVENTS';startsAt?:string;expiresAt?:string;maxPlans?:number;maxModelCalls?:number;tokenBudget?:number};
type ServiceBackground={protocol:'shuduo-service-agent-event-driver/v1';taskId:string;status:string;expiresAt?:number;maxEvents?:number;consumedEvents?:number;delivery?:string;state?:string;code?:string;cloudDriverVerified:false;publicationAutomatic?:false;scopeBlocked?:boolean};
type VersionRef={serviceId:string;versionId:string;configHash:string;fields:string[]};
type Diagnostic={code:string;phase:string;requestMayHaveBeenSent:boolean;httpStatus?:number;networkCode?:string;elapsedMs:number};
export type PrivateServicePlan=SourcePlan&{version:number;stage:string;pilotId:string;executionMode:'DURABLE_PRIVATE_SERVICE_AGENT_V1';scope:'PRIVATE_CLOUD_TEST';mode:'LIVE_MODEL';requestId:string;
 sourceBinding:ServicePlanSource;sourceKind:'AGENT'|'MANUAL';sourceAttribution?:'ENGINEER_ASSISTED'|'ENGINEER_AUTHORED';sourceRevisionId:string;sourceRunId:string;
 sourceCheck:'VERIFIED'|'UNAVAILABLE';sourceContext:{id:string;name:string;definition:string;validationContractId:string;metricLabels:Record<string,string>};
 resourceVersions:VersionRef[];selectedVersions?:VersionRef[];proposalHash?:string;requestedModel:string;executionWindow:{startsAt:string;expiresAt:string};maxAttempts:number;requestTokenLimit:number;tokenBudget:number;usedTokens:number;
 attempts:{attempt:number;status:string;model:string;usage:{total_tokens:number;prompt_tokens?:number;completion_tokens?:number};usageEstimated:boolean;startedAt:string;finishedAt?:string;diagnostic?:Diagnostic}[];
 quota:{attemptsUsed:number;attemptLimit:number;usedTokens:number;tokenLimit:number};
 recovery:{supported:true;driver:'EXPLICIT_ADVANCE'|'OSS_EVENTS';background?:ServiceBackground;backgroundDispatcherVerified:false;confirmationRequired:boolean;modelLeaseExpiresAt?:string;leaseExpired:boolean};};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max;
const int=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const date=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const record=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const exact=(v:unknown,keys:string[])=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const only=(v:unknown,keys:string[])=>record(v)&&Object.keys(v).every(k=>keys.includes(k));
const fields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
const validFields=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>=1&&v.length<=5&&new Set(v).size===v.length&&v.every(key=>fields.includes(key));
const refValid=(v:unknown):v is VersionRef=>exact(v,['serviceId','versionId','configHash','fields'])&&uuid((v as VersionRef).serviceId)&&uuid((v as VersionRef).versionId)&&hash((v as VersionRef).configHash)&&validFields((v as VersionRef).fields);
const sameRef=(a:VersionRef,b:VersionRef)=>a.serviceId===b.serviceId&&a.versionId===b.versionId&&a.configHash===b.configHash&&JSON.stringify(a.fields)===JSON.stringify(b.fields);
const allowed=['id','projectId','createdAt','updatedAt','version','message','sourceBinding','sourceContext','sourceKind','sourceAttribution','sourceRevisionId','sourceRunId','resourceVersions','resourcesTruncated','contextHash','requestId','pilotId','executionMode','scope','mode','requestedModel','executionWindow','completionScope','fullLifecycleE2E','agentIndependentE2E','publicDeployed','status','stage','attempts','usedTokens','requestTokenLimit','tokenBudget','maxAttempts','proposal','proposalHash','selectedVersions','explanation','finishedAt','error','errorCode','serviceId','appliedVersionId','appliedConfigHash','sourceCheck','sourceCheckCode','recovery','quota'];

export function checkedPrivateServicePlan(value:unknown,source:ServicePlanSource,binding:ServiceSourceBinding):PrivateServicePlan{
 const fail=()=>{throw Error('原私有规划回执不完整或与当前来源不一致；原编号保留，未重复提交。');};
 try{
  if(!only(value,allowed))fail();const p=value as PrivateServicePlan;
  if(!uuid(p.id)||!uuid(p.requestId)||!uuid(p.pilotId)||!int(p.version,1)||!sameServicePlanSource(p.sourceBinding,source)||p.scope!=='PRIVATE_CLOUD_TEST'||p.executionMode!=='DURABLE_PRIVATE_SERVICE_AGENT_V1'||p.mode!=='LIVE_MODEL'||
   p.completionScope!=='DATA_SERVICE_DESIGN'||p.fullLifecycleE2E!==false||p.agentIndependentE2E!==false||p.publicDeployed!==false||
   p.sourceKind!==binding.sourceKind||!uuid(p.sourceRevisionId)||!uuid(p.sourceRunId)||p.sourceKind==='MANUAL'&&(p.sourceAttribution!==(binding.manualDeliveryTaskId?'ENGINEER_AUTHORED':'ENGINEER_ASSISTED')||p.sourceRevisionId!==binding.revisionId||p.sourceRunId!==binding.runId)||p.sourceKind==='AGENT'&&p.sourceAttribution!==undefined||
   !['VERIFIED','UNAVAILABLE'].includes(p.sourceCheck)||!text(p.message,2000)||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED','APPLIED'].includes(p.status)||
   !['READY_FOR_MODEL','MODEL_IN_FLIGHT','MODEL_OUTCOME_UNKNOWN','MODEL_NOT_SENT','SUCCEEDED','FAILED','CANCELLED','APPLIED'].includes(p.stage)||
   !text(p.requestedModel,100)||!/^[A-Za-z0-9_.:/-]+$/.test(p.requestedModel)||!exact(p.executionWindow,['startsAt','expiresAt'])||!date(p.executionWindow.startsAt)||!date(p.executionWindow.expiresAt)||
   Date.parse(p.executionWindow.expiresAt)<=Date.parse(p.executionWindow.startsAt)||Date.parse(p.executionWindow.expiresAt)-Date.parse(p.executionWindow.startsAt)>7200000||
   !int(p.maxAttempts,1,3)||!int(p.requestTokenLimit,1024,24000)||!int(p.tokenBudget,p.requestTokenLimit,24000)||!int(p.usedTokens)||
   !exact(p.quota,['attemptsUsed','attemptLimit','usedTokens','tokenLimit'])||!int(p.quota.attemptsUsed)||p.quota.attemptLimit!==p.maxAttempts||!int(p.quota.usedTokens,p.usedTokens)||p.quota.tokenLimit!==p.tokenBudget)fail();
  const context=p.sourceContext;
  const stageStatus:Record<string,string>={READY_FOR_MODEL:'QUEUED',MODEL_IN_FLIGHT:'RUNNING',MODEL_OUTCOME_UNKNOWN:'INTERRUPTED',MODEL_NOT_SENT:'INTERRUPTED',SUCCEEDED:'SUCCEEDED',APPLIED:'APPLIED',FAILED:'FAILED',CANCELLED:'CANCELLED'};
  if(stageStatus[p.stage]!==p.status)fail();
  if(!exact(context,['id','name','definition','validationContractId','metricLabels'])||!text(context.id,100)||!text(context.name,160)||!text(context.definition,2000)||!text(context.validationContractId,160)||!exact(context.metricLabels,fields)||fields.some(field=>!text(context.metricLabels[field],160)))fail();
  const r=p.recovery;
  if(!only(r,['supported','driver','background','backgroundDispatcherVerified','confirmationRequired','modelLeaseExpiresAt','leaseExpired'])||r.supported!==true||!['EXPLICIT_ADVANCE','OSS_EVENTS'].includes(r.driver)||r.backgroundDispatcherVerified!==false||
   r.confirmationRequired!==(p.stage==='MODEL_OUTCOME_UNKNOWN')||typeof r.leaseExpired!=='boolean'||r.modelLeaseExpiresAt!==undefined&&!date(r.modelLeaseExpiresAt)||
   p.stage==='MODEL_IN_FLIGHT'&&(!date(r.modelLeaseExpiresAt)||Date.parse(r.modelLeaseExpiresAt)>Date.parse(p.executionWindow.expiresAt)))fail();
  const b=r.background;
  if(b&&(!only(b,['protocol','taskId','status','expiresAt','maxEvents','consumedEvents','delivery','state','code','cloudDriverVerified','publicationAutomatic','scopeBlocked'])||r.driver!=='OSS_EVENTS'||
   b.protocol!=='shuduo-service-agent-event-driver/v1'||b.taskId!==p.id||b.cloudDriverVerified!==false||!['INACTIVE','ACTIVE','COMPLETED','NEEDS_CONFIRMATION','PAUSED','EXPIRED','CANCELLED'].includes(b.status)||
   b.status!=='INACTIVE'&&(!int(b.expiresAt,1)||!int(b.maxEvents,1,3)||!int(b.consumedEvents,0,b.maxEvents)||b.publicationAutomatic!==false)||
   b.expiresAt!==undefined&&(!int(b.expiresAt,1)||b.expiresAt>Date.parse(p.executionWindow.expiresAt))||b.maxEvents!==undefined&&!int(b.maxEvents,1,p.maxAttempts)||b.consumedEvents!==undefined&&!int(b.consumedEvents,0,b.maxEvents??3)||b.publicationAutomatic!==undefined&&b.publicationAutomatic!==false||
   b.delivery!==undefined&&!['ACKNOWLEDGED','UNCONFIRMED','WAITING_FOR_CHECKPOINT','ALREADY_CONSUMED'].includes(b.delivery)||
   b.state!==undefined&&!['QUEUED','RUNNING','WAITING_FOR_RESULT','READY_FOR_MODEL','MODEL_IN_FLIGHT','MODEL_OUTCOME_UNKNOWN','MODEL_NOT_SENT','COMPLETED','NEEDS_CONFIRMATION','PAUSED','EXPIRED','CANCELLED'].includes(b.state)||
   b.code!==undefined&&!/^[A-Z][A-Z0-9_]{2,64}$/.test(b.code)||b.scopeBlocked!==undefined&&typeof b.scopeBlocked!=='boolean'))fail();
  if(!Array.isArray(p.attempts)||p.attempts.length>3||p.quota.attemptsUsed<p.attempts.length)fail();
  for(const [index,a]of p.attempts.entries()){
   if(!only(a,['attempt','status','startedAt','model','usage','usageEstimated','finishedAt','diagnostic'])||a.attempt!==index+1||!date(a.startedAt)||a.finishedAt!==undefined&&!date(a.finishedAt)||
    !['MODEL_IN_FLIGHT','MODEL_OUTCOME_UNKNOWN','MODEL_NOT_SENT','GENERATED'].includes(a.status)||!text(a.model,100)||typeof a.usageEstimated!=='boolean'||
    !only(a.usage,['total_tokens','prompt_tokens','completion_tokens'])||!int(a.usage.total_tokens,1)||[a.usage.prompt_tokens,a.usage.completion_tokens].some(v=>v!==undefined&&!int(v))||
    a.usage.prompt_tokens!==undefined&&a.usage.prompt_tokens>a.usage.total_tokens||a.usage.completion_tokens!==undefined&&a.usage.completion_tokens>a.usage.total_tokens)fail();
   const d=a.diagnostic;if(d&&(!only(d,['code','phase','requestMayHaveBeenSent','httpStatus','networkCode','elapsedMs'])||!text(d.code,80)||!/^[A-Z0-9_]+$/.test(d.code)||
    !['PREPARE','REQUEST','RESPONSE','PARSE','LEASE'].includes(d.phase)||typeof d.requestMayHaveBeenSent!=='boolean'||!int(d.elapsedMs)||d.httpStatus!==undefined&&!int(d.httpStatus,100,599)||d.networkCode!==undefined&&!/^[A-Z0-9_]{1,80}$/.test(d.networkCode)))fail();
  }
  if(p.attempts.reduce((sum,a)=>sum+a.usage.total_tokens,0)!==p.usedTokens||!Array.isArray(p.resourceVersions)||p.resourceVersions.length>100||!p.resourceVersions.every(refValid)||new Set(p.resourceVersions.map(ref=>ref.serviceId)).size!==p.resourceVersions.length)fail();
  const proposal=p.proposal;
  if(['SUCCEEDED','APPLIED'].includes(p.status)&&(!proposal||!hash(p.proposalHash)))fail();
  if(proposal){
   if(!only(proposal,proposal.serviceType==='DAPI'?['serviceType','name','slug','timeoutMs','rateLimitPerMinute','sourceReleaseRunId','fields']:['serviceType','name','slug','timeoutMs','rateLimitPerMinute','steps'])||
    !['DAPI','XAPI'].includes(proposal.serviceType)||!text(proposal.name,80)||!text(proposal.slug,48)||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(proposal.slug)||!int(proposal.timeoutMs,100,5000)||!int(proposal.rateLimitPerMinute,1,600)||
    !Array.isArray(p.selectedVersions)||!p.selectedVersions.every(refValid)||p.selectedVersions.some(ref=>!p.resourceVersions.some(original=>sameRef(ref,original))))fail();
   if(proposal.serviceType==='DAPI'&&(proposal.sourceReleaseRunId!==source.sourceReleaseRunId||!validFields(proposal.fields)||!proposal.fields.includes('client_id')||p.selectedVersions!.length!==0))fail();
   if(proposal.serviceType==='XAPI'&&(!Array.isArray(proposal.steps)||proposal.steps.length<2||proposal.steps.length>5||new Set(proposal.steps.map(step=>step.alias)).size!==proposal.steps.length||
    p.selectedVersions!.length!==proposal.steps.length||proposal.steps.some(step=>!exact(step,['alias','dapiId','dapiVersionId'])||!/^[a-z][a-z0-9_]{1,29}$/.test(step.alias)||!p.selectedVersions!.some(ref=>ref.serviceId===step.dapiId&&ref.versionId===step.dapiVersionId))))fail();
  }
  if([p.error,p.explanation].some(v=>v!==undefined&&(typeof v!=='string'||v.length>8000))||p.status==='APPLIED'&&(!uuid(p.serviceId)||!uuid(p.appliedVersionId)||!hash(p.appliedConfigHash)))fail();
  return p;
 }catch{fail();}
 throw Error('规划回执未确认');
}
export function servicePlanningWindowOpen(access:ServicePlanningAccess|undefined,source:ServicePlanSource|undefined,now:number){
 return Boolean(access?.enabled&&uuid(access.id)&&validServicePlanSource(source)&&sameServicePlanSource(access.sourceBinding,source)&&
  date(access.startsAt)&&date(access.expiresAt)&&Number.isFinite(now)&&now>=Date.parse(access.startsAt)&&now<Date.parse(access.expiresAt));
}
export function samePlanningWindow(plan:PrivateServicePlan,access:ServicePlanningAccess|undefined){
 return Boolean(access&&plan.pilotId===access.id&&plan.requestedModel===access.model&&plan.recovery.driver===(access.driver??'EXPLICIT_ADVANCE')&&plan.executionWindow.startsAt===access.startsAt&&plan.executionWindow.expiresAt===access.expiresAt);
}
export const privatePlanStageText:Record<string,string>={READY_FOR_MODEL:'任务已保存 · 待开始',MODEL_IN_FLIGHT:'模型规划中',MODEL_OUTCOME_UNKNOWN:'模型结果待确认',MODEL_NOT_SENT:'发送前已停止',SUCCEEDED:'方案待审阅',APPLIED:'草稿已创建',FAILED:'方案核验未通过',CANCELLED:'已取消'};
