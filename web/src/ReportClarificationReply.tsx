import {useEffect, useRef, useState} from 'react';
import {reportClarificationAnswer, reportClarificationDigest, reportClarificationRequestId} from '../../src/v2/report-clarification-contract.mjs';
import {checkedSourceReportPlan, type SourceReportPlan} from './source-report-plan';
import {publishedReportSource, type PublishedReportBinding} from '../../src/v2/published-report-request.mjs';

type Api = <T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type Source = {protocol:string;planId:string;evidenceDigest:string;question:string;originalRequest:string;sourceBinding:PublishedReportBinding;contextHash:string;depth:number;canReply:boolean;historicalCalls:number;knownTokens:number;unknownUsage:boolean};
type Pending = {requestId:string;evidenceDigest:string;answer?:string;answerDigest?:string};
type Props = {api:Api;plan:SourceReportPlan;canWrite:boolean;available:boolean;chatRequestId?:string;onContinue:(p:SourceReportPlan)=>void};
const answerHash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');

export function ReportClarificationReply({api,plan,canWrite,available,chatRequestId,onContinue}:Props){
  const [source,setSource]=useState<Source>(),[answer,setAnswer]=useState(''),[pending,setPending]=useState<Pending>(),[child,setChild]=useState<SourceReportPlan>();
  const [busy,setBusy]=useState(false),[missing,setMissing]=useState(false),[readError,setReadError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(true),inFlight=useRef(false);
  const key=chatRequestId?'shuduo:chat-report-answer:v1:'+chatRequestId:'shuduo:report-clarification:v1:'+plan.id;

  function checkedAnswerPlan(raw:unknown,p:Pending){
    const value=checkedSourceReportPlan(raw,plan.sourceBinding,p.requestId);
    if(value.originPlanId!==plan.id||value.contextHash!==plan.contextHash||
      value.clarification?.turns.at(-1)?.parentDigest!==p.evidenceDigest||value.requestBasisState==='UNCONFIRMED')
      throw Error('后续方案与原问题或回答不一致');
    return value;
  }
  const matchesAnswer=async(message:string,p:Pending)=>p.answer!==undefined?message===p.answer:await answerHash(message)===p.answerDigest;
  function isMissing(cause:unknown){
    const error=cause as {status?:number; code?:string};
    return error.status===404&&(!chatRequestId||error.code==='REPORT_PLAN_REQUEST_NOT_FOUND');
  }
  async function recover(p:Pending,advance:boolean,active:()=>boolean){
    try{
      const raw=await api('/reports/agent/requests/'+encodeURIComponent(p.requestId));
      const result=checkedAnswerPlan(raw,p);
      const matched=await matchesAnswer(result.message,p);
      if(!active())return;
      if(!matched&&!chatRequestId)throw Error('已登记回答与原内容不一致');
      setChild(result);setMissing(false);
      if(!matched){
        setNotice('此问题已有另一条回答。可以查看会话中已登记的方案。');
        return;
      }
      setAnswer(result.message);setNotice('已找回原回答和后续方案。');
      if(advance)onContinue(result);
    }catch(e){if(active()){setMissing(isMissing(e));setNotice(isMissing(e)?'原回答尚未登记，可以核对后按原内容重试。':`原回答尚待核对。${(e as Error).message}`);}}
  }
  useEffect(()=>{
    let active=true;live.current=true;
    (async()=>{try{
      const raw=await api<Source>(`/reports/agent/plans/${plan.id}/clarification`);
      if(raw.protocol!=='shuduo-report-clarification/v1'||raw.planId!==plan.id||raw.question!==plan.proposal?.question||!reportClarificationDigest(raw.evidenceDigest)||
        JSON.stringify(publishedReportSource(raw.sourceBinding))!==JSON.stringify(publishedReportSource(plan.sourceBinding))||raw.contextHash!==plan.contextHash||
        !Number.isInteger(raw.depth)||raw.depth<0||raw.depth>3||raw.canReply!==(raw.depth<3))throw Error('原问题依据未确认');
      if(!active)return;setSource(raw);
      let saved:string|null=null;
      try{saved=localStorage.getItem(key);}catch(e){if(!chatRequestId)throw e;}
      if(saved){
        const p=JSON.parse(saved) as Pending;
        if(!reportClarificationDigest(p.evidenceDigest)||p.evidenceDigest!==raw.evidenceDigest)throw Error('原问题摘要已经变化');
        reportClarificationRequestId(p.requestId);
        if(chatRequestId){if(p.requestId!==chatRequestId||!reportClarificationDigest(p.answerDigest)||p.answer!==undefined)throw Error('原回答编号或摘要未确认');}
        else reportClarificationAnswer(p.answer);
        setPending(p);if(p.answer)setAnswer(p.answer);
        await recover(p,Boolean(chatRequestId),()=>active);
      }else if(!chatRequestId){const draft=localStorage.getItem(key+':draft');if(draft!==null)setAnswer(draft);}
    }catch(e){if(active)setReadError((e as Error).message);}})();
    return()=>{active=false;live.current=false;};
  },[key]);
  async function lookup(){
    if(!pending||inFlight.current)return;inFlight.current=true;setBusy(true);setMissing(false);
    try{await recover(pending,Boolean(chatRequestId),()=>live.current);}finally{inFlight.current=false;if(live.current)setBusy(false);}
  }
  async function submit(original?:Pending){
    if(!source?.canReply||!canWrite||!available||inFlight.current||pending&&!original||readError||original&&!missing)return;
    inFlight.current=true;setBusy(true);setNotice('');
    try{
      const text=reportClarificationAnswer(original?.answer??answer);
      const digest=chatRequestId?await answerHash(text):undefined;
      if(!live.current)return;
      if(original&&(source.evidenceDigest!==original.evidenceDigest||digest!==original.answerDigest)){setNotice('请填写上次提交的原回答，再按原编号重试。');return;}
      const p:Pending=original??{requestId:chatRequestId??crypto.randomUUID(),evidenceDigest:source.evidenceDigest,...(digest?{answerDigest:digest}:{answer:text})};
      try{localStorage.setItem(key,JSON.stringify(p));}catch(e){if(!chatRequestId)throw e;}
      setPending(p);setMissing(false);
      const raw=await api(`/reports/agent/plans/${plan.id}/clarify`,{evidenceDigest:p.evidenceDigest,answer:text},{idempotencyKey:p.requestId});
      const result=checkedAnswerPlan(raw,p);
      if(!await matchesAnswer(result.message,p))throw Error('已登记的回答与提交内容不一致');
      if(live.current){setChild(result);onContinue(result);}
    }catch(e){if(live.current)setNotice(`回答结果尚未确认。${(e as Error).message}。请查询原回答。`);}
    finally{inFlight.current=false;if(live.current)setBusy(false);}
  }
  const canEdit=canWrite&&!busy&&(!pending||Boolean(chatRequestId&&missing));
  return <section className="report-clarification-reply" aria-label="回答原报表澄清问题">
    {!chatRequestId&&<><h5>回答后继续原来源</h5><p>原需求：{source?.originalRequest??'正在核对原需求…'}</p></>}
    {source&&!chatRequestId&&<small>已保留{source.historicalCalls}次历史调用、{source.knownTokens}个已记录Token{source.unknownUsage?'，另有未确认用量':''}。</small>}
    {readError&&<p role="alert">{readError}</p>}
    {source&&!source.canReply?<p role="status">三轮澄清已用完。请按已确认的口径提出新需求。</p>:<>
      <label>你的回答<textarea aria-label="报表澄清回答" value={answer} maxLength={1000} disabled={!canEdit} onChange={e=>{setAnswer(e.target.value);if(!chatRequestId)try{localStorage.setItem(key+':draft',e.target.value);}catch{}}}/></label>
      {!pending&&<button className="button" disabled={!canWrite||!available||!source?.canReply||busy||Boolean(readError)||!answer.trim()} onClick={()=>void submit()}>按此回答继续规划（新模型调用）</button>}
    </>}
    {pending&&<><button className="button" disabled={busy} onClick={()=>void lookup()}>查询原回答结果</button>{missing&&<button className="button" disabled={!canWrite||!available||busy||Boolean(readError)||!source?.canReply||!answer.trim()} onClick={()=>void submit(pending)}>按原编号和回答重试</button>}{child&&<button className="button" onClick={()=>onContinue(child)}>查看已创建后续方案</button>}</>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
