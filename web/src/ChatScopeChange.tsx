import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ArrowRight,GitBranch} from 'lucide-react';
import {checkedDerivedComparison,type DerivedResultComparison} from '../../src/v2/derived-comparison-client.mjs';
import {DerivedAmountReport} from './DerivedAmountComparison';
import {RunComparisonCode} from './RunComparisonCode';
import {acceptedChange,changeFromLocation,changeIsRunning,changeLocation,chooseStoredChange,readChanges,recommendedTarget,reviewChange,submitReviewedChange,
  type ChangeApi,type ChangeReview,type Changes,type ChatChange} from './chat-context-change';
import './chat-scope-change.css';

const states:Record<string,string>={QUEUED:'已排队',RUNNING:'运行中',SUCCEEDED:'已完成',FAILED:'失败',
  VALIDATION_FAILED:'断言未通过',INTERRUPTED:'已中断',CANCELLED:'已取消',NEEDS_CLARIFICATION:'等待口径确认'};
const ChatChangeDelivery=lazy(()=>import('./ChatChangeDelivery'));

function ChangeResult({api,history,change,canPrepare,isCurrent,onPin}:{api:ChangeApi;history:Changes;change:ChatChange;canPrepare?:boolean;isCurrent:()=>boolean;onPin:()=>void}){
  const [comparison,setComparison]=useState<DerivedResultComparison>(),[error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const b=history.binding,c=change;
  useEffect(()=>{
    setComparison(undefined);setError('');
    if(c.status!=='SUCCEEDED'||!c.revisionId||!c.runId||!c.revisionHash)return;
    let active=true;
    void (async()=>{
      try{
        const refs={taskId:c.taskId,parent:{taskId:b.taskId,revisionId:b.revisionId,revisionHash:b.revisionHash,runId:b.runId,contextId:b.contextId},
          child:{taskId:c.taskId,revisionId:c.revisionId,revisionHash:c.revisionHash,runId:c.runId,contextId:c.contextId}};
        const raw=await api('/agent/tasks/'+c.taskId+'/derivation-comparison');
        const value=checkedDerivedComparison(raw,refs);
        if(active)setComparison(value);
      }catch(cause){if(active)setError((cause as Error).message);}
    })();
    return()=>{active=false;};
  },[api,b.taskId,b.revisionId,b.revisionHash,b.runId,b.contextId,c.taskId,c.status,c.contextId,c.revisionId,c.revisionHash,c.runId,retry]);
  return <article className="chat-change-result" aria-label="口径变更结果">
    <header><strong>{history.targets.find(t=>t.id===c.contextId)?.name??c.contextId}</strong>
      <span role="status">{states[c.status]??c.status}</span></header>
    <p>{c.message}</p>
    <div className="chat-change-refs">
      <span>原 SQL 版本 <code title={b.revisionId}>{b.revisionId.slice(0,8)}</code></span>
      {c.revisionId&&<span>新 SQL 版本 <code title={c.revisionId}>{c.revisionId.slice(0,8)}</code></span>}
      <a className="button" href={'?module=agent-center&task='+encodeURIComponent(c.taskId)+'#agent-code'}>查看派生任务</a>
    </div>
    {comparison&&<section className="derived-amount-panel" aria-label="派生口径金额对照"><DerivedAmountReport report={comparison}/></section>}
    {comparison?.state==='MATCHED'&&<RunComparisonCode api={api} derived={comparison}/>}
    {comparison?.state==='MATCHED'&&canPrepare!==undefined&&<Suspense fallback={<p role="status">正在读取派生版本交付…</p>}>
      <ChatChangeDelivery api={api} intentId={b.intentId} changeRequestId={c.requestId} parent={comparison.parent} child={comparison.child}
        canPrepare={canPrepare} isCurrent={isCurrent} onPin={onPin}/>
    </Suspense>}
    {error&&<p role="alert">{error} <button className="button" onClick={()=>setRetry(n=>n+1)}>刷新金额对照</button></p>}
    {c.status==='SUCCEEDED'&&!comparison&&!error&&<p role="status">{c.revisionId&&c.runId&&c.revisionHash?'正在读取已保存的两次运行…':'新版本与批次仍待核对。'}</p>}
  </article>;
}

type Props={api:ChangeApi;intentId:string;taskId:string;canSubmit:boolean;canPrepare?:boolean;isCurrent:()=>boolean};
export default function ChatScopeChange({api,intentId,taskId,canSubmit,canPrepare,isCurrent}:Props) {
  const [history,setHistory]=useState<Changes>(),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const [selected,setSelected]=useState(()=>typeof location==='undefined'?undefined:changeFromLocation(location.href,intentId));
  const [target,setTarget]=useState(''),[message,setMessage]=useState('');
  const [review,setReview]=useState<ChangeReview>(),[working,setWorking]=useState(false),[notice,setNotice]=useState('');
  const [unknown,setUnknown]=useState(false);
  const live=useRef(false),sending=useRef(false),readEpoch=useRef(0);
  const writeAccess=useRef(canSubmit);
  writeAccess.current=canSubmit;
  const current=()=>live.current&&isCurrent();
  function selectChange(requestId:string) {
    if(!current())return;
    setSelected(requestId);
    window.history.replaceState(null,'',changeLocation(location.href,intentId,requestId));
  }
  const running=history?.changes.some(c=>changeIsRunning(c.status));
  async function load(){
    const ticket=++readEpoch.current;
    try{
      const result=await readChanges(api,intentId,taskId);
      if(!live.current||ticket!==readEpoch.current)return;
      setHistory(result);setError('');
      setTarget(value=>result.targets.some(t=>t.id===value)?value:recommendedTarget(result.targets));
      return result;
    }catch(cause){
      if(live.current&&ticket===readEpoch.current){setError((cause as Error).message);setHistory(undefined);}
    }
  }
  useEffect(()=>{
    live.current=true;void load();
    return()=>{live.current=false;readEpoch.current++;};
  },[api,intentId,taskId,retry]);
  useEffect(()=>{
    if(!running||working||error)return;
    const timer=setTimeout(()=>void load(),2300);
    return()=>clearTimeout(timer);
  },[history,running,working,error]);
  function prepare(){
    if(!history||!canSubmit||sending.current)return;
    try{setReview(reviewChange(history,target,message));setUnknown(false);setNotice('');}
    catch(cause){setNotice((cause as Error).message);}
  }
  async function reconcile(original:ChangeReview) {
    const result=await load();
    if(!result||!live.current)return false;
    const accepted=acceptedChange(result,original);
    if(accepted){
      selectChange(accepted.requestId);setReview(undefined);setMessage('');setUnknown(false);setNotice('');
      return true;
    }
    return false;
  }
  async function confirm(){
    if(!canSubmit||!review||sending.current)return;
    sending.current=true;setWorking(true);setNotice('');setUnknown(false);
    let failure='',started=false;
    try{
      try{await submitReviewedChange(api,review,()=>current()&&writeAccess.current,()=>{started=true;});}catch(cause){failure=(cause as Error).message;}
      if(failure&&!started&&!unknown){
        if(current()){await load();if(current()){setReview(undefined);setNotice(failure);}}
        return;
      }
      if(current()&&!await reconcile(review)&&current()){
        setUnknown(true);setNotice(failure||'提交回执待核对，请查询原请求。');
      }
    }catch(cause){if(current()){setUnknown(true);setNotice((cause as Error).message);}}
    finally{sending.current=false;if(current())setWorking(false);}
  }
  const chosen=history&&chooseStoredChange(history.changes,selected);
  const missingSelection=Boolean(history&&selected!==undefined&&!chosen);
  const canCreate=canSubmit&&!missingSelection&&Boolean(history?.eligible&&history.nextRequestId);
  const safeRetry=unknown&&Boolean(review&&history?.nextRequestId===review.requestId&&!history.changes.some(c=>c.requestId===review.requestId));
  return <section className="chat-scope-change" aria-label="在原对话修改业务口径">
    <header><GitBranch size={16}/><h3>{review?'审阅口径变更':chosen?'口径变更记录':'修改业务口径'}</h3></header>
    {error&&<p role="alert">{error} <button className="button" onClick={()=>setRetry(n=>n+1)}>重新读取变更记录</button></p>}
    {!history&&!error&&<p role="status">正在核对原版本和已登记的变更…</p>}
    {history&&<>
      {missingSelection&&<p role="alert">此对话中未找到链接指定的变更。 <button type="button" className="button" onClick={()=>{
        const url=new URL(location.href);url.searchParams.delete('chat_change');
        window.history.replaceState(null,'',url);setSelected(undefined);
      }}>回到当前会话</button></p>}
      {!review&&(history.changes.length>1||missingSelection&&history.changes.length>0)&&<label>已提交的变更<select aria-label="已提交的变更" value={chosen?.requestId??''} onChange={e=>selectChange(e.target.value)}>
        {!chosen&&<option value="" disabled>选择一项变更</option>}
        {history.changes.map((c,i)=><option key={c.requestId} value={c.requestId}>{i+1} · {c.message}</option>)}</select></label>}
      {chosen&&!review&&<ChangeResult key={[history.binding.runId,history.binding.revisionHash,chosen.requestId,chosen.status,chosen.revisionId,chosen.runId,chosen.revisionHash].join(':')} api={api}
        history={history} change={chosen} canPrepare={canPrepare} isCurrent={isCurrent} onPin={()=>selectChange(chosen.requestId)}/>}
      {review?<section className="chat-change-review" aria-label="审阅口径变更">
        <p>{review.message}</p>
        <dl><dt>原口径</dt><dd>{review.source.name} · 版本 <code>{review.binding.revisionId.slice(0,8)}</code> · 批次 <code>{review.binding.runId.slice(0,8)}</code></dd>
          <dt>目标口径</dt><dd><strong>{review.target.name}</strong><p>{review.target.definition}</p></dd></dl>
        {!review.target.recommended&&<p>此次同时变更测试场景，金额差异可能来自业务数据变化。</p>}
        <p>确认后，Agent 会从原 SQL 创建独立任务，调用模型并执行 Spark 校验。</p>
        {unknown&&<button className="button" disabled={working} onClick={async()=>{try{if(!await reconcile(review)&&current())setNotice('已核对原请求。请依据当前变更记录继续。');}catch(cause){if(current())setNotice((cause as Error).message);}}}>查询原请求</button>}
        <div className="chat-change-buttons">
          <button className="button" disabled={!canCreate||working||unknown&&!safeRetry} onClick={()=>void confirm()}>{working?'正在核对并提交…':unknown?'按原请求重试':'确认修改并运行'}</button>
          {(!unknown||history.changes.some(c=>c.requestId===review.requestId))&&<button className="button" disabled={working} onClick={()=>{setReview(undefined);setUnknown(false);setNotice('');}}>返回修改</button>}
        </div>
      </section>:canCreate?<form className="chat-change-form" onSubmit={event=>{event.preventDefault();prepare();}}>
        {chosen&&<p>本次修改从原口径「{history.source.name}」的版本 <code>{history.binding.revisionId.slice(0,8)}</code> 开始。</p>}
        <label>修改需求<textarea aria-label="描述口径修改需求" value={message} maxLength={2000} placeholder="例如，改成只算股票持仓和现金，保留只有现金的客户。" onChange={e=>setMessage(e.target.value)}/></label>
        <label>目标口径<select aria-label="目标业务口径" value={target} onChange={e=>setTarget(e.target.value)}>
          <option value="">选择已登记口径</option>{history.targets.map(t=><option key={t.id} value={t.id}>{t.name}{t.recommended?'（同一测试场景）':''}</option>)}
        </select></label>
        <button className="button" disabled={!target||message.trim().length<4} type="submit">审阅口径变更<ArrowRight size={14}/></button>
      </form>:!chosen&&!missingSelection&&<p role="status">{history.reason??(canSubmit?'当前没有可提交的目标口径。':'当前会话可查看已保存的口径变更。')}</p>}
    </>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
