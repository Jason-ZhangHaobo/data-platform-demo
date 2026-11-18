import {manualRunRecovery,verifiedManualOrigin} from './manual-run-recovery.ts';
import type {ManualRevisionReceipt} from './manual-run-recovery.ts';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function recoverManualRun<R extends ManualRevisionReceipt,T extends {id:string;revisionId?:string}>(
  pending:{revisionId:string;key:string},
  options:{href:string;isCurrent:()=>boolean;readRevision:(id:string)=>Promise<R>;
    submitRun:(revisionId:string,key:string)=>Promise<T>;acceptRevision?:(revision:R,originTaskId?:string)=>void},
) {
  const {revisionId,key}=pending,recovery=manualRunRecovery(options.href);
  if(!uuid.test(revisionId)||!uuid.test(key)||recovery.revisionId!==revisionId||recovery.requestKey!==key)
    throw Error('恢复链接与原提交编号不一致，未重新提交运行。');
  if(!options.isCurrent())return;
  const saved=await options.readRevision(revisionId);
  if(!options.isCurrent())return;
  if(saved.id!==revisionId||typeof saved.sql!=='string'||!saved.sql.trim()||typeof saved.contextId!=='string'||!saved.contextId.trim()||
    saved.source!=='MANUAL'||saved.manualProvenance?.kind!=='ENGINEER_EDIT'||saved.manualProvenance.agentIndependentE2E!==false)
    throw Error('原手工版本回执未通过核对，未重新提交运行。');
  const originTaskId=verifiedManualOrigin(saved,recovery.originTaskId);
  options.acceptRevision?.(saved,originTaskId);
  if(!options.isCurrent())return;
  const run=await options.submitRun(revisionId,key);
  if(!options.isCurrent())return;
  if(!uuid.test(run.id)||run.revisionId!==revisionId)
    throw Error('返回批次与原版本不一致，保留恢复编号。');
  return {revision:saved,run,originTaskId};
}
