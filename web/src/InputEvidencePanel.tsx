import {useEffect,useRef,useState} from 'react';
import {Download,RefreshCw} from 'lucide-react';
import {readInputEvidence} from '../../src/v2/input-evidence-client.mjs';
import type {InputEvidence} from '../../src/v2/input-evidence-client.mjs';
import {requestTextDownload} from './EvidenceDownload';
type Api=<T>(path:string)=>Promise<T>;
export function InputEvidencePanel({api,packageId,packageDigest,current}:{api:Api;packageId:string;packageDigest:string;current:boolean}){
 const key=packageId+':'+packageDigest,active=useRef(key);active.current=key;
 const [record,setRecord]=useState<{key:string;value:InputEvidence}>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const sequence=useRef(0);useEffect(()=>{sequence.current++;setRecord(undefined);setError('');setNotice('');setLoading(false);return()=>{sequence.current++;};},[key]);
 const value=record?.key===key?record.value:undefined;
 const read=async()=>{const ticket=++sequence.current;setLoading(true);setRecord(undefined);setError('');setNotice('');try{const result=await readInputEvidence({request:path=>api(path)},{packageId,packageDigest});if(active.current===key&&sequence.current===ticket)setRecord({key,value:result});}catch(cause){if(active.current===key&&sequence.current===ticket)setError((cause as Error).message);}finally{if(active.current===key&&sequence.current===ticket)setLoading(false);}};
 const save=()=>{if(!value)return;try{requestTextDownload('shuduo-input-evidence-'+packageId.slice(0,8)+'.json',JSON.stringify(value,null,2)+'\n');setNotice('已请求浏览器保存。请核对下载列表；没有文件不算保存完成，下方仍保留证明文本。');}catch{setNotice('保存未确认，请使用下方证明文本；不会重跑任务。');}};
 return <section className="input-evidence-panel" aria-label="原包离线输入证明"><header><div><span className="eyebrow">INPUT EVIDENCE · READ ONLY</span><h3>带走这份代码使用的输入依据</h3><p>{current?'所选交付版本':'历史交付版本'} · {packageDigest.slice(0,10)}。仅包含所选持仓与必要来源记录，不需要导出整个元数据库。</p></div></header>
  <button className="button" disabled={loading} onClick={()=>void read()}><RefreshCw size={14}/>{loading?'正在读取原输入…':value?'重新读取原输入证明':'读取原包输入证明'}</button>
  {error&&<p role="alert">{error}。未沿用上次材料；原文件与批准保持。</p>}
  {value&&<><dl><dt>目标表</dt><dd>{value.records.offline_sync_task.targetTable}</dd><dt>完整目标行数</dt><dd>{value.records.offline_sync_run.finalCount}</dd><dt>原CSV事件／行数</dt><dd>{value.records.offline_sync_run.readCount}</dd><dt>证明摘要</dt><dd>{value.evidenceHash.slice(0,16)}</dd></dl>
   <p>原 CSV 仍需在本机提供。下载此文件后，使用离线核验命令检查原包、CSV与证明；材料读取不代表输入或完整生命周期已通过。</p>
   <button className="button" onClick={save}><Download size={14}/>下载输入证明 JSON</button>
   <details className="input-evidence-text"><summary>下载未生成？查看证明文本</summary><pre tabIndex={0} aria-label="原包输入证明 JSON">{JSON.stringify(value,null,2)}</pre></details></>}
  {notice&&<p role="status">{notice}</p>}
 </section>;
}
