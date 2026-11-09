import{publishedReportSource,publishedReportMetrics,reportRequestId}from'../../src/v2/published-report-request.mjs';
import{checkedPublishedReportReceipt}from'../../src/v2/published-report-client.mjs';
import type{PublishedReportBinding}from'../../src/v2/published-report-request.mjs';
import type{PublishedReportReceipt}from'../../src/v2/published-report-client.mjs';
export type SourceReportPlan={id:string;requestId:string;status:string;planMode:'PUBLISHED_SOURCE_REPORT_V1';message:string;sourceBinding:PublishedReportBinding;sourceEvidenceHash:string;contextHash:string;proposalHash?:string;proposal?:{kind:'PUBLISHED_REPORT'|'CLARIFICATION_REQUIRED';name?:string;metricIds?:string[];widgets?:{id:string;title:string}[];question?:string};model?:string;planningMode?:string;error?:string;explanation?:string;reportCreation?:PublishedReportReceipt};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function checkedSourceReportPlan(value:unknown,source:PublishedReportBinding,requestId?:string):SourceReportPlan{
 const bad=()=>{throw Error('同源报表方案的原请求、来源或指标尚未确认；未执行报表');};
 if(!value||typeof value!=='object'||Array.isArray(value))bad();const p=value as SourceReportPlan;
 try{reportRequestId(p.id);if(JSON.stringify(publishedReportSource(p.sourceBinding))!==JSON.stringify(publishedReportSource(source)))bad();}catch{bad();}
 if(p.planMode!=='PUBLISHED_SOURCE_REPORT_V1'||typeof p.requestId!=='string'||requestId&&p.requestId!==requestId||typeof p.message!=='string'||!hash(p.sourceEvidenceHash)||!hash(p.contextHash)||!['QUEUED','RUNNING','SUCCEEDED','NEEDS_CLARIFICATION','FAILED','CANCELLED','INTERRUPTED','APPLYING','APPLIED'].includes(p.status))bad();
 if(['SUCCEEDED','APPLYING','APPLIED','NEEDS_CLARIFICATION'].includes(p.status)){
  if(!hash(p.proposalHash)||!p.proposal)bad();
  if(p.status==='NEEDS_CLARIFICATION'){if(p.proposal!.kind!=='CLARIFICATION_REQUIRED'||typeof p.proposal!.question!=='string')bad();}
  else{let ids:string[]=[];try{ids=publishedReportMetrics(p.proposal!.metricIds);}catch{bad();}if(p.proposal!.kind!=='PUBLISHED_REPORT'||typeof p.proposal!.name!=='string'||!Array.isArray(p.proposal!.widgets)||p.proposal!.widgets.length!==ids.length||p.proposal!.widgets.some(w=>!ids.includes(w.id)||typeof w.title!=='string')||new Set(p.proposal!.widgets.map(w=>w.id)).size!==ids.length)bad();}
 }
 if(p.status==='APPLIED')checkedPublishedReportReceipt(p.reportCreation,{requestId:p.id,source,name:p.proposal?.name,metricIds:p.proposal?.metricIds});
 return p;
}
