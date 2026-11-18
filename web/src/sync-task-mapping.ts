export type SyncMappingMetadata={id:string;revisionId:string;schemaHash:string;columns:{name:string;type:string;nullable:boolean}[]};
export type SyncMappingDraft={sourceId:string;metadataVersionId:string;sourceRevisionId:string;schemaHash:string;
  columns:SyncMappingMetadata['columns'];mapping:Record<string,string>;keySources:string[];watermarkSource?:string};
const identifier=/^[a-z][a-z0-9_]{0,62}$/;

export function newSyncMappingDraft(sourceId:string,metadata:SyncMappingMetadata,previous?:SyncMappingDraft):SyncMappingDraft {
  const before=previous&&previous.sourceId===sourceId?previous:undefined;
  return {sourceId,metadataVersionId:metadata.id,sourceRevisionId:metadata.revisionId,schemaHash:metadata.schemaHash,
    columns:metadata.columns.map(column=>({...column})),
    mapping:Object.fromEntries(metadata.columns.map(column=>[column.name,before&&Object.hasOwn(before.mapping,column.name)?before.mapping[column.name]:column.name])),
    keySources:before?[...before.keySources]:metadata.columns.some(c=>c.name==='position_id')?['position_id']:[],
    watermarkSource:before?before.watermarkSource:metadata.columns.some(c=>c.name==='trade_date')?'trade_date':undefined};
}
export function syncMappingProblem(draft:SyncMappingDraft|undefined,sourceId:string,metadata:SyncMappingMetadata|undefined):string|undefined {
  if(!draft||!sourceId)return '请先选择数据源并采集元数据。';
  if(!metadata)return '当前源尚未采集元数据；原配置保留，请先完成采集。';
  if(draft.sourceId!==sourceId||draft.metadataVersionId!==metadata.id||draft.sourceRevisionId!==metadata.revisionId||draft.schemaHash!==metadata.schemaHash)
    return '源版本或元数据已变化，原配置保留。请核对后使用当前元数据。';
  const entries=Object.entries(draft.mapping).map(([from,to])=>[from,to.trim()]).filter(([,to])=>to);
  if(!entries.length)return '至少保留一个字段映射。';
  const fields=new Set(metadata.columns.map(c=>c.name));
  if(entries.some(([from,to])=>!fields.has(from)||!identifier.test(to)))return '目标字段须以小写字母开头，仅含小写字母、数字和下划线，最多63个字符。';
  if(new Set(entries.map(([,to])=>to)).size!==entries.length)return '每个目标字段只能映射一次。';
  if(!draft.keySources.length||draft.keySources.length>5||new Set(draft.keySources).size!==draft.keySources.length)return '请选择1—5个不重复的主键源字段。';
  if(draft.keySources.some(name=>!fields.has(name)||!draft.mapping[name]?.trim()))return '已选主键源字段已移除或未映射，请重新选择。';
  if(draft.watermarkSource&&(!fields.has(draft.watermarkSource)||!draft.mapping[draft.watermarkSource]?.trim()))return '已选水位源字段已移除或未映射，请重新选择。';
}
export function syncTaskMappingFields(draft:SyncMappingDraft,sourceId:string,metadata:SyncMappingMetadata|undefined){
  const reason=syncMappingProblem(draft,sourceId,metadata);if(reason)throw Error(reason);
  const mapping=Object.fromEntries(Object.entries(draft.mapping).map(([from,to])=>[from,to.trim()]).filter(([,to])=>to));
  return {sourceRevisionId:draft.sourceRevisionId,metadataVersionId:draft.metadataVersionId,mapping,
    keyFields:draft.keySources.map(name=>mapping[name]),...(draft.watermarkSource?{watermarkField:mapping[draft.watermarkSource]}:{})};
}
