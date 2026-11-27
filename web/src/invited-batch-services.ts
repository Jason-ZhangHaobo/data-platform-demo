import {readAgentConsumption, type AgentConsumptionInput} from '../../src/v2/agent-consumption-request.mjs';
import {agentConsumptionTarget} from './agent-consumption-view.ts';
import {consumptionApplicationInput,consumptionDapiInput,consumptionPlanAvailable,consumptionServices,consumptionWindowOpen,consumptionXapiInput,type ConsumptionScope} from './service-consumption-scope.ts';
import {serviceSourcesPath,sourceRunEligible,sourceRunMatches,type ServiceSourceBinding} from './service-source-binding.ts';

export type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
export type Source=ServiceSourceBinding & {sourceKind:'AGENT';taskId:string;runId:string;revisionId:string;scope:'PRIVATE_CLOUD_TEST'};
export type Scope=ConsumptionScope & {pilotId:string;plan:NonNullable<ConsumptionScope['plan']>};
type Run=Parameters<typeof sourceRunMatches>[0] & {rowCount?:number};
type Service=Parameters<typeof agentConsumptionTarget>[2][number] & {scope:string;currentVersion?:{configHash:string}};
type Application=Parameters<typeof agentConsumptionTarget>[3][number] & {pilotStartsAt?:number;createdAt?:string};
function applicationWindowMatches(app:Application,scope:Scope){
  const starts=Date.parse(scope.startsAt??''),ends=Date.parse(scope.expiresAt??'');
  return ends===Date.parse(app.expiresAt??'')&&(app.pilotStartsAt===undefined?
    starts<=Date.parse(app.createdAt??'')&&Date.parse(app.createdAt??'')<ends:app.pilotStartsAt===starts);
}
const bad=()=>Error('接口、测试应用或批次与本次冻结计划不符，请核对原记录。');
const uuid=(value:string)=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function matchesInvitedConsumption(scope:ConsumptionScope|undefined,binding:Source,batch:string):scope is Scope{
  return consumptionPlanAvailable(scope)&&!scope.plan.outputContractId&&scope.plan.agentConsumptionAvailable===true&&
    scope.taskId===binding.taskId&&scope.plan.packageDigest===binding.packageDigest&&scope.plan.sourceReleaseRunId===batch;
}
export function invitedConsumptionWritable(scope:ConsumptionScope|undefined,binding:Source,batch:string,access:{canConsume?:boolean;sessionExpiresAt?:string},now=Date.now()){
  return access.canConsume===true&&now<Date.parse(access.sessionExpiresAt??'')&&matchesInvitedConsumption(scope,binding,batch)&&consumptionWindowOpen(scope,now);
}
export type Original=AgentConsumptionInput & {requestId:string};
type SavedApplication={applicationId:string;name:string;status:string;createdAt:string;expiresAt:string;revokedAt?:string;serviceIds:string[]};
export function checkedInvitedApplications(value:unknown,serviceIds:string[],catalogTruncated:boolean):SavedApplication[]{
  if(!Array.isArray(value)||value.length>20)throw bad();
  const date=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
  const apps=value.map(item=>{
    if(!item||!uuid(item.applicationId)||typeof item.name!=='string'||!item.name||!['ACTIVE','EXPIRED','REVOKED'].includes(item.status)||
      !date(item.createdAt)||!date(item.expiresAt)||item.revokedAt!==undefined&&(!date(item.revokedAt)||item.status!=='REVOKED')||
      !Array.isArray(item.serviceIds)||!item.serviceIds.length||item.serviceIds.length>3||new Set(item.serviceIds).size!==item.serviceIds.length||
      !item.serviceIds.every((id:string)=>uuid(id)&&(catalogTruncated||serviceIds.includes(id))))throw bad();
    const {applicationId,name,status,createdAt,expiresAt,revokedAt}=item;
    return {applicationId,name,status,createdAt,expiresAt,revokedAt,serviceIds:item.serviceIds};
  });
  if(new Set(apps.map(app=>app.applicationId)).size!==apps.length)throw bad();
  return apps;
}
export async function invitedConsumptionRequestId(input:AgentConsumptionInput){
  const normalized=readAgentConsumption(input,'00000000-0000-0000-0000-000000000000');
  const bytes=new TextEncoder().encode(JSON.stringify(['invited-batch-consumption/v1',normalized]));
  const hex=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),'8'+hex.slice(13,16),'a'+hex.slice(17,20),hex.slice(20,32)].join('-');
}
export function invitedConsumptionRequests(value:unknown,source:Source,batchId:string):Original[]{
  if(!Array.isArray(value)||value.length>20)throw bad();
  const originals=value.map(item=>{
    const {requestId,...body}=item??{};
    const input=readAgentConsumption(body,requestId),s=input.sourceBinding;
    if(s.taskId!==source.taskId||s.packageDigest!==source.packageDigest||s.releaseId!==source.releaseId||s.sourceReleaseRunId!==batchId)throw bad();
    return {requestId,...input};
  });
  if(new Set(originals.map(item=>item.requestId)).size!==originals.length)throw bad();
  return originals;
}
export async function readInvitedServiceCatalog(api:Api,scope:Scope,source:Source,batchId:string){
  if(!matchesInvitedConsumption(scope,source,batchId))throw bad();
  const [runs,dapis,xapis,apps]=await Promise.all([api<Run[]>(serviceSourcesPath(source)),api<Service[]>('/data-services/dapis'),
    api<Service[]>('/data-services/xapis'),api<Application[]>('/data-services/applications')]);
  if(![runs,dapis,xapis,apps].every(Array.isArray)||runs.some(run=>!sourceRunMatches(run,source)))throw bad();
  const selected=runs.filter(run=>run.id===batchId&&sourceRunEligible(run));
  if(selected.length!==1)throw bad();
  const all=[...dapis,...xapis],services=consumptionServices(all,scope),specs=[...scope.plan.dapis,scope.plan.xapi];
  if(services.some(s=>s.scope!=='PRIVATE_CLOUD_TEST'||!uuid(s.id)||!s.currentVersion||!uuid(s.currentVersion.id)||!/^[a-f0-9]{64}$/.test(s.currentVersion.configHash))||
    new Set(services.map(s=>s.slug)).size!==services.length||all.some(s=>specs.some(v=>v.slug===s.slug)&&!services.includes(s)))throw bad();
  const applications=apps.filter(a=>a.pilotId===scope.pilotId||a.name===scope.plan.applicationName).map(({id,name,status,pilotId,expiresAt,scope:appScope,serviceIds,customerAccess,createdAt,pilotStartsAt})=>
    ({id,name,status,pilotId,expiresAt,scope:appScope,serviceIds,customerAccess,createdAt,pilotStartsAt}));
  const target=agentConsumptionTarget(scope,selected[0],services,applications);
  if(applications.length&&(!target||!uuid(target.application.id)||!Array.isArray(target.application.serviceIds)||target.application.serviceIds.length!==2||
    !['ACTIVE','REVOKED','EXPIRED'].includes(target.application.status)||!Number.isFinite(Date.parse(target.application.expiresAt??''))))throw bad();
  const grantCurrent=Boolean(target&&applicationWindowMatches(applications[0],scope));
  return {services,target,grantCurrent,rowCount:selected[0].rowCount};
}
// A user may resume this preparation after the issuer has returned only part of the plan.
export async function prepareInvitedServices(api:Api,scope:Scope,source:Source,batchId:string,assertOpen:()=>void){
  const current=await readInvitedServiceCatalog(api,scope,source,batchId);
  let services=current.services;
  function remember(item:Service,slug:string){
    if(item.scope!=='PRIVATE_CLOUD_TEST'||item.slug!==slug||!uuid(item.id)||!item.currentVersion||
      !uuid(item.currentVersion.id)||!/^[a-f0-9]{64}$/.test(item.currentVersion.configHash))throw bad();
    const next=[...services.filter(s=>s.id!==item.id),item];
    if(next.filter(s=>s.slug===slug).length!==1||!consumptionServices(next,scope).includes(item))throw bad();
    services=next;return item;
  }
  const specs=[...scope.plan.dapis,scope.plan.xapi];
  for(const [index,spec] of specs.entries()){
    const base='/data-services/'+(index<2?'dapis':'xapis');
    let service=services.find(item=>item.slug===spec.slug);
    if(service?.status==='PUBLISHED'&&service.publishedVersion)continue;
    const existing=Boolean(service);
    if(!service){
      const body=index<2?consumptionDapiInput(scope,index):consumptionXapiInput(scope,services);
      assertOpen();
      service=remember(await api<Service>(base,body,{idempotencyKey:'invited-'+scope.pilotId+'-service-'+index}),spec.slug);
      if(service.status==='PUBLISHED'&&service.publishedVersion)continue;
    }
    if(!service?.currentVersion)throw bad();
    const path=base+'/'+service.id,version=service.currentVersion;
    const publish=()=>{assertOpen();return api(path+'/publish',{configHash:version.configHash});};
    // A passing test may have been saved before the original response was lost.
    let needsTest=true;
    if(existing){
      try{await publish();needsTest=false;}
      catch(error){if((error as {code?:string}).code!=='SERVICE_TEST_REQUIRED')throw error;}
    }
    if(needsTest){
      assertOpen();
      const {test}=await api<{test:{status:string;versionId:string;configHash:string}}>(path+'/test',{});
      if(test.status!=='PASSED'||test.versionId!==version.id||test.configHash!==version.configHash)throw bad();
      await publish();
    }
    const published=remember(await api<Service>(path),spec.slug);
    if(published.id!==service.id||published.status!=='PUBLISHED'||published.publishedVersion?.id!==version.id)throw bad();
  }
}

