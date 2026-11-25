import {exactDeliveryAdvance} from './agent-workflow-read.ts';
import type {Delivery, RehearsalSettlementEvidence, Workflow} from './agent-workflow-read.ts';

export function pendingOriginalRehearsal(workflow: Workflow | undefined, delivery=workflow?.delivery) {
  return Boolean(delivery?.sourcePinned && delivery.mode==='DURABLE_AGENT_DELIVERY_V1' &&
    ['QUEUED','RUNNING'].includes(delivery.status) &&
    workflow?.publication.scope==='PRIVATE_CLOUD_TEST' &&
    (workflow.eventDrivenRehearsal || delivery.rehearsalBackground?.state==='BATCH_RESERVED') &&
    delivery.verificationId && workflow.verification?.id===delivery.verificationId &&
    ['QUEUED','RUNNING'].includes(workflow.verification.status) &&
    ['FILE_REHEARSAL_SUBMITTING','FILE_REHEARSAL_RUNNING'].includes(delivery.stage));
}

export function assertSameRehearsal(original: Delivery, returned: Delivery | undefined) {
  if (!returned || !original.verificationId || returned.id!==original.id || returned.verificationId!==original.verificationId ||
      returned.packageId!==original.packageId || returned.packageDigest!==original.packageDigest ||
      returned.sourceRunId!==original.sourceRunId || returned.sourceRevisionId!==original.sourceRevisionId)
    throw Error('读取到的记录与原演练批次不符。请刷新交付记录后确认当前批次。');
}

export async function checkOriginalRehearsal(workflow: Workflow,
  submit:(path:string, body:unknown)=>Promise<unknown>, read:()=>Promise<Workflow|undefined>) {
  const original=workflow.delivery;
  if (!original || !pendingOriginalRehearsal(workflow,original)) throw Error('原演练批次尚未确认。');
  const body=exactDeliveryAdvance(workflow,original);
  let submission:'SENT'|'DENIED'|'UNCONFIRMED'='SENT';
  try { await submit('/agent/deliveries/'+original.id+'/advance',body); }
  catch (error) {
    const status=(error as {status?:number}|null)?.status;
    submission=(status===401||status===403)?'DENIED':'UNCONFIRMED';
  }
  // A lost POST reply can still mean the original result was committed.
  // Re-read once. A second POST requires a new user action.
  const latest=await read();
  if (!latest) return;
  assertSameRehearsal(original,latest.delivery);
  if (!latest.verification || latest.verification.id!==original.verificationId ||
      (latest.verification.status==='SUCCEEDED' && latest.delivery?.status!=='SUCCEEDED'))
    throw Error('演练回执和交付任务的状态尚未对齐。请刷新原批次。');
  switch (latest.verification?.status) {
    case 'SUCCEEDED': return '原演练批次已核对，结果已保存。';
    case 'FAILED': return '原演练已记录失败，请查看该批次的错误。';
    case 'CANCELLED': return '原演练批次已取消。';
    case 'INTERRUPTED': return '原演练批次已中断。';
    case 'RUNNING':
    case 'QUEUED':
      if(submission==='DENIED') return '当前账号或窗口无权登记回执，原批次仍待确认。';
      return submission==='SENT' ? '已核对原批次，Worker 结果仍待确认。' : '核对请求的结果未知，原批次记录仍在等待回执。';
    default: throw Error('未能确认原演练的结果。请重新读取该批次。');
  }
}

export function settlementLabel(proof: RehearsalSettlementEvidence | undefined) {
  if (!proof) return '历史回执未记录';
  return {
    SIGNED_RESULT_EVENT:'后台收到签名结果事件',
    SIGNED_REHEARSAL_WAKE:'后台执行签名演练事件时取得回执',
    OWNER_RECONCILIATION:'操作人核对原批次'
  }[proof.trigger];
}
