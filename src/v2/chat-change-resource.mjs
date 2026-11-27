export const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
export const validSource=s=>uuid(s?.taskId) && uuid(s.revisionId) && uuid(s.runId) && digest(s.revisionHash) &&
  typeof s.contextId==='string' && s.contextId.length>0;
export const sameSource=(a,b)=>['taskId','revisionId','revisionHash','runId','contextId'].every(key=>a?.[key]===b?.[key]);

export function chatChangeResourcePath({intentId,changeRequestId,sourceRunId,sourceTaskId},resource) {
  if (!uuid(intentId) || typeof changeRequestId!=='string' || !/^chat-derive-v1-[a-f0-9]{64}$/.test(changeRequestId) ||
      (sourceRunId!==undefined && !uuid(sourceRunId)) || (sourceTaskId!==undefined && !uuid(sourceTaskId)) ||
      !['delivery','publication'].includes(resource)) throw Error('请使用原对话、变更请求和已保存批次的编号。');
  return `/agent/intents/${intentId}/development/changes/${changeRequestId}/${resource}`;
}
