import {servicePlanSourceBinding} from './service-plan-request.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const bad=()=>Object.assign(Error('须指定原请求、应用、DAPI、XAPI 版本及同源发布批次'),{status:422,code:'AGENT_CONSUMPTION_INVALID'});
export const agentConsumptionPath='/data-services/agent/consumption-jobs';
export function agentConsumptionReceiptPath(requestId) {
  if (!uuid(requestId)) throw bad();
  return `${agentConsumptionPath}/${requestId}`;
}

export function readAgentConsumption(body,requestId) {
  agentConsumptionReceiptPath(requestId);
  const keys=['sourceBinding','applicationId','dapiVersionId','xapiVersionId'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length||!keys.every(key=>Object.hasOwn(body,key))||
    ![body.applicationId,body.dapiVersionId,body.xapiVersionId].every(uuid)||body.dapiVersionId===body.xapiVersionId)throw bad();
  const sourceBinding=servicePlanSourceBinding(body.sourceBinding);
  if(!sourceBinding.taskId)throw bad();
  return {sourceBinding,applicationId:body.applicationId,dapiVersionId:body.dapiVersionId,xapiVersionId:body.xapiVersionId};
}

export const agentConsumptionQuery=Object.freeze({page:'1',page_size:'100'});
