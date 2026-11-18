const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
export const archivedSyncInputKind='SYNC_RUN_ARCHIVE_V1';
export const materializedSyncInputKind='SYNC_MATERIALIZED_HOLDINGS_V1';
const matches=(pattern,value,length)=>typeof value==='string'&&value.length===length&&pattern.test(value);
export function parseSyncSqlSelection(selection) {
  if(selection?.kind===materializedSyncInputKind){
    const change=selection.mode==='INCREMENTAL_CHANGELOG';
    if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).length!==(change?9:7)||
      typeof selection.targetTable!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(selection.targetTable)||!['FULL','INCREMENTAL_UPSERT','INCREMENTAL_CHANGELOG'].includes(selection.mode)||
      !matches(uuid,selection.taskId,36)||!matches(uuid,selection.runId,36)||!matches(digest,selection.targetHash,64)||!matches(digest,selection.landingSnapshotHash,64)||
      change&&(!matches(uuid,selection.changeEpochId,36)||!matches(digest,selection.changeStateHash,64)))throw Object.assign(Error('请选择已核对的完整持仓目标快照、模式及控制摘要'),{status:422,code:'SYNC_SQL_INPUT_INVALID'});
    return {kind:materializedSyncInputKind,targetTable:selection.targetTable,taskId:selection.taskId,runId:selection.runId,targetHash:selection.targetHash,landingSnapshotHash:selection.landingSnapshotHash,mode:selection.mode,...(change?{changeEpochId:selection.changeEpochId,changeStateHash:selection.changeStateHash}:{})};
  }
  const archive=selection?.kind===archivedSyncInputKind;
  if (!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).length!==(archive?6:3)||
    selection.targetTable!=='raw_positions'||!matches(uuid,selection.runId,36)||!matches(digest,selection.targetHash,64)||
    archive&&(!matches(uuid,selection.taskId,36)||!matches(digest,selection.landingSnapshotHash,64)))
    throw Object.assign(Error('请选择已核对的持仓同步批次和落地摘要'),{status:422,code:'SYNC_SQL_INPUT_INVALID'});
  return archive?{kind:archivedSyncInputKind,targetTable:'raw_positions',taskId:selection.taskId,runId:selection.runId,
    targetHash:selection.targetHash,landingSnapshotHash:selection.landingSnapshotHash}
    :{targetTable:'raw_positions',runId:selection.runId,targetHash:selection.targetHash};
}
export function syncSqlSelectionFromBinding(binding) {
  if(binding?.kind===materializedSyncInputKind)return parseSyncSqlSelection({kind:binding.kind,targetTable:binding.targetTable,taskId:binding.taskId,runId:binding.runId,targetHash:binding.targetHash,landingSnapshotHash:binding.landingSnapshotHash,mode:binding.mode,...(binding.mode==='INCREMENTAL_CHANGELOG'?{changeEpochId:binding.changeEpochId,changeStateHash:binding.changeStateHash}:{})});
  return parseSyncSqlSelection(binding?.kind===undefined
    ?{targetTable:binding?.targetTable,runId:binding?.runId,targetHash:binding?.targetHash}
    :{kind:binding.kind,targetTable:binding.targetTable,taskId:binding.taskId,runId:binding.runId,targetHash:binding.targetHash,landingSnapshotHash:binding.landingSnapshotHash});
}
