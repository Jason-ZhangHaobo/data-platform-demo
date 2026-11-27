import{publishedReportSource,publishedReportMetrics,reportRequestId}from'../../src/v2/published-report-request.mjs';
import {matchesCustomerAnalysisProposal} from '../../src/v2/customer-analysis-plan-contract.mjs';
import{checkedPublishedReportReceipt}from'../../src/v2/published-report-client.mjs';
import{reportChatReplyKey}from'../../src/v2/report-clarification-contract.mjs';
import type{PublishedReportBinding}from'../../src/v2/published-report-request.mjs';
import type{PublishedReportReceipt}from'../../src/v2/published-report-client.mjs';
export type SourceReportPlan={id:string;requestId:string;status:string;planMode:'PUBLISHED_SOURCE_REPORT_V1';message:string;sourceBinding:PublishedReportBinding;sourceEvidenceHash:string;contextHash:string;proposalHash?:string;proposal?:{kind:'PUBLISHED_REPORT'|'CLARIFICATION_REQUIRED';name?:string;metricIds?:string[];widgets?:{id:string;title:string}[];customerAnalysis?:{kind:'MYSQL_HOLDINGS_CUSTOMER_ANALYSIS';metricIds:string[]};question?:string};model?:string;planningMode?:string;error?:string;explanation?:string;reportCreation?:PublishedReportReceipt;requestBasisState?:'VERIFIED'|'UNCONFIRMED';originPlanId?:string;derivationKind?:string;clarification?:{protocol:string;rootPlanId:string;originalRequest:string;sourceBinding:PublishedReportBinding;contextHash:string;depth:number;digest:string;turns:{planId:string;requestId:string;parentDigest:string;question:string;answer:string;model:string;usage:unknown;usageEstimated:boolean;usageUnknown:boolean;planningMode:string}[]};executionMode?:string;providerPhase?:'NOT_STARTED'|'STARTED'|'RECORDED';usageEstimated?:boolean;usageUnknown?:boolean;recovery?:{state:'RESUMABLE_NOT_STARTED'|'MODEL_RESULT_UNKNOWN';canResume:boolean;automaticRetry:false}};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function checkedSourceReportPlan(value:unknown,source:PublishedReportBinding,requestId?:string):SourceReportPlan{
 const bad=():never=>{throw Error('同源报表方案的原请求、来源或指标尚未确认；未执行报表');};
 if(!value||typeof value!=='object'||Array.isArray(value))bad();const p=value as SourceReportPlan;
 try{reportRequestId(p.id);if(JSON.stringify(publishedReportSource(p.sourceBinding))!==JSON.stringify(publishedReportSource(source)))bad();}catch{bad();}
 if(p.planMode!=='PUBLISHED_SOURCE_REPORT_V1'||typeof p.requestId!=='string'||requestId&&p.requestId!==requestId||typeof p.message!=='string'||!hash(p.sourceEvidenceHash)||!hash(p.contextHash)||!['QUEUED','RUNNING','SUCCEEDED','NEEDS_CLARIFICATION','FAILED','CANCELLED','INTERRUPTED','APPLYING','APPLIED'].includes(p.status))bad();
 if(p.requestBasisState!==undefined&&!['VERIFIED','UNCONFIRMED'].includes(p.requestBasisState))bad();
 if(p.clarification!==undefined||p.originPlanId!==undefined||p.derivationKind!==undefined){const c=p.clarification;if(!c||!Array.isArray(c.turns)||!c.turns.length)return bad();const last=c.turns.at(-1);if(p.derivationKind!=='REPORT_CLARIFICATION_V1'||!c||c.protocol!=='shuduo-report-clarification/v1'||!hash(c.digest)||!Number.isInteger(c.depth)||c.depth<1||c.depth>3||c.turns.length!==c.depth||c.rootPlanId!==c.turns[0].planId||typeof c.originalRequest!=='string'||c.originalRequest.length<4||c.originalRequest.length>2000||c.contextHash!==p.contextHash||JSON.stringify(publishedReportSource(c.sourceBinding))!==JSON.stringify(publishedReportSource(source))||!last||last.planId!==p.originPlanId||last.answer!==p.message||c.turns.some(t=>!hash(t.parentDigest)||typeof t.question!=='string'||t.question.length<4||t.question.length>300||typeof t.answer!=='string'||!t.answer.trim()||t.answer.length>1000))bad();try{reportRequestId(c.rootPlanId);for(const t of c.turns)reportRequestId(t.planId);}catch{bad();}}
 if(p.recovery&&(p.recovery.automaticRetry!==false||!['RESUMABLE_NOT_STARTED','MODEL_RESULT_UNKNOWN'].includes(p.recovery.state)||p.recovery.canResume!==(p.recovery.state==='RESUMABLE_NOT_STARTED')||p.recovery.canResume&&p.status!=='INTERRUPTED'||p.recovery.state==='MODEL_RESULT_UNKNOWN'&&p.usageUnknown!==true))bad();
 if(['SUCCEEDED','APPLYING','APPLIED','NEEDS_CLARIFICATION'].includes(p.status)){
  if(p.executionMode==='SOURCE_BOUND_REPORT_AGENT_V1'&&p.providerPhase!=='RECORDED')bad();
  if(!hash(p.proposalHash)||!p.proposal)bad();
  if(p.status==='NEEDS_CLARIFICATION'){if(p.proposal!.kind!=='CLARIFICATION_REQUIRED'||typeof p.proposal!.question!=='string')bad();}
  else {
   const proposal=p.proposal!;
   let ids:string[]=[];
   try{ids=publishedReportMetrics(proposal.metricIds);}catch{bad();}
   const widgets=proposal.widgets;
   if(proposal.kind!=='PUBLISHED_REPORT'||typeof proposal.name!=='string'||!Array.isArray(widgets)||
     widgets.some(w=>!w||!ids.includes(w.id)||typeof w.title!=='string'||!w.title.trim())||
     new Set(widgets.map(w=>w.id)).size!==widgets.length)bad();
   if(proposal.customerAnalysis===undefined){if(widgets!.length!==ids.length)bad();}
   else if(source.kind!=='AGENT'||!matchesCustomerAnalysisProposal(proposal))bad();
  }
 }
 if(p.status==='APPLIED')checkedPublishedReportReceipt(p.reportCreation,{requestId:p.id,source,name:p.proposal?.name,metricIds:p.proposal?.metricIds});
 return p;
}

