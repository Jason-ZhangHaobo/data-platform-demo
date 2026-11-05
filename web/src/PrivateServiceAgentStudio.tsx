import {useEffect,useRef,useState} from 'react';
import {Bot,CheckCircle2,Clock3,LoaderCircle,Play,RefreshCw,ShieldCheck,Square} from 'lucide-react';
import {createServicePlanSubmission,boundServicePlansPath,servicePlanMarker,servicePlanLocation,servicePlanRecoverySource,readPrivateServiceAgentContext,sameServicePlanSource} from './service-plan-source';
import type {ServicePlanSource,ServiceAgentContext} from './service-plan-source';
import type {ServiceSourceBinding} from './service-source-binding';
import {checkedPrivateServicePlan,servicePlanningWindowOpen,samePlanningWindow,privatePlanStageText} from './private-service-plan';
import type {PrivateServicePlan,ServicePlanningAccess} from './private-service-plan';

type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type Props={api:Api;binding:ServiceSourceBinding;verifiedSource?:ServicePlanSource;readEnabled:boolean;planningEnabled:boolean;transportEnabled:boolean;canAct:boolean;modelConfigured:boolean;
 access?:ServicePlanningAccess;onApplied:(serviceId:string)=>Promise<void>;onBusyChange:(busy:boolean)=>void;onRefreshSource:()=>Promise<void>};
