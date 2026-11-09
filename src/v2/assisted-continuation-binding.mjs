const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function checkedAssistedContinuationBinding(value){
  const keys=['kind','taskId','revisionId','runId','revisionHash','evidenceDigest','depth'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||
    value.kind!=='ASSISTED_SUCCESS_CONTINUATION'||![value.taskId,value.revisionId,value.runId].every(uuid)||!hash(value.revisionHash)||!hash(value.evidenceDigest)||
    !Number.isSafeInteger(value.depth)||value.depth<1||value.depth>16)
    throw Object.assign(new Error('续改须绑定已核验父任务、版本、运行及证据摘要，最多保留16级续改'),{status:422,code:'ASSISTED_CONTINUATION_INVALID'});
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function assistedContinuationAttribution(value){
  const b=checkedAssistedContinuationBinding(value);
  return {sourceKind:'MANUAL',agentIndependentE2E:false,sourceAttribution:{kind:'ENGINEER_ASSISTED',referenceKind:'ASSISTED_CONTINUATION',
    parentTaskId:b.taskId,parentRevisionId:b.revisionId,parentRunId:b.runId,parentRevisionHash:b.revisionHash,parentEvidenceDigest:b.evidenceDigest,depth:b.depth,agentIndependentE2E:false}};
}
