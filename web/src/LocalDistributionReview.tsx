import React,{useEffect,useRef,useState} from 'react';
import type {FileReview, FundReviewBasis, Workflow} from './agent-workflow-read';
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
const labels={code:'已核对当前代码与分类粒度',assertions:'已核对复合键、占比分母与六位精度',deliveryFiles:'已核对调度、部署文件与成功演练',localScope:'仅登记本机虚构样例的文件审阅，不批准发布'};
export function LocalDistributionReview({api,packageId,packageDigest,verificationId,review,enabled,current=true,onRefresh,fund=false,fundReview,staleReview=false}:{
 api:Api;packageId:string;packageDigest:string;verificationId:string;review?:FileReview;enabled:boolean;current?:boolean;
 onRefresh:()=>Promise<Pick<Workflow,"fileReview"|"package"|"verification">|undefined>;fund?:boolean;fundReview?:FundReviewBasis;staleReview?:boolean;
}){
 const [checked,setChecked]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[error,setError]=useState('');
 const requestKey=useRef<string|undefined>(undefined);
 useEffect(()=>{if(review){setUnknown(false);setError('');}},[review?.id]);
 const complete=Object.keys(labels).every(k=>checked[k]);
 const rehearsalDigest=fundReview?.status==='READY'?fundReview.digest:undefined;
 const canRecord=enabled&&fundReview?.status!=='UNAVAILABLE';
 async function submit(){
  if(!canRecord||busy||review||!complete)return;
  requestKey.current??=crypto.randomUUID();setBusy(true);setError('');
  try{
   if(unknown){
    const latest=await onRefresh();
    if(rehearsalDigest&&(latest?.package?.digest!==packageDigest||latest.verification?.id!==verificationId||
      latest.verification.fundReview?.status!=='READY'||latest.verification.fundReview.digest!==rehearsalDigest))return;
    if(latest?.fileReview&&latest.fileReview.fundRehearsalDigest===rehearsalDigest){setUnknown(false);return;}
   }
   const recorded=await api<FileReview>(`/delivery/packages/${packageId}/review`,{
    packageDigest,verificationId,reviewNote:'本机虚构证券交付文件审阅；不代表发布批准',attestations:checked,
    ...(rehearsalDigest?{fundRehearsalDigest:rehearsalDigest}:{}),
   },{idempotencyKey:requestKey.current});
   if(rehearsalDigest&&(recorded.packageDigest!==packageDigest||recorded.verificationId!==verificationId||
      recorded.fundRehearsalDigest!==rehearsalDigest))throw Error('审阅回执与当前演练不一致');
   await onRefresh();setUnknown(false);
  }catch(e){
   setUnknown(true);setError((e as Error).message+' 请先刷新审阅依据。');
   if(rehearsalDigest)await onRefresh().catch(()=>{});
  }
  finally{setBusy(false);}
 }
 return <section className="agent-verification-card agent-file-review" aria-label={fund?"基金文件本机审阅":"分布文件本机审阅"}><h4>本机文件审阅</h4>
  <p>审阅绑定此包摘要与成功演练。仅记录文件检查；发布须独立确认，不代表公网或生产上线。</p>
  <small>包摘要 {packageDigest.slice(0,16)} · 演练 {verificationId.slice(0,8)}</small>
  {rehearsalDigest&&<small> · 签名演练摘要 {rehearsalDigest.slice(0,16)}</small>}
  {fundReview?.status==='UNAVAILABLE'&&<p role="alert">签名演练依据暂未核对，请刷新。</p>}
  {staleReview&&rehearsalDigest&&<p role="status">演练依据已更新，请重新逐项审阅。</p>}
  {review?<p className={current?"passed":""} role="status">{current?"此包本机文件已审阅":"历史本机审阅记录；当前依据需重新核验"} · {review.id.slice(0,8)} · 不代表批准发布</p>:<>
   {Object.entries(labels).map(([key,label])=><label className="agent-file-review-check" key={key}><input type="checkbox" checked={checked[key]??false} disabled={!canRecord||busy||unknown} onChange={e=>setChecked(v=>({...v,[key]:e.target.checked}))}/>{label}</label>)}
   <button className="button" disabled={!canRecord||busy||!complete} onClick={()=>void submit()}>{unknown?'按原编号重试文件审阅':'记录此版本的本机审阅'}</button>
  </>}
  {unknown&&<button className="button" disabled={busy} onClick={()=>{setBusy(true);void onRefresh().catch(e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>只读刷新审阅状态</button>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