const terminal=new Set(['SUCCEEDED','FAILED','CANCELLED','APPLIED']);
const href=()=>typeof window==='undefined'?undefined:window.location.href;
export function PrivateServiceAgentStudio(props:Props){
 const marker=href()?servicePlanMarker(href()!):{invalid:false as const,requestId:undefined,planId:undefined,batchId:undefined},
  source=props.verifiedSource??servicePlanRecoverySource(props.binding,href()),identity=JSON.stringify([props.binding,source??null]);
 const [clock,setClock]=useState(Date.now),[message,setMessage]=useState('为当前发布结果规划一个财富顾问客户资产查询接口，保留原有字段口径'),
  [plan,setPlan]=useState<PrivateServicePlan>(),[plans,setPlans]=useState<PrivateServicePlan[]>([]),[historyState,setHistoryState]=useState<'LOADING'|'READY'|'ERROR'>('LOADING'),
  [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pendingRequest,setPendingRequest]=useState<string|undefined>(marker.invalid?undefined:marker.requestId),
  [pendingAction,setPendingAction]=useState<string>(),[confirmRetry,setConfirmRetry]=useState(false),[reviewed,setReviewed]=useState(false);
 const [contextInfo,setContextInfo]=useState<ServiceAgentContext>();
 const mounted=useRef(true),current=useRef(identity),callbacks=useRef(props);current.current=identity;callbacks.current=props;
 const controller=useRef<ReturnType<typeof createServicePlanSubmission<PrivateServicePlan>>|undefined>(undefined);
 const actionSequence=useRef(0);
 const valid=(key:string)=>mounted.current&&current.current===key;
 const latest=(key:string,ticket:number)=>valid(key)&&actionSequence.current===ticket;
 const sourceAvailable=Boolean(props.verifiedSource),windowOpen=servicePlanningWindowOpen(props.access,props.verifiedSource,clock),
  windowTasks=plans.filter(p=>p.pilotId===props.access?.id).length,
  writeWindow=Boolean(props.planningEnabled&&props.transportEnabled&&props.canAct&&windowOpen),
  canSave=Boolean(writeWindow&&contextInfo&&historyState==='READY'&&Number.isSafeInteger(props.access?.maxPlans)&&windowTasks<Number(props.access?.maxPlans)&&!plan&&!pendingRequest&&!marker.invalid),
  currentWindow=Boolean(plan&&samePlanningWindow(plan,props.access)),
  quotaOpen=Boolean(plan&&plan.quota.attemptsUsed<plan.quota.attemptLimit&&plan.quota.usedTokens<plan.quota.tokenLimit),
  canAdvance=Boolean(plan&&writeWindow&&currentWindow&&props.modelConfigured&&sourceAvailable&&plan.sourceCheck==='VERIFIED'&&quotaOpen&&!pendingRequest&&!pendingAction&&['READY_FOR_MODEL','MODEL_NOT_SENT','MODEL_OUTCOME_UNKNOWN'].includes(plan.stage)),
  canApply=Boolean(plan&&writeWindow&&currentWindow&&sourceAvailable&&plan.sourceCheck==='VERIFIED'&&plan.status==='SUCCEEDED'&&reviewed&&!pendingRequest&&!pendingAction);
 const windowReason=props.access?.reason==='BOUNDARY_CHANGED'?'执行配置与原窗口不一致，需要先复核。':!props.canAct?'当前账号或入口没有规划写权限。':!props.planningEnabled?'当前服务未开放新规划步骤。':props.access?.reason==='NOT_STARTED'?'执行窗口尚未开始。':props.access?.reason==='EXPIRED'||props.access?.expiresAt&&clock>=Date.parse(props.access.expiresAt)?'执行窗口已到期。':!sameServicePlanSource(props.access?.sourceBinding,props.verifiedSource)?'当前发布批次不属于此执行窗口。':'当前执行窗口未开放。';
 function start(action:string){setBusy(action);setError('');setNotice('');callbacks.current.onBusyChange(true);return ++actionSequence.current;}
 function end(key:string,ticket:number){if(latest(key,ticket)){setBusy('');callbacks.current.onBusyChange(false);}}
 function submission(){
  if(!source)throw Error('原规划来源不完整，未新建任务');
  if(!controller.current){const m=href()?servicePlanMarker(href()!):{invalid:true as const};controller.current=createServicePlanSubmission<PrivateServicePlan>({api:props.api,initialKey:!m.invalid?m.requestId:undefined,onPending:key=>{
   if(!mounted.current)return;setPendingRequest(key);if(key&&source&&href())history.replaceState(null,'',servicePlanLocation(href()!,{batchId:source.sourceReleaseRunId,requestId:key}));
  }});}return controller.current;
 }
 function accept(value:unknown,sourceValue:ServicePlanSource,key:string,requestId?:string,ticket?:number){
  if(!valid(key)||ticket!==undefined&&!latest(key,ticket))return;
  const next=checkedPrivateServicePlan(value,sourceValue,props.binding);
  if(requestId&&next.requestId!==requestId)throw Error('原请求编号与规划回执不一致，未采用该结果');
  if(requestId)submission().acknowledge(requestId);
  setPendingRequest(undefined);setMessage(next.message);setPlan(next);setPlans(old=>[next,...old.filter(item=>item.id!==next.id)]);setConfirmRetry(false);setReviewed(false);setPendingAction(undefined);
  if(href())history.replaceState(null,'',servicePlanLocation(href()!,{batchId:sourceValue.sourceReleaseRunId,planId:next.id}));
  return next;
 }
 async function readOriginal(id?:string,retrySave=false){
  if(!source||busy)return;const key=identity,selected=source,ticket=start('read');
  try{
   const pending=pendingRequest??(!marker.invalid?marker.requestId:undefined),value=id?await props.api('/data-services/agent/plans/'+id):pending?
    await(retrySave?submission().retry():submission().recover()):plan?await props.api('/data-services/agent/plans/'+plan.id):undefined;
   if(value){const next=accept(value,selected,key,id?undefined:pending,ticket);if(next&&latest(key,ticket)){setNotice('已读取原任务；没有再次调用模型。');if(next.status==='APPLIED'&&next.serviceId)await props.onApplied(next.serviceId);}}
  }catch(cause){if(latest(key,ticket))setError((cause as Error).message+' 原编号保留，只读查询可以重试。');}finally{end(key,ticket);}
 }
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.close();callbacks.current.onBusyChange(false);};},[]);
 useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{
  if(!props.readEnabled||!source)return;let active=true;const key=identity,selected=source;
  const isCurrent=()=>active&&valid(key);
  const m=href()?servicePlanMarker(href()!):{invalid:true as const};if(m.invalid){setError('规划恢复链接不完整，未读取其他任务。');setHistoryState('ERROR');return;}
  setHistoryState('LOADING');
  void(async()=>{try{
   if(m.requestId){setPendingRequest(m.requestId);const value=await submission().recover();if(isCurrent())accept(value,selected,key,m.requestId);}
   else if(m.planId){const value=await props.api('/data-services/agent/plans/'+m.planId);if(isCurrent())accept(value,selected,key);}
   if(!isCurrent())return;
   const [values,context]=await Promise.all([props.api<unknown[]>(boundServicePlansPath(selected)),sourceAvailable?readPrivateServiceAgentContext(props.api,selected):Promise.resolve(undefined)]);if(!isCurrent())return;
   if(context&&(context.sourceKind!==props.binding.sourceKind||props.binding.sourceKind==='MANUAL'&&(context.releaseRuns[0].sourceRevisionId!==props.binding.revisionId||context.releaseRuns[0].sourceRunId!==props.binding.runId)))throw Error('原来源类型或人工版本与当前交接不一致');
   if(!Array.isArray(values))throw Error('原来源的规划列表尚未确认');const next=values.map(value=>checkedPrivateServicePlan(value,selected,props.binding));setPlans(next);setContextInfo(context);setHistoryState('READY');setError('');
  }catch(cause){if(isCurrent()){setHistoryState('ERROR');setError((cause as Error).message+' 原来源和编号保留，未重复提交。');}}})();
  return()=>{active=false;};
 },[identity,sourceAvailable,props.readEnabled]);
 useEffect(()=>{
  if(!plan||plan.status!=='RUNNING'||busy||pendingAction)return;let active=true,reads=0,flight=false;const key=identity,selected=source,id=plan.id;
  if(!selected)return;
  const timer=setInterval(async()=>{if(!active||flight||reads>=12){if(reads>=12)clearInterval(timer);return;}reads++;flight=true;
   try{const value=await props.api('/data-services/agent/plans/'+id);if(active&&valid(key)){
    const next=checkedPrivateServicePlan(value,selected,props.binding);setPlan(next);setPlans(old=>[next,...old.filter(p=>p.id!==id)]);if(next.status!=='RUNNING'||next.recovery.leaseExpired||next.sourceCheck==='UNAVAILABLE')clearInterval(timer);
   }}catch(cause){clearInterval(timer);if(active&&valid(key))setError((cause as Error).message+' 状态读取已暂停，可手动查询原任务。');}finally{flight=false;}
  },5000);return()=>{active=false;clearInterval(timer);};
 },[plan?.id,plan?.status,busy,pendingAction,identity]);
 async function save(){
  if(!canSave||!source||busy||message.trim().length<4||message.trim().length>2000)return;const key=identity,selected=source,text=message.trim(),ticket=start('save');
  try{const c=submission(),value=await c.submit({message:text,sourceBinding:selected}),request=c.snapshot().key;
   if(!request)throw Error('原请求编号未确认');if(value.message!==text)throw Error('回执需求与本次提交不一致');
   if(accept(value,selected,key,request,ticket)&&latest(key,ticket))setNotice('任务已保存，尚未调用模型；请核对后开始规划。');
  }catch(cause){if(latest(key,ticket))setError((cause as Error).message+' 请先查询原请求，不会自动重发。');}finally{end(key,ticket);}
 }
 async function advance(reconcile=false){
  if(!plan||!source||busy||(!reconcile&&!canAdvance)||reconcile&&!(props.planningEnabled&&props.canAct&&plan.recovery.leaseExpired)||plan.stage==='MODEL_OUTCOME_UNKNOWN'&&!confirmRetry)return;
  const key=identity,selected=source,id=plan.id,version=plan.version,ticket=start('advance');setPendingAction('advance');
  try{const value=await props.api('/data-services/agent/plans/'+id+'/advance',{expectedVersion:version,...(plan.stage==='MODEL_OUTCOME_UNKNOWN'?{confirmModelRetry:true}:{})});
   if(accept(value,selected,key,undefined,ticket)&&latest(key,ticket))setNotice(reconcile?'已核对原租约状态，没有自动重试模型。':'本次推进结果已保存，请查看方案或恢复提示。');
  }catch(cause){if(latest(key,ticket))setError((cause as Error).message+' 本次结果待核对；先读取原任务，不自动再调用模型。');}finally{end(key,ticket);}
 }
 async function apply(){
  if(!canApply||!plan||!source||busy)return;const key=identity,selected=source,id=plan.id,proposalHash=plan.proposalHash,ticket=start('apply');setPendingAction('apply');
  try{const service=await props.api<{id:string;currentVersion?:{id:string;configHash:string}}>('/data-services/agent/plans/'+id+'/apply',{proposalHash}),value=await props.api('/data-services/agent/plans/'+id);
   if(!latest(key,ticket))return;const next=checkedPrivateServicePlan(value,selected,props.binding);
   if(next.status!=='APPLIED'||next.serviceId!==service.id||next.appliedVersionId!==service.currentVersion?.id||next.appliedConfigHash!==service.currentVersion?.configHash)throw Error('原草稿回执与任务版本未对应');
   accept(next,selected,key,undefined,ticket);await props.onApplied(service.id);if(latest(key,ticket))setNotice('原草稿已创建；当前窗口不包含测试、发布或调用凭证。');
  }catch(cause){if(latest(key,ticket))setError((cause as Error).message+' 请读取原任务；原方案和幂等草稿保留，不另建资源。');}finally{end(key,ticket);}
 }
 async function cancel(){
  if(!plan||!source||!props.canAct||busy&&!['advance','read'].includes(busy)||terminal.has(plan.status))return;const key=identity,selected=source,id=plan.id,ticket=start('cancel');setPendingAction('cancel');
  try{const value=await props.api('/data-services/agent/plans/'+id+'/cancel',{sourceBoundOnly:true}),next=accept(value,selected,key,undefined,ticket);if(next&&latest(key,ticket))setNotice(next.status==='CANCELLED'?'后续规划已停止；历史尝试与保守预留保留。':'原步骤已经结束；未改变既有方案或草稿，请查看原任务。');}
  catch(cause){if(latest(key,ticket))setError((cause as Error).message+' 可读取原任务确认取消结果。');}finally{end(key,ticket);}
 }
 function newPlan(){if(!plan||!terminal.has(plan.status)||busy||pendingRequest||!source||!writeWindow)return;setPlan(undefined);setReviewed(false);setConfirmRetry(false);setPendingAction(undefined);setError('');setNotice('原规划仍在记录中；新需求会保存为另一个任务。');controller.current?.close();controller.current=undefined;
  if(href())history.replaceState(null,'',servicePlanLocation(href()!,{batchId:source.sourceReleaseRunId}));}
 return <section className="service-agent-studio private-service-studio" aria-label="持久私有服务规划">
  <header><div className="service-agent-icon"><Bot size={20}/></div><div><span className="eyebrow">DATA AGENT · SERVICE DESIGN</span><h3>把发布结果变成接口方案</h3><p>保存需求后明确开始规划；审阅指定方案再确认草稿。</p></div><span className="pill"><ShieldCheck size={13}/> 私有规划</span></header>
  <div className="private-service-steps" aria-label="规划步骤">{['保存任务','模型规划','确认草稿'].map((label,index)=><span key={label} className={index===0&&plan||index===1&&['SUCCEEDED','APPLIED'].includes(plan?.status??'')||index===2&&plan?.status==='APPLIED'?'done':index===1&&plan&&plan.attempts.length>0||index===2&&plan?.status==='SUCCEEDED'?'active':''}>{index+1} · {label}</span>)}</div>
  {contextInfo&&!plan&&<div className="private-service-source"><strong>{contextInfo.sourceContext.name}</strong><p>{contextInfo.sourceContext.definition}</p><small>当前批次可用DAPI：{contextInfo.services.length} 个。字段含义与发布包一致。</small><details><summary>查看字段口径与候选版本</summary>{Object.entries(contextInfo.sourceContext.metricLabels).map(([field,label])=><p key={field}>{label} · <code>{field}</code></p>)}{contextInfo.services.map(service=><p key={service.id}>{service.name} · 固定版本 {service.publishedVersion.id.slice(0,8)}</p>)}</details></div>}
  {!sourceAvailable&&<p className="service-feedback" role="status">当前来源尚未通过核对。原记录仍可读取或取消；创建、模型推进和草稿确认保持关闭。<button className="button" disabled={!!busy} onClick={()=>void props.onRefreshSource().catch(()=>{})}>重新核对来源</button></p>}
  {!props.transportEnabled&&<p className="service-context-boundary">此通道未开放新规划步骤；可读取原记录，有取消权限时可停止后续规划。</p>}
  {props.transportEnabled&&sourceAvailable&&!writeWindow&&<p className="service-context-boundary">{windowReason}原窗口记录与用量保留，不会因切换来源清零。</p>}
  {props.access?.expiresAt&&<p className="service-context-boundary">窗口截止：{new Date(props.access.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）。仅规划与草稿确认，经典测试、发布和凭证保持关闭。</p>}
  <div className="private-service-layout"><div className="private-service-composer"><label>接口需求<textarea aria-label="私有服务规划需求" value={message} maxLength={2000} rows={4} readOnly={Boolean(plan||pendingRequest)} disabled={!!busy} onChange={event=>setMessage(event.target.value)}/></label><small>{message.length}/2000 · 仅使用本项目虚构证券案例</small>
   <div className="private-service-actions"><button className="button primary" disabled={!canSave||!!busy||message.trim().length<4} onClick={()=>void save()}>{busy==='save'?<LoaderCircle className="spin" size={15}/>:<CheckCircle2 size={15}/>}保存规划任务</button>{plan&&terminal.has(plan.status)&&<button className="button" disabled={!writeWindow||!!busy||Boolean(pendingRequest)||windowTasks>=Number(props.access?.maxPlans??0)} onClick={newPlan}>新建规划</button>}</div>
   {!props.modelConfigured&&<p>模型尚未配置；可以在有效窗口先保存任务，配置就绪后再明确推进。</p>}
   {props.access?.maxPlans&&windowOpen&&<small>{historyState==='READY'?`当前窗口已保存 ${windowTasks}/${props.access.maxPlans} 个任务，服务端会重新核对额度。`:historyState==='LOADING'?'正在读取当前窗口任务数…':'当前窗口任务数未确认，创建保持关闭。'}</small>}
   {pendingRequest&&<div className="service-feedback" role="status"><strong>原提交结果待确认</strong><p>请求编号 {pendingRequest}。查询只读取，不调用模型。</p><button className="button" disabled={!!busy||!source} onClick={()=>void readOriginal()}>查询原提交</button>{controller.current?.snapshot().canRetry&&<button className="button" disabled={!writeWindow||!!busy||!sourceAvailable} onClick={()=>void readOriginal(undefined,true)}>核对后重试原保存</button>}</div>}
   {plans.length>0&&<details className="private-service-history"><summary>此来源的本人规划记录（{plans.length}）</summary>{plans.map(item=><button className="button" key={item.id} disabled={!!busy||Boolean(pendingRequest)} onClick={()=>void readOriginal(item.id)}>{item.proposal?.name??item.message.slice(0,24)} · {privatePlanStageText[item.stage]}</button>)}</details>}
  </div><div className="private-service-task" aria-live="polite">{plan?<><div className="private-service-task-heading"><span className={['SUCCEEDED','APPLIED'].includes(plan.status)?'pill success':'pill'}>{busy==='advance'?'已请求推进 · 等待结果':busy==='cancel'?'正在取消原任务':pendingAction&&!busy?'操作结果待核对':privatePlanStageText[plan.stage]}</span><small>任务 {plan.id.slice(0,8)} · 最新已知版本 {plan.version}</small></div>
   <div className="private-service-quota"><div><strong>{plan.quota.attemptsUsed}<small>/{plan.quota.attemptLimit}</small></strong><span>原窗口模型尝试</span></div><div><strong>{plan.quota.usedTokens.toLocaleString()}<small>/{plan.quota.tokenLimit.toLocaleString()}</small></strong><span>窗口已用／保守预留 Token</span></div></div>
   <small>{busy?'用量为最近确认的检查点，响应或读取后更新。':''}包含未确认与发送前停止的尝试。Token 预留不是已扣费账单；实际推进还受费用、权限和来源门约束。</small>
   <p><strong>{plan.sourceContext.name}</strong><br/>{plan.sourceContext.definition}</p><small>{plan.sourceKind==='MANUAL'?'工程师人工来源 · 不计 Agent 自主完成':'Agent发布来源'} · 模型 {plan.requestedModel}</small>
   {(!sourceAvailable||plan.sourceCheck==='UNAVAILABLE')&&<p role="status">原来源待复核；此处为历史口径，只读与取消可用。</p>}
   {!currentWindow&&<p>原任务不属于当前执行窗口，不能借新窗口继续调用或应用。</p>}
   {plan.stage==='MODEL_IN_FLIGHT'&&<p><Clock3 size={14}/> {plan.recovery.leaseExpired?'原租约已到期，需核对中断状态；不会自动重试。':'正在等待原模型步骤，刷新后仍按此任务恢复。'}</p>}
   {plan.stage==='MODEL_OUTCOME_UNKNOWN'&&<div className="private-service-warning"><strong>上次调用可能已经收费</strong><p>结果未确认，次数和保守用量保留。先读取原任务，确认仍需重试后再继续。</p><label><input type="checkbox" checked={confirmRetry} disabled={!!busy||!canAdvance} onChange={event=>setConfirmRetry(event.target.checked)}/>我确认在剩余额度内重试这次未知结果</label></div>}
   {plan.stage==='MODEL_NOT_SENT'&&<p>上次在发送前停止，没有确认发起模型请求；历史尝试和保守预留保留，先处理配置或预算原因。</p>}
   {plan.error&&<p role={plan.status==='FAILED'?'alert':'status'}>{plan.error}</p>}
   <div className="private-service-actions">{['READY_FOR_MODEL','MODEL_NOT_SENT','MODEL_OUTCOME_UNKNOWN'].includes(plan.stage)&&<button className="button primary" disabled={!canAdvance||!!busy||plan.stage==='MODEL_OUTCOME_UNKNOWN'&&!confirmRetry} onClick={()=>void advance()}>{busy==='advance'?<LoaderCircle className="spin" size={15}/>:<Play size={15}/>} {plan.stage==='MODEL_OUTCOME_UNKNOWN'?'确认重试模型':plan.stage==='MODEL_NOT_SENT'?'明确继续原任务':'开始模型规划'}</button>}
    {plan.recovery.leaseExpired&&<button className="button" disabled={!props.planningEnabled||!props.canAct||!!busy} onClick={()=>void advance(true)}>核对中断状态</button>}
    <button className="button" disabled={!!busy||Boolean(pendingRequest)} onClick={()=>void readOriginal(plan.id)}><RefreshCw size={14}/>读取原任务</button>
    {!terminal.has(plan.status)&&<button className="button" disabled={!props.canAct||Boolean(busy&&!['advance','read'].includes(busy))} onClick={()=>void cancel()}><Square size={14}/>取消后续规划</button>}</div>
   {pendingAction&&<p role="status">{busy?'正在处理原任务。':'上次操作结果待核对，请先读取原任务，不会自动重发。'}</p>}
   {plan.proposal&&<div className="service-agent-plan"><h4>{plan.proposal.name} <small>{plan.proposal.serviceType}</small></h4><code>/{plan.proposal.slug}</code><p>{plan.explanation}</p>
    {plan.proposal.serviceType==='DAPI'?<p>返回字段：{plan.proposal.fields?.map(field=>plan.sourceContext.metricLabels[field]).join('、')}</p>:<ul>{plan.proposal.steps?.map(step=><li key={step.alias}>{step.alias} → DAPI {step.dapiId.slice(0,8)} · 固定版本 {step.dapiVersionId.slice(0,8)}</li>)}</ul>}
    <small>超时 {plan.proposal.timeoutMs}ms · 限流 {plan.proposal.rateLimitPerMinute}/分钟 · 方案摘要 {plan.proposalHash?.slice(0,12)}</small>
    {plan.status==='SUCCEEDED'&&<><label className="private-service-review"><input type="checkbox" checked={reviewed} disabled={!!busy||!writeWindow||!currentWindow||!sourceAvailable||plan.sourceCheck==='UNAVAILABLE'||Boolean(pendingAction)} onChange={event=>setReviewed(event.target.checked)}/>我已审阅该方案和固定版本，确认仅创建此摘要对应的草稿</label><button className="button primary" disabled={!canApply||!!busy} onClick={()=>void apply()}>{busy==='apply'?<LoaderCircle className="spin" size={15}/>:<ShieldCheck size={15}/>}确认创建原草稿</button></>}
    {plan.status==='APPLIED'&&<p className="service-feedback"><CheckCircle2 size={16}/>已创建草稿 {plan.serviceId?.slice(0,8)}。测试、发布和凭证不在本次规划窗口内。</p>}</div>}
   <details><summary>查看尝试与原来源</summary><p>任务 {plan.id} · 请求 {plan.requestId}</p><p>批次 {plan.sourceBinding.sourceReleaseRunId}</p>{plan.attempts.map(a=><p key={a.attempt}>第{a.attempt}次 · {a.status==='MODEL_NOT_SENT'?'发送前停止':a.status==='MODEL_OUTCOME_UNKNOWN'?'结果未知':a.status==='MODEL_IN_FLIGHT'?'调用中':'模型已返回'} · {a.usage.total_tokens} Token{a.usageEstimated?'（保守预留）':''}{a.diagnostic?' · '+a.diagnostic.code:''}</p>)}</details>
  </>:<div className="private-service-empty"><Bot size={26}/><h4>{pendingRequest?'正在找回原提交':'规划从一条明确需求开始'}</h4><p>先保存任务，再明确开始。窗口与来源不满足时不会调用模型。</p>{historyState==='LOADING'&&source&&<small>正在读取此来源的本人记录…</small>}</div>}</div></div>
  {(error||notice)&&<div className={error?'service-feedback error':'service-feedback'} role={error?'alert':'status'}>{error||notice}</div>}
  <p className="service-context-boundary">当前为显式推进协议，不代表已安装云事件后台。任务、方案和草稿均绑定原来源；刷新与查询不会自动调用模型。</p>
 </section>;
}
