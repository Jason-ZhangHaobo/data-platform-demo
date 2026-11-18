import {parseSyncSqlSelection} from './sync-sql-selection.mjs';
export const inputEvidenceProtocol='shuduo-sync-input-evidence/v1';
export const inputEvidenceMaxBytes=3*1024*1024;
export const inputEvidenceFields=Object.freeze({
 offline_sync_run:['id','projectId','taskId','status','actualExecution','sourceRevisionId','metadataVersionId','sourceHash','targetTable','configHash','finalCount','targetHash','snapshotStatus','landingSnapshotHash','finishedAt','readCount','inserted','updated','unchanged','deleted','changeState'],
 offline_sync_task:['id','projectId','sourceId','sourceRevisionId','sourceType','metadataVersionId','targetTable','mode','mapping','keyFields','watermarkField','changeConfig','changeSpecHash','configHash'],
 source_metadata:['id','projectId','sourceId','revisionId','contentHash','bytes','rowCount','columns','schemaHash'],
 source_revision:['id','projectId','sourceId','sourceType'],
 sync_sql_input:['id','projectId','payload','contentHash'],
});
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value??{},key)&&value[key]!==undefined).map(key=>[key,value[key]]));
export const inputEvidenceCanonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
export function projectInputEvidenceRecord(kind,value){
 const record=pick(value,inputEvidenceFields[kind]??[]);
 if(Array.isArray(record.columns))record.columns=record.columns.map(column=>pick(column,['name','ordinal','type','nullable','distinctCount']));
 if(record.changeState)record.changeState=pick(record.changeState,['epochId','specHash','changeStateHash','appliedEvents','deleteEvents','duplicateEvents','staleEvents']);
 if(record.changeConfig)record.changeConfig=pick(record.changeConfig,['epochId','operationField','sequenceField']);
 return structuredClone(record);
}
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const scalar=value=>value===null||['string','number','boolean'].includes(typeof value);
const text=value=>typeof value==='string'&&value.length<=4096;
export function checkInputEvidenceShape(value,expected={}){
 const invalid=()=>Error('输入证明的范围、原包绑定或记录结构未确认，请重读同一版本');
 const keys=['protocol','scope','readOnly','binding','projectId','actorId','records','snapshot','sourceCsvIncluded','immutableAuditVerified','fullLifecycleE2E','evidenceHash'];
 if(!exact(value,keys)||value.protocol!==inputEvidenceProtocol||value.scope!=='LOCAL_SAVED_INPUT_EVIDENCE'||value.readOnly!==true||
  value.sourceCsvIncluded!==false||value.immutableAuditVerified!==false||value.fullLifecycleE2E!==false||!sha(value.evidenceHash)||
  !exact(value.binding,['packageId','packageDigest','sourceInputHash'])||!uuid(value.binding.packageId)||!sha(value.binding.packageDigest)||!sha(value.binding.sourceInputHash)||
  ['packageId','packageDigest'].some(k=>expected[k]!==undefined&&expected[k]!==value.binding[k])||
  typeof value.projectId!=='string'||!value.projectId||value.projectId.length>100||!(value.actorId==='local-engineer'||uuid(value.actorId))||
  !exact(value.records,Object.keys(inputEvidenceFields)))throw invalid();
 for(const [kind,item] of Object.entries(value.records)){
  if(!record(item)||!uuid(item.id)||item.projectId!==value.projectId||inputEvidenceCanonical(item)!==inputEvidenceCanonical(projectInputEvidenceRecord(kind,item)))throw invalid();
 }
 const frozen=value.records.sync_sql_input?.payload,columns=value.records.source_metadata?.columns,task=value.records.offline_sync_task;
 if(!exact(frozen,['actorId','selection','source','context'])||frozen.actorId!==value.actorId||!record(frozen.selection)||!record(frozen.source)||!record(frozen.context)||
  !Array.isArray(columns)||columns.length>512||columns.some(c=>!exact(c,['name','ordinal','type','nullable','distinctCount'])||!text(c.name)||!text(c.type)||typeof c.nullable!=='boolean'||!Number.isSafeInteger(c.ordinal)||c.ordinal<0||!Number.isSafeInteger(c.distinctCount)||c.distinctCount<0)||
  !exact(frozen.source,['taskId','sourceRevisionId','metadataVersionId','rowCount'])||!['taskId','sourceRevisionId','metadataVersionId'].every(k=>uuid(frozen.source[k]))||!Number.isSafeInteger(frozen.source.rowCount)||frozen.source.rowCount<0||frozen.source.rowCount>500||
  !exact(frozen.context,['id','name','businessDate','advisorId','classification','definition','tables','expected'])||!['id','name','businessDate','advisorId','classification','definition'].every(k=>text(frozen.context[k]))||
  !Array.isArray(frozen.context.expected)||frozen.context.expected.length>500||frozen.context.expected.some(row=>!exact(row,['client_id','holding_market_value','available_cash','total_assets','security_count'])||!Object.values(row).every(scalar))||
  !Array.isArray(frozen.context.tables)||frozen.context.tables.length!==3||frozen.context.tables.some(t=>!exact(t,['name','label','columns','rows'])||!text(t.name)||!text(t.label)||!Array.isArray(t.columns)||t.columns.length>32||t.columns.some(c=>!Array.isArray(c)||c.length!==2||!c.every(text))||!Array.isArray(t.rows)||t.rows.length>500||t.rows.some(r=>!Array.isArray(r)||r.length!==t.columns.length||!r.every(scalar)))||
  !record(task.mapping)||Object.values(task.mapping).some(v=>typeof v!=='string')||!Array.isArray(task.keyFields)||!task.keyFields.every(text))throw invalid();
 try{parseSyncSqlSelection(frozen.selection);}catch{throw invalid();}
 if(value.snapshot!==null&&(!exact(value.snapshot,['run_id','target_table','payload','snapshot_hash','byte_count'])||!uuid(value.snapshot.run_id)||!sha(value.snapshot.snapshot_hash)||
  typeof value.snapshot.payload!=='string'||!Number.isSafeInteger(value.snapshot.byte_count)||value.snapshot.byte_count<1||value.snapshot.byte_count>1024*1024))throw invalid();
 if(new TextEncoder().encode(JSON.stringify(value)).length>inputEvidenceMaxBytes)throw invalid();
 return value;
}
