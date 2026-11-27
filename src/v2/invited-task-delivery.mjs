import {uuid,digest} from './chat-change-resource.mjs';

function selection(input) {
  if (!input || Object.keys(input).some(key=>!['taskId','revisionId','revisionHash','runId','deliveryId'].includes(key)) ||
      !uuid(input.taskId) || !uuid(input.revisionId) || !digest(input.revisionHash) || !uuid(input.runId) ||
      (input.deliveryId!==undefined && !uuid(input.deliveryId)))
    throw Object.assign(Error('请指定原任务、代码版本、SQL 摘要和开发批次'),{status:422});
  return input;
}

export function readInvitedDeliverySelection(taskId,query) {
  const keys=[...query.keys()];
  if (new Set(keys).size!==keys.length || keys.includes('taskId'))
    throw Object.assign(Error('原交付链接的来源参数重复或混用了其他任务'),{status:422});
  return selection({taskId,...Object.fromEntries(query)});
}

export function invitedTaskDeliveryPath(input) {
  const {taskId,revisionId,revisionHash,runId,deliveryId}=selection(input);
  const query=new URLSearchParams({revisionId,revisionHash,runId});
  if (deliveryId) query.set('deliveryId',deliveryId);
  return '/agent/tasks/'+taskId+'/chat-delivery?'+query;
}

export async function invitedTaskDeliveryRequestId(input) {
  const {taskId,revisionId,revisionHash,runId}=selection(input);
  const bytes=new TextEncoder().encode(JSON.stringify(['shuduo-invited-chat-delivery/v1',taskId,revisionId,revisionHash,runId]));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  return hash.slice(0,8)+'-'+hash.slice(8,12)+'-8'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32);
}
