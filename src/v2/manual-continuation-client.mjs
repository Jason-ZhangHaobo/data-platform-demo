import {checkedManualContinuationBinding,manualContinuationAttribution} from './manual-continuation-binding.mjs';
import {checkedAssistedDevelopmentReference} from './assisted-development-reference.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const bad=()=>Object.assign(new Error('手工续改回执未绑定原保存代码、成功运行和人工来源；保留原请求编号，不自动重提'),{code:'MANUAL_CONTINUATION_RECEIPT_INVALID'});
export async function readManualContinuation(client,selection){
  if(!selection||Object.keys(selection).some(k=>!['sourceRunId','revisionId','revisionHash','contextId'].includes(k))||!uuid(selection.sourceRunId))throw bad();
  const v=await client.request(`/runs/${selection.sourceRunId}/manual-continuation`),b=checkedManualContinuationBinding(v?.binding),r=checkedAssistedDevelopmentReference(v?.developmentReference);
  if(v.protocol!=='shuduo-manual-sql-continuation/v1'||typeof v.contextId!=='string'||b.runId!==selection.sourceRunId||['revisionId','revisionHash'].some(k=>selection[k]!==undefined&&selection[k]!==b[k])||
    selection.contextId!==undefined&&v.contextId!==selection.contextId||r.kind!=='MANUAL_SUCCESS_REFERENCE'||r.sourceRunId!==b.runId||r.sourceRevisionId!==b.revisionId||r.sourceRevisionHash!==b.revisionHash||r.evidenceDigest!==b.evidenceDigest||r.originAgentTaskId!==b.originAgentTaskId)throw bad();
  return {protocol:v.protocol,contextId:v.contextId,binding:b,developmentReference:r};
}
export function manualContinuationReceiptMatches(task,body){
  const raw=body?.manualContinuation??task?.manualContinuation;if(raw===undefined)return true;
  try{
    const b=checkedManualContinuationBinding(raw),actual=checkedManualContinuationBinding(task?.manualContinuation),a=task?.sourceAttribution,
      expected=manualContinuationAttribution(b).sourceAttribution;
    return uuid(task?.id)&&task.sourceKind==='MANUAL'&&task.agentIndependentE2E===false&&task.sourceRunId===undefined&&task.repairComparison===undefined&&task.derivedFrom===undefined&&task.assistedContinuation===undefined&&
      JSON.stringify(b)===JSON.stringify(actual)&&a&&Object.keys(a).length===Object.keys(expected).length&&Object.keys(expected).every(k=>a[k]===expected[k])&&
      (body===undefined||task.initialSql===body.sql&&task.contextId===body.contextId&&task.message===body.message);
  }catch{return false;}
}
export async function createManualContinuation(client,input){
  if(!input||Object.keys(input).some(k=>!['sourceRunId','message','requestId','confirm'].includes(k))||input.confirm!==true||!uuid(input.requestId)||typeof input.message!=='string'||input.message.trim().length<4||input.message.length>2000)throw bad();
  const proof=await readManualContinuation(client,{sourceRunId:input.sourceRunId}),revision=await client.request(`/revisions/${proof.binding.revisionId}`);
  if(revision.id!==proof.binding.revisionId||revision.hash!==proof.binding.revisionHash||revision.contextId!==proof.contextId||typeof revision.sql!=='string')throw bad();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(revision.sql))),v=>v.toString(16).padStart(2,'0')).join('');if(hash!==revision.hash)throw bad();
  const body={message:input.message.trim(),sql:revision.sql,contextId:proof.contextId,manualContinuation:proof.binding},task=await client.request('/agent/tasks',{method:'POST',body,idempotencyKey:input.requestId});
  if(!manualContinuationReceiptMatches(task,body))throw bad();return task;
}
