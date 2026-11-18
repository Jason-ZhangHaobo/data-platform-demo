type Task={id:string;runId?:string;revisionId?:string;contextId?:string;status:string;mode?:string;sourceKind?:string;sourceAttribution?:unknown;syncInput?:unknown};
type Run={id:string;revisionId?:string;agentTaskId?:string;contextId?:string;status:string;syncInput?:unknown};
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)&&value.length===36;
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

// Routing the view does not grant publication permission. A manual edit must
// retain its separate provenance; a native run must show its own saved delivery.
export function frozenDeliveryMode({task,run,revisionId}:{task?:Task;run?:Run;revisionId?:string}):'AGENT'|'MANUAL'|'UNCONFIRMED' {
  if(!run||!record(run.syncInput))return 'UNCONFIRMED';
  if(run.agentTaskId===undefined)return 'MANUAL';
  if(!task||task.sourceKind==='MANUAL'||task.sourceAttribution!==undefined||!['LIVE_MODEL','SYNTHETIC_MODEL'].includes(task.mode??'')||
    task.status!=='SUCCEEDED'||run.status!=='SUCCEEDED'||!uuid(task.id)||task.runId!==run.id||run.agentTaskId!==task.id||
    !uuid(revisionId)||task.revisionId!==revisionId||run.revisionId!==revisionId||task.contextId!=='holdings-t1'||task.contextId!==run.contextId||
    !record(task.syncInput))return 'UNCONFIRMED';
  const input=task.syncInput,other=run.syncInput;
  if(input.targetTable!=='raw_positions'||!digest(input.snapshotHash)||!uuid(input.snapshotId)||!uuid(input.runId)||!digest(input.targetHash)||
    !['taskId','sourceRevisionId','metadataVersionId'].every(field=>uuid(input[field]))||!Number.isInteger(input.rowCount)||Number(input.rowCount)<1||Number(input.rowCount)>500||
    (input.kind===undefined?input.landingSnapshotHash!==undefined:input.kind!=='SYNC_RUN_ARCHIVE_V1'||!digest(input.landingSnapshotHash))||
    !['targetTable','snapshotHash','snapshotId','runId','targetHash','taskId','sourceRevisionId','metadataVersionId','rowCount','kind','landingSnapshotHash'].every(field=>input[field]===other[field]))return 'UNCONFIRMED';
  return 'AGENT';
}
