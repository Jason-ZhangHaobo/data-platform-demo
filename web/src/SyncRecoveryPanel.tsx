import { useState } from "react";

type Mapping = Record<string,string>;
type Schema = { sourceRevisionId:string; metadataVersionId:string; columns:{name:string;type:string;nullable:boolean}[] };
type RecoveryPreview = {
  protocol:"shuduo-sync-recovery/v1"; previousTaskId:string; failedRunId:string; basisDigest:string;
  previous:Schema; current:Schema; targetTable:string; mode:string; keyFields:string[]; watermarkField?:string;
  previousMapping:Mapping; suggestedMapping:Mapping;
};
type Api = <T>(path:string, body?:unknown) => Promise<T>;

export function SyncRecoveryPanel({api,taskId,failedRunId,canWrite,disabled,onSaved}:{
  api:Api;taskId:string;failedRunId:string;canWrite:boolean;disabled:boolean;onSaved:(id:string)=>Promise<void>;
}) {
  const [preview,setPreview] = useState<RecoveryPreview>();
  const [mappings,setMappings] = useState<Mapping>({});
  const [working,setWorking] = useState("");
  const [error,setError] = useState("");
  const path = "/sync/tasks/"+taskId+"/recovery";

  const read = async () => {
    setWorking("read"); setError(""); setPreview(undefined);
    try {
      const item = await api<RecoveryPreview>(path);
      if (item.protocol!=="shuduo-sync-recovery/v1" || item.previousTaskId!==taskId || item.failedRunId!==failedRunId)
        throw Error("原失败运行已变化，请刷新任务目录后重读。");
      setMappings(item.suggestedMapping);
      setPreview(item);
    } catch (cause) { setError((cause as Error).message); }
    finally { setWorking(""); }
  };
  const mapping = Object.fromEntries(Object.entries(mappings).map(([name,target])=>[name,target.trim()]).filter(([,target])=>target));
  const destinations = Object.values(mapping);
  const missingKeys = preview ? [...preview.keyFields, ...(preview.watermarkField?[preview.watermarkField]:[])]
    .filter(field=>!destinations.includes(field)) : [];
  const invalid = missingKeys.length ? "还需映射主键或水位 "+missingKeys.join("、") :
    new Set(destinations).size!==destinations.length ? "每个目标字段只能出现一次。" : "";
  const save = async () => {
    if (!preview || invalid || !canWrite || disabled || working) return;
    setWorking("save"); setError("");
    try {
      const task = await api<{id:string;recovery?:{previousTaskId:string;failedRunId:string}}>(path,
        {confirm:true,basisDigest:preview.basisDigest,mapping});
      if (task.recovery?.previousTaskId!==taskId || task.recovery.failedRunId!==failedRunId)
        throw Error("保存回执的原任务或失败编号不一致，请核对目录。");
      await onSaved(task.id);
    } catch (cause) { setError((cause as Error).message); }
    finally { setWorking(""); }
  };
  const removed = preview?.previous.columns.filter(column=>!preview.current.columns.some(item=>item.name===column.name)) ?? [];

  return <section className="sync-recovery" aria-label="审阅同步恢复映射">
    <header><h4>恢复源结构变更</h4><button className="button" disabled={disabled||Boolean(working)} onClick={()=>void read()}>
      {working==="read"?"读取中…":preview?"重读恢复依据":"检查恢复映射"}
    </button></header>
    <p>原失败 {failedRunId.slice(0,8)}。按当前源的字段配置一份新草稿。</p>
    {error && <p role="alert">{error}</p>}
    {preview && <>
      <p>元数据 {preview.previous.metadataVersionId.slice(0,8)} → {preview.current.metadataVersionId.slice(0,8)} · 目标 <code>{preview.targetTable}</code></p>
      <p>{preview.mode==="FULL"?"全量执行会替换目标表数据。":"增量恢复须保留原目标字段和类型。"} 主键 {preview.keyFields.join("、")}{preview.watermarkField&&" · 水位 "+preview.watermarkField}</p>
      {removed.length>0&&<p>当前源已移除 {removed.map(column=>column.name).join("、")}。请为需要保留的目标字段另选当前源字段。</p>}
      <div className="sync-recovery-columns">
        {preview.current.columns.map(column=>{
          const old = preview.previous.columns.find(item=>item.name===column.name);
          return <label key={column.name}>
            <span><code>{column.name}</code><small>{old ? (old.type===column.type?column.type:`${old.type} → ${column.type}`):`新增 · ${column.type}`}</small></span>
            <input aria-label={column.name+" 的目标字段"} value={Object.hasOwn(mappings,column.name)?mappings[column.name]:""}
              disabled={!canWrite||disabled||Boolean(working)} placeholder="留空跳过"
              onChange={event=>setMappings({...mappings,[column.name]:event.target.value})}/>
          </label>;
        })}
      </div>
      {invalid && <p role="status">{invalid}</p>}
      <button className="button" disabled={!canWrite||disabled||Boolean(working)||Boolean(invalid)} onClick={()=>void save()}>
        {working==="save"?"保存中…":"确认保存恢复草稿"}
      </button>
    </>}
  </section>;
}
