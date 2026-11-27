import { verifiedDeliveryBytes } from './delivery-file-bytes.mjs';

const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const changeKey=value=>typeof value==='string' && /^chat-derive-v1-[a-f0-9]{64}$/.test(value);
const states=new Set(['NOT_PREPARED','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED']);
const bad=()=>Error('派生交付回执与当前选定的任务、版本或文件未能核对，请重新读取原记录。');

function pathFor({intentId,changeRequestId,sourceRunId,sourceTaskId}) {
  if (!uuid(intentId) || !changeKey(changeRequestId) ||
      (sourceRunId!==undefined && !uuid(sourceRunId)) || (sourceTaskId!==undefined && !uuid(sourceTaskId))) throw bad();
  return `/agent/intents/${intentId}/development/changes/${changeRequestId}/delivery`;
}
const validSource=s=>uuid(s?.taskId) && uuid(s.revisionId) && uuid(s.runId) && digest(s.revisionHash) &&
  typeof s.contextId==='string' && s.contextId.length>0;
const sameSource=(a,b)=>['taskId','revisionId','revisionHash','runId','contextId'].every(key=>a?.[key]===b?.[key]);

async function checked(value,input) {
  if (value?.protocol!=='shuduo-chat-change-delivery/v1' || value.intentId!==input.intentId ||
      value.changeRequestId!==input.changeRequestId || !uuid(value.requestId) || !states.has(value.status)) throw bad();
  const {source,parent,delivery,package:bundle,verification}=value;
  if (!validSource(source) || !validSource(parent) || parent.taskId===source.taskId || parent.runId===source.runId ||
      parent.revisionId===source.revisionId || source.contextId===parent.contextId ||
      (input.sourceRunId!==undefined && input.sourceRunId!==source.runId) ||
      (input.sourceTaskId!==undefined && input.sourceTaskId!==source.taskId) ||
      (input.expectedParent!==undefined && !sameSource(parent,input.expectedParent)) ||
      (input.expectedSource!==undefined && !sameSource(source,input.expectedSource))) throw bad();
  if (value.status==='NOT_PREPARED') {
    if (delivery || bundle || verification) throw bad();
    return value;
  }
  if (!uuid(delivery?.id) || delivery.status!==value.status || delivery.sourceAgentTaskId!==source.taskId ||
      delivery.sourceRunId!==source.runId || delivery.sourceRevisionId!==source.revisionId ||
      delivery.sourceSqlHash!==source.revisionHash) throw bad();
  if (bundle || delivery.packageId) {
    const saved=bundle?.manifest?.source;
    if (!uuid(bundle?.id) || bundle.id!==delivery.packageId || !digest(bundle.digest) || bundle.digest!==delivery.packageDigest ||
        bundle.manifest?.format!=='shuduo-delivery/v1' || bundle.manifest.releaseState!=='NOT_PUBLISHED' ||
        saved?.runId!==source.runId || saved.revisionId!==source.revisionId || saved.sqlHash!==source.revisionHash ||
        saved.contextId!==source.contextId || saved.derivation?.kind!=='REGISTERED_CONTEXT_CHANGE' || !sameSource(saved.derivation,parent) ||
        !await verifiedDeliveryBytes(bundle,source.revisionHash)) throw bad();
  }
  if (verification && (!uuid(verification.id) || verification.id!==delivery.verificationId || !bundle)) throw bad();
  if (value.status==='SUCCEEDED') {
    const checks=verification?.validation?.regressions;
    if (!bundle || verification?.status!=='SUCCEEDED' || verification.engine!=='Apache Spark' ||
        !/^\d+\.\d+\.\d+$/.test(verification.engineVersion) || verification.mainSqlExecuted!==true ||
        verification.testSqlValidation?.passed!==true || verification.testSqlValidation.sqlHash!==bundle.manifest.files['tests.sql'].sha256 ||
        verification.validation?.passed!==true || !Array.isArray(checks) || checks.length!==5 ||
        !checks.every(c=>typeof c?.contextId==='string' && c.passed===true) ||
        new Set(checks.map(c=>c.contextId)).size!==checks.length) throw bad();
    const fixtures=JSON.parse(bundle.files['fixtures.json']), schedule=JSON.parse(bundle.files['schedule.json']);
    const deployment=JSON.parse(bundle.files['deployment.json']);
    if (deployment.runtime?.version!==verification.engineVersion || !Number.isFinite(Date.parse(verification.scheduledFor)) ||
        verification.businessDate!==fixtures.context?.businessDate || !Array.isArray(fixtures.validationContexts) ||
        fixtures.validationContexts.length!==checks.length ||
        !checks.every(check=>fixtures.validationContexts.some(context=>context.id===check.contextId)) ||
        !Array.isArray(schedule.nodes) || !Array.isArray(verification.executionOrder) ||
        verification.executionOrder.length!==schedule.nodes.length) throw bad();
    const completed=new Set();
    for (const id of verification.executionOrder) {
      const node=schedule.nodes.find(item=>item.id===id);
      if (!node || completed.has(id) || !Array.isArray(node.dependsOn) || !node.dependsOn.every(dep=>completed.has(dep))) throw bad();
      completed.add(id);
    }
  }
  return value;
}

export async function readChatChangeDelivery(client,input) {
  return checked(await client.request(pathFor(input)),input);
}

export async function prepareChatChangeDelivery(client,input) {
  if (input.confirm!==true || !uuid(input.sourceRunId) || !uuid(input.requestId)) throw Error('请确认已审阅的派生批次和准备请求编号。');
  const path=pathFor(input);
  const current=await readChatChangeDelivery(client,input);
  if (current.requestId!==input.requestId) throw bad();
  if (current.status!=='NOT_PREPARED') return current;
  try {
    const result=await client.request(path,{method:'POST',body:{source:current.source,confirm:true},idempotencyKey:input.requestId});
    const receipt=await checked(result,input);
    if (receipt.requestId!==input.requestId || !sameSource(receipt.source,current.source) ||
        !sameSource(receipt.parent,current.parent) || receipt.status==='NOT_PREPARED') throw bad();
    return receipt;
  } catch (error) {
    if (error.status>=400 && error.status<500) throw error;
    // A lost response may follow a successful write. Reconcile once via GET.
    const saved=await readChatChangeDelivery(client,input);
    if (saved.requestId!==input.requestId || !sameSource(saved.source,current.source) ||
        !sameSource(saved.parent,current.parent) || saved.status==='NOT_PREPARED')
      throw Error('尚未确认本次交付准备，请按原请求编号查询；系统保留本次选择。');
    return saved;
  }
}
