import {normalizedDistributionRows,distributionFields,snapshotContractById} from './distribution-services.mjs';
const fail=()=>Object.assign(Error('分布结果快照缺失、契约过期或完整性未确认'),{status:409,code:'DISTRIBUTION_SNAPSHOT_UNAVAILABLE'});
export function initDistributionStore(db){db.exec('CREATE TABLE IF NOT EXISTS service_distribution_snapshots(snapshot_id TEXT PRIMARY KEY,output_contract_id TEXT NOT NULL,metadata_hash TEXT NOT NULL,rows_json TEXT NOT NULL,FOREIGN KEY(snapshot_id) REFERENCES service_snapshots(id))');}
export const distributionDescriptor=(db,id)=>db.prepare('SELECT output_contract_id,metadata_hash FROM service_distribution_snapshots WHERE snapshot_id=?').get(id);
function snapshotPayload(contractId, rows, hash) {
 const contract = snapshotContractById(contractId);
 if (!contract) throw fail();
 return { outputContractId: contractId, metadataHash: hash(contract), rows: normalizedDistributionRows(rows, contractId) };
}
export const resultSnapshotHash = (contractId, rows, hash) => hash(snapshotPayload(contractId, rows, hash));
export function materializeDistribution(store,id,rows,now,contractId,hash){
 const payload=snapshotPayload(contractId,rows,hash),normalized=payload.rows,metadataHash=payload.metadataHash,contentHash=hash(payload);
 const prior=store.db.prepare('SELECT content_hash,row_count FROM service_snapshots WHERE id=?').get(id);
 if(prior){const d=distributionDescriptor(store.db,id);if(prior.content_hash!==contentHash||d?.output_contract_id!==contractId||d.metadata_hash!==metadataHash)throw fail();return{id,contentHash,rowCount:prior.row_count,outputContractId:contractId,replayed:true};}
 store.db.exec('BEGIN IMMEDIATE');try{store.db.prepare('INSERT INTO service_snapshots VALUES(?,?,?,?)').run(id,contentHash,normalized.length,now);store.db.prepare('INSERT INTO service_distribution_snapshots VALUES(?,?,?,?)').run(id,contractId,metadataHash,JSON.stringify(normalized));store.db.exec('COMMIT');}catch(e){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw e;}
 store.mutationListener?.();return{id,contentHash,rowCount:normalized.length,outputContractId:contractId,replayed:false};
}
export function distributionSnapshotEvidence(store,snapshot,descriptor,hash){
 try{
  const c=snapshotContractById(descriptor.output_contract_id),record=store.db.prepare('SELECT rows_json FROM service_distribution_snapshots WHERE snapshot_id=?').get(snapshot.id);if(!c||descriptor.metadata_hash!==hash(c)||!record||record.rows_json.length>1000000)throw fail();
  const payload=snapshotPayload(c.id,JSON.parse(record.rows_json),hash),rows=payload.rows,computedHash=hash(payload);
  return{...snapshot,outputContractId:c.id,metadataHash:descriptor.metadata_hash,actualRowCount:rows.length,computedHash,integrityVerified:rows.length===snapshot.rowCount&&snapshot.contentHash===computedHash};
 }catch{return{...snapshot,outputContractId:descriptor.output_contract_id,integrityVerified:false};}
}
export function queryDistribution(store,id,query,fields,descriptor){
 const c=snapshotContractById(descriptor.output_contract_id);if(!c)throw fail();
 const projection=distributionFields(c.id,fields);
 const filters=c.keyFields.includes("portfolio_id") ? c.keyFields.filter(key=>query[key]!==undefined).map(key=>[key,query[key]]) :
   query.clientId ? [["client_id",query.clientId]] : [];
 const where=filters.map(([key])=>` AND json_extract(j.value,'$.${key}')=?`).join("");
 const params=[id,...filters.map(([,value])=>value)];
 const from=` FROM service_distribution_snapshots s,json_each(s.rows_json) j WHERE s.snapshot_id=?${where}`;
 const total=store.db.prepare('SELECT COUNT(*) AS n'+from).get(...params).n;
 const sql='SELECT '+projection.map(f=>`json_extract(j.value,'$.${f}') AS ${f}`).join(',')+from+' ORDER BY '+c.keyFields.map(f=>`json_extract(j.value,'$.${f}') COLLATE BINARY`).join(',')+' LIMIT ? OFFSET ?';
 const rows=store.db.prepare(sql).all(...params,query.pageSize,(query.page-1)*query.pageSize).map(r=>({...r}));
 return{rows,pagination:{page:query.page,pageSize:query.pageSize,total,totalPages:Math.max(1,Math.ceil(total/query.pageSize))},query};
}
