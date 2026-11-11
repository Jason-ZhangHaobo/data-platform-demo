import {useEffect,useRef,useState} from 'react';
import {Download,FileCheck2,LoaderCircle,RefreshCw} from 'lucide-react';
import {checkedReportProvenance} from '../../src/v2/report-provenance-client.mjs';
import type {ReportProvenance} from '../../src/v2/report-provenance-client.mjs';
type Api=<T>(path:string)=>Promise<T>;
export function ReportProvenancePanel({api,reportId,runId,versionId,resultHash}:{api:Api;reportId:string;runId:string;versionId:string;resultHash:string}){
 const key=JSON.stringify([reportId,runId,versionId,resultHash]),epoch=useRef(0),active=useRef(key);active.current=key;
 const [record,setRecord]=useState<{key:string;value:ReportProvenance}>(),[state,setState]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{epoch.current++;setRecord(undefined);setState('');setError('');setNotice('');return()=>{epoch.current++;};},[key]);
 const value=record?.key===key?record.value:undefined;
 async function read(){const seq=++epoch.current,same=()=>active.current===key&&epoch.current===seq;setState('LOADING');setError('');setNotice('');
  try{const result=await checkedReportProvenance(await api(`/reports/${reportId}/provenance?run_id=${runId}`),{reportId,reportRunId:runId,reportVersionId:versionId,resultHash});if(same()){setRecord({key,value:result});setState('READY');}}
  catch(e){if(same()){setState('ERROR');setError((e as Error).message);}}
 }
 const downloadUrl = value && state === 'READY'
  ? `/api/v2/reports/${reportId}/provenance?run_id=${runId}&download_digest=${value.digest}`
  : undefined;
 return <details key={key} className="report-provenance-v2" onToggle={e=>{if(e.currentTarget.open&&state==='')void read();}}>
  <summary><FileCheck2 size={17}/><span>需求与审阅溯源<small>固定到此版本 · 离开聊天后也能核对</small></span></summary>
  <div className="report-provenance-body-v2">
   <div className="report-provenance-tools-v2"><span>只读核对原记录，不调用模型、不计算</span><button className="button" disabled={state==='LOADING'} onClick={()=>void read()}><RefreshCw size={14}/>重新核对</button>{downloadUrl
    ? <a className="button" href={downloadUrl} target="_blank" rel="noopener"
         onClick={() => setNotice('已请求下载。保存后可用 shuduo reports verify-provenance --file 文件路径 离线核对。')}>
        <Download size={14}/>导出溯源JSON
      </a>
    : <button className="button" disabled><Download size={14}/>导出溯源JSON</button>}</div>
   {state==='LOADING'&&<p role="status"><LoaderCircle size={14} className="spin"/>正在核对需求、审阅与固定运行…</p>}
   {error&&<p role="status">溯源未确认：{error}。旧报表不会自动补写聊天记录。{value&&'下方为上次读取结果，导出已关闭。'}</p>}
   {value&&<>
    <dl className="report-provenance-demand-v2"><div><dt>原始需求</dt><dd>{value.review.originalRequest}</dd></div>{value.review.turns.map((t,i)=><div key={i}><dt>澄清 {i+1}</dt><dd><strong>{t.question}</strong><p>{t.answer}</p></dd></div>)}</dl>
    <div className="report-provenance-proof-v2"><div><span>审阅方案</span><strong>{value.review.proposal.name}</strong><code>{value.review.proposalHash.slice(0,16)}</code></div><div><span>固定产物</span><strong>V{value.artifacts.versionNumber} · {value.artifacts.reportRunId.slice(0,8)}</strong><code>结果 {value.artifacts.resultHash.slice(0,16)}</code></div><div><span>完整溯源摘要</span><code title={value.digest}>{value.digest.slice(0,24)}</code><small>{value.review.captureMode==='EXISTING_APPLICATION_RECHECK'?'既有应用重新核对后冻结':'应用方案时冻结'}</small></div></div>
    <p className="report-provenance-boundary-v2">规划来源：{value.review.provider.model} · {value.review.provider.mode}。SHA256用于本机内容与版本核对，不是第三方签名；不代表真实模型、云端发布或完整E2E验收。</p>
   </>}
   {notice&&<p role="status">{notice}</p>}
  </div>
 </details>;
}
