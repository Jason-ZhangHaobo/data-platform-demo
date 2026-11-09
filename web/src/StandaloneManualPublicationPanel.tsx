import {useEffect,useRef,useState} from 'react';
import {Activity,RefreshCw,ShieldCheck,Square} from 'lucide-react';
import {readStandalonePublication,publishStandaloneManual,cancelStandalonePublication,manualPublicationRequestId} from '../../src/v2/standalone-manual-publication-client.mjs';
import type {ManualPublication,ManualPublicationSelection} from '../../src/v2/standalone-manual-publication-client.mjs';
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type Window={manualDeliveryTaskId:string;packageDigest:string;verificationId:string;startsAt:string;expiresAt:string};
const labels:Record<string,string>={SCHEDULED:'等待调度',RUNNING:'批次运行中',SUCCEEDED:'独立核验通过',FAILED:'批次失败',CANCELLED:'已停止',WAITING_SCHEDULER:'等待调度',RUNNING_CLOUD_TEST:'批次运行中',ACTIVE_CLOUD_TEST:'继续观察',COMPLETED_CLOUD_TEST:'两个样例批次已结束',HEALTHY:'两个批次核验通过',CRITICAL:'存在未解决告警',RECOVERED_WITH_FAILURE:'已恢复，仍有失败历史',OBSERVING:'继续观察',PENDING:'尚无运行结论',STOPPED:'已停止'};
const reviews=[['code','已核对当前SQL版本及业务口径'],['assertions','已核对独立结果和五场景断言'],['deliveryFiles','已审阅当前包的调度、部署及其他文件'],['cloudScope','仅发布两个冻结虚构样例批次，非生产上线']] as const;
export function StandaloneManualPublicationPanel({api,selection,canPublish,blocked,available,window:approvedWindow}:{api:Api;selection:ManualPublicationSelection;canPublish:boolean;blocked:boolean;available:boolean;window?:Window}){
 const key=JSON.stringify(selection),source=useRef(key);source.current=key;const live=useRef(true),seq=useRef(0),flight=useRef(false),request=useRef<{key:string;id?:string}>({key}),access=useRef({canPublish,blocked});access.current={canPublish,blocked};
 const [record,setRecord]=useState<{key:string;state:'LOADING'|'READY'|'ERROR';value?:ManualPublication;error?:string}>({key,state:'LOADING'}),[checked,setChecked]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState<string>(),[error,setError]=useState(''),[stopConfirmed,setStopConfirmed]=useState(false),[stopAck,setStopAck]=useState(''),[clock,setClock]=useState(Date.now());
 const current=record.key===key?record:undefined,value=current?.value,release=value?.release,uncertain=unknown===key;
 const validWindow=Boolean(approvedWindow&&approvedWindow.manualDeliveryTaskId===selection.taskId&&approvedWindow.packageDigest===selection.packageDigest&&approvedWindow.verificationId===selection.verificationId&&clock>=Date.parse(approvedWindow.startsAt)&&clock<Date.parse(approvedWindow.expiresAt)),writable=canPublish&&!blocked&&available&&validWindow;
 const client={request:(p:string,o?:{method?:string;body?:unknown;idempotencyKey?:string})=>api<unknown>(p,o?.method==='POST'?o.body:undefined,o)},active=(scope:string)=>live.current&&source.current===scope;
 const load=async()=>{const scope=key,ticket=++seq.current;setRecord(old=>({key:scope,state:'LOADING',value:old.key===scope?old.value:undefined}));
  try{const next=await readStandalonePublication(client,selection);if(active(scope)&&ticket===seq.current){setRecord({key:scope,state:'READY',value:next});setUnknown(old=>old===scope?undefined:old);setError('');}return next;}
  catch(e){if(active(scope)&&ticket===seq.current)setRecord(old=>({key:scope,state:'ERROR',value:old.key===scope?old.value:undefined,error:(e as Error).message}));return undefined;}};
 useEffect(()=>{live.current=true;return()=>{live.current=false;seq.current++;};},[]);
 useEffect(()=>{if(request.current.key!==key)request.current={key};setChecked({});setStopConfirmed(false);setStopAck('');void load();},[key]);
 useEffect(()=>{if(!approvedWindow)return;setClock(Date.now());const id=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(id);},[approvedWindow?.startsAt,approvedWindow?.expiresAt]);
 useEffect(()=>{if(!writable)setChecked({});},[writable]);
 const publish=async()=>{if(flight.current||!writable||current?.state!=='READY'||release||uncertain||!reviews.every(([id])=>checked[id]))return;const scope=key;flight.current=true;setBusy(true);setError('');
  try{const requestId=request.current.id??await manualPublicationRequestId(selection);if(!active(scope)||!access.current.canPublish||access.current.blocked)return;request.current={key:scope,id:requestId};const next=await publishStandaloneManual(client,{...selection,requestId,confirm:true,attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true}});if(active(scope)){setRecord({key:scope,state:'READY',value:next});setChecked({});}}
  catch(e){if(active(scope)){setUnknown(scope);setError((e as Error).message+' 原请求编号保留，先读取原发布，不自动重提。');}}
  finally{flight.current=false;if(active(scope))setBusy(false);}};
 const stop=async()=>{if(flight.current||!canPublish||!validWindow||!release||!stopConfirmed)return;const scope=key;flight.current=true;setBusy(true);setError('');
  try{const ack=await cancelStandalonePublication(client,{...selection,releaseId:release.id,confirm:true});if(active(scope)){setStopAck(ack.status==='CANCELLED'?'停止已确认，原文件和运行历史保留。':'原发布已经结束，没有新增计算。');setStopConfirmed(false);await load();}}
  catch(e){if(active(scope)){setUnknown(scope);setError((e as Error).message+' 原发布编号保留；未自动重试。');}}
  finally{flight.current=false;if(active(scope))setBusy(false);}};
 return <section className="agent-delivery-panel" aria-label="独立手工审阅发布与监控"><header><div><ShieldCheck size={17}/><strong>审阅此版本，再观察运行</strong></div><button className="button" disabled={busy||current?.state==='LOADING'} onClick={()=>void load()}><RefreshCw size={14}/>读取原发布与监控</button></header>
  <p>当前包 {selection.packageDigest.slice(0,12)} · 演练 {selection.verificationId.slice(0,8)}。工程师审阅后，由调度器运行两个冻结虚构样例批次，保留人工来源和原运行历史。</p>
  {busy&&<p role="status">正在提交原版本操作，请等待回执；不会自动重提。</p>}{current?.state!=='READY'&&<p role={current?.state==='ERROR'?'alert':'status'}>{current?.error??'正在读取原发布记录；读取不创建调度或计算。'}</p>}{error&&<p role="alert">{error}</p>}{stopAck&&<p role="status">{stopAck}</p>}{uncertain&&<p role="status">操作结果未确认。保留原请求与版本，请先读取原发布。</p>}
  {!writable&&<p>当前审阅窗口未开放、已到期、权限不足或版本未确认；文件和已有发布历史仍保留。</p>}
  {current?.state==='READY'&&!release&&<fieldset disabled={!writable||busy||uncertain}><legend>逐项审阅后才能发布</legend>{reviews.map(([id,label])=><label className="agent-review-check" key={id}><input type="checkbox" checked={Boolean(checked[id])} onChange={e=>setChecked(old=>({...old,[id]:e.target.checked}))}/>{label}</label>)}<button className="button primary" disabled={!writable||busy||uncertain||!reviews.every(([id])=>checked[id])} onClick={()=>void publish()}>发布此版本的两个样例批次</button></fieldset>}
  {release&&<><h4><Activity size={16}/> {labels[release.status]??release.status} · {labels[release.health]??release.health}</h4><code>发布 {release.id}</code><ol>{value?.runs.map(r=><li key={r.id}>批次 {r.sequence} · {labels[r.status]??r.status} · <code>{r.id.slice(0,8)}</code></li>)}</ol>{value?.alerts.map(a=><p role={a.status==='OPEN'?'alert':'status'} key={a.id}>{a.status==='OPEN'?'待处理告警':'已恢复告警'}：{a.message}</p>)}<small>监控事件 {value?.events.length??0} 条；保留失败和恢复历史，不以状态标签代替独立结果。</small>
   {!['COMPLETED_CLOUD_TEST','CANCELLED'].includes(release.status)&&<div><label className="agent-review-check"><input type="checkbox" checked={stopConfirmed} onChange={e=>setStopConfirmed(e.target.checked)} disabled={!canPublish||!validWindow||busy}/>确认停止此发布的后续批次，保留历史</label><button className="button" disabled={!canPublish||!validWindow||busy||!stopConfirmed} onClick={()=>void stop()}><Square size={14}/>停止原发布</button></div>}
  </>}
  <small>发布后由独立调度器推进，页面可以关闭。刷新读取原批次和告警；实际云端验收按运行证据单独确认。</small>
 </section>;
}
