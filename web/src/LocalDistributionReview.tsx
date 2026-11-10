import React,{useEffect,useRef,useState} from 'react';
import type {FileReview} from './agent-workflow-read';
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
const labels={code:'已核对当前代码与分类粒度',assertions:'已核对复合键、占比分母与六位精度',deliveryFiles:'已核对调度、部署文件与成功演练',localScope:'仅登记本机虚构样例的文件审阅，不批准发布'};
export function LocalDistributionReview({api,packageId,packageDigest,verificationId,review,enabled,current=true,onRefresh}:{api:Api;packageId:string;packageDigest:string;verificationId:string;review?:FileReview;enabled:boolean;current?:boolean;onRefresh:()=>Promise<{fileReview?:FileReview}|undefined>}){
 const [checked,setChecked]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[error,setError]=useState('');
 const requestKey=useRef<string|undefined>(undefined);
 useEffect(()=>{if(review){setUnknown(false);setError('');}},[review?.id]);
 const complete=Object.keys(labels).every(k=>checked[k]);
 async function submit(){
  if(!enabled||busy||review||!complete)return;
  requestKey.current??=crypto.randomUUID();setBusy(true);setError('');
  try{
   if(unknown){const current=await onRefresh();if(current?.fileReview){setUnknown(false);return;}}
   await api(`/delivery/packages/${packageId}/review`,{packageDigest,verificationId,reviewNote:'本机虚构证券交付文件审阅；不代表发布批准',attestations:checked},{idempotencyKey:requestKey.current});
   await onRefresh();setUnknown(false);
  }catch(e){setUnknown(true);setError((e as Error).message+' 审阅结果未确认，先刷新原记录；不创建发布或计算。');}
  finally{setBusy(false);}
 }
 return <section className="agent-verification-card agent-file-review" aria-label="分布文件本机审阅"><h4>本机文件审阅</h4>
  <p>审阅绑定此包摘要与成功演练。仅记录文件检查；发布须独立确认，不代表公网或生产上线。</p>
  <small>包摘要 {packageDigest.slice(0,16)} · 演练 {verificationId.slice(0,8)}</small>
  {review?<p className={current?"passed":""} role="status">{current?"此包本机文件已审阅":"历史本机审阅记录；当前依据需重新核验"} · {review.id.slice(0,8)} · 不代表批准发布</p>:<>
   {Object.entries(labels).map(([key,label])=><label className="agent-file-review-check" key={key}><input type="checkbox" checked={checked[key]??false} disabled={!enabled||busy||unknown} onChange={e=>setChecked(v=>({...v,[key]:e.target.checked}))}/>{label}</label>)}
   <button className="button" disabled={!enabled||busy||!complete} onClick={()=>void submit()}>{unknown?'按原编号重试文件审阅':'记录此版本的本机审阅'}</button>
  </>}
  {unknown&&<button className="button" disabled={busy} onClick={()=>{setBusy(true);void onRefresh().catch(e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>只读刷新审阅状态</button>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
