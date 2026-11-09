const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function checkedManualContinuationBinding(value){
  const keys=['kind','revisionId','runId','revisionHash','evidenceDigest',...(value?.originAgentTaskId===undefined?[]:['originAgentTaskId'])];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||value.kind!=='MANUAL_SUCCESS_CONTINUATION'||
    !uuid(value.revisionId)||!uuid(value.runId)||!hash(value.revisionHash)||!hash(value.evidenceDigest)||value.originAgentTaskId!==undefined&&!uuid(value.originAgentTaskId))throw Object.assign(new Error('手工续改须绑定确切成功运行、保存代码和证据摘要'),{status:422,code:'MANUAL_CONTINUATION_INVALID'});
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function manualContinuationAttribution(value,originAgentTaskId=value?.originAgentTaskId){
  const b=checkedManualContinuationBinding(value);
  if(originAgentTaskId!==b.originAgentTaskId||originAgentTaskId!==undefined&&!uuid(originAgentTaskId))throw new Error('手工版本的关联任务未确认');
  return {sourceKind:'MANUAL',agentIndependentE2E:false,sourceAttribution:{kind:'ENGINEER_ASSISTED',referenceKind:'MANUAL_SUCCESS_REFERENCE',
    sourceRunId:b.runId,sourceRevisionId:b.revisionId,sourceRevisionHash:b.revisionHash,sourceEvidenceDigest:b.evidenceDigest,...(originAgentTaskId?{manualOriginTaskId:originAgentTaskId}:{}),agentIndependentE2E:false}};
}
