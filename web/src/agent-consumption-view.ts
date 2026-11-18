import {agentConsumptionReceiptPath,readAgentConsumption} from '../../src/v2/agent-consumption-request.mjs';
import type {AgentConsumptionInput} from '../../src/v2/agent-consumption-request.mjs';

import {consumptionPlanAvailable,consumptionServices} from './service-consumption-scope.ts';
import type {ConsumptionScope} from './service-consumption-scope.ts';

export const agentConsumptionRequestParam = 'agent_consumption_request';
const receiptMode = 'agent_consumption_view';
const sourceFields = ['task','release','package','release_batch','application','dapi_version','xapi_version'] as const;
const id=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const bad=()=>Object.assign(Error('回执与所选发布批次、应用或接口版本不一致。'),{code:'AGENT_CONSUMPTION_SCOPE_MISMATCH'});

export function agentConsumptionRequestMarker(href:string):string|undefined|null {
  const values=new URL(href).searchParams.getAll(agentConsumptionRequestParam);
  if(!values.length)return undefined;
  return values.length===1&&id(values[0])?values[0]:null;
}

export function agentConsumptionLocation(href:string,requestId:string,selection?:AgentConsumptionInput) {
  agentConsumptionReceiptPath(requestId);
  const url=new URL(href);
  url.searchParams.set(agentConsumptionRequestParam,requestId);
  if(selection){
    const {sourceBinding,applicationId,dapiVersionId,xapiVersionId}=readAgentConsumption(selection,requestId);
    const values=[sourceBinding.taskId, sourceBinding.releaseId, sourceBinding.packageDigest, sourceBinding.sourceReleaseRunId,
      applicationId,dapiVersionId,xapiVersionId];
    const query=new URLSearchParams({module:'services',[receiptMode]:'receipt',[agentConsumptionRequestParam]:requestId});
    sourceFields.forEach((field,index)=>query.set(field,values[index]));
    url.search=query.toString();
    url.hash='release-batch-consumption';
  }
  return url;
}

export function agentConsumptionReceiptSelection(href:string) {
  const url=new URL(href),query=url.searchParams;
  if(!query.has(receiptMode))return undefined;
  const requestId=agentConsumptionRequestMarker(href);
  if(!requestId||url.pathname!=='/v2/'||url.hash!=='#release-batch-consumption'||query.get('module')!=='services'||
    query.get(receiptMode)!=='receipt'||query.size!==sourceFields.length+3||
    !['module',receiptMode,...sourceFields].every(field=>query.getAll(field).length===1))return null;
  const [taskId,releaseId,packageDigest,sourceReleaseRunId,applicationId,dapiVersionId,xapiVersionId]=sourceFields.map(field=>query.get(field));
  try {
    return readAgentConsumption({sourceBinding:{taskId,releaseId,packageDigest,sourceReleaseRunId},applicationId,dapiVersionId,xapiVersionId},requestId);
  } catch {
    return null;
  }
}

const states=['DELIVERY_UNKNOWN','QUEUED','RESULT_UNCONFIRMED','COMPLETED','FAILED'] as const;
export function checkedAgentConsumptionReceipt(value:unknown,requestId:string,candidate?:AgentConsumptionInput) {
  if(!record(value)||value.protocol!=='shuduo-agent-consumption-wake/v1'||value.requestId!==requestId||typeof value.wakeId!=='string'||!id(value.wakeId)||
    typeof value.state!=='string'||!states.some(state=>state===value.state)||value.agentInitiated!==(value.state==='COMPLETED')||
    value.externalSystemVerified!==false||!Array.isArray(value.calls)||value.calls.length>2||value.state==='COMPLETED'&&value.calls.length!==2)throw bad();
  const selection=readAgentConsumption({sourceBinding:value.sourceBinding,applicationId:value.applicationId,
    dapiVersionId:value.dapiVersionId,xapiVersionId:value.xapiVersionId},requestId);
  if(candidate&&JSON.stringify(selection)!==JSON.stringify(readAgentConsumption(candidate,requestId)))throw bad();
  const calls=value.calls.map((call:unknown,index:number)=>{
    const type=index===0?'DAPI':'XAPI',versionId=type==='DAPI'?selection.dapiVersionId:selection.xapiVersionId;
    if(!record(call)||call.type!==type||!id(call.serviceId)||call.versionId!==versionId||!digest(call.callIdDigest)||
      !digest(call.rowsDigest)||!digest(call.paginationDigest)||typeof call.rowCount!=='number'||!Number.isSafeInteger(call.rowCount)||
      call.rowCount<1||call.rowCount>100)throw bad();
    return {type,versionId,callIdDigest:call.callIdDigest,rowCount:call.rowCount};
  });
  if(new Set(calls.map(call=>call.callIdDigest)).size!==calls.length)throw bad();
  return {...selection,requestId,wakeId:value.wakeId,state:value.state as typeof states[number],calls};
}

export function agentConsumptionTarget(scope:ConsumptionScope|undefined,
  batch:{id:string;releaseId:string;sourceAgentTaskId?:string;packageDigest?:string}|undefined, services:Parameters<typeof consumptionServices>[0],
  applications:{id:string;name:string;status:string;pilotId?:string;expiresAt?:string;scope:string;serviceIds:string[];customerAccess?:unknown}[]) {
  if(!consumptionPlanAvailable(scope)||scope.plan.agentConsumptionAvailable!==true||scope.plan.outputContractId||!scope.plan.taskId||
    !batch||batch.id!==scope.plan.sourceReleaseRunId||batch.packageDigest!==scope.plan.packageDigest||batch.sourceAgentTaskId!==scope.plan.taskId||
    applications.length!==1)return;
  const app=applications[0],scoped=consumptionServices(services,scope);
  const dapi=scoped.find(item=>item.slug===scope.plan.dapis[0].slug),xapi=scoped.find(item=>item.slug===scope.plan.xapi.slug);
  if(app.scope!=='PRIVATE_CLOUD_TEST'||app.pilotId!==scope.pilotId||app.name!==scope.plan.applicationName||app.customerAccess!==undefined||
    !dapi?.publishedVersion||!xapi?.publishedVersion||dapi.status!=='PUBLISHED'||xapi.status!=='PUBLISHED'||
    ![dapi.id,xapi.id].every(id=>app.serviceIds.includes(id)))return;
  return {input:{sourceBinding:{taskId:scope.plan.taskId,releaseId:batch.releaseId,packageDigest:scope.plan.packageDigest,sourceReleaseRunId:batch.id},
    applicationId:app.id,dapiVersionId:dapi.publishedVersion.id,xapiVersionId:xapi.publishedVersion.id},
    applicationName:app.name,application:app,dapiName:dapi.name,xapiName:xapi.name};
}
