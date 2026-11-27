import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Download,Package,RefreshCw} from 'lucide-react';
import {invitedTaskDeliveryPath,invitedTaskDeliveryRequestId} from '../../src/v2/invited-task-delivery.mjs';
import {checkedAgentWorkflow,exactDeliveryAdvance,type Delivery,type Workflow} from './agent-workflow-read';
import {DeliveryFilePreview} from './DeliveryFilePreview';
import {requestTextDownload} from './EvidenceDownload';
import {settlementLabel} from './rehearsal-result-check';
import {invitedDeliveryWriteWindow,invitedRehearsalStatus} from './invited-delivery-state';
import {pinInvitedDelivery,type InvitedEditorSource} from './invited-task-location';
import type {InvitedStartWindow} from './invited-chat-start';
import './agent-development.css';

type Source=InvitedEditorSource & {runId:string};
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type Props={source:Source;api:Api;verified:boolean;testSource:boolean;access:InvitedStartWindow};
type Receipt={workflow:Workflow;requestId:string;requestFound:boolean};
const idPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function deliveryIdFrom(receipt:Delivery,source:Source){
  if(!idPattern.test(receipt?.id)||receipt.mode!=='DURABLE_AGENT_DELIVERY_V1'||receipt.sourcePinned!==true||
    receipt.sourceRevisionId!==source.revisionId||receipt.sourceRunId!==source.runId)
    throw Error('交付回执与原代码版本或运行批次不符。');
  return receipt.id;
}

