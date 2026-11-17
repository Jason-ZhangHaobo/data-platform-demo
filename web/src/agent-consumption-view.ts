import {agentConsumptionReceiptPath,readAgentConsumption} from '../../src/v2/agent-consumption-request.mjs';
import type {AgentConsumptionInput} from '../../src/v2/agent-consumption-request.mjs';

import {consumptionPlanAvailable,consumptionServices} from './service-consumption-scope.ts';
import type {ConsumptionScope} from './service-consumption-scope.ts';

export const agentConsumptionRequestParam = 'agent_consumption_request';
const id=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const bad=()=>Error('回执与原委托、应用或确切接口版本不一致。');

export function agentConsumptionRequestMarker(href:string):string|undefined|null {
  const values=new URL(href).searchParams.getAll(agentConsumptionRequestParam);
  if(!values.length)return undefined;
  return values.length===1&&id(values[0])?values[0]:null;
}

export function agentConsumptionLocation(href:string,requestId:string,historyView=false) {
  agentConsumptionReceiptPath(requestId);
  const url=new URL(href);
  url.searchParams.set(agentConsumptionRequestParam,requestId);
  if(historyView){url.searchParams.set('module','services');url.searchParams.set('agent_consumption_view','receipt');url.hash='release-batch-consumption';}
  return url;
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
  applications:{id:string;name:string;status:string;pilotId?:string;expiresAt?:string;scope:string;serviceIds:string[]}[]) {
  if(!consumptionPlanAvailable(scope)||scope.plan.agentConsumptionAvailable!==true||scope.plan.outputContractId||!scope.plan.taskId||
    !batch||batch.id!==scope.plan.sourceReleaseRunId||batch.packageDigest!==scope.plan.packageDigest||batch.sourceAgentTaskId!==scope.plan.taskId||
    applications.length!==1)return;
  const app=applications[0],scoped=consumptionServices(services,scope);
  const dapi=scoped.find(item=>item.slug===scope.plan.dapis[0].slug),xapi=scoped.find(item=>item.slug===scope.plan.xapi.slug);
  if(app.scope!=='PRIVATE_CLOUD_TEST'||app.pilotId!==scope.pilotId||app.name!==scope.plan.applicationName||
    !dapi?.publishedVersion||!xapi?.publishedVersion||dapi.status!=='PUBLISHED'||xapi.status!=='PUBLISHED'||
    ![dapi.id,xapi.id].every(id=>app.serviceIds.includes(id)))return;
  return {input:{sourceBinding:{taskId:scope.plan.taskId,releaseId:batch.releaseId,packageDigest:scope.plan.packageDigest,sourceReleaseRunId:batch.id},
    applicationId:app.id,dapiVersionId:dapi.publishedVersion.id,xapiVersionId:xapi.publishedVersion.id},
    applicationName:app.name,application:app,dapiName:dapi.name,xapiName:xapi.name};
}
