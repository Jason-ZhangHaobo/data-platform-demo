import {checkedAssistedDevelopmentReference,sameAssistedDevelopmentReference} from './assisted-development-reference.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bad=()=>new Error('人工辅助交付回执与指定任务、代码或批次不一致；保留原请求编号，不自动重试');
const checkedInput=(value,write)=>{
  const keys=['taskId','sourceRunId','sourceKind',...(write?['requestId','confirm']:[])];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||value.sourceKind!==undefined&&value.sourceKind!=='MANUAL')throw bad();
  return value;
};
export async function readManualDeliveryWorkflow(client,input){
  const {taskId,sourceRunId}=checkedInput(input,false);
  if(!uuid(taskId)||!uuid(sourceRunId))throw bad();
  const value=await client.request(`/runs/${sourceRunId}/workflow`),r=value?.report,p=value?.publication;
  if(r?.taskId!==taskId||r.runId!==sourceRunId||!uuid(r.revisionId)||!digest(r.revisionHash)||r.sourceKind!=='MANUAL'||r.agentIndependentE2E!==false||
    p?.scope!=='PRIVATE_CLOUD_TEST'||p.sourceKind!=='MANUAL'||p.sourceRunId!==sourceRunId||p.agentIndependentE2E!==false)throw bad();
  if(r.developmentReference!==undefined)checkedAssistedDevelopmentReference(r.developmentReference);
  return value;
}
export async function prepareManualDelivery(client,input){
  const {taskId,sourceRunId,requestId,confirm}=checkedInput(input,true);
  if(confirm!==true||!uuid(requestId))throw bad();
  const before=await readManualDeliveryWorkflow(client,{taskId,sourceRunId}),r=before.report;
  if(r.status!=='PASSED')throw bad();
  const value=await client.request(`/runs/${sourceRunId}/prepare-delivery`,{method:'POST',body:{},idempotencyKey:requestId});
  if(!uuid(value?.id)||value.sourceKind!=='MANUAL'||value.agentIndependentE2E!==false||value.sourceAgentTaskId!==taskId||value.sourceRunId!==sourceRunId||
    value.sourceRevisionId!==r.revisionId||value.sourceSqlHash!==r.revisionHash||!sameAssistedDevelopmentReference(value.developmentReference,r.developmentReference))throw bad();
  return value;
}
