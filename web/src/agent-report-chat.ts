import { publishedReportSource, reportRequestId } from '../../src/v2/published-report-request.mjs';
import type { PublishedReportBinding } from '../../src/v2/published-report-request.mjs';
import { checkedPublishedReportReceipt } from '../../src/v2/published-report-client.mjs';
import { readSyncSqlOutputSchema } from '../../src/v2/sync-sql-output-schema-client.mjs';
import { serviceHandoffLocation,serviceSourceFromLocation,serviceSourcesPath,sourceRunEligible,sourceRunMatches,
  validServiceSourceBinding } from './service-source-binding.ts';
import type {ServiceSourceBinding} from './service-source-binding.ts';

export type ReportBatch = ReturnType<typeof publishedReportSource>;
type SourceRun = Parameters<typeof sourceRunMatches>[0] & {sequence?:number; sourceEvidence?:{
  protocol?:string;snapshotHash?:string;metadataVersionId?:string;syncRunId?:string;businessDate?:string
}};
export type ChatTarget = {source:ReportBatch;requestId?:string};
export const sameReportSource = (a:unknown,b:unknown) => {
  try{return JSON.stringify(publishedReportSource(a))===JSON.stringify(publishedReportSource(b));}catch{return false;}
};
function serviceBinding(source:ReportBatch):ServiceSourceBinding {
  if (source.kind!=='AGENT' || !source.taskId) throw Error('请选择原生持仓 Agent 的发布批次。');
  return {taskId:source.taskId,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',releaseId:source.releaseId,
    packageDigest:source.packageDigest,revisionId:source.revisionId,runId:source.runId};
}
export function chatBatchLocation(href:string,source:PublishedReportBinding,requestId?:string) {
  const pinned=publishedReportSource(source);
  const url=serviceHandoffLocation(href,serviceBinding(pinned));
  url.searchParams.set('module','agent-center');
  url.searchParams.set('chat_batch',pinned.batchId);
  if(requestId)url.searchParams.set('chat_request',reportRequestId(requestId));
  url.hash='agent-chat';
  return url.pathname+url.search+url.hash;
}
export function chatBatchTarget(href:string):ChatTarget|null|undefined {
  const url=new URL(href),q=url.searchParams;
  if(!q.has('chat_batch')&&!q.has('chat_request'))return undefined;
  const selected=serviceSourceFromLocation(href);
  if(q.getAll('module').length!==1||q.get('module')!=='agent-center'||q.getAll('chat_batch').length!==1||
    q.getAll('chat_request').length>1||q.has('report_request')||q.has('task')||selected.status!=='VALID')return null;
  const b=selected.binding;
  if(b.sourceKind!=='AGENT'||b.scope!=='LOCAL_TEST_ONLY'||!b.taskId||!b.revisionId||!b.runId)return null;
  try{return {source:publishedReportSource({kind:'AGENT',taskId:b.taskId,releaseId:b.releaseId,revisionId:b.revisionId,runId:b.runId,
    packageDigest:b.packageDigest,batchId:reportRequestId(q.get('chat_batch'))}),...(q.has('chat_request')?{requestId:reportRequestId(q.get('chat_request'))}:{})};}
  catch{return null;}
}
export function chatBatchFromServiceHref(href:string) {
  const url=new URL(href,'http://localhost/');
  const b=serviceSourceFromLocation(url.href);
  if(b.status!=='VALID'||b.binding.scope!=='LOCAL_TEST_ONLY'||b.binding.sourceKind!=='AGENT'||url.searchParams.getAll('release_batch').length!==1)throw Error('发布来源未确认');
  const target=b.binding;
  return chatBatchLocation(url.href,publishedReportSource({kind:'AGENT',taskId:target.taskId,releaseId:target.releaseId,
    revisionId:target.revisionId,runId:target.runId,packageDigest:target.packageDigest,batchId:url.searchParams.get('release_batch')}));
}
export function chatBatchCandidates(value:unknown) {
  if(!Array.isArray(value))throw Error('发布批次目录无法读取。');
  return (value as SourceRun[]).flatMap(r=>{
    const b={taskId:r.sourceAgentTaskId,sourceKind:r.sourceKind,scope:r.scope,releaseId:r.releaseId,revisionId:r.sourceRevisionId,runId:r.sourceRunId,packageDigest:r.packageDigest};
    if(!validServiceSourceBinding(b)||b.sourceKind!=='AGENT'||b.scope!=='LOCAL_TEST_ONLY'||!sourceRunEligible(r)||
       r.sourceEvidence?.protocol!=='shuduo-sync-sql-consumption-source/v1'||![1,2].includes(r.sequence??0))return [];
    return [{source:publishedReportSource({kind:'AGENT',taskId:b.taskId,releaseId:b.releaseId,revisionId:b.revisionId,
      runId:b.runId,packageDigest:b.packageDigest,batchId:r.id}),sequence:r.sequence,businessDate:r.sourceEvidence.businessDate}];
  });
}
export async function readWealthBatch(api:<T>(path:string)=>Promise<T>,source:ReportBatch) {
  const b=serviceBinding(source);
  const [runs,schema]=await Promise.all([api<SourceRun[]>(serviceSourcesPath(b)),readSyncSqlOutputSchema({request:path=>api(path)},{runId:source.runId})]);
  if(!Array.isArray(runs)||!runs.every(r=>sourceRunMatches(r,b)))throw Error('原发布来源无法核对。');
  const matched=runs.filter(r=>r.id===source.batchId&&sourceRunEligible(r)),r=matched[0],e=r?.sourceEvidence;
  if(matched.length!==1||![1,2].includes(r.sequence??0)||!e||e.protocol!=='shuduo-sync-sql-consumption-source/v1'||
    schema.status!=='MATCHED'||schema.source.revisionId!==source.revisionId||schema.source.snapshotHash!==e.snapshotHash||
    schema.inputMetadata?.sourceType!=='SERVER_MYSQL'||schema.inputMetadata.syncRunId!==e.syncRunId||
    schema.inputMetadata.frozen.metadataVersionId!==e.metadataVersionId)throw Error('指定批次或原 MySQL 持仓归档未能核对。');
  return {sequence:r.sequence!,businessDate:e.businessDate};
}

export function appliedChatReport(plan:Record<string,unknown>|undefined,source:ReportBatch|undefined) {
  if(!source||plan?.requestBasisState!=='VERIFIED'||plan.planMode!=='PUBLISHED_SOURCE_REPORT_V1'||plan.status!=='APPLIED'||!sameReportSource(plan.sourceBinding,source))return;
  try{
    const receipt=checkedPublishedReportReceipt(plan.reportCreation,{requestId:reportRequestId(plan.id),source});
    return receipt.status==='SUCCEEDED'&&receipt.reportId===plan.reportId?receipt:undefined;
  }catch{return;}
}
