import {checkedDistributionConsumption} from './distribution-consumption-read.ts';
import {checkedFundConsumption} from './fund-consumption-read.ts';
import {checkedPublication} from './publication-selection.ts';
import type {PublicationSelector} from './publication-selection';
import {serviceSourceScope,validServiceSourceBinding} from './service-source-binding.ts';
import type {ServiceSourceBinding} from './service-source-binding';
import type {TaskConsumption} from './agent-journey';
export type RollbackTarget={id:string;packageDigest:string;metadataHash:string;sourceRevisionId:string;successfulRunCount:number;taskId?:string};
export type Release={id:string;status:string;health:string;modelMode?:string;sourceKind?:string;sourceRunId?:string;reviewDigest?:string;agentIndependentE2E?:boolean;packageId?:string;packageDigest?:string;verificationId?:string;sourceAgentTaskId?:string;sourceRevisionId?:string;runCount?:number;rolledBackToReleaseId?:string;rolledBackToTaskId?:string;restoredAt?:string;outputContract?:{id:string;metadataHash:string}};
export type Publication={rollbackTargets?:RollbackTarget[];historyRunCount?:number;release?:Release;runs:{id:string;status:string;sequence:number;schedulerTriggered?:boolean;stage?:unknown;resultUnknown?:boolean;durationMs?:number;triggeredAt?:string;finishedAt?:string}[];alerts:{id:string;status:string;message:string;recoveryRunId?:string}[];events:{id:string;type:string;observedAt:string;releaseId?:string;releaseRunId?:string;packageDigest?:string}[]};
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const id=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const optional=(v:unknown,check:(v:unknown)=>boolean)=>v===undefined||check(v);
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const uniqueIds=(rows:Record<string,unknown>[])=>new Set(rows.map(r=>r.id)).size===rows.length;
const invalidPublication=()=>Error('发布与监控回执的记录结构或确切来源未确认；保留原记录，只读重查，不自动发布。');

