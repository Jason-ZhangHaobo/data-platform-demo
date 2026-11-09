const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const invalid=()=>Object.assign(new Error('对照修正回执与所选运行或代码不一致；未新建任务'),{code:'REPAIR_COMPARISON_RECEIPT_INVALID'});
export function comparisonRepairReceiptMatches(task,body){
  const binding=body?.repairComparison??task?.repairComparison;
  if(binding===undefined)return true;
  const keys=['baselineRunId','currentRevisionHash','baselineRevisionHash','evidenceDigest'];
  return !!task&&uuid(task.id)&&task.sourceKind==='MANUAL'&&task.agentIndependentE2E===false&&task.sourceAttribution?.kind==='ENGINEER_ASSISTED'&&
    task.sourceAttribution.agentIndependentE2E===false&&task.sourceAttribution.sourceRunId===task.sourceRunId&&
    task.sourceAttribution.baselineRunId===binding.baselineRunId&&task.sourceAttribution.evidenceDigest===binding.evidenceDigest&&
    uuid(binding.baselineRunId)&&keys.slice(1).every(k=>digest(binding[k]))&&keys.every(k=>task.repairComparison?.[k]===binding[k])&&
    (body===undefined||task.sourceRunId===body.sourceRunId&&task.contextId===body.contextId&&task.initialSql===body.sql);
}
export async function readRepairComparisonBasis(client,{sourceRunId,baselineRunId,currentRevisionHash,baselineRevisionHash,contextId}){
  if(!uuid(sourceRunId)||!uuid(baselineRunId)||sourceRunId===baselineRunId)throw invalid();
  const v=await client.request(`/runs/${sourceRunId}/repair-comparison?baseline_run_id=${baselineRunId}`),b=v?.binding;
  if(v?.protocol!=='shuduo-sql-repair-basis/v1'||v.sourceRunId!==sourceRunId||b?.baselineRunId!==baselineRunId||
    !['currentRevisionHash','baselineRevisionHash','evidenceDigest'].every(k=>digest(b?.[k]))||Object.keys(b).length!==4||
    currentRevisionHash!==undefined&&b.currentRevisionHash!==currentRevisionHash||baselineRevisionHash!==undefined&&b.baselineRevisionHash!==baselineRevisionHash||contextId!==undefined&&v.contextId!==contextId||
    v.summary?.sourceRunId!==sourceRunId||v.summary.baselineRunId!==baselineRunId||v.summary.evidenceDigest!==b.evidenceDigest||v.summary.agentIndependentE2E!==false||v.summary.causalConclusion!=='NOT_ESTABLISHED'||
    v.attribution?.sourceKind!=='MANUAL'||v.attribution.agentIndependentE2E!==false)throw invalid();
  return {protocol:v.protocol,sourceRunId:v.sourceRunId,contextId:v.contextId,binding:{baselineRunId:b.baselineRunId,currentRevisionHash:b.currentRevisionHash,baselineRevisionHash:b.baselineRevisionHash,evidenceDigest:b.evidenceDigest}};
}
// GUI uses its existing original-request recovery controller. CLI/MCP callers
// supply their own stable requestId and query that same request on lost response.
export async function createComparisonRepairTask(client,{sourceRunId,baselineRunId,message,requestId,confirm}){
  if(confirm!==true||!uuid(requestId)||typeof message!=='string'||message.trim().length<4||message.length>2000)throw invalid();
  const basis=await readRepairComparisonBasis(client,{sourceRunId,baselineRunId}),run=await client.request(`/runs/${sourceRunId}`),rev=await client.request(`/revisions/${run.revisionId}`);
  if(run.id!==sourceRunId||run.revisionHash!==basis.binding.currentRevisionHash||rev.id!==run.revisionId||rev.hash!==basis.binding.currentRevisionHash||rev.contextId!==basis.contextId||typeof rev.sql!=='string')throw invalid();
  const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(rev.sql))),b=>b.toString(16).padStart(2,'0')).join('');
  if(actual!==rev.hash)throw invalid();
  const body={message:message.trim(),sql:rev.sql,contextId:basis.contextId,sourceRunId,repairComparison:basis.binding};
  const task=await client.request('/agent/tasks',{method:'POST',idempotencyKey:requestId,body});
  if(!comparisonRepairReceiptMatches(task,body))throw invalid();return task;
}
