// Shared read-only client syntax; server identity and provenance remain final.
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function serviceSourceReadPath(kind, input = {}) {
  const invalid = () => new Error('需提供合法的任务、确切包摘要与发布编号；来源不完整时不会回退其他结果');
  if (!['sources','task-evidence'].includes(kind) || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['agentTaskId','manualDeliveryTaskId','packageDigest','releaseId','callIdDigest','batchId'].includes(key))) throw invalid();
  for (const key of ['agentTaskId','manualDeliveryTaskId','releaseId','batchId']) if (Object.hasOwn(input,key) && (typeof input[key] !== 'string' || !uuid.test(input[key]))) throw invalid();
  if (Object.hasOwn(input,'packageDigest') && (typeof input.packageDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.packageDigest))) throw invalid();
  if (Object.hasOwn(input,'callIdDigest') && (kind !== 'task-evidence' || !input.releaseId ||
      typeof input.callIdDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.callIdDigest))) throw invalid();
  if (input.batchId && (kind !== 'task-evidence' || !input.releaseId || !input.agentTaskId)) throw invalid();
  if(input.manualDeliveryTaskId&&(input.agentTaskId||!input.packageDigest||!input.releaseId))throw invalid();
  if (!input.manualDeliveryTaskId && (kind === 'task-evidence' ? !input.agentTaskId || !input.packageDigest :
      (input.packageDigest || input.releaseId) && (!input.agentTaskId || !input.packageDigest || !input.releaseId))) throw invalid();
  const query = new URLSearchParams();
  for (const [key,name] of [['agentTaskId','agent_task_id'],['manualDeliveryTaskId','manual_delivery_task_id'],['packageDigest','package_digest'],['releaseId','release_id'],['callIdDigest','call_id_digest'],['batchId','release_batch_id']])
    if (Object.hasOwn(input,key)) query.set(name,input[key]);
  return `/data-services/${kind}${query.size ? '?' + query : ''}`;
}
