import {manualRunLocation} from "./manual-run-recovery.ts";
import type {ConsumptionScope} from "./service-consumption-scope.ts";

export type ServiceSourceBinding={taskId:string;packageDigest:string;releaseId:string;sourceKind:"AGENT"|"MANUAL";revisionId?:string;runId?:string};
export type PublicationSource={status:"RESOLVED"|"UNAVAILABLE";sourceKind?:"AGENT"|"MANUAL";taskId:string;packageDigest:string;verificationId:string;revisionId?:string;runId?:string};
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const queryKeys={taskId:"source_task",packageDigest:"source_package",releaseId:"source_release",sourceKind:"source_kind",revisionId:"source_revision",runId:"source_run"} as const;
export function validServiceSourceBinding(value:unknown):value is ServiceSourceBinding{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const b=value as ServiceSourceBinding;
  return uuid(b.taskId)&&digest(b.packageDigest)&&uuid(b.releaseId)&&["AGENT","MANUAL"].includes(b.sourceKind)&&
    (b.revisionId===undefined||uuid(b.revisionId))&&(b.runId===undefined||uuid(b.runId))&&
    (b.sourceKind!=="MANUAL"||uuid(b.revisionId)&&uuid(b.runId));
}
export function serviceSourceKey(binding?:ServiceSourceBinding){return binding?JSON.stringify([binding.taskId,binding.packageDigest,binding.releaseId,binding.sourceKind,binding.revisionId??"",binding.runId??""]):"";}
export function serviceReadCurrent(key:string,request:number,activeKey:string,activeRequest:number,alive=true){return alive&&key===activeKey&&request===activeRequest;}
export type ServiceSourceLocation={status:"ABSENT"}|{status:"VALID";binding:ServiceSourceBinding}|{status:"INVALID";error:string};
const invalidLocation=():ServiceSourceLocation=>({status:"INVALID",error:"接口交接来源不完整或不合法；请返回原发布卡重新选择确切版本，不会回退到全项目数据。"});
export function serviceSourceFromLocation(href:string,manualWorkspace=false):ServiceSourceLocation{
  const query=new URL(href).searchParams,entries=[...query].filter(([key])=>key.startsWith("source_"));
  if(!entries.length)return (manualWorkspace||query.get("module")==="services")&&["origin_task","revision","run"].some(key=>query.has(key))?invalidLocation():{status:"ABSENT"};
  if(new Set(entries.map(([key])=>key)).size!==entries.length||entries.some(([key])=>!Object.values(queryKeys).includes(key as typeof queryKeys[keyof typeof queryKeys])))return invalidLocation();
  const value=Object.fromEntries(Object.entries(queryKeys).filter(([,key])=>query.has(key)).map(([name,key])=>[name,query.get(key)]));
  return validServiceSourceBinding(value)?{status:"VALID",binding:value}:invalidLocation();
}
export function serviceHandoffLocation(href:string,binding:ServiceSourceBinding){
  if(!validServiceSourceBinding(binding))throw Error("人工／Agent接口交接缺少确切发布来源");
  const url=new URL(href);url.search="";
  url.searchParams.set("module","services");url.hash="";
  for(const[key,name]of Object.entries(queryKeys)){const value=binding[key as keyof ServiceSourceBinding];if(value!==undefined)url.searchParams.set(name,value);}
  return url;
}
export function serviceReturnLocation(href:string,binding:ServiceSourceBinding){
  if(!validServiceSourceBinding(binding))throw Error("原版本返回来源未确认");
  let url=new URL(href);url.search="";
  if(binding.sourceKind==="MANUAL")url=manualRunLocation(url.href,{revisionId:binding.revisionId!,runId:binding.runId,originTaskId:binding.taskId});
  else{for(const key of ["revision","run","origin_task","run_request","save_request","agent_request"])url.searchParams.delete(key);url.searchParams.set("task",binding.taskId);}
  url.searchParams.set("module","agent-center");url.hash="agent-service-handoff";return url;
}
export function publicationSourceLocation(href:string,target:{taskId:string;packageDigest:string;verificationId:string},source?:PublicationSource){
  if(!source)return;
  let url=new URL(href);url.search="";
    if(source.status!=="RESOLVED"||!digest(target.packageDigest)||!uuid(target.verificationId)||source.taskId!==target.taskId||source.packageDigest!==target.packageDigest||source.verificationId!==target.verificationId||
      !uuid(source.taskId)||!uuid(source.revisionId)||!uuid(source.runId)||!["AGENT","MANUAL"].includes(source.sourceKind??""))return;
    if(source.sourceKind==="MANUAL")url=manualRunLocation(url.href,{revisionId:source.revisionId,runId:source.runId,originTaskId:source.taskId});
    else{url.searchParams.set("task",source.taskId);for(const key of ["revision","run","origin_task","run_request","save_request","agent_request"])url.searchParams.delete(key);}
  url.searchParams.set("module","agent-center");url.hash="agent-publication";return url;
}
export function serviceSourcesPath(binding:ServiceSourceBinding){
  if(!validServiceSourceBinding(binding))throw Error("接口交接来源不完整");
  return "/data-services/sources?"+new URLSearchParams({agent_task_id:binding.taskId,package_digest:binding.packageDigest,release_id:binding.releaseId});
}
export function serviceEvidencePath(binding:ServiceSourceBinding){return serviceSourcesPath(binding).replace("/sources?","/task-evidence?");}
type SourceRun={id:string;releaseId:string;sequence?:number;createdAt?:string;sourceAgentTaskId?:string;sourceRevisionId?:string;sourceRunId?:string;packageDigest?:string;sourceKind?:string;sourceAttribution?:string;agentIndependentE2E?:boolean;status?:string;published?:boolean;schedulerTriggered?:boolean;engine?:string;mainSqlExecuted?:boolean;testSqlValidation?:{passed:boolean};codeExecuted?:boolean;validation?:{passed:boolean}};
export function sourceRunEligible(run:SourceRun){return run.status==="SUCCEEDED"&&run.published===true&&run.schedulerTriggered===true&&run.validation?.passed===true&&
  (run.engine==="Apache Spark"&&run.mainSqlExecuted===true&&run.testSqlValidation?.passed===true||run.engine==="CPython"&&run.codeExecuted===true);}
