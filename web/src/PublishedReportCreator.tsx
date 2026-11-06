import {useEffect,useRef,useState} from 'react';
import {LoaderCircle,Plus,RefreshCw} from 'lucide-react';
import {publishedReportInput} from '../../src/v2/published-report-request.mjs';
import {submitPublishedReport,lookupPublishedReport,resumePublishedReport} from '../../src/v2/published-report-client.mjs';
import type{PublishedReportReceipt}from'../../src/v2/published-report-client.mjs';
import type{PublishedReportBinding}from'../../src/v2/published-report-request.mjs';
import type{PublishedReportSource}from'./published-report-read';
type Pending={requestId:string;name:string;source:PublishedReportBinding};
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
export function PublishedReportCreator({api,source,canCreate,onCreated}:{api:Api;source:PublishedReportSource;canCreate:boolean;onCreated:(receipt:PublishedReportReceipt)=>void}){
 const[name,setName]=useState('财富顾问资产分析报告'),[batchId,setBatchId]=useState(source.batchIds[0]),[pending,setPending]=useState<Pending>(),[receipt,setReceipt]=useState<PublishedReportReceipt>(),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[missing,setMissing]=useState(false),[storageBlocked,setStorageBlocked]=useState(false);
 const alive=useRef(true),key='shuduo:published-report:v1:'+JSON.stringify([source.kind,source.taskId??'',source.releaseId,source.packageDigest,source.revisionId,source.runId]);
 const client={request:(path:string,options?:{body?:unknown;idempotencyKey?:string})=>api<unknown>(path,options?.body,{idempotencyKey:options?.idempotencyKey})};
 const accept=(value:PublishedReportReceipt)=>{setReceipt(value);setMissing(false);if(value.status==='SUCCEEDED'){setNotice('确切批次的快照、报表和实际聚合已核验，结果已回到当前会话。');onCreated(value);}else setNotice(value.error?.message??'原请求已保存，尚未完成；可核对后续接原编号。');};
 const lookup=async(p:Pending)=>{
  setBusy(true);setNotice('正在查询原报表请求，不创建新任务…');
  try{const value=await lookupPublishedReport(client,p);if(alive.current)accept(value);}
  catch(e){if(alive.current){setMissing((e as {status?:number}).status===404);setNotice('原请求结果尚未确认；保留原编号。查询不到时，可核对后按原内容重试。');}}
  finally{if(alive.current)setBusy(false);}
 };
 useEffect(()=>{
  alive.current=true;
  try{
   const raw=localStorage.getItem(key);
   if(raw){const saved=JSON.parse(raw) as Pending,body=publishedReportInput({name:saved.name,source:saved.source});
    if(JSON.stringify([body.source.kind,body.source.taskId??'',body.source.releaseId,body.source.packageDigest,body.source.revisionId,body.source.runId])!==key.slice(key.indexOf('['))||typeof saved.requestId!=='string')throw Error('OTHER_SOURCE');
    const p={requestId:saved.requestId,...body};setPending(p);setName(p.name);setBatchId(p.source.batchId);void lookup(p);
   }
  }catch{setStorageBlocked(true);setNotice('本机原请求信息未确认，未创建新请求；请保留现场核对。');}
  return()=>{alive.current=false;};
 },[]);
 const submit=async(original?:Pending)=>{
  if(!canCreate||busy||storageBlocked)return;
  setBusy(true);setNotice('');
  try{
   const{batchIds,...base}=source,p=original??{requestId:crypto.randomUUID(),...publishedReportInput({name,source:{...base,batchId}})};
   if(!batchIds.includes(p.source.batchId))throw Error('原批次当前未确认，未改用其他批次');
   localStorage.setItem(key,JSON.stringify(p));setPending(p);setMissing(false);
   const value=await submitPublishedReport(client,p);if(alive.current)accept(value);
  }catch(e){if(alive.current)setNotice(`报表结果尚未确认：${(e as Error).message}。先查询原请求，不新建编号。`);}
  finally{if(alive.current)setBusy(false);}
 };
 const resume=async()=>{
  if(!canCreate||!pending||!receipt||busy)return;setBusy(true);
  try{const value=await resumePublishedReport(client,{id:receipt.id,requestId:pending.requestId,source:pending.source});if(alive.current)accept(value);}
  catch(e){if(alive.current)setNotice(`续接尚未确认：${(e as Error).message}。保留原编号，不重新创建。`);}
  finally{if(alive.current)setBusy(false);}
 };
 return <section className="published-report-create-v2" aria-label="从确切发布批次创建报表"><h4>从此发布结果创建报表</h4><p>物化选定批次并实际聚合，沿用当前业务口径；不运行新SQL、模型或Spark，不补造类别和行业字段。</p>
  {!pending&&<div className="published-report-form-v2"><label>报表名称<input aria-label="报表名称" value={name} maxLength={80} disabled={!canCreate||busy||storageBlocked} onChange={e=>setName(e.target.value)}/></label><label>来源批次<select aria-label="报表源批次" value={batchId} disabled={!canCreate||busy||storageBlocked} onChange={e=>setBatchId(e.target.value)}>{source.batchIds.map(id=><option key={id} value={id}>已核验批次 {id.slice(0,8)}</option>)}</select></label><button className="button" disabled={!canCreate||busy||storageBlocked||name.trim().length<2} onClick={()=>void submit()}>{busy?<LoaderCircle size={14} className="spin"/>:<Plus size={14}/>}创建并核验报表</button></div>}
  {pending&&<><small>原请求 {pending.requestId} · 固定批次 {pending.source.batchId.slice(0,8)} · {receipt?.status==='SUCCEEDED'?'已完成':receipt?.status==='PARTIAL'?'保留中间结果':'结果待查询'}</small><div className="published-report-actions-v2"><button className="button" disabled={busy} onClick={()=>void lookup(pending)}><RefreshCw size={14}/>查询原报表请求</button>{receipt&&receipt.status!=='SUCCEEDED'&&<button className="button" disabled={!canCreate||busy} onClick={()=>void resume()}>继续原报表请求</button>}{missing&&<button className="button" disabled={!canCreate||busy} onClick={()=>void submit(pending)}>按原编号和内容重试</button>}{receipt?.status==='SUCCEEDED'&&<button className="button" disabled={!canCreate||busy} onClick={()=>{try{localStorage.removeItem(key);setPending(undefined);setReceipt(undefined);setNotice('');}catch{setNotice('本机原请求尚未清除，未创建另一张报表');}}}>创建另一张报表</button>}</div></>}
  {!canCreate&&<small>当前只读，可查看及查询原结果；创建与续接尚未开放。</small>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
