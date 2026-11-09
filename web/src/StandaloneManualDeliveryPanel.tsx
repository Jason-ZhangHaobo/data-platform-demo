import {useEffect,useRef,useState} from 'react';
import type {StandaloneServiceSourceBinding,ServiceSourceBinding}from'./service-source-binding';
import {StandaloneManualPublicationPanel} from './StandaloneManualPublicationPanel';
import {Package,RefreshCw,Play,Square} from 'lucide-react';
import {DeliveryFilePreview} from './DeliveryFilePreview';
import {readStandaloneWorkflow,prepareStandaloneManual,mutateStandaloneManual} from '../../src/v2/standalone-manual-client.mjs';
import type {StandaloneWorkflow,StandaloneTask} from '../../src/v2/standalone-manual-client.mjs';
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
const terminal=(s:string)=>['SUCCEEDED','FAILED','CANCELLED'].includes(s);
function download(name:string,value:string){const url=URL.createObjectURL(new Blob([value],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=name;link.hidden=true;document.body.appendChild(link);try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}}
export function StandaloneManualDeliveryPanel({api,sourceRunId,revisionId,revisionHash,dirty,canWrite,canPublish=false,expectedSource,onOpenServices}:{api:Api;sourceRunId:string;revisionId:string;revisionHash?:string;dirty:boolean;canWrite:boolean;canPublish?:boolean;expectedSource?:StandaloneServiceSourceBinding;onOpenServices?:(source:ServiceSourceBinding)=>void}){
  const key=JSON.stringify([sourceRunId,revisionId,revisionHash]),active=useRef(key);active.current=key;
  const access=useRef({dirty,canWrite});access.current={dirty,canWrite};
  const alive=useRef(true),sequence=useRef(0),flight=useRef(false),request=useRef({key,id:crypto.randomUUID()});
  const [record,setRecord]=useState<{key:string;state:'LOADING'|'READY'|'ERROR';value?:StandaloneWorkflow;error?:string}>({key,state:'LOADING'}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState<string>();
  const current=record.key===key?record:undefined,value=current?.value,task=value?.delivery,unknown=uncertain===key;
  const returnMatches=!expectedSource||task?.id===expectedSource.manualDeliveryTaskId&&task.packageDigest===expectedSource.packageDigest&&task.sourceRunId===expectedSource.runId&&task.sourceRevisionId===expectedSource.revisionId&&task.sourceSqlHash===expectedSource.revisionHash;
  const client={request:(path:string,o?:{method?:string;body?:unknown;idempotencyKey?:string})=>api<unknown>(path,o?.method==='POST'?o.body:undefined,o)};
  const live=(scope:string)=>alive.current&&active.current===scope;
  const load=async()=>{
    const scope=key,ticket=++sequence.current;setRecord(old=>({key:scope,state:'LOADING',value:old.key===scope?old.value:undefined}));
    try{const next=await readStandaloneWorkflow(client,{sourceRunId,revisionId,revisionHash});if(live(scope)&&ticket===sequence.current){setRecord({key:scope,state:'READY',value:next});setUncertain(old=>old===scope?undefined:old);setError('');}return next;}
    catch(e){if(live(scope)&&ticket===sequence.current)setRecord(old=>({key:scope,state:'ERROR',value:old.key===scope?old.value:undefined,error:(e as Error).message}));return undefined;}
  };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  useEffect(()=>{if(request.current.key!==key)request.current={key,id:crypto.randomUUID()};void load();},[key]);
  const drive=async(start:StandaloneTask)=>{
    if(flight.current||!access.current.canWrite||access.current.dirty||current?.state!=='READY'||unknown)return;
    const scope=key;flight.current=true;setBusy(true);setError('');let item=start;
    try{for(let n=0;n<5&&!terminal(item.status)&&live(scope)&&access.current.canWrite&&!access.current.dirty;n++){
      item=await mutateStandaloneManual(client,{sourceRunId,taskId:item.id,expectedVersion:item.version,operation:'advance',confirm:true});if(!live(scope))return;
      await load();if(!terminal(item.status))await new Promise(r=>setTimeout(r,1500));
    }}catch(e){if(live(scope)){setUncertain(scope);setError((e as Error).message+' 先读取原交付编号，不自动重提。');}}
    finally{flight.current=false;if(live(scope))setBusy(false);}
  };
  const prepare=async()=>{
    if(flight.current||busy||unknown||!returnMatches||current?.state!=='READY'||!value?.sourceCurrent||!value.executionAvailable||!canWrite||dirty)return;
    const scope=key;flight.current=true;setBusy(true);setError('');
    try{const started=await prepareStandaloneManual(client,{sourceRunId,requestId:request.current.id,confirm:true});if(!live(scope))return;
      const next=await load();flight.current=false;setBusy(false);if(next&&access.current.canWrite&&!access.current.dirty)await drive(started);
    }catch(e){if(live(scope)){setUncertain(scope);setError((e as Error).message+' 原准备请求编号保留，请先读取原交付。');}}
    finally{flight.current=false;if(live(scope))setBusy(false);}
  };
  const stop=async()=>{if(!task||flight.current||!canWrite)return;const scope=key;flight.current=true;setBusy(true);
    try{await mutateStandaloneManual(client,{sourceRunId,taskId:task.id,expectedVersion:task.version,operation:'cancel',confirm:true});if(live(scope))await load();}
    catch(e){if(live(scope)){setUncertain(scope);setError((e as Error).message);}}finally{flight.current=false;if(live(scope))setBusy(false);}
  };
  return <section className="agent-delivery-panel standalone-manual-delivery" aria-label="独立手工文件与演练"><header><div><Package size={17}/><strong>手工开发文件与演练</strong></div><button className="button" disabled={busy||current?.state==='LOADING'} onClick={()=>void load()}><RefreshCw size={14}/>读取原交付</button></header>
    <p>无需模型。固定这份手工SQL、测试、调度和部署文件，再交给隔离Spark演练；不创建Agent任务，不自动批准或发布。</p>
    <small>原运行 {sourceRunId.slice(0,8)} · 原版本 {revisionId.slice(0,8)} · 人工作者（MANUAL／ENGINEER_AUTHORED）</small>
    {current?.state==='READY'&&!returnMatches&&<p role="alert">返程的确切手工交付与保存记录尚未一致；原文件仅供历史查看，不推进或切换其他版本。</p>}{dirty&&<p role="status">未保存修改不属于当前交付；请先保存并核验新代码，下面仍保留原版本记录。</p>}
    {current?.state!=='READY'&&<p role={current?.state==='ERROR'?'alert':'status'}>{current?.error??'正在核对原版本与交付证据；读取不启动计算。'}</p>}
    {error&&<p role="alert">{error}</p>}{unknown&&<p role="status">操作结果尚未确认。保留原编号，先“读取原交付”再继续。</p>}
    {value&&<><p>{value.report.summary}</p><ul>{value.report.checks.map(c=><li key={c.id}>{c.label} · {c.passed?'通过':'未通过'}</li>)}</ul>
      {!value.sourceCurrent&&<p role="status">原来源证据已变化，已有交付作为历史保留，不继续准备或演练。请核对原版本与结果。</p>}
      {!task&&<button className="button primary" disabled={!canWrite||dirty||busy||unknown||current?.state!=='READY'||!value.sourceCurrent||!value.executionAvailable} onClick={()=>void prepare()}><Play size={14}/>准备文件并演练（不调用模型）</button>}
      {!value.executionAvailable&&<p>隔离Spark执行器尚未就绪，现有代码和证据保留；此流程不要求模型API Key。</p>}
      {task&&<><h4>{task.status==='SUCCEEDED'?'文件演练已通过':task.status==='FAILED'?'文件演练失败':task.status==='CANCELLED'?'交付已停止':task.stage==='PACKAGE_READY'?'文件已准备，待演练':'交付准备中'}</h4><code>手工交付 {task.id} · 版本 {task.version}</code>{task.error&&<p role="alert">{task.error}</p>}
        {!terminal(task.status)&&<div className="agent-delivery-actions"><button className="button primary" disabled={!canWrite||dirty||busy||unknown||current?.state!=='READY'||!value.sourceCurrent} onClick={()=>void drive(task)}><Play size={14}/>继续原演练</button><button className="button" disabled={!canWrite||busy} onClick={()=>void stop()}><Square size={14}/>停止原交付</button></div>}
      </>}
      {value.package&&<DeliveryFilePreview key={value.package.digest} bundle={value.package} current={value.sourceCurrent&&!dirty} onDownload={download}/>}
      {value.verification&&<p>文件演练 {value.verification.id} · {value.verification.status==='SUCCEEDED'?'主SQL、测试SQL和登记回归通过':value.verification.status} · Spark {value.verification.engineVersion??'待回执'}</p>}
      {task?.status==='SUCCEEDED'&&task.packageDigest&&task.verificationId&&value.publication.scope==='PRIVATE_CLOUD_TEST'&&<StandaloneManualPublicationPanel key={`${task.id}:${task.packageDigest}:${task.verificationId}`} api={api} selection={{sourceRunId,taskId:task.id,packageDigest:task.packageDigest,verificationId:task.verificationId,...(expectedSource?{releaseId:expectedSource.releaseId}:{})}} sourceRevision={{id:revisionId,hash:task.sourceSqlHash}} onOpenServices={onOpenServices} canPublish={canPublish} blocked={dirty||busy||unknown||!returnMatches||current?.state!=='READY'||!value.sourceCurrent} available={value.publication.available} window={value.publication.window}/>}
      <p>{value.publication.reason}</p><small>文件准备与演练由本页推进，离开后保留原编号；发布后的批次由独立调度器推进。</small>
    </>}
  </section>;
}
