import {createHash} from 'node:crypto';
export const changelogMode='INCREMENTAL_CHANGELOG';
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const changeHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fail=(message,code='CHANGE_STATE_UNCONFIRMED',status=409)=>Object.assign(Error(message),{status,code});
const ident=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v),sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sequence=v=>typeof v==='string'&&/^(0|[1-9]\d{0,39})$/.test(v);
export function normalizeChangeConfig(value,mapping,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||Object.keys(value).some(k=>!['epochId','operationField','sequenceField'].includes(k))||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i).test(value.epochId??'')||!ident(value.operationField)||!ident(value.sequenceField)||value.operationField===value.sequenceField)throw fail('变更模式须提供变更代号UUID、操作源字段和序号源字段','CHANGE_CONFIG_INVALID',422);
 if(Object.hasOwn(mapping,value.operationField)||Object.hasOwn(mapping,value.sequenceField)||keys.some(k=>![...Object.values(mapping)].includes(k)))throw fail('操作与序号字段不得映射到业务目标，主键须来自业务映射','CHANGE_CONTROL_MAPPING_INVALID',422);
 return {epochId:value.epochId,operationField:value.operationField,sequenceField:value.sequenceField};
}
export const changeSpecHash=(config,mapping,keys)=>changeHash({operationField:config.operationField,sequenceField:config.sequenceField,mapping,keys});
export function initializeChangeTables(db){db.exec('CREATE TABLE IF NOT EXISTS landing_change_targets(target_table TEXT PRIMARY KEY,epoch_id TEXT NOT NULL,spec_hash TEXT NOT NULL,state_hash TEXT NOT NULL,last_run_id TEXT NOT NULL,receipt TEXT NOT NULL);CREATE TABLE IF NOT EXISTS landing_change_keys(target_table TEXT NOT NULL,row_key TEXT NOT NULL,last_sequence TEXT NOT NULL,event_hash TEXT NOT NULL,tombstone INTEGER NOT NULL,PRIMARY KEY(target_table,row_key));');}
export function changeStateHash(db,target,targetHash,epochId,specHash){return changeHash({target,epochId,specHash,targetHash,keys:db.prepare('SELECT row_key,last_sequence,event_hash,tombstone FROM landing_change_keys WHERE target_table=? ORDER BY row_key').all(target).map(r=>({...r}))});}
function validReceiptCounts(r,rowCount){return r.protocol==='shuduo-csv-changelog/v1'&&['readCount','inserted','updated','unchanged','deleted','appliedEvents','deleteEvents','duplicateEvents','staleEvents','finalCount'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0)&&r.finalCount===rowCount&&r.readCount===r.appliedEvents+r.duplicateEvents+r.staleEvents&&r.inserted+r.updated+r.unchanged===r.appliedEvents-r.deleteEvents&&r.deleted<=r.deleteEvents;}
export function inspectChangeState(db,target,targetHash){
 const marker=db.prepare('SELECT * FROM landing_change_targets WHERE target_table=?').get(target);
 if(!marker)return undefined;
 const keys=db.prepare('SELECT * FROM landing_change_keys WHERE target_table=?').all(target);
 if(!sha(marker.state_hash)||keys.some(k=>!sequence(k.last_sequence)||!sha(k.event_hash)||![0,1].includes(k.tombstone)))throw fail('变更目标行或墓碑证据不一致，未继续写入');
 let receipt;try{receipt=JSON.parse(marker.receipt);}catch{throw fail('原变更提交回执损坏');}
 const dataStateHash=changeStateHash(db,target,targetHash,marker.epoch_id,marker.spec_hash);
 if(!validReceiptCounts(receipt,db.prepare('SELECT COUNT(*) AS n FROM landing_rows WHERE target_table=?').get(target).n)||receipt.dataStateHash!==dataStateHash||changeHash({dataStateHash,receiptHash:changeHash(receipt)})!==marker.state_hash||receipt.runId!==marker.last_run_id||receipt.targetHash!==targetHash||receipt.epochId!==marker.epoch_id||receipt.specHash!==marker.spec_hash)throw fail('原变更提交回执与目标不一致');
 return {...marker,receipt:{...receipt,changeStateHash:marker.state_hash}};
}
export function prepareChangeEvents(rows,mapping,keys,config){return rows.map(source=>{
 const op=source[config.operationField],seq=source[config.sequenceField];
 if(!['UPSERT','DELETE'].includes(op)||!sequence(seq))throw fail('每行操作须为UPSERT或DELETE，序号须为最多40位的规范非负整数文本','CHANGE_EVENT_INVALID',422);
 const row=Object.fromEntries(Object.entries(mapping).map(([from,to])=>[to,source[from]]));
 if(keys.some(k=>row[k]===null||row[k]===undefined||!String(row[k]).trim()||String(row[k]).includes('\u001f')))throw fail('变更主键不能为空或含分隔控制字符','CHANGE_KEY_INVALID',422);
 const key=keys.map(k=>String(row[k])).join('\u001f'),payload=canonical(row),eventHash=changeHash({op,seq,...(op==='UPSERT'?{row}:{key})});return {op,seq,key,row,payload,eventHash};
});}
export function assertChangeStart({db,target,targetHash,config,specHash,guard,events}){
 if(!guard||guard.epochId!==config.epochId||guard.specHash!==specHash)throw fail('变更执行缺少登记的目标控制依据');
 const marker=inspectChangeState(db,target,targetHash);
 if(!marker){if(!guard.initialize||db.prepare('SELECT 1 FROM landing_rows WHERE target_table=? LIMIT 1').get(target)||db.prepare('SELECT 1 FROM landing_change_keys WHERE target_table=? LIMIT 1').get(target))throw fail('仅空的新目标可初始化，已有目标或缺失控制状态不得推断就绪');if(events.some(e=>e.op!=='UPSERT'))throw fail('初始化批次须为完整UPSERT快照，后续批次才接受删除','CHANGE_INITIAL_BATCH_INVALID',422);}
 else if(guard.initialize||marker.epoch_id!==config.epochId||marker.spec_hash!==specHash||marker.state_hash!==guard.expectedStateHash)throw fail('变更代号、映射或原控制状态不匹配');
 return marker;
}
export function applyChangeEvents(db,target,events,sourceHash,syncedAt){
 let keyCount=db.prepare('SELECT COUNT(*) AS n FROM landing_change_keys').get().n;
 const counts={inserted:0,updated:0,unchanged:0,deleted:0,appliedEvents:0,deleteEvents:0,duplicateEvents:0,staleEvents:0};
 const get=db.prepare('SELECT * FROM landing_change_keys WHERE target_table=? AND row_key=?'),priorRow=db.prepare('SELECT payload FROM landing_rows WHERE target_table=? AND row_key=?'),put=db.prepare('INSERT INTO landing_rows VALUES(?,?,?,?,?) ON CONFLICT(target_table,row_key) DO UPDATE SET payload=excluded.payload,source_hash=excluded.source_hash,synced_at=excluded.synced_at'),del=db.prepare('DELETE FROM landing_rows WHERE target_table=? AND row_key=?'),save=db.prepare('INSERT INTO landing_change_keys VALUES(?,?,?,?,?) ON CONFLICT(target_table,row_key) DO UPDATE SET last_sequence=excluded.last_sequence,event_hash=excluded.event_hash,tombstone=excluded.tombstone');
 for(const e of events){const old=get.get(target,e.key);if(old){if(BigInt(e.seq)<BigInt(old.last_sequence)){counts.staleEvents++;continue;}if(e.seq===old.last_sequence){if(e.eventHash!==old.event_hash)throw fail('相同主键/序号对应不同内容，整批已拒绝','CHANGE_SEQUENCE_CONFLICT');counts.duplicateEvents++;continue;}}
  if(!old&&++keyCount>200000)throw fail('变更主键控制状态达到留存上限','CHANGE_KEY_LIMIT',413);
  counts.appliedEvents++;if(e.op==='DELETE'){counts.deleteEvents++;counts.deleted+=del.run(target,e.key).changes;}else{const row=priorRow.get(target,e.key);if(!row)counts.inserted++;else if(row.payload===e.payload)counts.unchanged++;else counts.updated++;put.run(target,e.key,e.payload,sourceHash,syncedAt);}
  save.run(target,e.key,e.seq,e.eventHash,e.op==='DELETE'?1:0);
 }
 return counts;
}
export function validateChangeSnapshot(tables){
 const targets=tables.landingChangeTargets,keys=tables.landingChangeKeys;if(targets===undefined&&keys===undefined)return;
 if(!Array.isArray(targets)||!Array.isArray(keys))throw fail('恢复缺少成对的变更控制表');
 const targetNames=new Set(targets.map(t=>t.target_table));if(keys.some(k=>!targetNames.has(k.target_table)||!sequence(k.last_sequence)||!sha(k.event_hash)||![0,1].includes(k.tombstone)))throw fail('恢复的墓碑引用或序号不合法');
 // Verify the complete row/ledger correspondence before destructive restore.
 for(const t of targets){if(!ident(t.target_table)||!sha(t.state_hash)||!sha(t.spec_hash))throw fail('恢复的变更摘要不合法');try{
   const compare=(a,b)=>Buffer.compare(Buffer.from(a.row_key),Buffer.from(b.row_key));
   const rows=tables.landingRows.filter(r=>r.target_table===t.target_table).sort(compare).map(r=>({rowKey:r.row_key,...JSON.parse(r.payload)})),targetHash=changeHash(rows);
   const dataStateHash=changeHash({target:t.target_table,epochId:t.epoch_id,specHash:t.spec_hash,targetHash,keys:keys.filter(k=>k.target_table===t.target_table).sort(compare).map(({row_key,last_sequence,event_hash,tombstone})=>({row_key,last_sequence,event_hash,tombstone}))});
   const receipt=JSON.parse(t.receipt);if(!validReceiptCounts(receipt,rows.length)||receipt.dataStateHash!==dataStateHash||changeHash({dataStateHash,receiptHash:changeHash(receipt)})!==t.state_hash||receipt.runId!==t.last_run_id||receipt.targetHash!==targetHash||receipt.epochId!==t.epoch_id||receipt.specHash!==t.spec_hash)throw Error('binding');
  }catch{throw fail('恢复的变更回执、行或墓碑不一致');}}
}
