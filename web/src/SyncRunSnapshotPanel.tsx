import {useEffect,useState} from 'react';
import {RefreshCw,Table2} from 'lucide-react';
import {syncRunSnapshotPath} from '../../src/v2/sync-run-snapshot-client.mjs';

type Receipt={taskId:string;runId:string;targetTable:string;status:'VERIFIED'|'NOT_RETAINED';reason?:string;
  rowCount:number;targetHash:string;snapshotHash?:string;integrityVerified?:boolean;createdAt?:string;
  page:number;pageSize:number;totalPages?:number;columns?:string[];rows?:Record<string,unknown>[];
  currentTarget?:{status:'VERIFIED'|'UNCONFIRMED';runId?:string;rowCount?:number;targetHash?:string;matchesOriginalRun?:boolean}};
type Api=<T>(path:string)=>Promise<T>;
type Read={runId:string;page:number;loading?:boolean;error?:string;receipt?:Receipt};
export function SyncRunSnapshotPanel({api,taskId,runs}:{api:Api;taskId:string;runs:{id:string;status:string}[]}) {
  const available=runs.filter(run=>run.status==='SUCCEEDED');
  const [runId,setRunId]=useState(available[0]?.id??''),[page,setPage]=useState(1),[refresh,setRefresh]=useState(0),[read,setRead]=useState<Read>();
  useEffect(()=>{if(!runId&&available[0])setRunId(available[0].id);},[available[0]?.id,runId]);
  useEffect(()=>{
    if(!runId)return;
    let live=true;
    setRead({runId,page,loading:true});
    void api<Receipt>(syncRunSnapshotPath({taskId,runId,page,pageSize:20})).then(receipt=>{
      if(!live)return;
      if(receipt.taskId!==taskId||receipt.runId!==runId||receipt.page!==page||receipt.pageSize!==20||
        !['VERIFIED','NOT_RETAINED'].includes(receipt.status)||
        (receipt.status==='VERIFIED'&&(!receipt.integrityVerified||!Array.isArray(receipt.rows)||!Array.isArray(receipt.columns))))
        throw Error('原批次响应不完整，未采用行数据');
      setRead({runId,page,receipt});
    }).catch(cause=>{if(live)setRead({runId,page,error:cause instanceof Error?cause.message:'原批次读取未确认'});});
    return()=>{live=false;};
  },[api,taskId,runId,page,refresh]);
  if(!available.length)return <section className="sync-run-snapshot"><h4>原批次落地快照</h4><p>实际成功的同步运行产生后，可在这里核对原批次数据。</p></section>;
  const current=read?.runId===runId&&read.page===page?read:undefined,receipt=current?.receipt;
  return <section className="sync-run-snapshot" aria-label="原批次落地快照">
    <header><div><Table2 size={17}/><h4>原批次落地快照</h4></div><button className="button" disabled={current?.loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={14}/>重新核对</button></header>
    <label>查看成功批次<select aria-label="查看同步原批次" value={runId} onChange={event=>{setRunId(event.target.value);setPage(1);}}>{available.map(run=><option key={run.id} value={run.id}>{run.id.slice(0,8)}</option>)}</select></label>
    <small>只读原批次，不会重新同步。默认表预览仍显示当前表。</small>
    {(!current||current.loading)&&<p role="status">正在读取并核对原批次…</p>}
    {current?.error&&<div role="alert" className="sync-snapshot-error"><p>{current.error}</p><small>读取未通过，不显示行数据。可重新核对。</small></div>}
    {receipt&&<>
      <p><strong>{receipt.targetTable}</strong> · 原批次 {receipt.rowCount} 行</p>
      {receipt.status==='NOT_RETAINED'?<p role="status">未留存完整快照：{receipt.reason==='RETENTION_LIMIT'?'本批次达到留存上限，原同步摘要仍保留':'该历史批次未归档行数据'}。不能据此预览历史行，也未使用当前表替代。</p>:<>
        <p className="sync-snapshot-proof">原行数据摘要已核对 · {receipt.createdAt?new Date(receipt.createdAt).toLocaleString('zh-CN',{hour12:false}):'时间未记录'}<br/><code title={receipt.targetHash}>落地摘要 {receipt.targetHash.slice(0,16)}</code><br/><code title={receipt.snapshotHash}>快照摘要 {receipt.snapshotHash?.slice(0,16)}</code></p>
        <p>{receipt.currentTarget?.status!=='VERIFIED'?'当前表状态未确认；下方仍是已核对的原快照。':receipt.currentTarget.matchesOriginalRun?'当前表仍对应本批次。':`当前表已不是本批次（当前 ${receipt.currentTarget.rowCount} 行）；下方保留原批次数据。`}</p>
        <div className="sync-snapshot-scroll" tabIndex={0} aria-label="原批次数据表，可横向滚动"><table><thead><tr>{receipt.columns?.map(column=><th key={column}>{column}</th>)}</tr></thead><tbody>{receipt.rows?.map((row,index)=><tr key={String(row.rowKey??index)}>{receipt.columns?.map(column=><td key={column}>{row[column]===null?'NULL':row[column]===undefined?'—':String(row[column])}</td>)}</tr>)}</tbody></table></div>
        {receipt.rowCount===0&&<p>原批次为已核对的空表。</p>}
        <nav aria-label="原快照分页，每页20行"><button className="button" disabled={page<=1} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page} / {receipt.totalPages} 页</span><button className="button" disabled={page>=(receipt.totalPages??1)} onClick={()=>setPage(value=>value+1)}>下一页</button></nav>
      </>}
    </>}
  </section>;
}
