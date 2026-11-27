import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {RefreshCw,ShieldCheck} from 'lucide-react';
import {publicationHistoryPath,publicationPreflightPath,publicationRequestReceiptPath} from '../../src/v2/publication-request.mjs';
import {privateReleasePendingLabel} from '../../src/v2/private-release-stage.mjs';
import {AgentPublicationApprovalActions} from './AgentPublicationApprovalActions';
import {AgentPublicationReview,publicationTargetMatches} from './AgentPublicationReview';
import {InvitedPublicationBasis} from './InvitedPublicationBasis';
import {checkedAgentPublication,checkedExactPublicationApproval,checkedExactPublicationReceipt,type Publication} from './agent-delivery-evidence-read';
import {invitedBatchAssertions,invitedPublicationMonitor} from './invited-publication-monitor';
import {checkedCloudPublicationPreflight,type CloudPublicationPreflight,type Workflow} from './agent-workflow-read';
import {reviewAttestationsComplete} from './delivery-presentation';
import {publicationMonitorHref} from './ops-publication';
import {invitedPublicationPin,pinInvitedPublication,type InvitedApprovalPin,type InvitedEditorSource} from './invited-task-location';
import type {InvitedStartWindow} from './invited-chat-start';
import type {PublicationTarget} from './AuthDialog';

type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type Source=InvitedEditorSource & {runId:string};
type Props={source:Source;workflow:Workflow;access:InvitedStartWindow;verified:boolean;api:Api};
const InvitedBatchConsumption=lazy(()=>import('./InvitedBatchConsumption'));
type SavedApproval=ReturnType<typeof checkedExactPublicationApproval>;
type Saved={history:Publication;approval?:SavedApproval;requestFound:boolean};
type Review={preflight:CloudPublicationPreflight;window:PublicationTarget};
const labels:Record<string,string>={SCHEDULED:'等待调度',QUEUED:'已排队',RUNNING:'运行中',SUCCEEDED:'成功',FAILED:'失败',CANCELLED:'已取消',INTERRUPTED:'已中断'};
const beijing=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});

function PublicationBatches({history,source}:{history:Publication;source:Source}){
  const {release,runs,alerts}=history;
  if(!release)return null;
  const {pair,complete}=invitedPublicationMonitor(history);
  const href=pair&&release.packageDigest&&release.verificationId&&release.reviewDigest&&publicationMonitorHref({
    taskId:source.taskId,releaseId:release.id,revisionId:source.revisionId,firstBatchId:pair.firstBatchId,secondBatchId:pair.secondBatchId,
    source:{runId:source.runId,packageDigest:release.packageDigest,verificationId:release.verificationId,reviewDigest:release.reviewDigest}});
  return <div className="invited-batch-history" aria-label="原发布的两个批次">
    <p role="status">{complete?'两个测试批次均已完成并通过监控核验':pair?.triggered!==undefined?
      `发布已登记，调度器已触发 ${pair.triggered} / 2 批。`:'发布已登记，调度依据待核对。'}</p>
    <dl className="invited-rehearsal"><div><dt>发布编号</dt><dd><code>{release.id}</code></dd></div></dl>
    <ol>{runs.map(batch=>{
      const event=history.events.find(item=>item.releaseId===release.id&&item.releaseRunId===batch.id&&item.packageDigest===release.packageDigest&&
        (item.type==='BATCH_SUCCEEDED'&&batch.status==='SUCCEEDED'||item.type==='BATCH_FAILED'&&batch.status==='FAILED'));
      const checks=pair?invitedBatchAssertions(batch,source.contextId):undefined;
      return <li key={batch.id}><h4>第 {batch.sequence} 批 · {batch.resultUnknown?'结果待核对':privateReleasePendingLabel(batch)??labels[batch.status]??'状态待核对'}</h4>
        <dl><dt>批次编号</dt><dd><code>{batch.id}</code></dd>
          <dt>调度状态</dt><dd>{batch.schedulerTriggered===true?'已触发':batch.schedulerTriggered===false?'尚未触发':'待核对'}</dd>
          {batch.triggeredAt&&<><dt>触发时间</dt><dd>{beijing.format(new Date(batch.triggeredAt))}（北京）</dd></>}
          {batch.finishedAt&&<><dt>完成时间</dt><dd>{beijing.format(new Date(batch.finishedAt))}（北京）</dd></>}
          {batch.durationMs!==undefined&&<><dt>执行耗时</dt><dd>{(batch.durationMs/1000).toLocaleString('zh-CN')} 秒</dd></>}
          {checks?.testSql!==undefined&&<><dt>测试 SQL</dt><dd>{checks.testSql?'通过':'未通过'}</dd></>}
          {checks?.regression&&<><dt>回归断言</dt><dd>{checks.regression.passed} / {checks.regression.total} 通过</dd></>}
          {event&&<><dt>监控事件</dt><dd>{event.type==='BATCH_SUCCEEDED'?'批次成功':'批次失败'} · {beijing.format(new Date(event.observedAt))}（北京）</dd></>}
        </dl></li>;
    })}</ol>
    {alerts.map(alert=><p key={alert.id} role={alert.status==='OPEN'?'alert':undefined}>{alert.status==='OPEN'?'未解除告警':'已恢复告警'} · {alert.message}</p>)}
    {href&&<a className="button" href={href}>在运维监控查看原批次</a>}
  </div>;
}