export async function issueInvitedApplication(api:Api,scope:Scope,source:Source,batchId:string,assertOpen:()=>void){
  const current=await readInvitedServiceCatalog(api,scope,source,batchId);
  if(current.target)throw Error('本窗已签发测试应用，可按原应用继续委托或撤销。');
  const body=consumptionApplicationInput(scope,current.services);
  assertOpen();
  const issued=await api<{application:Application;token:string|null;tokenShownOnce:boolean}>('/data-services/applications',body,
    {idempotencyKey:'invited-'+scope.pilotId+'-application'});
  const app=issued.application;
  if(!app||!uuid(app.id)||app.scope!==source.scope||app.pilotId!==scope.pilotId||app.name!==body.name||
    app.customerAccess!==undefined||!applicationWindowMatches(app,scope)||!Array.isArray(app.serviceIds)||
    app.serviceIds.length!==body.serviceIds.length||!body.serviceIds.every(id=>app.serviceIds.includes(id)))throw bad();
  if(issued.tokenShownOnce===true&&(app.status!=='ACTIVE'||typeof issued.token!=='string'||!/^sz_private_[A-Za-z0-9_-]{32}$/.test(issued.token)))throw bad();
  return {applicationId:app.id,token:issued.tokenShownOnce===true?issued.token:null};
}
