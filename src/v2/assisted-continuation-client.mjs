import {checkedAssistedContinuationBinding,assistedContinuationAttribution} from './assisted-continuation-binding.mjs';
import {checkedAssistedDevelopmentReference} from './assisted-development-reference.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const bad=()=>Object.assign(new Error('续改回执未绑定所选成功版本或人工辅助来源；保留原请求编号，不自动重提'),{code:'ASSISTED_CONTINUATION_RECEIPT_INVALID'});
export async function readAssistedContinuation(client,selection){
  if(!selection||Object.keys(selection).some(k=>!['taskId','revisionId','runId','revisionHash','contextId'].includes(k))||!uuid(selection.taskId))throw bad();
  const v=await client.request(`/agent/tasks/${selection.taskId}/assisted-continuation`),b=checkedAssistedContinuationBinding(v?.binding),r=checkedAssistedDevelopmentReference(v?.developmentReference);
  if(v.protocol!=='shuduo-assisted-continuation/v1'||typeof v.contextId!=='string'||b.taskId!==selection.taskId||['revisionId','runId','revisionHash'].some(k=>selection[k]!==undefined&&b[k]!==selection[k])||
    selection.contextId!==undefined&&v.contextId!==selection.contextId||r.kind!=='ASSISTED_CONTINUATION'||r.parentTaskId!==b.taskId||r.sourceRunId!==b.runId||r.sourceRevisionId!==b.revisionId||r.sourceRevisionHash!==b.revisionHash||r.parentEvidenceDigest!==b.evidenceDigest||r.depth!==b.depth)throw bad();
  return {protocol:v.protocol,contextId:v.contextId,binding:b,developmentReference:r};
}
export function assistedContinuationReceiptMatches(task,body){
  const raw=body?.assistedContinuation??task?.assistedContinuation;if(raw===undefined)return true;
  try{
    const b=checkedAssistedContinuationBinding(raw),actual=checkedAssistedContinuationBinding(task?.assistedContinuation),expected=assistedContinuationAttribution(b).sourceAttribution;
    return uuid(task?.id)&&task.id!==b.taskId&&task.sourceKind==='MANUAL'&&task.agentIndependentE2E===false&&task.sourceRunId===undefined&&task.repairComparison===undefined&&task.derivedFrom===undefined&&
      JSON.stringify(b)===JSON.stringify(actual)&&task.sourceAttribution&&Object.keys(task.sourceAttribution).length===Object.keys(expected).length&&Object.keys(expected).every(k=>task.sourceAttribution[k]===expected[k])&&
      (body===undefined||task.initialSql===body.sql&&task.contextId===body.contextId&&task.message===body.message);
  }catch{return false;}
}
export async function createAssistedContinuation(client,input){
  if(!input||Object.keys(input).some(k=>!['taskId','message','requestId','confirm'].includes(k))||input.confirm!==true||!uuid(input.requestId)||typeof input.message!=='string'||input.message.trim().length<4||input.message.length>2000)throw bad();
  const proof=await readAssistedContinuation(client,{taskId:input.taskId}),revision=await client.request(`/revisions/${proof.binding.revisionId}`);
  if(revision.id!==proof.binding.revisionId||revision.hash!==proof.binding.revisionHash||revision.contextId!==proof.contextId||typeof revision.sql!=='string')throw bad();
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(revision.sql)),hash=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');if(hash!==revision.hash)throw bad();
  const body={message:input.message.trim(),sql:revision.sql,contextId:proof.contextId,assistedContinuation:proof.binding};
  const task=await client.request('/agent/tasks',{method:'POST',body,idempotencyKey:input.requestId});if(!assistedContinuationReceiptMatches(task,body))throw bad();return task;
}
