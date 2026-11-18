import {createHash} from 'node:crypto';
const fail=(status,message,code='QUALITY_SOURCE_INVALID')=>Object.assign(Error(message),{status,code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v),sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function qualityRunInput(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['expectedVersionId','sourceSelection'].includes(k)))throw fail(422,'检测参数只接受规则基准版本及显式sourceSelection，不能忽略其他批次参数');
 if(input.sourceSelection!==undefined){qualityArchiveSelection(input.sourceSelection);if(!uuid(input.expectedVersionId))throw fail(422,'归档检测须指定已审阅的规则版本');}return input;
}
export function qualityArchiveSelection(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==5||Object.keys(value).some(k=>!['kind','taskId','runId','snapshotHash','metadataVersionId'].includes(k))||value.kind!=='SYNC_RUN_ARCHIVE_V1'||!uuid(value.taskId)||!uuid(value.runId)||!uuid(value.metadataVersionId)||!sha(value.snapshotHash))throw fail(422,'请选择完整的原归档批次、元数据版本及快照摘要');
 return {kind:value.kind,taskId:value.taskId,runId:value.runId,metadataVersionId:value.metadataVersionId,snapshotHash:value.snapshotHash};
}
export function createQualityArchiveSource({store,project,ingestion}){
 function source(rule,selected){
  const selection=qualityArchiveSelection(selected),task=store.get('offline_sync_task',selection.taskId,project),run=store.get('offline_sync_run',selection.runId,project);
  if(!task||!run||run.taskId!==task.id)throw fail(404,'原归档任务或批次不存在');
  if(rule.assetId!==`landing:${task.targetTable}`)throw fail(409,'归档批次不属于当前规则的落地表');
  if(run.metadataVersionId!==selection.metadataVersionId||run.landingSnapshotHash!==selection.snapshotHash)throw fail(409,'归档版本或摘要与已选来源不一致');
  const retained=ingestion.retainedRunSnapshot(task.id,run.id);
  if(retained.status!=='VERIFIED'||retained.integrityVerified!==true||retained.snapshotHash!==selection.snapshotHash)throw fail(409,'原批次未留存或完整性未确认，不能改用当前表');
  const evidence={...selection,targetTable:task.targetTable,targetHash:retained.targetHash,rowCount:retained.rowCount},evidenceHash=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  return {asset:{id:rule.assetId,versionId:run.id,evidenceHash,syncSource:{status:'VERIFIED',runId:run.id,metadataVersionId:run.metadataVersionId}},rows:retained.rows,archiveSource:{...evidence,evidenceHash,healthImpact:'HISTORY_ONLY'}};
 }
 function candidates(rule){
  if(!rule.assetId.startsWith('landing:'))return [];
  const tasks=new Map(store.list('offline_sync_task',project).filter(t=>rule.assetId===`landing:${t.targetTable}`).map(t=>[t.id,t]));
  return store.list('offline_sync_run',project).filter(r=>tasks.has(r.taskId)&&r.status==='SUCCEEDED'&&r.actualExecution===true&&r.snapshotStatus==='RETAINED'&&sha(r.landingSnapshotHash)).slice(0,40).map(r=>({selection:{kind:'SYNC_RUN_ARCHIVE_V1',taskId:r.taskId,runId:r.id,metadataVersionId:r.metadataVersionId,snapshotHash:r.landingSnapshotHash},taskName:tasks.get(r.taskId).name,rowCount:r.finalCount,createdAt:r.createdAt,integrity:'RECHECK_BEFORE_RUN'}));
 }
 return {source,candidates};
}
