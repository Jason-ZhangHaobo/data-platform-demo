import {useEffect,useRef,useState} from 'react';
import {readMaterializedSyncSqlArchives} from '../../src/v2/sync-sql-output-schema-client.mjs';
import type {MaterializedSyncSqlCandidate} from '../../src/v2/sync-sql-output-schema-client.mjs';
type Api=<T>(path:string)=>Promise<T>;
export const materializedModeLabels:Record<string,string>={FULL:'全量目标',INCREMENTAL_UPSERT:'合并后目标',INCREMENTAL_CHANGELOG:'显式变更后目标'};
export function MaterializedSyncInputPicker({api,disabled,onChoose}:{api:Api;disabled:boolean;onChoose:(candidate:MaterializedSyncSqlCandidate)=>void}){
 const [items,setItems]=useState<MaterializedSyncSqlCandidate[]>(),[selected,setSelected]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');const sequence=useRef(0);useEffect(()=>()=>{sequence.current++;},[]);
 const read=async()=>{const ticket=++sequence.current;setLoading(true);setError('');setItems(undefined);try{const result=await readMaterializedSyncSqlArchives({request:path=>api(path)});if(ticket===sequence.current){setItems(result);setSelected(previous=>result.some(c=>c.runId===previous)?previous:result[0]?.runId??'');}}catch(cause){if(ticket===sequence.current)setError((cause as Error).message);}finally{if(ticket===sequence.current)setLoading(false);}};
 const candidate=items?.find(c=>c.runId===selected);
 return <details className="agent-sync-materialized-picker"><summary>选择完整目标快照用于开发</summary><p>全量、增量合并或显式变更后的完整持仓状态；使用已留存快照，原始增量／删除事件不会作为全量持仓。只读取目录，选用前重新核对。</p>
  <button className="button" disabled={disabled||loading} onClick={()=>void read()}>{loading?'正在读取…':items?'重读完整快照目录':'读取完整快照目录'}</button>
  {error&&<p role="alert">{error}</p>}{items?.length===0&&<p role="status">暂无七个登记持仓字段、500行以内的完整快照。可先完成对应同步并留存；当前表不会补造历史。</p>}
  {Boolean(items?.length)&&<><label>完整目标快照<select aria-label="选择完整持仓快照" value={selected} disabled={disabled||loading} onChange={e=>setSelected(e.target.value)}>{items?.map(c=><option key={c.runId} value={c.runId}>{c.targetTable} · {materializedModeLabels[c.mode]} · {c.rowCount}行 · {c.runId.slice(0,8)}</option>)}</select></label>
   {candidate&&<div><strong>{candidate.taskName}</strong><p>{candidate.targetTable} · {materializedModeLabels[candidate.mode]} · {candidate.rowCount===0?'空持仓候选（核对后保留登记账户现金）':`${candidate.rowCount}行完整目标状态`}</p><small>目录回执尚未核对实际行。核对成功后才可作为开发输入，提交时再次检查。</small></div>}
   <button className="button" disabled={disabled||loading||!candidate} onClick={()=>candidate&&onChoose(candidate)}>核对并使用完整快照</button></>}
 </details>;
}
