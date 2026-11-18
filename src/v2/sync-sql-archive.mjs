import {ingestionSchemaHash} from './ingestion.mjs';
import {currentSyncSqlInput,syncSqlLandingContext} from './sync-sql-input.mjs';
import {archivedSyncInputKind,materializedSyncInputKind,parseSyncSqlSelection} from './sync-sql-selection.mjs';

const unavailable=()=>Object.assign(Error('所选原批次不符合已登记的全量虚构持仓输入，未使用当前表替代'),{status:409,code:'SYNC_SQL_ARCHIVE_UNAVAILABLE'});
const supported=(task,run)=>task?.sourceType==='LOCAL_CSV'&&task.mode==='FULL'&&task.targetTable==='raw_positions'&&
  run?.taskId===task.id&&run.status==='SUCCEEDED'&&run.actualExecution===true&&run.snapshotStatus==='RETAINED'&&
  Number.isInteger(run.finalCount)&&run.finalCount>0&&run.finalCount<=500;

// Listing is a receipt inventory, not a claim that each archive has been read.
export function syncSqlArchiveCandidates({store,project}) {
  const tasks=new Map(store.list('offline_sync_task',project).map(task=>[task.id,task]));
  return store.list('offline_sync_run',project).filter(run=>supported(tasks.get(run.taskId),run)).slice(0,100).map(run=>({
    taskId:run.taskId,runId:run.id,taskName:tasks.get(run.taskId).name,rowCount:run.finalCount,finishedAt:run.finishedAt,
    verification:'REQUIRES_CHECK',targetHash:run.targetHash,landingSnapshotHash:run.landingSnapshotHash,
  }));
}

export function archivedSyncSqlInput({store,project,ingestion},taskId,runId) {
  const task=store.get('offline_sync_task',taskId,project),run=store.get('offline_sync_run',runId,project);
  if(!supported(task,run))throw unavailable();
  const metadata=store.get('source_metadata',task.metadataVersionId,project);
  if(metadata?.sourceId!==task.sourceId||metadata.revisionId!==task.sourceRevisionId||metadata.contentHash!==run.sourceHash||
    !Array.isArray(metadata.columns)||metadata.schemaHash!==ingestionSchemaHash(metadata.columns)||
    !Object.keys(task.mapping??{}).every(field=>metadata.columns.some(column=>column.name===field)))throw unavailable();
  const archived=ingestion.retainedRunSnapshot(taskId,runId);
  if(archived.status!=='VERIFIED')throw unavailable();
  const fields=Object.values(task.mapping);
  return {selection:parseSyncSqlSelection({kind:archivedSyncInputKind,targetTable:'raw_positions',taskId,runId,
      targetHash:archived.targetHash,landingSnapshotHash:archived.snapshotHash}),
    source:{taskId,sourceRevisionId:task.sourceRevisionId,metadataVersionId:task.metadataVersionId,rowCount:archived.rowCount},
    context:syncSqlLandingContext(archived.rows,fields),
    ...(fields.includes('currency')?{verifiedCurrency:'CNY'}:{})};
}
const supportedFields=task=>{try{syncSqlLandingContext([],Object.values(task.mapping??{}));return true;}catch{return false;}};
const materializedSupported=(task,run)=>supportedFields(task)&&task?.sourceType==='LOCAL_CSV'&&['FULL','INCREMENTAL_UPSERT','INCREMENTAL_CHANGELOG'].includes(task.mode)&&
  run?.taskId===task.id&&run.status==='SUCCEEDED'&&run.actualExecution===true&&run.snapshotStatus==='RETAINED'&&Number.isInteger(run.finalCount)&&run.finalCount>=0&&run.finalCount<=500;
export function materializedSyncSqlCandidates({store,project}){
  const tasks=new Map(store.list('offline_sync_task',project).map(task=>[task.id,task]));
  return store.list('offline_sync_run',project).filter(run=>materializedSupported(tasks.get(run.taskId),run)).slice(0,100).map(run=>{const task=tasks.get(run.taskId);return {taskId:task.id,runId:run.id,taskName:task.name,targetTable:task.targetTable,mode:task.mode,rowCount:run.finalCount,finishedAt:run.finishedAt,targetHash:run.targetHash,landingSnapshotHash:run.landingSnapshotHash,...(task.mode==='INCREMENTAL_CHANGELOG'?{changeEpochId:task.changeConfig?.epochId,changeStateHash:run.changeState?.changeStateHash}:{}),verification:'REQUIRES_CHECK'};});
}
export function materializedSyncSqlInput({store,project,ingestion},taskId,runId){
  const task=store.get('offline_sync_task',taskId,project),run=store.get('offline_sync_run',runId,project);
  if(!materializedSupported(task,run))throw Object.assign(Error('所选批次没有可核对的完整持仓快照'),{status:409,code:'SYNC_SQL_MATERIALIZED_UNAVAILABLE'});
  const metadata=store.get('source_metadata',task.metadataVersionId,project);
  if(metadata?.sourceId!==task.sourceId||metadata.revisionId!==task.sourceRevisionId||metadata.contentHash!==run.sourceHash||!Array.isArray(metadata.columns)||metadata.schemaHash!==ingestionSchemaHash(metadata.columns)||!Object.keys(task.mapping??{}).every(field=>metadata.columns.some(column=>column.name===field)))throw unavailable();
  if(task.mode==='INCREMENTAL_CHANGELOG'){
    if(task.changeConfig?.epochId!==run.changeState?.epochId||task.changeSpecHash!==run.changeState?.specHash||!run.changeState?.changeStateHash)throw unavailable();
  }
  const archived=ingestion.retainedRunSnapshot(taskId,runId);if(archived.status!=='VERIFIED')throw unavailable();
  const fields=Object.values(task.mapping),selection=parseSyncSqlSelection({kind:materializedSyncInputKind,targetTable:task.targetTable,taskId,runId,targetHash:archived.targetHash,landingSnapshotHash:archived.snapshotHash,mode:task.mode,...(task.mode==='INCREMENTAL_CHANGELOG'?{changeEpochId:task.changeConfig.epochId,changeStateHash:run.changeState.changeStateHash}:{})});
  return {selection,source:{taskId,sourceRevisionId:task.sourceRevisionId,metadataVersionId:task.metadataVersionId,rowCount:archived.rowCount},context:syncSqlLandingContext(archived.rows,fields),...(archived.rowCount>0&&fields.includes('currency')?{verifiedCurrency:'CNY'}:{})};
}
export function selectedSyncSqlInput(resources,selection) {
  if(selection.kind===materializedSyncInputKind)return materializedSyncSqlInput(resources,selection.taskId,selection.runId);
  return selection.kind===archivedSyncInputKind?archivedSyncSqlInput(resources,selection.taskId,selection.runId):currentSyncSqlInput(resources);
}
