import{ReportClarificationReply}from'./ReportClarificationReply';
import{useEffect,useRef,useState}from'react';
import{Bot,Send,CheckCircle2,RefreshCw,LoaderCircle}from'lucide-react';
import{publishedReportSource}from'../../src/v2/published-report-request.mjs';
import{checkedPublishedReportReceipt}from'../../src/v2/published-report-client.mjs';
import type{PublishedReportReceipt}from'../../src/v2/published-report-client.mjs';
import type{PublishedReportSource}from'./published-report-read';
import{checkedSourceReportPlan}from'./source-report-plan';
import type{SourceReportPlan}from'./source-report-plan';
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
export function PublishedReportAgent({api,source,canWrite,onCreated}:{api:Api;source:PublishedReportSource;canWrite:boolean;onCreated:(value:PublishedReportReceipt)=>void}){
 const selectionKey='shuduo:source-report-batch:v1:'+JSON.stringify([source.kind,source.taskId??'',source.releaseId,source.packageDigest,source.revisionId,source.runId]);
 const[message,setMessage]=useState('基于此发布结果的可用字段生成分析报表，保留原业务口径并说明缺失字段'),[batchId,setBatchId]=useState(()=>{try{const saved=localStorage.getItem(selectionKey);return saved&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(saved)?saved:source.batchIds[0];}catch{return source.batchIds[0];}}),[available,setAvailable]=useState(false),[plan,setPlan]=useState<SourceReportPlan>(),[pendingKey,setPendingKey]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const{batchIds,...base}=source,binding=publishedReportSource({...base,batchId}),key=JSON.stringify(binding),active=useRef(key),epoch=useRef(0),alive=useRef(true);active.current=key;
 const storage='shuduo:source-report-plan:v1:'+key;
 const[executionUnconfirmed,setExecutionUnconfirmed]=useState(false);
 const[history,setHistory]=useState<SourceReportPlan[]>(),[historyReading,setHistoryReading]=useState(false),[historyError,setHistoryError]=useState('');
 const readHistory=async()=>{if(historyReading)return;const current=key;setHistoryReading(true);setHistoryError('');try{const raw=await api<unknown>(`/reports/agent/plans?source_batch_id=${batchId}`);if(!Array.isArray(raw))throw Error('目录未确认');const rows=raw.slice(0,20).map(p=>checkedSourceReportPlan(p,binding));if(alive.current&&active.current===current)setHistory(rows);}catch(e){if(alive.current&&active.current===current)setHistoryError((e as Error).message);}finally{if(alive.current&&active.current===current)setHistoryReading(false);}};
 const selectHistory=async(id:string)=>{if(busy)return;const current=key;setBusy(true);try{const raw=await api(`/reports/agent/plans/${id}`);if(alive.current&&active.current===current){adopt(raw);setHistoryReady(true);setNotice('已读取所选原方案；输入框中的未发送文字保留，未调用模型。');}}catch(e){if(alive.current&&active.current===current){setExecutionUnconfirmed(true);setNotice((e as Error).message);}}finally{if(alive.current&&active.current===current)setBusy(false);}};
 const[historyReady,setHistoryReady]=useState(false),[missingOriginal,setMissingOriginal]=useState(false),[pendingMessage,setPendingMessage]=useState('');
 const adopt=(raw:unknown,requestId?:string)=>{const value=checkedSourceReportPlan(raw,binding,requestId);setPlan(value);setExecutionUnconfirmed(false);setPendingKey(value.requestId);try{localStorage.setItem(storage,JSON.stringify({requestId:value.requestId,message:value.message}));}catch{setNotice('本机未保存原方案，请保留服务端原方案编号；未重新规划。');}if(value.status==='APPLIED'&&value.reportCreation)onCreated(value.reportCreation);return value;};
 const query=async()=>{
  if(busy)return;const current=key;setBusy(true);setNotice('只读查询原方案，不重新调用模型');
  try{if(plan){const raw=await api(`/reports/agent/plans/${plan.id}`);if(alive.current&&active.current===current){adopt(raw,plan.requestId);setHistoryReady(true);setMissingOriginal(false);}}else if(pendingKey){const raw=await api(`/reports/agent/requests/${encodeURIComponent(pendingKey)}`);if(alive.current&&active.current===current){adopt(raw,pendingKey);setHistoryReady(true);setMissingOriginal(false);}}else{
   const rows=await api<unknown>(`/reports/agent/plans?source_batch_id=${batchId}`);if(!Array.isArray(rows))throw Error('方案目录回执未确认');if(alive.current&&active.current===current){if(rows[0])adopt(rows[0]);else setNotice('此批次尚无已有方案');setHistoryReady(true);}
  }}catch(e){if(alive.current&&active.current===current){setMissingOriginal(Boolean(pendingKey)&&(e as {status?:number}).status===404);setExecutionUnconfirmed((e as {status?:number}).status!==404);setNotice((e as Error).message);}}finally{if(alive.current&&active.current===current)setBusy(false);}
 };
 useEffect(()=>{
  alive.current=true;const sequence=++epoch.current;setPlan(undefined);setPendingKey('');setNotice('');setBusy(false);setExecutionUnconfirmed(false);setHistoryReady(false);setMissingOriginal(false);setPendingMessage('');setHistory(undefined);setHistoryError('');setHistoryReading(false);
  api<{reports?:{sourceBoundPlanningAvailable?:boolean}}>('/status').then(v=>{if(alive.current&&sequence===epoch.current)setAvailable(v.reports?.sourceBoundPlanningAvailable===true);}).catch(()=>{if(alive.current&&sequence===epoch.current)setAvailable(false);});
  (async()=>{try{const saved=localStorage.getItem(storage);if(saved){const p=JSON.parse(saved);if(typeof p.requestId!=='string'||typeof p.message!=='string')throw Error('原请求信息尚未确认');if(alive.current&&sequence===epoch.current){setPendingKey(p.requestId);setMessage(p.message);setPendingMessage(p.message);}const raw=await api(`/reports/agent/requests/${encodeURIComponent(p.requestId)}`);if(alive.current&&sequence===epoch.current){adopt(raw,p.requestId);setHistoryReady(true);}}else{
   const rows=await api<unknown>(`/reports/agent/plans?source_batch_id=${batchId}`);if(!Array.isArray(rows))throw Error('方案目录回执未确认');if(alive.current&&sequence===epoch.current){if(rows[0])adopt(rows[0]);setHistoryReady(true);}
  }}catch(e){if(alive.current&&sequence===epoch.current){setMissingOriginal((e as {status?:number}).status===404);setNotice(`原方案尚未确认：${(e as Error).message}。不会自动调用模型。`);}}})();
  try{const draft=localStorage.getItem(storage+':draft');if(typeof draft==='string')setMessage(draft);}catch{}
  return()=>{alive.current=false;epoch.current++;};
 },[key]);
 useEffect(()=>{if(!plan||!['QUEUED','RUNNING'].includes(plan.status))return;let reads=0,stopped=false;const current=key;
  const timer=setInterval(async()=>{if(stopped||++reads>30){clearInterval(timer);return;}try{const value=await api(`/reports/agent/plans/${plan.id}`);if(!stopped&&alive.current&&active.current===current)adopt(value,plan.requestId);}catch(e){if(!stopped)setNotice(`方案查询未确认：${(e as Error).message}。保留原编号。`);}},2500);
  return()=>{stopped=true;clearInterval(timer);};
 },[plan?.id,plan?.status,key]);
 const generate=async(retryOriginal=false)=>{
  if(!canWrite||!batchIds.includes(batchId)||!available||busy||executionUnconfirmed||Boolean(plan?.recovery)||plan?.requestBasisState==='UNCONFIRMED'||(!retryOriginal&&(!historyReady||pendingKey&&!plan))||retryOriginal&&(!missingOriginal||!pendingKey||pendingMessage.trim().length<4)||!retryOriginal&&message.trim().length<4||plan?.status==='APPLYING')return;const current=key,requestId=retryOriginal?pendingKey:crypto.randomUUID(),frozenMessage=retryOriginal?pendingMessage:message;setBusy(true);setNotice('');
  try{localStorage.setItem(storage,JSON.stringify({requestId,message:frozenMessage}));setPendingKey(requestId);setPendingMessage(frozenMessage);setMissingOriginal(false);const raw=await api('/reports/agent/plans',{message:frozenMessage,source:binding},{idempotencyKey:requestId});if(alive.current&&active.current===current){adopt(raw,requestId);setHistoryReady(true);}}catch(e){if(alive.current&&active.current===current)setNotice(`规划结果尚未确认：${(e as Error).message}。先查询原请求，不重新调用模型。`);}finally{if(alive.current&&active.current===current)setBusy(false);}
 };
 const apply=async()=>{
  if(!canWrite||!batchIds.includes(batchId)||busy||executionUnconfirmed||plan?.recovery||plan?.requestBasisState==='UNCONFIRMED'||!plan?.proposalHash)return;const original=plan,current=key;setBusy(true);setNotice('');
  try{const raw=await api(`/reports/agent/plans/${original.id}/apply`,{proposalHash:original.proposalHash});if(!alive.current||active.current!==current)return;
   const created=checkedPublishedReportReceipt(raw,{requestId:original.id,source:binding,name:original.proposal?.name,metricIds:original.proposal?.metricIds});
   const latest=await api(`/reports/agent/plans/${original.id}`);if(!alive.current||active.current!==current)return;adopt(latest,original.requestId);if(created.status==='SUCCEEDED'){setNotice('已按审阅方案实际生成报表，下方显示同源结果。');}else setNotice('中间结果已保存；查询后可继续原报表生成，不重复规划。');
  }catch(e){if(alive.current&&active.current===current){setExecutionUnconfirmed(true);setNotice(`生成结果尚未确认：${(e as Error).message}。请查询原方案后再续接。`);}}finally{if(alive.current&&active.current===current)setBusy(false);}
 };
 const recoveryBlocked=Boolean(plan?.recovery)||plan?.requestBasisState==='UNCONFIRMED';
 const resumePlanning=async()=>{if(!plan?.recovery?.canResume||!canWrite||!available||busy||executionUnconfirmed)return;const original=plan,current=key;setBusy(true);try{const raw=await api(`/reports/agent/plans/${original.id}/resume`,{});if(alive.current&&active.current===current)adopt(raw,original.requestId);}catch(e){if(alive.current&&active.current===current){setExecutionUnconfirmed(true);setNotice(`续接结果尚未确认：${(e as Error).message}。先查询原方案，不重复调用。`);}}finally{if(alive.current&&active.current===current)setBusy(false);}};
 const pending=plan&&['QUEUED','RUNNING'].includes(plan.status),canApply=plan&&['SUCCEEDED','APPLYING'].includes(plan.status)&&plan.proposal?.kind==='PUBLISHED_REPORT';
 return <section className="source-report-agent-v2" aria-label="同源报表Agent"><header className="agent-workflow-title"><Bot size={18}/><h4>把报告需求交给 Agent</h4><button className="button" disabled={busy} onClick={()=>void query()}><RefreshCw size={14}/>查询原方案</button></header>
  <p>仅提供此批次的字段、口径和摘要。模型先规划；审阅后才实际创建，不向模型发送客户或持仓行。</p>
  <label>报告来源<select aria-label="Agent报表来源批次" value={batchId} disabled={busy||executionUnconfirmed||Boolean(pending)||plan?.status==='APPLYING'} onChange={e=>{try{localStorage.setItem(selectionKey,e.target.value);}catch{}setBatchId(e.target.value);}}>{!batchIds.includes(batchId)&&<option value={batchId}>原批次未确认，请明确重选</option>}{batchIds.map(id=><option key={id} value={id}>已核验批次 {id.slice(0,8)}</option>)}</select></label>
  <textarea aria-label="报告需求" value={message} maxLength={2000} rows={2} disabled={!canWrite||busy||Boolean(pending)} onChange={e=>{setMessage(e.target.value);try{localStorage.setItem(storage+':draft',e.target.value);}catch{}}}/>
  <button className="button" onClick={()=>void generate()} disabled={!canWrite||!batchIds.includes(batchId)||!available||!historyReady||busy||executionUnconfirmed||recoveryBlocked||Boolean(pending)||Boolean(pendingKey&&!plan)||plan?.status==='APPLYING'||message.trim().length<4}>{busy||pending?<LoaderCircle size={14} className="spin"/>:<Send size={14}/>}生成报表方案{plan?'（新模型请求）':''}</button>
  {plan?.recovery?.state==='MODEL_RESULT_UNKNOWN'&&<p role="status">原模型调用结果未知，已保留用量预留；不会自动重试。请先核对原记录，不用新请求替代。</p>}
  {plan?.recovery?.canResume&&<><p role="status">原进程已中断，记录证明模型尚未调用；可继续同一规划，保留原编号与来源。</p><button className="button" disabled={!canWrite||!available||busy||executionUnconfirmed} onClick={()=>void resumePlanning()}>继续原规划（模型尚未调用）</button></>}
  {pending&&<button className="button" disabled={!canWrite||busy} onClick={async()=>{if(!plan)return;const current=key;setBusy(true);try{const raw=await api(`/reports/agent/plans/${plan.id}/cancel`,{});if(alive.current&&active.current===current)adopt(raw,plan.requestId);}catch(e){if(alive.current&&active.current===current)setNotice((e as Error).message);}finally{if(alive.current&&active.current===current)setBusy(false);}}}>停止规划，保留原请求</button>}
  {missingOriginal&&pendingKey&&<button className="button" disabled={!canWrite||!available||busy} onClick={()=>void generate(true)}>按原编号和原内容重试规划</button>}
  {!available&&<p>模型暂未连接；仍可手动创建同源报表，已有方案可以查询和审阅。</p>}
  <details className="source-report-history"><summary>当前批次的规划历史</summary><button className="button" disabled={historyReading||busy} onClick={()=>void readHistory()}>读取规划历史</button>{historyReading&&<p role="status">正在核对历史目录…</p>}{historyError&&<p role="status">{historyError}，未替换当前方案。</p>}{history?.map(p=><button className="button" key={p.id} disabled={busy} onClick={()=>void selectHistory(p.id)}>{p.proposal?.name??'报表规划'} · {p.id.slice(0,8)} · {p.status}</button>)}{history?.length===0&&<p>该批次暂无已确认规划记录。</p>}{history?.length===20&&<small>本页最多显示20条，可通过CLI/API按原编号查询。</small>}</details>
  {plan&&<div className="source-report-proposal-v2"><small>原方案 {plan.id.slice(0,8)} · {plan.status} · 模型 {plan.model??'处理中'} {plan.planningMode==='TEST_DOUBLE'?'· 合成规划器验收':''}</small><p>{plan.clarification?'本次回答':'原需求'}：{plan.message}</p>
   {plan.proposal?.kind==='CLARIFICATION_REQUIRED'?<><p role="status">{plan.proposal.question}</p><ReportClarificationReply key={plan.id} api={api} plan={plan} canWrite={canWrite&&!executionUnconfirmed&&plan.requestBasisState!=='UNCONFIRMED'} available={available} onContinue={value=>{adopt(value,value.requestId);setHistoryReady(true);setNotice('已保留原问题、回答和来源；后续方案独立核验与审阅。');}}/></>:<><h4>{plan.proposal?.name??'正在核对字段与指标'}</h4><ul>{plan.proposal?.widgets?.map(w=><li key={w.id}>{w.title}</li>)}</ul></>}
   {plan.clarification&&<details><summary>查看随此方案保留的澄清记录</summary><p>原需求：{plan.clarification.originalRequest}</p>{plan.clarification.turns.map((t,i)=><p key={t.planId}>第{i+1}轮：{t.question}<br/>回答：{t.answer}</p>)}</details>}{plan.requestBasisState==='UNCONFIRMED'&&<p role="status">原请求或澄清依据未确认；历史记录保留，当前不能继续模型或应用。</p>}
   <p>{plan.explanation??plan.error}</p>{plan.proposalHash&&<small>审阅摘要 {plan.proposalHash.slice(0,12)} · 仅当前固定来源</small>}
   {canApply&&<button className="button" disabled={!canWrite||!batchIds.includes(batchId)||busy||executionUnconfirmed||recoveryBlocked} onClick={()=>void apply()}><CheckCircle2 size={14}/>{plan.status==='APPLYING'?'继续原报表生成':'按此方案创建并核验报表'}</button>}{plan.status==='APPLIED'&&<p>此方案的报表已实际生成；查询不重新规划或聚合。</p>}
  </div>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
