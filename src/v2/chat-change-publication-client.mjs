import {chatChangeResourcePath,digest,sameSource,uuid,validSource} from './chat-change-resource.mjs';

const phases=['READY','PUBLISHED'];
const statuses=new Set(['SCHEDULED','RUNNING','SUCCEEDED','FAILED','VALIDATION_FAILED','CANCELLED','INTERRUPTED']);
const attestations=['code','assertions','deliveryFiles','localScope'];
const timestamp=value=>typeof value==='string' && Number.isFinite(Date.parse(value));
const bad=()=>Error('发布回执与所选版本、演练或原批次不一致，请重新读取原会话。');
const path=input=>chatChangeResourcePath(input,'publication');

function checked(receipt,input) {
  if (receipt?.protocol!=='shuduo-chat-change-publication/v1' || receipt.intentId!==input.intentId ||
      receipt.scope!=='LOCAL_TEST_RELEASE' || receipt.publicDeployed!==false ||
      receipt.changeRequestId!==input.changeRequestId || !uuid(receipt.requestId) || !phases.includes(receipt.phase) ||
      !validSource(receipt.source) || !validSource(receipt.parent) || receipt.source.taskId===receipt.parent.taskId ||
      receipt.source.runId===receipt.parent.runId || receipt.source.revisionId===receipt.parent.revisionId ||
      !uuid(receipt.packageId) || !digest(receipt.packageDigest) || !uuid(receipt.verificationId) ||
      !digest(receipt.reviewDigest) || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.businessDate) ||
      typeof receipt.canPublish!=='boolean' || typeof receipt.monitoringVerified!=='boolean' ||
      receipt.scheduleSpec?.runCount!==2 || receipt.scheduleSpec.triggerAfterSeconds!==5 || receipt.scheduleSpec.intervalSeconds!==30 ||
      !Array.isArray(receipt.runs) || !Array.isArray(receipt.events) || !Array.isArray(receipt.alerts)) throw bad();
  if ((input.expectedSource && !sameSource(receipt.source,input.expectedSource)) ||
      (input.expectedParent && !sameSource(receipt.parent,input.expectedParent)) ||
      (input.sourceRunId!==undefined && input.sourceRunId!==receipt.source.runId) ||
      (input.sourceTaskId!==undefined && input.sourceTaskId!==receipt.source.taskId) ||
      ['packageId','packageDigest','verificationId','requestId','reviewDigest'].some(key=>input[key]!==undefined && input[key]!==receipt[key]))
    throw bad();
  if (receipt.phase==='READY') {
    if (receipt.reviewId!=null || receipt.reviewActorScope!=null || receipt.approvalId!=null || receipt.release ||
        receipt.monitoringVerified || receipt.runs.length || receipt.alerts.length || receipt.events.length) throw bad();
    return receipt;
  }
  if (!uuid(receipt.reviewId) || !uuid(receipt.approvalId) || !['LOCAL_DEVELOPER','SIGNED_MEMBER'].includes(receipt.reviewActorScope) ||
      !uuid(receipt.release?.id) || typeof receipt.release.status!=='string' || typeof receipt.release.health!=='string' ||
      receipt.runs.length!==2 || new Set(receipt.runs.map(run=>run.id)).size!==2) throw bad();
  for (const [i,run] of receipt.runs.entries()) {
    if (!uuid(run?.id) || run.sequence!==i+1 || !statuses.has(run.status) || typeof run.schedulerTriggered!=='boolean' ||
        !timestamp(run.scheduledTriggerAt) || (run.schedulerTriggered && (!timestamp(run.triggeredAt) ||
          Date.parse(run.triggeredAt)<Date.parse(run.scheduledTriggerAt))) ||
        (i>0 && Date.parse(run.scheduledTriggerAt)<=Date.parse(receipt.runs[i-1].scheduledTriggerAt))) throw bad();
    if (run.status==='SUCCEEDED' && (!run.schedulerTriggered || run.resultUnknown || !timestamp(run.finishedAt) ||
        Date.parse(run.finishedAt)<Date.parse(run.triggeredAt) ||
        run.engine!=='Apache Spark' || !/^\d+\.\d+\.\d+$/.test(run.engineVersion) ||
        run.testSqlPassed!==true || run.assertionCount!==5 || !Number.isSafeInteger(run.rowCount) || run.rowCount<0 ||
        typeof run.totalAssets!=='string' || !/^-?\d+\.\d{2}$/.test(run.totalAssets))) throw bad();
  }
  for (const item of [...receipt.events,...receipt.alerts]) {
    if (!uuid(item?.id) || (item.releaseRunId!=null && !receipt.runs.some(run=>run.id===item.releaseRunId))) throw bad();
  }
  if (receipt.events.some(event=>!timestamp(event.observedAt) || typeof event.type!=='string') ||
      receipt.alerts.some(alert=>!['OPEN','RESOLVED'].includes(alert.status))) throw bad();
  if (receipt.monitoringVerified && (receipt.runs.some(run=>run.status!=='SUCCEEDED' ||
      receipt.events.filter(event=>event.type==='BATCH_SUCCEEDED' && event.releaseRunId===run.id &&
        Date.parse(event.observedAt)>=Date.parse(run.finishedAt)).length!==1) ||
      receipt.alerts.some(alert=>alert.status==='OPEN'))) throw bad();
  return receipt;
}

export async function readChatChangePublication(client,input) {
  return checked(await client.request(path(input)),input);
}

export function reviewedChatChangeInput(receipt,attestations,confirm) {
  checked(receipt,{intentId:receipt?.intentId,changeRequestId:receipt?.changeRequestId});
  path(receipt);
  return {intentId:receipt.intentId,changeRequestId:receipt.changeRequestId,sourceRunId:receipt.source.runId,
    expectedSource:receipt.source,expectedParent:receipt.parent,requestId:receipt.requestId,
    packageId:receipt.packageId,packageDigest:receipt.packageDigest,verificationId:receipt.verificationId,
    reviewDigest:receipt.reviewDigest,attestations,confirm};
}

export async function publishChatChange(client,input) {
  const attest=input.attestations;
  if (input.confirm!==true || !uuid(input.sourceRunId) || !uuid(input.packageId) || !digest(input.packageDigest) ||
      !uuid(input.verificationId) || !uuid(input.requestId) || !digest(input.reviewDigest) ||
      !attest || Object.keys(attest).length!==attestations.length || !attestations.every(key=>attest[key]===true))
    throw Error('请审阅所选代码、断言、文件和两个本机测试批次，逐项确认后再发布。');
  const before=await readChatChangePublication(client,input);
  if (before.phase==='PUBLISHED') return before;
  if (!before.canPublish) throw Error('当前会话或调度器不能发布此测试版本。');
  const body={source:before.source,packageId:before.packageId,packageDigest:before.packageDigest,verificationId:before.verificationId,
    reviewDigest:before.reviewDigest,attestations:{...attest},confirm:true};
  const expected={...input,expectedParent:before.parent,expectedSource:before.source};
  try {
    const result=checked(await client.request(path(input),{method:'POST',idempotencyKey:before.requestId,body}),expected);
    if (result.phase!=='PUBLISHED') throw bad();
    return result;
  } catch (error) {
    if (error.status>=400 && error.status<500) throw error;
    // The write may have succeeded. Read the original request without resending it.
    const recovered=await readChatChangePublication(client,expected);
    if (recovered.phase==='READY') throw Error('发布提交结果尚待确认，请查询原发布请求。');
    return recovered;
  }
}