export function sourceRunMatches(run:SourceRun,binding:ServiceSourceBinding){
  return run.releaseId===binding.releaseId&&run.sourceAgentTaskId===binding.taskId&&run.packageDigest===binding.packageDigest&&(run.sourceKind??"AGENT")===binding.sourceKind&&
    (binding.revisionId===undefined||run.sourceRevisionId===binding.revisionId)&&(binding.runId===undefined||run.sourceRunId===binding.runId)&&
    (binding.sourceKind!=="MANUAL"||run.sourceAttribution==="ENGINEER_ASSISTED"&&run.agentIndependentE2E===false);
}
export function sourceBindingScopeCompatible(binding:ServiceSourceBinding,scope?:ConsumptionScope,runs?:SourceRun[]){
  if(!scope)return true;
  return Boolean(scope.plan&&scope.taskId===binding.taskId&&scope.plan.taskId===binding.taskId&&scope.plan.packageDigest===binding.packageDigest&&
    (!runs||runs.some(run=>run.id===scope.plan!.sourceReleaseRunId&&sourceRunMatches(run,binding)&&sourceRunEligible(run))));
}
type BoundVersion={id:string;sourcePackageDigest?:string;sourceReleaseRunId?:string;steps?:{dapiId:string;dapiVersionId:string;alias:string}[]};
type BoundService={id:string;serviceType:string;currentVersion?:BoundVersion;publishedVersion?:BoundVersion;versions:BoundVersion[]};
// A matching old history cannot authorize edits to another current version.
export function sourceBoundServices<T extends BoundService>(services:T[],binding:ServiceSourceBinding,runs:SourceRun[]):T[]{
  const runIds=new Set(runs.filter(run=>sourceRunMatches(run,binding)&&sourceRunEligible(run)).map(run=>run.id));
  const isDapi=(v:BoundVersion|undefined)=>Boolean(v&&v.sourcePackageDigest===binding.packageDigest&&runIds.has(v.sourceReleaseRunId??""));
  const dapis=services.filter(s=>s.serviceType==="DAPI"&&isDapi(s.currentVersion)&&(!s.publishedVersion||isDapi(s.publishedVersion))).map(s=>({...s,versions:s.versions.filter(isDapi)}));
  // An XAPI pins immutable child versions, not whichever DAPI version is live
  // now. Keep this index separate from the DAPIs editable in this source view.
  const versionRuns=new Map(services.filter(s=>s.serviceType==="DAPI").flatMap(s=>s.versions.filter(isDapi).map(v=>[`${s.id}:${v.id}`,v.sourceReleaseRunId] as const)));
  const isXapi=(v:BoundVersion|undefined)=>Boolean(v&&v.steps&&v.steps.length>=2&&v.steps.every(step=>versionRuns.has(`${step.dapiId}:${step.dapiVersionId}`))&&
    new Set(v.steps.map(step=>step.dapiId)).size===v.steps.length&&new Set(v.steps.map(step=>versionRuns.get(`${step.dapiId}:${step.dapiVersionId}`))).size===1);
  const xapis=services.filter(s=>s.serviceType==="XAPI"&&isXapi(s.currentVersion)&&(!s.publishedVersion||isXapi(s.publishedVersion))).map(s=>({...s,versions:s.versions.filter(isXapi)}));
  return [...dapis,...xapis] as T[];
}
export function defaultBoundSourceRun(binding:ServiceSourceBinding,runs:SourceRun[],services:BoundService[],selection:{currentRunId?:string;selectedServiceId?:string}={}){
  const eligible=runs.filter(run=>sourceRunMatches(run,binding)&&sourceRunEligible(run)),ids=new Set(eligible.map(run=>run.id));
  if(selection.currentRunId&&ids.has(selection.currentRunId))return selection.currentRunId;
  const visible=sourceBoundServices(services,binding,runs),preferred=visible.find(service=>service.id===selection.selectedServiceId)??visible[0];
  if(preferred?.serviceType==="DAPI"&&preferred.currentVersion&&ids.has(preferred.currentVersion.sourceReleaseRunId??""))return preferred.currentVersion.sourceReleaseRunId;
  if(preferred?.serviceType==="XAPI"&&preferred.currentVersion?.steps){
    const childRuns=preferred.currentVersion.steps.map(step=>services.find(service=>service.id===step.dapiId&&service.serviceType==="DAPI")?.versions
      .find(version=>version.id===step.dapiVersionId&&version.sourcePackageDigest===binding.packageDigest)?.sourceReleaseRunId);
    if(childRuns.length>=2&&childRuns.every(id=>id&&ids.has(id))&&new Set(childRuns).size===1)return childRuns[0];
  }
  const sequence=(run:SourceRun)=>Number.isSafeInteger(run.sequence)&&run.sequence!>=0?run.sequence!:Infinity;
  const created=(run:SourceRun)=>Number.isFinite(Date.parse(run.createdAt??""))?Date.parse(run.createdAt!):Infinity;
  return eligible.sort((a,b)=>sequence(a)-sequence(b)||created(a)-created(b)||a.id.localeCompare(b.id))[0]?.id;
}
export function sourceBoundCalls<T extends {serviceId:string;serviceVersionId?:string}>(calls:T[],services:BoundService[]):T[]{
  const versions=new Set(services.flatMap(service=>service.versions.map(version=>`${service.id}:${version.id}`)));
  return calls.filter(call=>Boolean(call.serviceVersionId)&&versions.has(`${call.serviceId}:${call.serviceVersionId}`));
}
export function sourceBoundSwitches<T extends {fromVersionId?:string;toVersionId?:string}>(receipts:T[],service:BoundService):T[]{
  const versions=new Set(service.versions.map(version=>version.id));
  return receipts.filter(receipt=>Boolean(receipt.fromVersionId&&receipt.toVersionId)&&versions.has(receipt.fromVersionId!)&&versions.has(receipt.toVersionId!));
}
