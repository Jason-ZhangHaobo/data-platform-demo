import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {RefreshCw,Send} from 'lucide-react';
import {readChatChangePublication,publishChatChange,reviewedChatChangeInput,type ChatChangePublicationReceipt as Receipt} from '../../src/v2/chat-change-publication-client.mjs';
import type {ChatDeliverySource} from '../../src/v2/chat-change-delivery-client.mjs';
import type {ChangeApi} from './chat-context-change';
import {reviewAttestationsComplete} from './delivery-presentation';
import {ChatPublicationReview,ChatPublicationMonitor} from './ChatPublicationEvidence';

type Props={
  api:ChangeApi;intentId:string;changeRequestId:string;parent:ChatDeliverySource;child:ChatDeliverySource;
  packageId:string;packageDigest:string;verificationId:string;canInteract:boolean;isCurrent:()=>boolean;onPin:()=>void;
};
export default function ChatChangePublication({api,intentId,changeRequestId,parent,child,packageId,packageDigest,verificationId,canInteract,isCurrent,onPin}:Props){
  const selection=useMemo(()=>({intentId,changeRequestId,expectedParent:parent,expectedSource:child,
    sourceTaskId:child.taskId,sourceRunId:child.runId,packageId,packageDigest,verificationId}),
    [intentId,changeRequestId,parent,child,packageId,packageDigest,verificationId]);
  const [value,setValue]=useState<Receipt>(),[review,setReview]=useState<Receipt>(),[checked,setChecked]=useState<Record<string,boolean>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(false),flight=useRef(false),readOrder=useRef(0),access=useRef({canInteract,isCurrent});
  access.current={canInteract,isCurrent};
  const client=useMemo(()=>({
    request:(path:string,options?:{method?:'POST';body?:unknown;idempotencyKey?:string})=>{
      if(options?.method==='POST'&&(!live.current||!access.current.isCurrent()||!access.current.canInteract))
        throw Error('当前版本或发布权限已变化，请重新读取');
      return api(path,options?.body,options?.idempotencyKey?{idempotencyKey:options.idempotencyKey}:undefined);
    },
  }),[api]);
  const active=()=>live.current&&access.current.isCurrent();
  const load=useCallback(async()=>{
    const tick=++readOrder.current;
    try{
      const next=await readChatChangePublication(client,selection);
      if(active()&&tick===readOrder.current){setValue(next);setError('');return next;}
    }catch(cause){
      if(active()&&tick===readOrder.current){setError((cause as Error).message);setValue(undefined);setReview(undefined);setChecked({});}
    }
  },[client,selection]);
  useEffect(()=>{
    live.current=true;void load();
    return()=>{live.current=false;readOrder.current++;};
  },[load]);
  useEffect(()=>{
    if(review&&(!canInteract||!value?.canPublish||value.phase!==review.phase||
      value.requestId!==review.requestId||value.reviewDigest!==review.reviewDigest)){
      setReview(undefined);setChecked({});
    }
  },[review,value,canInteract]);
  useEffect(()=>{
    if(!value||busy||error||value.phase!=='PUBLISHED'||value.monitoringVerified||
      !value.runs.some(r=>['SCHEDULED','RUNNING'].includes(r.status)&&!r.resultUnknown))return;
    const timer=setTimeout(()=>void load(),2200);
    return()=>clearTimeout(timer);
  },[value,busy,error,load]);

  async function openReview(){
    if(!active()||!canInteract||!value?.canPublish||flight.current)return;
    flight.current=true;setBusy(true);setNotice('');setChecked({});setReview(undefined);
    try{
      const next=await load();
      if(next&&next.phase!=='PUBLISHED'&&next.canPublish&&active()&&access.current.canInteract)setReview(next);
    }finally{flight.current=false;if(live.current)setBusy(false);}
  }
  async function publish(){
    if(flight.current||!active()||!canInteract||!review?.canPublish||!reviewAttestationsComplete(checked,false,true))return;
    flight.current=true;setBusy(true);setError('');setNotice('');readOrder.current++;
    try{
      onPin();
      const next=await publishChatChange(client,reviewedChatChangeInput(review,{...checked},true));
      if(active()){setValue(next);setReview(undefined);setChecked({});}
    }catch(cause){
      if(active()){setValue(undefined);setReview(undefined);setChecked({});setError((cause as Error).message);setNotice('请查询原发布记录，核对已登记的审阅、批准或批次。');}
    }finally{flight.current=false;if(live.current)setBusy(false);}
  }
  async function refresh(){
    if(!active()||flight.current)return;
    flight.current=true;setBusy(true);setNotice('');setReview(undefined);setChecked({});
    try{await load();}finally{flight.current=false;if(live.current)setBusy(false);}
  }
  const writable=canInteract&&value?.canPublish===true;
  return <section aria-label="派生版本测试发布" className="chat-change-publication">
    <header><h4><Send size={16}/>本机测试发布</h4>
      {value&&<span>{value.phase==='PUBLISHED'?'已登记发布':'等待版本审阅'}</span>}</header>
    {error?<div><p role="alert">{error}</p><button type="button" className="button" disabled={busy} onClick={()=>void refresh()}>核对原发布</button></div>
      :!value?<p role="status">正在读取原发布…</p>
      :value.phase==='PUBLISHED'?<>
        <ChatPublicationMonitor value={value}/>
        <button type="button" className="button" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={13}/>刷新运行记录</button>
      </>:review&&writable?<ChatPublicationReview value={review} checked={checked} busy={busy}
        onCheck={(id,state)=>setChecked(previous=>({...previous,[id]:state}))} onPublish={()=>void publish()}
        onCancel={()=>{setReview(undefined);setChecked({});}}/>:<>
        <p>冻结业务日 {value.businessDate} · 计划 {value.scheduleSpec.runCount} 个测试批次</p>
        {writable?<button type="button" className="button" disabled={busy} onClick={()=>void openReview()}>审阅测试发布</button>
          :<p role="status">{canInteract?'本机发布条件尚未就绪。':'当前可查看已保存的发布记录。'}</p>}
      </>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