export default function InvitedTaskPublication({api,source,workflow,access,verified}:Props){
  const {taskId,revisionId,revisionHash,runId}=source;
  const deliveryId=workflow.delivery!.id,packageId=workflow.package!.id,
    packageDigest=workflow.package!.digest,verificationId=workflow.verification!.id;
  const exact=useMemo(()=>({taskId,revisionId,revisionHash,runId,packageId,packageDigest,verificationId}),
    [taskId,revisionId,revisionHash,runId,packageId,packageDigest,verificationId]);
  const selector=useMemo(()=>({sourceKind:'AGENT' as const,sourceRunId:runId,packageDigest,verificationId}),[runId,packageDigest,verificationId]);
  const [saved,setSaved]=useState<Saved>(),[error,setError]=useState(''),[reading,setReading]=useState(true);
  const [review,setReview]=useState<Review>(),[busy,setBusy]=useState(false),[section,setSection]=useState('');
  const [checked,setChecked]=useState<Record<string,boolean>>({}),[approval,setApproval]=useState<SavedApproval>();
  const evidenceButton=useRef<HTMLButtonElement|null>(null),reviewButton=useRef<HTMLButtonElement|null>(null);
  const reviewHeading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(review)reviewHeading.current?.focus();},[review]);
  const mounted=useRef(false),readEpoch=useRef(0),opening=useRef(false);
  const latest=useRef({access,verified,workflow,checked,approval,saved});
  latest.current={access,verified,workflow,checked,approval,saved};
  const target=access.publicationTarget;
  function activeWindow(){
    const {access,verified}=latest.current,window=access.publicationTarget;
    return verified&&access.publicationSupported&&window&&Date.now()<Date.parse(access.sessionExpiresAt??'')&&
      publicationTargetMatches(window,exact)?window:undefined;
  }
  const closeReview=useCallback(()=>{setReview(undefined);setSection('');setChecked({});setApproval(undefined);},[]);
  const dismiss=()=>{closeReview();requestAnimationFrame(()=>reviewButton.current?.focus());};
  useEffect(()=>{closeReview();},[closeReview,target?.startsAt,target?.expiresAt,target?.taskId,target?.packageDigest,target?.verificationId]);

  const load=useCallback(async()=>{
    const stamp=++readEpoch.current,current=()=>mounted.current&&stamp===readEpoch.current;
    setReading(true);
    try{
      const pin=invitedPublicationPin(location.href);
      if(!pin)throw Error('原发布链接不完整。');
      let releaseId=pin.releaseId,approved:SavedApproval|undefined,requestFound=false,originalBatches:string[]|undefined;
      if(pin.approval){
        let original: {protocol:string;runs?:{id:string}[]}|undefined;
        try {original=await api(publicationRequestReceiptPath(taskId,pin.approval.requestId));}
        catch(cause){if((cause as {status?:number}).status!==404)throw cause;}
        if(original){
          requestFound=true;
          const expected={...exact,reviewDigest:pin.approval.reviewDigest};
          if(original.protocol==='shuduo-cloud-publication-receipt/v1'){
            const found=checkedExactPublicationReceipt(original,expected);
            if(releaseId&&found!==releaseId)throw Error('原请求对应另一发布。');
            releaseId=found;originalBatches=original.runs!.map(batch=>batch.id);
          }else approved=checkedExactPublicationApproval(original,expected,pin.approval);
        }
      }
      if(!current())return;
      const history=checkedAgentPublication(await api(publicationHistoryPath(taskId,{...selector,...(releaseId?{releaseId}:{})})),{
        taskId,scope:'PRIVATE_CLOUD_TEST',selector,releaseId});
      if(history.readMode!=='SAVED_HISTORY')throw Error('原发布监控的保存状态尚未核实。');
      // A signed event may create the release between the two GETs.
      const sameApproval=!approved||approved.approvalId===(history.release as {approvalId?:string}|undefined)?.approvalId;
      if(history.release&&(history.release.packageId!==packageId||history.release.sourceRevisionId!==revisionId||
        pin.approval&&(!requestFound||!sameApproval||history.release.reviewDigest!==pin.approval.reviewDigest)||
        originalBatches&&!originalBatches.every((id,i)=>history.runs.find(row=>row.sequence===i+1)?.id===id)))
        throw Error('原发布请求、交付包或批次未能对应。');
      if(!current())return;
      if(history.release){
        const url=pinInvitedPublication(location.href,{...exact,contextId:source.contextId,requestId:source.requestId},deliveryId,undefined,history.release.id);
        if(url.href!==location.href)window.history.replaceState(null,'',url);
        closeReview();
      }
      setSaved({history,approval:approved,requestFound});setError('');
    }catch(cause){
      if(current()){setSaved(undefined);setError((cause as Error).message);closeReview();}
    }finally{if(current())setReading(false);}
  },[api,closeReview,deliveryId,exact,packageId,revisionId,selector,source.contextId,source.requestId,taskId]);
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;readEpoch.current++;};},[load]);

  const release=saved?.history.release,queued=approval?.background?.state==='QUEUED'||saved?.approval?.background?.state==='QUEUED';
  const consumptionSource=useMemo(()=>release?{sourceKind:'AGENT' as const,scope:'PRIVATE_CLOUD_TEST' as const,
    taskId,revisionId,runId,packageDigest,releaseId:release.id}:undefined,[release?.id,taskId,revisionId,runId,packageDigest]);
  const monitor=saved&&invitedPublicationMonitor(saved.history);
  const observe=Boolean(target)&&(queued||Boolean(release&&['WAITING_SCHEDULER','RUNNING_CLOUD_TEST','ACTIVE_CLOUD_TEST'].includes(release.status)));
  useEffect(()=>{
    if(!observe||error)return;
    const delays=[4000,10000,20000,30000];let count=0,alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    const schedule=()=>{clearTimeout(timer);if(alive&&document.visibilityState==='visible'&&count<delays.length)
      timer=setTimeout(async()=>{count++;await load();schedule();},delays[count]);};
    schedule();document.addEventListener('visibilitychange',schedule);
    return()=>{alive=false;clearTimeout(timer);document.removeEventListener('visibilitychange',schedule);};
  },[observe,release?.id,error,load]);

  async function preflight(){
    return checkedCloudPublicationPreflight(await api(publicationPreflightPath(taskId,selector)),latest.current.workflow);
  }
  async function openReview(){
    if(opening.current||reading||!saved||release||!activeWindow())return;
    opening.current=true;setBusy(true);setError('');closeReview();
    try{
      const p=await preflight(),window=activeWindow(),pin=invitedPublicationPin(location.href);
      if(!mounted.current)return;
      if(!window||!p.approvalRequestId||!pin||pin.releaseId)throw Error('当前窗口或独立批准请求未能核实。');
      if(pin.approval&&pin.approval.requestId!==p.approvalRequestId&&latest.current.saved?.approval?.background)
        throw Error('原批准已委托后台，请先核对该请求的发布结果。');
      setReview({preflight:p,window});
    }catch(cause){if(mounted.current)setError((cause as Error).message);}
    finally{opening.current=false;if(mounted.current)setBusy(false);}
  }
  async function beforeWrite(){
    const window=activeWindow();
    if(!window||!review||window.startsAt!==review.window.startsAt||window.expiresAt!==review.window.expiresAt||
      latest.current.saved?.history.release||!latest.current.approval&&!reviewAttestationsComplete(latest.current.checked,true))
      throw Error('须核对当前窗口、原发布记录和四项审阅依据。');
    const p=await preflight(),requestId=p.approvalRequestId;
    if(!mounted.current||activeWindow()?.expiresAt!==window.expiresAt||p.reviewDigest!==review.preflight.reviewDigest||!requestId||
      requestId!==review.preflight.approvalRequestId||p.backgroundPublicationSupported!==review.preflight.backgroundPublicationSupported){
      if(mounted.current)closeReview();
      throw Error('窗口或审阅版本已变化，请重新读取并审阅。');
    }
    if(!latest.current.approval&&!reviewAttestationsComplete(latest.current.checked,true))
      throw Error('审阅确认项已变化，请核对后再保存批准。');
    const pin:InvitedApprovalPin={requestId,reviewDigest:p.reviewDigest,startsAt:window.startsAt,expiresAt:window.expiresAt};
    history.replaceState(null,'',pinInvitedPublication(location.href,source,deliveryId,pin));
  }
  const mayReview=Boolean(activeWindow()&&saved&&!release&&!reading&&!busy);
  return <section className="invited-publication" aria-label="测试发布与运行监控">
    <header><h3><ShieldCheck size={17}/>测试发布与运行监控</h3><button type="button" className="button" disabled={reading||busy} onClick={()=>void load()}><RefreshCw size={14}/>刷新发布记录</button></header>
    {!saved&&!error&&<p role="status">正在读取原发布记录…</p>}
    {error&&<p role="alert">{error}</p>}
    {release&&saved?<PublicationBatches history={saved.history} source={source}/>:saved&&<>
      {saved.approval?<p role="status">此版本的批准已保存{saved.approval.background?'，后台发布回执待核对':'，尚未发起测试发布'}。</p>:<p role="status">此包及演练暂无已登记发布。</p>}
      {mayReview&&!review&&<button ref={reviewButton} type="button" className="button primary" onClick={()=>void openReview()}>审阅并发布两个测试批次</button>}
      {!review&&!activeWindow()&&<p>{verified?'发布操作须进入此包及演练的受邀发布窗口。':'原开发或签名演练依据尚待核对。'}</p>}
    </>}
    {consumptionSource&&access.consumptionSupported&&monitor?.complete&&monitor.pair&&<Suspense fallback={<p role="status">正在打开批次接口记录…</p>}>
      <InvitedBatchConsumption key={consumptionSource.releaseId} api={api} source={consumptionSource} access={access}
        verified={verified&&!reading&&!busy} fund={source.contextId.startsWith('fund-')} batchIds={[monitor.pair.firstBatchId,monitor.pair.secondBatchId]}/>
    </Suspense>}
    {review&&!release&&activeWindow()&&review.preflight.approvalRequestId&&<>
      <AgentPublicationReview cloud packageDigest={packageDigest} revisionId={revisionId} runId={runId} verificationId={verificationId}
        preflight={review.preflight} confirmed={checked} disabled={reading||busy} approvalSaved={Boolean(approval)} headingRef={reviewHeading}
        onOpenEvidence={(id,trigger)=>{evidenceButton.current=trigger;setSection(id);}} onConfirm={(id,value)=>setChecked(old=>({...old,[id]:value}))}
        onCancel={dismiss} approvalActions={<AgentPublicationApprovalActions key={review.preflight.approvalRequestId}
          requestId={review.preflight.approvalRequestId} expected={{...exact,reviewDigest:review.preflight.reviewDigest}} window={review.window}
          disabled={reading||busy||!activeWindow()} confirmed={reviewAttestationsComplete(checked,true)} backgroundSupported={review.preflight.backgroundPublicationSupported}
          api={api} beforeWrite={beforeWrite} onSaved={setApproval} onClose={dismiss} onReleased={id=>{
            history.replaceState(null,'',pinInvitedPublication(location.href,source,deliveryId,undefined,id));closeReview();void load();
          }}/>} />
      {section&&<InvitedPublicationBasis section={section} workflow={workflow} preflight={review.preflight} onClose={()=>{setSection('');evidenceButton.current?.focus();}}/>}
    </>}
  </section>;
}