export default function InvitedTaskDelivery({source,api,access,verified,testSource}:Props){
  const {taskId,contextId,revisionId,revisionHash,runId}=source;
  const selection=useMemo(()=>({taskId,revisionId,revisionHash,runId}),[taskId,revisionId,revisionHash,runId]);
  const [receipt,setReceipt]=useState<Receipt>(),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const [reading,setReading]=useState(true);
  const [downloadNotice,setDownloadNotice]=useState('');
  const flight=useRef(false),mounted=useRef(false),readEpoch=useRef(0),selectedDelivery=useRef<string|undefined>(undefined);
  const latest=useRef({access,verified});latest.current={access,verified};
  const load=useCallback(async()=>{
    const epoch=++readEpoch.current;
    setReading(true);
    const current=()=>mounted.current&&readEpoch.current===epoch;
    try{
      const requestId=await invitedTaskDeliveryRequestId(selection),query=new URL(location.href).searchParams;
      const originalRequest=query.get('invited_package_request'),requestedRehearsal=query.get('invited_rehearsal');
      if(originalRequest!==null&&originalRequest!==requestId)throw Error('交付请求编号与当前任务版本不符。');
      let deliveryId=requestedRehearsal??selectedDelivery.current,requestFound=false;
      if(originalRequest){
        let prior:Delivery|undefined;
        try {prior=await api<Delivery>('/agent/tasks/'+taskId+'/delivery-requests/'+requestId);}
        catch(cause){if((cause as {status?:number}).status!==404)throw cause;}
        if(prior){
          const original=deliveryIdFrom(prior,{...selection,contextId});
          if(deliveryId&&deliveryId!==original)throw Error('原准备请求和演练指向不同交付。');
          deliveryId=original;requestFound=true;
        }
      }
      if(!current())return;
      const raw=await api<unknown>(invitedTaskDeliveryPath({...selection,deliveryId}));
      const workflow=await checkedAgentWorkflow(raw,{taskId,revisionId,runId,contextId,deliveryId,manual:false});
      const report=workflow.report;
      if(workflow.publication.scope!=='PRIVATE_CLOUD_TEST'||report.revisionHash!==revisionHash||
        report.revisionId!==revisionId||report.runId!==runId)throw Error('当前交付与所选 SQL 及批次未能对应。');
      if(originalRequest&&!requestFound&&workflow.delivery)throw Error('原请求暂无回执，已登记的其他交付不能用于确认本次提交。');
      if(!current())return;
      selectedDelivery.current=workflow.delivery?.id;
      setReceipt({workflow,requestId,requestFound});setError('');
    }catch(cause){
      if(current()){setReceipt(undefined);setError((cause as Error).message);}
    }finally{if(current())setReading(false);}
  },[api,selection,taskId,revisionId,revisionHash,runId,contextId]);
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;readEpoch.current++;};},[load]);

  const workflow=receipt?.workflow,delivery=workflow?.delivery,bundle=workflow?.package,result=workflow?.verification;
  const markers=new URL(location.href).searchParams,preparedHere=markers.has('invited_package_request'),scheduledHere=markers.has('invited_rehearsal');
  const mayWrite=verified&&invitedDeliveryWriteWindow(access,taskId);
  const canPrepare=Boolean(mayWrite && workflow?.report.status==='PASSED' && workflow.preparationSource &&
    (!delivery||delivery.stage==='PACKAGE_PERSISTING'&&receipt?.requestFound));
  const canRehearse=Boolean(mayWrite && workflow?.backgroundRehearsalAvailable && bundle && delivery?.sourcePinned &&
    delivery.stage==='PACKAGE_READY' && !delivery.verificationId && !delivery.rehearsalBackground && !scheduledHere);
  const observing=Boolean(delivery?.rehearsalBackground||result||scheduledHere);
  useEffect(()=>{
    if(working||!workflow||!observing||!delivery||!['QUEUED','RUNNING'].includes(delivery.status)||error)return;
    // Browser reads observe the signed event. The Worker continues independently.
    let count=0,timer:ReturnType<typeof setTimeout>|undefined,active=true;
    const schedule=()=>{
      clearTimeout(timer);
      if(active&&document.visibilityState==='visible'&&count<4)
        timer=setTimeout(async()=>{count++;await load();schedule();},[3000,7000,15000,30000][count]);
    };
    schedule();document.addEventListener('visibilitychange',schedule);
    return()=>{active=false;clearTimeout(timer);document.removeEventListener('visibilitychange',schedule);};
  },[working,observing,delivery?.id,delivery?.status,Boolean(workflow),error,load]);

  async function act(action:'prepare'|'rehearse'){
    if(!receipt||reading||flight.current||!latest.current.verified||!invitedDeliveryWriteWindow(latest.current.access,taskId)||
      (action==='prepare'?!canPrepare:!canRehearse))return;
    flight.current=true;setWorking(true);setError('');readEpoch.current++;
    try{
      if(action==='prepare'){
        history.replaceState(null,'',pinInvitedDelivery(location.href,source,'prepare',receipt.requestId));
        const original=await api<Delivery>('/agent/tasks/'+taskId+'/prepare-delivery',
          {expectedSource:receipt.workflow.preparationSource},{idempotencyKey:receipt.requestId});
        if(mounted.current)selectedDelivery.current=deliveryIdFrom(original,source);
      }else if(delivery){
        history.replaceState(null,'',pinInvitedDelivery(location.href,source,'rehearse',delivery.id));
        await api('/agent/deliveries/'+delivery.id+'/advance',{
          ...exactDeliveryAdvance(receipt.workflow,delivery),dispatchInBackground:true});
      }
      if(mounted.current)await load();
    }catch(cause){
      if(mounted.current){setReceipt(undefined);setError('操作回执待核对。'+(cause as Error).message);}
    }finally{flight.current=false;if(mounted.current)setWorking(false);}
  }
  function download(){
    if(!bundle)return;
    try{requestTextDownload('shuduo-delivery-package.json',JSON.stringify(bundle,null,2)+'\n');setDownloadNotice('已请求下载，请在浏览器的下载列表查看。');}
    catch{setDownloadNotice('下载未完成，请重试。');}
  }
  return <section className="invited-delivery" aria-label="调度与部署文件">
    <header><h3><Package size={17}/>调度与部署文件</h3><button type="button" className="button" disabled={working||reading} onClick={()=>void load()}><RefreshCw size={14}/>{reading?'正在读取…':'刷新交付记录'}</button></header>
    {!receipt&&!error&&<p role="status">正在读取此版本的交付记录…</p>}
    {error&&<p role="alert">{error}</p>}
    {workflow&&<><p role="status">{invitedRehearsalStatus(workflow,scheduledHere)}</p>
      {testSource&&!bundle&&<p>此任务使用测试执行来源。生成受邀交付包需要核实原模型及 Spark 的开发记录。</p>}
      {canPrepare&&<button type="button" className="button primary" disabled={working||reading} onClick={()=>void act('prepare')}>
        {preparedHere?'按原请求准备文件':'生成八份交付文件'}</button>}
      {verified&&!bundle&&!canPrepare&&<p>{mayWrite?'此版本尚无可用的交付准备依据。':'在原任务可写的受邀开发窗口可准备文件。'}</p>}
      {bundle&&<><DeliveryFilePreview key={bundle.digest} bundle={bundle} current onDownload={(name,body)=>requestTextDownload(name,body,'text/plain;charset=utf-8')}/>
        <div className="invited-delivery-actions"><button type="button" className="button" onClick={download}><Download size={14}/>下载版本化交付包</button>
          {canRehearse&&<button type="button" className="button primary" disabled={working||reading} onClick={()=>void act('rehearse')}>委托一次 Spark 文件演练</button>}</div>
        {downloadNotice&&<small role="status">{downloadNotice}</small>}
        {canRehearse&&<p>演练将用 Spark 执行此包的加工 SQL 和测试 SQL。</p>}</>}
      {result&&<dl className="invited-rehearsal" aria-label="文件演练记录">
        <div><dt>演练批次</dt><dd><code>{result.id}</code></dd></div>
        {result.engine&&<div><dt>执行引擎</dt><dd>{result.engine} {result.engineVersion}</dd></div>}
        {result.testSqlValidation&&<div><dt>测试 SQL</dt><dd>{result.testSqlValidation.passed?'通过':'未通过'}</dd></div>}
        {result.validation?.regressions&&<div><dt>回归断言</dt><dd>{result.validation.regressions.filter(r=>r.passed).length} / {result.validation.regressions.length} 通过</dd></div>}
        {result.settlementEvidence&&<div><dt>结果确认方式</dt><dd>{settlementLabel(result.settlementEvidence)}</dd></div>}
      </dl>}
      {result?.error&&<p role="alert">{result.error}</p>}
    </>}
  </section>;
}
