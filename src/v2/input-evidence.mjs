import {isDeepStrictEqual as same} from 'node:util';
import {validateDeliveryPackage} from './delivery.mjs';
import {publishedReportHash} from './published-report-source.mjs';
import {validateSyncSqlDeliveryContext} from './sync-sql-input.mjs';
import {syncSqlSelectionFromBinding,materializedSyncInputKind} from './sync-sql-selection.mjs';
import {checkedSyncSnapshot} from './sync-run-snapshot.mjs';
import {ingestionSchemaHash} from './ingestion.mjs';
import {checkInputEvidenceShape,inputEvidenceProtocol,inputEvidenceFields,projectInputEvidenceRecord} from './input-evidence-contract.mjs';

const requireEvidence=(condition)=>{if(!condition)throw Object.assign(Error('原包输入证据缺失或不一致；未导出替代记录'),{status:409,code:'INPUT_EVIDENCE_UNAVAILABLE'});};
const hash=value=>publishedReportHash(value);
function checkBinding(value,bundle){
 const plan=validateDeliveryPackage(bundle,value.binding.packageDigest),input=plan.source.syncInput,context=plan.fixtures.context;
 requireEvidence(input&&plan.source.projectId===value.projectId&&input.actorId===value.actorId&&hash(input)===value.binding.sourceInputHash);
 validateSyncSqlDeliveryContext(input,context);
 const records=value.records,run=records.offline_sync_run,task=records.offline_sync_task,meta=records.source_metadata,revision=records.source_revision,frozen=records.sync_sql_input;
 const config=Object.fromEntries(['sourceRevisionId','sourceType','metadataVersionId','targetTable','mode','mapping','keyFields','watermarkField',...(task.mode==='INCREMENTAL_CHANGELOG'?['changeConfig','changeSpecHash']:[])].map(k=>[k,task[k]]));
 requireEvidence(run.id===input.runId&&task.id===input.taskId&&meta.id===input.metadataVersionId&&revision.id===input.sourceRevisionId&&frozen.id===input.snapshotId&&
  frozen.contentHash===input.snapshotHash&&same(frozen.payload,{actorId:input.actorId,selection:syncSqlSelectionFromBinding(input),source:{taskId:input.taskId,sourceRevisionId:input.sourceRevisionId,metadataVersionId:input.metadataVersionId,rowCount:input.rowCount},context})&&
  run.status==='SUCCEEDED'&&run.actualExecution===true&&run.taskId===task.id&&run.sourceRevisionId===revision.id&&run.metadataVersionId===meta.id&&
  task.sourceType==='LOCAL_CSV'&&revision.sourceType==='LOCAL_CSV'&&task.sourceId===revision.sourceId&&meta.sourceId===revision.sourceId&&meta.revisionId===revision.id&&
  task.configHash===hash(config)&&meta.schemaHash===ingestionSchemaHash(meta.columns)&&run.configHash===task.configHash&&run.sourceHash===meta.contentHash&&run.targetHash===input.targetHash&&run.finalCount===input.rowCount&&task.targetTable===input.targetTable&&run.targetTable===input.targetTable);
 if(input.kind===materializedSyncInputKind)requireEvidence(task.mode===input.mode&&value.snapshot!==null);
 if(value.snapshot!==null){
  requireEvidence(run.snapshotStatus==='RETAINED'&&run.landingSnapshotHash===value.snapshot.snapshot_hash&&(!input.landingSnapshotHash||input.landingSnapshotHash===run.landingSnapshotHash));
  checkedSyncSnapshot(value.snapshot,{runId:run.id,targetTable:task.targetTable,binding:{projectId:value.projectId,taskId:task.id,sourceId:task.sourceId,sourceRevisionId:revision.id,metadataVersionId:meta.id,configHash:task.configHash,sourceHash:run.sourceHash},targetHash:input.targetHash,rowCount:input.rowCount,snapshotHash:run.landingSnapshotHash});
 }
 return plan;
}
export function buildInputEvidence({store,project,bundle,readSnapshot}){
 const plan=validateDeliveryPackage(bundle,bundle.digest),input=plan.source.syncInput;
 requireEvidence(input&&plan.source.projectId===project);
 const ids={offline_sync_run:input.runId,offline_sync_task:input.taskId,source_metadata:input.metadataVersionId,source_revision:input.sourceRevisionId,sync_sql_input:input.snapshotId},records={};
 for(const kind of Object.keys(inputEvidenceFields)){
  const record=store.get(kind,ids[kind],project);requireEvidence(record?.id===ids[kind]&&record.projectId===project);
  if(kind==='offline_sync_task' && record.sourceType==='SERVER_MYSQL')
    throw Object.assign(Error('此包使用 MySQL 原持仓归档。请使用「核验原包输入」并下载该批次的核验回执。'),{status:409,code:'INPUT_EVIDENCE_CSV_REQUIRED'});
  records[kind]=projectInputEvidenceRecord(kind,record);
 }
 const run=records.offline_sync_run;
 requireEvidence(run.snapshotStatus!=='RETAINED'||typeof readSnapshot==='function');
 const snapshot=run.snapshotStatus==='RETAINED'?readSnapshot(run.id):null;
 requireEvidence(run.snapshotStatus!=='RETAINED'||snapshot);
 const body={protocol:inputEvidenceProtocol,scope:'LOCAL_SAVED_INPUT_EVIDENCE',readOnly:true,binding:{packageId:bundle.id,packageDigest:bundle.digest,sourceInputHash:hash(input)},projectId:project,actorId:input.actorId,records,
  snapshot:snapshot===null?null:Object.fromEntries(['run_id','target_table','payload','snapshot_hash','byte_count'].map(k=>[k,snapshot[k]])),sourceCsvIncluded:false,immutableAuditVerified:false,fullLifecycleE2E:false};
 const value={...body,evidenceHash:hash(body)};checkInputEvidenceShape(value);checkBinding(value,bundle);return value;
}
export function inputEvidenceReaders(value,{bundle,project,actor}){
 checkInputEvidenceShape(value,{packageDigest:bundle.digest});const {evidenceHash,...body}=value;
 requireEvidence(hash(body)===evidenceHash&&value.projectId===project&&value.actorId===actor);checkBinding(value,bundle);
 return {store:{get:(kind,id,selectedProject)=>selectedProject===project&&value.records[kind]?.id===id?value.records[kind]:undefined},
  readSnapshot:id=>value.snapshot?.run_id===id?value.snapshot:undefined};
}
