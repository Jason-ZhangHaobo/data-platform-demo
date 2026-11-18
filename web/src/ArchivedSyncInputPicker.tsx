import {useEffect,useRef,useState} from 'react';
import {readSyncSqlArchives} from '../../src/v2/sync-sql-output-schema-client.mjs';
import type {SyncSqlArchiveCandidate} from '../../src/v2/sync-sql-output-schema-client.mjs';
type Api=<T>(path:string)=>Promise<T>;
export function ArchivedSyncInputPicker({api,disabled,onChoose}:{api:Api;disabled:boolean;onChoose:(candidate:SyncSqlArchiveCandidate)=>void}) {
  const [candidates,setCandidates]=useState<SyncSqlArchiveCandidate[]>(),[selected,setSelected]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const sequence=useRef(0);useEffect(()=>()=>{sequence.current++;},[]);
  async function read(){const current=++sequence.current;setLoading(true);setError('');setCandidates(undefined);
    try{const value=await readSyncSqlArchives({request:path=>api(path)});if(sequence.current===current){setCandidates(value);setSelected(previous=>value.some(item=>item.runId===previous)?previous:value[0]?.runId??'');}}
    catch(cause){if(sequence.current===current)setError(cause instanceof Error?cause.message:'原批次目录未确认');}
    finally{if(sequence.current===current)setLoading(false);}}
  const candidate=candidates?.find(item=>item.runId===selected);
  return <details className="agent-sync-archive-picker"><summary>选择原同步批次</summary>
    <p>候选来自最近100条已归档的全量虚构持仓成功回执。选中后还需重核原行摘要、元数据和业务口径；不会切换落地表或自动运行。</p>
    <button className="button" disabled={disabled||loading} onClick={()=>void read()}>{loading?'正在读取…':candidates?'重读归档目录':'读取归档目录'}</button>
    {error&&<p role="alert">{error}</p>}
    {candidates?.length===0&&<p role="status">尚无留存完整快照、500行以内的全量持仓候选。可先完成持仓同步。</p>}
    {Boolean(candidates?.length)&&<><label>原持仓批次<select aria-label="选择原持仓批次" disabled={disabled||loading} value={selected} onChange={event=>setSelected(event.target.value)}>{candidates?.map(item=><option key={item.runId} value={item.runId}>{item.taskName} · {item.runId.slice(0,8)} · 回执{item.rowCount}行</option>)}</select></label>
      {candidate&&<p>运行于 {new Date(candidate.finishedAt).toLocaleString('zh-CN',{hour12:false})} · 目录尚未核对行数据。</p>}
      <button className="button" disabled={disabled||loading||!candidate} onClick={()=>{if(candidate)onChoose(candidate);}}>核对并使用原批次</button></>}
  </details>;
}
