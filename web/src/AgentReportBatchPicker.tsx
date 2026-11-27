import {useEffect,useRef,useState} from 'react';
import {chatBatchCandidates, type ReportBatch} from './agent-report-chat';
type Props={api:<T>(path:string)=>Promise<T>;onSelect:(source:ReportBatch)=>void;disabled:boolean};
export function AgentReportBatchPicker({api,onSelect,disabled}:Props){
  const [rows,setRows]=useState<ReturnType<typeof chatBatchCandidates>>(),[chosen,choose]=useState(''),[loading,load]=useState(false),[error,fail]=useState('');
  const epoch=useRef(0);useEffect(()=>()=>{epoch.current++;},[]);
  async function list(){
    const ticket=++epoch.current;load(true);setRows(undefined);choose('');fail('');
    try{const next=chatBatchCandidates(await api('/data-services/sources'));if(ticket===epoch.current)setRows(next);}
    catch(cause){if(ticket===epoch.current)fail((cause as Error).message);}
    finally{if(ticket===epoch.current)load(false);}
  }
  const row=rows?.find(r=>r.source.batchId===chosen);
  return <details className="chat-report-picker"><summary>选择报表批次</summary>
    <button type="button" className="button" disabled={disabled||loading} onClick={()=>void list()}>{loading?'正在读取…':'读取已发布持仓批次'}</button>
    {rows&&rows.length>0&&<><select aria-label="选择聊天报表批次" value={chosen} disabled={disabled} onChange={e=>choose(e.target.value)}>
      <option value="">请选择批次</option>
      {rows.map(r=><option key={r.source.batchId} value={r.source.batchId}>{r.businessDate} · 第 {r.sequence} 批 · {r.source.batchId.slice(0,8)}</option>)}
    </select><button type="button" className="button" disabled={disabled||!row} onClick={()=>{if(row)onSelect(row.source);}}>使用此批次</button></>}
    {rows?.length===0&&<p role="status">尚无可选的成功持仓发布批次。</p>}{error&&<p role="alert">{error}</p>}
  </details>;
}
