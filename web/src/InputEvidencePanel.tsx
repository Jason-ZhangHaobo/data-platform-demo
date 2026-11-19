import {readPackageInputCheck} from '../../src/v2/package-input-check-client.mjs';
import type {PackageInputCheck} from '../../src/v2/package-input-check-client.mjs';
import {useEffect,useRef,useState} from 'react';
import {Download,RefreshCw} from 'lucide-react';
import {readInputEvidence} from '../../src/v2/input-evidence-client.mjs';
import type {InputEvidence} from '../../src/v2/input-evidence-client.mjs';
import {requestTextDownload} from './EvidenceDownload';
type Api=<T>(path:string)=>Promise<T>;
export function InputEvidencePanel({api,packageId,packageDigest,current}:{api:Api;packageId:string;packageDigest:string;current:boolean}){
 const key=packageId+':'+packageDigest,active=useRef(key);active.current=key;
 const [record,setRecord]=useState<{key:string;value:InputEvidence}>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [checkRecord,setCheckRecord]=useState<{key:string;value:PackageInputCheck}>(),[checking,setChecking]=useState(false),[checkError,setCheckError]=useState('');
 const checkSequence=useRef(0);
 const sequence=useRef(0);useEffect(()=>{sequence.current++;checkSequence.current++;setCheckRecord(undefined);setChecking(false);setCheckError('');setRecord(undefined);setError('');setNotice('');setLoading(false);return()=>{sequence.current++;checkSequence.current++;};},[key]);
 const value=record?.key===key?record.value:undefined;
 const read=async()=>{const ticket=++sequence.current;setLoading(true);setRecord(undefined);setError('');setNotice('');try{const result=await readInputEvidence({request:path=>api(path)},{packageId,packageDigest});if(active.current===key&&sequence.current===ticket)setRecord({key,value:result});}catch(cause){if(active.current===key&&sequence.current===ticket){setError((cause as Error).message);setCheckRecord(undefined);}}finally{if(active.current===key&&sequence.current===ticket)setLoading(false);}};
 const checked=checkRecord?.key===key?checkRecord.value:undefined;
 const check=async()=>{const ticket=++checkSequence.current;setChecking(true);setCheckRecord(undefined);setCheckError('');setNotice('');try{const result=await readPackageInputCheck({request:path=>api(path)},{packageId,packageDigest});if(active.current===key&&checkSequence.current===ticket)setCheckRecord({key,value:result});}catch(cause){if(active.current===key&&checkSequence.current===ticket)setCheckError((cause as Error).message);}finally{if(active.current===key&&checkSequence.current===ticket)setChecking(false);}};
 const saveCheck=()=>{if(!checked)return;try{requestTextDownload('shuduo-input-check-'+packageId.slice(0,8)+'.json',JSON.stringify(checked,null,2)+'\n');setNotice('已请求保存原包输入核验回执，请核对下载列表。');}catch{setNotice('保存未确认，核验回执仍保留在本页。');}};
 const save=()=>{if(!value)return;try{requestTextDownload('shuduo-input-evidence-'+packageId.slice(0,8)+'.json',JSON.stringify(value,null,2)+'\n');setNotice('已请求浏览器保存。请核对下载列表；没有文件不算保存完成，下方仍保留证明文本。');}catch{setNotice('保存未确认，请使用下方证明文本；不会重跑任务。');}};
 return <section className="input-evidence-panel" aria-label="原包离线输入证明"><header><div><span className="eyebrow">INPUT EVIDENCE · READ ONLY</span><h3>核验并保留原包输入依据</h3><p>{current?'所选交付版本':'历史交付版本'} · {packageDigest.slice(0,10)}。仅包含所选持仓与必要来源记录，不需要导出整个元数据库。</p></div></header>
  <div className="input-check-actions"><button className="button primary" disabled={checking} onClick={()=>void check()}>{checking?'正在核验原包输入…':checked?'重新核验原包输入':'核验原包输入'}</button><small>读取原登记CSV与冻结证据，核对来源和字节；代码结果仍以原运行回执为准。</small></div>
  {checkError&&<p className="input-check-error" role="alert">{checkError}。原包保留，已有离线证明可配合原CSV复核。</p>}
  {checked&&<div className="input-check-result" role="status"><strong>原包输入核验通过</strong><p>已核对原批次 {checked.input.syncRunId.slice(0,8)} · {checked.input.rows}行持仓输入 · {checked.input.proof?'原完整目标快照':'原CSV全量重放'}。{checked.input.rows===0?'空持仓仍保留登记账户与现金。':''}</p><p>仅对应此原包输入，未改变代码核验、审阅或发布状态。修改来源后请重新核验。</p><small>输入摘要 {checked.input.snapshotHash.slice(0,16)} · 回执 {checked.evidenceDigest.slice(0,16)}</small><button className="button" onClick={saveCheck}><Download size={14}/>下载输入核验回执</button></div>}
  <button className="button" disabled={loading} onClick={()=>void read()}><RefreshCw size={14}/>{loading?'正在读取原输入…':value?'重新读取原输入证明':'读取原包输入证明'}</button>
  {error&&<p role="alert">{error}。未沿用上次材料；原文件与批准保持。</p>}
  {value&&<><dl><dt>目标表</dt><dd>{value.records.offline_sync_task.targetTable}</dd><dt>完整目标行数</dt><dd>{value.records.offline_sync_run.finalCount}</dd><dt>原CSV事件／行数</dt><dd>{value.records.offline_sync_run.readCount}</dd><dt>证明摘要</dt><dd>{value.evidenceHash.slice(0,16)}</dd></dl>
   <p>离线核验时仍需本机原 CSV。下载材料后可复核原包、CSV与证明；材料读取与输入核验分别记录。</p>
   <button className="button" onClick={save}><Download size={14}/>下载输入证明 JSON</button>
   <details className="input-evidence-text"><summary>下载未生成？查看证明文本</summary><pre tabIndex={0} aria-label="原包输入证明 JSON">{JSON.stringify(value,null,2)}</pre></details></>}
  {notice&&<p role="status">{notice}</p>}
 </section>;
}
