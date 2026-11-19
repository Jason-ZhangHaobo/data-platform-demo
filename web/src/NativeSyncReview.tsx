import {useEffect,useRef,useState} from 'react';
import {readNativeSyncReview} from '../../src/v2/native-sync-review-client.mjs';
import type {NativeSyncReview as Receipt,NativeSyncReviewBinding} from '../../src/v2/native-sync-review-client.mjs';
import {requestTextDownload} from './EvidenceDownload';
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
const labels={code:'已核对代码、持仓粒度与现金不重复累计',assertions:'已核对独立预期、结果和五场景回归',deliveryFiles:'已核对八文件、调度日期与部署依赖',localScope:'仅记录本机虚构持仓文件审阅；不批准发布'};
export type NativeReviewTarget={taskId:string;deliveryId:string;verificationId:string;enabled:boolean};
export function NativeSyncReview({api,binding,current,enabled}:{api:Api;binding:NativeSyncReviewBinding;current:boolean;enabled:boolean}){
 const key=JSON.stringify([binding,current,enabled]),active=useRef(key);active.current=key;
 const ticket=useRef(0),request=useRef<string|undefined>(undefined),[value,setValue]=useState<Receipt>(),[checked,setChecked]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unknown,setUnknown]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{ticket.current++;request.current=undefined;setValue(undefined);setChecked({});setBusy(false);setError('');setUnknown(false);setNotice('');return()=>{ticket.current++;};},[key]);
 const load=async()=>{const n=++ticket.current;setBusy(true);setError('');setNotice('');setValue(undefined);setChecked({});try{const next=await readNativeSyncReview({request:path=>api(path)},binding);if(active.current===key&&ticket.current===n){setValue(next);if(next.review.status==='REVIEWED')setUnknown(false);}}catch(cause){if(active.current===key&&ticket.current===n)setError((cause as Error).message);}finally{if(active.current===key&&ticket.current===n)setBusy(false);}};
 const complete=Object.keys(labels).every(k=>checked[k]),canRecord=enabled&&current&&value&&value.review.status!=='REVIEWED';
 const record=async()=>{
  if(!canRecord||!complete||busy)return;
  const prior=value,n=++ticket.current;let writeAttempted=false;setBusy(true);setError('');setNotice('');request.current??=crypto.randomUUID();
  try{
   // Re-read the exact original before a write. Unknown writes are never automatically retried.
   const fresh=await readNativeSyncReview({request:path=>api(path)},binding);
   if(active.current!==key||ticket.current!==n)return;
   if(fresh.review.status==='REVIEWED'){setValue(fresh);setUnknown(false);return;}
   if(fresh.evidence.syncRehearsalDigest!==prior.evidence.syncRehearsalDigest){setValue(fresh);setChecked({});throw Error('演练依据已变化，请重新逐项审阅');}
   writeAttempted=true;await api(`/delivery/packages/${binding.packageId}/review`,{packageDigest:binding.packageDigest,verificationId:binding.verificationId,
    syncRehearsalDigest:fresh.evidence.syncRehearsalDigest,reviewNote:'本人核对本机虚构证券文件；不代表批准发布',attestations:checked},{idempotencyKey:request.current});
   const confirmed=await readNativeSyncReview({request:path=>api(path)},binding);
   if(confirmed.review.status!=='REVIEWED')throw Error('审阅写入结果尚未确认');
   if(active.current===key&&ticket.current===n){setValue(confirmed);setUnknown(false);setChecked({});}
  }catch(cause){if(active.current===key&&ticket.current===n){setUnknown(writeAttempted);setValue(undefined);setChecked({});setError((cause as Error).message);}}
  finally{if(active.current===key&&ticket.current===n)setBusy(false);}
 };
 const save=()=>{if(!value)return;try{requestTextDownload('shuduo-review-preflight-'+binding.packageId.slice(0,8)+'.json',JSON.stringify(value,null,2)+'\n');setNotice('已请求保存审阅预检，请核对下载列表；材料完整性摘要不代表不可篡改生产审计。');}catch{setNotice('下载未确认，下方仍可展开原材料文本。');}};
 return <section className="native-sync-review" aria-label="冻结持仓审阅与发布预检"><header><span className="eyebrow">REVIEW BEFORE RELEASE</span><h3>从文件通过，到可审阅交付</h3><p>{current?'当前原包':'历史原包，只读对照'}。读取不会重新计算；文件审阅与发布批准分别记录。</p></header>
  <button className="button" disabled={busy} onClick={()=>void load()}>{busy?'正在核对确切审阅依据…':unknown?'查询原审阅结果':'核对原包审阅与发布范围'}</button>
  {error&&<p className="input-check-error" role="alert">{error}。已撤下旧预检；原文件与批准保留。</p>}
  {unknown&&<p role="status">操作结果待确认。先查询原包、原演练的审阅；没有回执时仍需本人重新逐项确认，不会自动重提。</p>}
  {value&&<><div className="native-review-summary" role="status"><strong>{value.review.status==='REVIEWED'?'当前文件审阅已核对':value.review.status==='STALE_REVIEW'?'原审阅与当前演练不一致，待重新审阅':'技术证据已核对，待本人文件审阅'}</strong><p>Apache Spark {value.evidence.rehearsal.engineVersion} · 结果 {value.evidence.rehearsal.selectedRowCount} 行 · {value.evidence.rehearsal.regressionCount} 场景通过</p><p>{value.evidence.source.developmentMode==='SYNTHETIC_MODEL'?'开发来源为合成模型样例；文件演练证据单独核对，不计真实模型端到端。':'开发来源为原模型运行；此处只核对原交付，不新增模型或计算。'}</p></div>
   <dl><dt>确切包</dt><dd>{binding.packageDigest}</dd><dt>演练摘要</dt><dd>{value.evidence.syncRehearsalDigest}</dd><dt>原代码版本</dt><dd>{value.evidence.source.revisionId}</dd><dt>同一冻结业务日</dt><dd>{value.consentBasis.businessDate}</dd></dl>
   <div className="native-review-batches"><strong>后续独立批准的本机测试范围</strong><ol>{value.batches.map(batch=><li key={batch.sequence}>第 {batch.sequence} 批：批准并激活后约 {batch.afterSeconds} 秒触发，仍加工 {batch.businessDate}。</li>)}</ol><p>两批是同一冻结数据的测试，不是两个交易日。{value.schedulerEnabled?'本机计时器已配置，仍未批准或启动此计划。':'本机计时器未启用，预检不会替你开启。'} 公网和生产发布不在此次范围内。</p></div>
   <details><summary>核对八文件与完整摘要</summary><dl>{Object.entries(value.evidence.fileHashes).map(([name,hash])=><div key={name}><dt>{name}</dt><dd>{hash}</dd></div>)}</dl></details>
   {canRecord&&<fieldset disabled={busy}><legend>本人文件审阅</legend>{Object.entries(labels).map(([name,label])=><label key={name}><input type="checkbox" checked={Boolean(checked[name])} onChange={e=>setChecked(v=>({...v,[name]:e.target.checked}))}/>{label}</label>)}<button className="button primary" disabled={!complete||busy} onClick={()=>void record()}>仅记录文件审阅</button></fieldset>}
   {!enabled&&value.review.status!=='REVIEWED'&&<p>当前为只读查看；不会代记本人审阅。</p>}
   {value.review.status==='REVIEWED'&&<p>文件审阅已记录；本次核对不批准发布，也不启动上述两批。</p>}
   <button className="button" onClick={save}>下载审阅预检 JSON</button><details><summary>查看审阅材料文本</summary><pre tabIndex={0}>{JSON.stringify(value,null,2)}</pre></details>
  </>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
