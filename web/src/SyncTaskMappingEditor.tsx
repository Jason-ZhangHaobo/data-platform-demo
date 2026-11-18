import {newSyncMappingDraft,syncMappingProblem} from './sync-task-mapping';
import type {SyncMappingDraft,SyncMappingMetadata} from './sync-task-mapping';

export function SyncTaskMappingEditor({draft,sourceId,metadata,disabled,onChange}:{
  draft?:SyncMappingDraft;sourceId:string;metadata?:SyncMappingMetadata;disabled:boolean;onChange:(draft:SyncMappingDraft)=>void;
}){
  if(!draft)return <p role="status">选择数据源并采集元数据后配置字段映射。</p>;
  const problem=syncMappingProblem(draft,sourceId,metadata);
  const stale=!metadata||draft.metadataVersionId!==metadata.id||draft.sourceRevisionId!==metadata.revisionId||draft.schemaHash!==metadata.schemaHash;
  const fields=new Set(draft.columns.map(column=>column.name));
  const update=(patch:Partial<SyncMappingDraft>)=>onChange({...draft,...patch});
  return <section className="sync-task-mapping" aria-label="同步字段映射配置">
    <header><div><h4>字段映射、主键与水位</h4><small>元数据 {draft.metadataVersionId.slice(0,8)} · 源版本 {draft.sourceRevisionId.slice(0,8)}</small></div>
      <button className="button" disabled={disabled||!metadata} onClick={()=>metadata&&onChange(newSyncMappingDraft(sourceId,metadata,stale?draft:undefined))}>
        {stale?'使用当前元数据':'重置为同名映射'}
      </button></header>
    <p>目标字段可重命名，留空则跳过。主键与水位会保存为对应的目标字段；水位记录输入最大值，不用于过滤输入或 CDC。创建草稿不会执行同步。</p>
    <div className="sync-mapping-table-wrap"><table className="sync-mapping-table"><thead><tr><th>源字段／类型</th><th>目标字段</th><th>主键</th></tr></thead><tbody>
      {draft.columns.map(column=><tr key={column.name}><th scope="row"><code>{column.name}</code><small>{column.type}{column.nullable?' · 可空':''}</small></th>
        <td><input aria-label={column.name+' 的目标字段'} value={draft.mapping[column.name]??''} disabled={disabled} placeholder="留空跳过"
          onChange={event=>update({mapping:{...draft.mapping,[column.name]:event.target.value}})}/></td>
        <td><input type="checkbox" aria-label={column.name+' 作为主键'} checked={draft.keySources.includes(column.name)}
          disabled={disabled||!draft.keySources.includes(column.name)&&draft.keySources.length>=5}
          onChange={event=>update({keySources:event.target.checked?[...draft.keySources,column.name]:draft.keySources.filter(name=>name!==column.name)})}/></td></tr>)}
    </tbody></table></div>
    <div className="sync-mapping-roles"><div><strong>主键（按所选顺序，1—5个）</strong><p>{draft.keySources.length?draft.keySources.map(name=>draft.mapping[name]?.trim()||name).join(' → '):'尚未选择'}</p>
      {draft.keySources.filter(name=>!fields.has(name)).map(name=><button className="button" key={name} disabled={disabled} onClick={()=>update({keySources:draft.keySources.filter(key=>key!==name)})}>移除旧主键 {name}</button>)}</div>
      <label>水位源字段<select aria-label="同步水位源字段" value={draft.watermarkSource??''} disabled={disabled} onChange={event=>update({watermarkSource:event.target.value||undefined})}>
        <option value="">不设置水位</option>
        {draft.watermarkSource&&!fields.has(draft.watermarkSource)&&<option value={draft.watermarkSource}>{draft.watermarkSource}（旧字段）</option>}
        {draft.columns.map(column=><option key={column.name} value={column.name}>{column.name}{draft.mapping[column.name]?.trim()?' → '+draft.mapping[column.name].trim():'（未映射）'}</option>)}
      </select></label></div>
    {problem&&<p className="sync-mapping-problem" role="status">{problem}</p>}
  </section>;
}