export function checkedAgentPublication(value:unknown,{taskId,scope,selector,releaseId,requireRelease=false}:{taskId:string;scope:'LOCAL_TEST_RELEASE'|'PRIVATE_CLOUD_TEST';selector?:PublicationSelector;releaseId?:string;requireRelease?:boolean}):Publication{
 if(!record(value)||!optional(value.scope,v=>v===scope)||!Array.isArray(value.runs)||!Array.isArray(value.alerts)||!Array.isArray(value.events))throw invalidPublication();
 const r=value.release,runs=value.runs,alerts=value.alerts,events=value.events;
 if(r!==undefined&&(!record(r)||!id(r.id)||!['ACTIVE_LOCAL','SUPERSEDED_LOCAL','ROLLED_BACK_LOCAL','FAILED_LOCAL','WAITING_SCHEDULER','RUNNING_CLOUD_TEST','ACTIVE_CLOUD_TEST','COMPLETED_CLOUD_TEST','CANCELLED','FAILED','ROLLED_BACK'].includes(String(r.status))||
  !['PENDING','OBSERVING','HEALTHY','CRITICAL','RECOVERED_WITH_FAILURE','RECOVERING','STOPPED'].includes(String(r.health))||!id(r.packageId)||!hash(r.packageDigest)||!id(r.sourceRevisionId)||
  !optional(r.sourceAgentTaskId,v=>v===taskId)||!optional(r.scope,v=>v===scope)||!['sourceRunId','verificationId'].every(k=>optional(r[k],id))||!optional(r.sourceKind,v=>v==='AGENT'||v==='MANUAL')||
  !optional(r.agentIndependentE2E,v=>typeof v==='boolean')||r.sourceKind==='MANUAL'&&r.agentIndependentE2E!==false||
  !optional(r.runCount,v=>count(v)&&Number(v)>0)||releaseId!==undefined&&r.id!==releaseId))throw invalidPublication();
 if(!r&&(runs.length||alerts.length||events.length||releaseId||requireRelease))throw invalidPublication();
 if(scope==='PRIVATE_CLOUD_TEST'&&record(r)&&r.reviewDigest!==undefined&&(
  !hash(r.reviewDigest)||r.scope!==scope||r.sourceKind!=='AGENT'||r.sourceAgentTaskId!==taskId||!id(r.sourceRunId)||
  runs.length!==2||![1,2].every(sequence=>runs.some(b=>record(b)&&b.sequence===sequence))||
  !runs.every(b=>record(b)&&b.releaseId===r.id&&['reviewDigest','packageId','packageDigest','sourceAgentTaskId','sourceRunId']
   .every(key=>b[key]===r[key]))))throw invalidPublication();
 if(!runs.every(b=>record(b)&&id(b.id)&&(['SCHEDULED','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(String(b.status))||scope==='LOCAL_TEST_RELEASE'&&b.status==='INTERRUPTED')&&count(b.sequence)&&Number(b.sequence)>0&&
  optional(b.resultUnknown,v=>typeof v==='boolean'&&(v===false||scope==='LOCAL_TEST_RELEASE'&&b.status==='INTERRUPTED'&&b.schedulerTriggered===true))&&
  optional(b.schedulerTriggered,v=>typeof v==='boolean')&&optional(b.durationMs,v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)&&['triggeredAt','finishedAt'].every(k=>optional(b[k],date))&&
  optional(b.releaseId,v=>record(r)&&v===r.id)&&optional(b.packageDigest,v=>record(r)&&v===r.packageDigest))||!uniqueIds(runs)||new Set(runs.map(b=>b.sequence)).size!==runs.length||record(r)&&r.runCount!==undefined&&runs.length>Number(r.runCount))throw invalidPublication();
 if(!alerts.every(a=>record(a)&&id(a.id)&&['OPEN','RESOLVED'].includes(String(a.status))&&typeof a.message==='string'&&optional(a.recoveryRunId,id)&&optional(a.releaseId,v=>record(r)&&v===r.id))||!uniqueIds(alerts))throw invalidPublication();
 if(!events.every(e=>record(e)&&id(e.id)&&typeof e.type==='string'&&e.type.length>0&&date(e.observedAt)&&optional(e.releaseId,v=>record(r)&&v===r.id)&&
  optional(e.packageDigest,v=>record(r)&&v===r.packageDigest)&&optional(e.releaseRunId,v=>id(v)&&runs.some(b=>b.id===v)))||!uniqueIds(events))throw invalidPublication();
 if(value.rollbackTargets!==undefined&&(!Array.isArray(value.rollbackTargets)||value.rollbackTargets.length>10||!value.rollbackTargets.every(t=>record(t)&&id(t.id)&&hash(t.packageDigest)&&hash(t.metadataHash)&&id(t.sourceRevisionId)&&count(t.successfulRunCount)&&Number(t.successfulRunCount)>=2&&optional(t.taskId,id))))throw invalidPublication();
 if(!optional(value.historyRunCount,count))throw invalidPublication();
 if(record(r)&&(!optional(r.rolledBackToReleaseId,id)||!optional(r.rolledBackToTaskId,id)||!optional(r.restoredAt,date)||r.outputContract!==undefined&&(!record(r.outputContract)||typeof r.outputContract.id!=='string'||!hash(r.outputContract.metadataHash))))throw invalidPublication();
 const result=value as Publication;
 return selector?checkedPublication(result,taskId,selector,releaseId,requireRelease):result;
}

const fields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
const invalidConsumption=()=>Error('消费回执的结构、固定版本或原发布来源未确认；只读重查，不创建接口、凭证或调用。');
export function checkedAgentConsumption(value:unknown,binding:ServiceSourceBinding,batches:{id:string;status:string;schedulerTriggered?:boolean}[],expectedOutput?:{id:string;metadataHash:string},expectedFund?:{id:string;modelMode:string}):TaskConsumption{
 if(expectedFund)return checkedFundConsumption(value,binding,batches,expectedFund);
 if(record(value)&&value.protocol==='shuduo-local-distribution-consumption/v1')return checkedDistributionConsumption(value,binding,batches,expectedOutput);
 if(expectedOutput)throw invalidConsumption();
 if(!validServiceSourceBinding(binding)||!record(value)||value.protocol!==(serviceSourceScope(binding)==='LOCAL_TEST_ONLY'?'shuduo-local-task-consumption/v1':'shuduo-private-task-consumption/v1')||value.scope!==serviceSourceScope(binding)||
  value.taskId!==binding.taskId||value.packageDigest!==binding.packageDigest||value.releaseId!==binding.releaseId||
  (binding.sourceKind==='MANUAL'?value.sourceKind!=='MANUAL':value.sourceKind!==undefined&&value.sourceKind!=='AGENT')||
  !['PENDING','VERIFIED'].includes(String(value.status))||typeof value.truncated!=='boolean'||!date(value.checkedAt)||typeof value.notice!=='string'||
  value.publicDeployed!==false||value.externalSystemVerified!==false||value.agentIndependentE2E!==false||!Array.isArray(value.services)||value.services.length>20||!count(value.matchingCount)||Number(value.matchingCount)<value.services.length||value.truncated!==(Number(value.matchingCount)>value.services.length))throw invalidConsumption();
 const services=value.services;
 for(const entry of services){
  if(!record(entry)||!id(entry.serviceId)||!id(entry.versionId)||!hash(entry.configHash)||!['DAPI','XAPI'].includes(String(entry.serviceType))||typeof entry.name!=='string'||typeof entry.notice!=='string'||
   !['PENDING','VERIFIED','NEEDS_ATTENTION'].includes(String(entry.status))||!optional(entry.code,v=>typeof v==='string')||!optional(entry.fullAssetComposition,v=>typeof v==='boolean')||
   !Array.isArray(entry.sourceRunIds)||!entry.sourceRunIds.every(id)||new Set(entry.sourceRunIds).size!==entry.sourceRunIds.length||
   !optional(entry.releaseId,v=>v===binding.releaseId)||!optional(entry.sourceKind,v=>v===binding.sourceKind)||!optional(entry.agentIndependentE2E,v=>v===false))throw invalidConsumption();
  const call=entry.call;
  if(call!==undefined&&(!record(call)||!id(call.callId)||call.versionId!==entry.versionId||!hash(call.resultHash)||!count(call.rowCount)||typeof call.verified!=='boolean'||
   !id(call.applicationId)||!['ACTIVE','REVOKED','EXPIRED'].includes(String(call.applicationStatus))||!date(call.finishedAt)||call.configHash!==entry.configHash))throw invalidConsumption();
  if(entry.status==='VERIFIED'){
   const versions=entry.sourceVersions,source=entry.source,sourceRunIds=entry.sourceRunIds;
   if(!record(call)||call.verified!==true||Number(call.rowCount)<1||entry.releaseId!==binding.releaseId||entry.sourceKind!==binding.sourceKind||entry.agentIndependentE2E!==false||!entry.sourceRunIds.length||
    !entry.sourceRunIds.every(runId=>runId!==binding.runId&&batches.some(b=>b.id===runId&&b.status==='SUCCEEDED'&&b.schedulerTriggered===true))||
    !Array.isArray(versions)||versions.length<(entry.serviceType==='XAPI'?2:1)||versions.length>(entry.serviceType==='XAPI'?5:1)||
    !versions.every(v=>record(v)&&id(v.serviceId)&&id(v.versionId)&&hash(v.configHash)&&v.releaseId===binding.releaseId&&v.packageDigest===binding.packageDigest&&v.sourceKind===binding.sourceKind&&sourceRunIds.includes(v.sourceReleaseRunId)&&
      Array.isArray(v.fields)&&v.fields.length>0&&v.fields.every(f=>fields.includes(f))&&new Set(v.fields).size===v.fields.length)||
    !record(source)||source.schema!=='shuduo-service-consumer-source/v1'||source.scope!==serviceSourceScope(binding)||source.taskId!==binding.taskId||source.packageDigest!==binding.packageDigest||source.releaseId!==binding.releaseId||source.sourceKind!==binding.sourceKind||
    !id(source.revisionId)||!hash(source.revisionHash)||!id(source.developmentRunId)||typeof source.contextId!=='string'||typeof source.validationContractId!=='string'||!entry.sourceRunIds.includes(source.sourceReleaseRunId)||source.sourceReleaseRunId===source.developmentRunId||
    binding.revisionId!==undefined&&source.revisionId!==binding.revisionId||binding.runId!==undefined&&source.developmentRunId!==binding.runId)throw invalidConsumption();
   const complete=entry.serviceType==='XAPI'&&fields.every(f=>versions.some(v=>v.fields.includes(f)));
   if(entry.fullAssetComposition!==complete)throw invalidConsumption();
  }
 }
 if(new Set(services.map(s=>s.serviceId)).size!==services.length||value.status==='VERIFIED'&&(value.truncated||!services.some(s=>s.status==='VERIFIED'&&s.fullAssetComposition===true)))throw invalidConsumption();
 return value as TaskConsumption;
}