// Start from the specialist recorded in the conversation's own handoff graph.
// Only follow answers sent in this chat, even if the same question was also
// answered in the specialist workbench. Recovery performs reads only.
export async function readChatReportPlan(
  client: {request: (path: string) => Promise<unknown>},
  {root, source}: {root: unknown; source: PublishedReportBinding},
): Promise<SourceReportPlan> {
  const first = checkedSourceReportPlan(root, source);
  const mismatch = () => Error('原报表会话的答复依据尚未核实，请重新读取原会话');
  if (first.requestBasisState !== 'VERIFIED' || first.clarification) throw mismatch();
  let current = first;
  while (current.status === 'NEEDS_CLARIFICATION' && (current.clarification?.depth ?? 0) < 3) {
    const key = reportChatReplyKey(current.id);
    let raw: unknown;
    try {
      raw = await client.request('/reports/agent/requests/' + key);
    } catch (error) {
      const read = error as {status?: number; code?: string} | null;
      if (read?.status === 404 && read.code === 'REPORT_PLAN_REQUEST_NOT_FOUND') return current;
      throw error;
    }
    const child = checkedSourceReportPlan(raw, source, key);
    const chain = child.clarification;
    const prior = current.clarification?.turns ?? [];
    const turn = chain?.turns.at(-1);
    if (child.requestBasisState !== 'VERIFIED' || child.originPlanId !== current.id ||
        child.contextHash !== first.contextHash || child.sourceEvidenceHash !== first.sourceEvidenceHash ||
        !chain || chain.rootPlanId !== first.id || chain.originalRequest !== first.message ||
        chain.depth !== prior.length + 1 || turn?.planId !== current.id ||
        turn.requestId !== current.requestId || turn.question !== current.proposal?.question ||
        chain.turns.some(t => t.planId === child.id) ||
        prior.some((t, i) => {
          const ancestor = chain.turns[i];
          return ancestor.planId !== t.planId || ancestor.requestId !== t.requestId ||
            ancestor.parentDigest !== t.parentDigest || ancestor.question !== t.question || ancestor.answer !== t.answer;
        })) throw mismatch();
    current = child;
  }
  return current;
}
