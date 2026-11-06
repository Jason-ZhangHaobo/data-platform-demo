import type {ValidationDetailsReport} from './validation-details';
import type {ServiceSourceBinding} from './service-source-binding';
import {deliveryFileGuide} from './delivery-presentation.ts';

export type Delivery = {id:string;version:number;status:string;stage:string;mode?:string;sourceKind?:string;packageId?:string;packageDigest?:string;verificationId?:string;sourceRevisionId?:string;sourceRunId?:string;error?:string};
export type Workflow = {
 report:{taskId:string;sourceKind?:string;agentIndependentE2E?:boolean;contextId?:string;validationContractId?:string;validationDetails?:ValidationDetailsReport;status:string;summary:string;definition?:string;checks:{id:string;label:string;passed:boolean}[];revisionId?:string;revisionHash?:string;runId?:string;rowCount:number;engine?:string;engineVersion?:string;notice:string};
 delivery?:Delivery;
 package?:{id:string;digest:string;manifest:unknown;files:Record<string,string>};
 verification?:{id:string;status:string;engine?:string;engineVersion?:string;mainSqlExecuted?:boolean;durationMs?:number;error?:string;testSqlValidation?:{passed:boolean};validation?:{passed:boolean;regressions?:{contextId:string;passed:boolean}[]}};
 publication:{available:boolean;scope:string;reason:string};
};
export type WorkflowSelection={taskId:string;contextId?:string;revisionId?:string;runId?:string;manual:boolean;expectedSourceBinding?:ServiceSourceBinding};
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const id=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown)=>typeof v==='string';
const optional=(v:unknown,check:(v:unknown)=>boolean)=>v===undefined||check(v);
const nonnegative=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const canonical=(v:unknown)=>JSON.stringify(v,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=async(v:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const bad=()=>Error('核验与交付回执的结构、原任务或版本关系未确认；保留原记录，重新读取，不自动计算或发布。');

// This checks the readable receipt and byte integrity, not execution, approval,
// a signature, or a replacement for the server's full deployment validation.
export async function checkedAgentWorkflow(value:unknown,selection:WorkflowSelection):Promise<Workflow>{
 if(!record(value)||!record(value.report)||!record(value.publication))throw bad();
 const r=value.report,p=value.publication,checks=r.checks;
 if(r.schema!=='shuduo-development-verification/v1'||r.taskId!==selection.taskId||!id(r.taskId)||typeof r.contextId!=='string'||!r.contextId||
  selection.contextId!==undefined&&r.contextId!==selection.contextId||!['PENDING','PASSED','NEEDS_ATTENTION'].includes(String(r.status))||
  ![r.summary,r.notice].every(text)||!nonnegative(r.rowCount)||!['definition','engine','engineVersion','validationContractId'].every(k=>optional(r[k],text))||
  !['revisionId','runId'].every(k=>optional(r[k],id))||!optional(r.revisionHash,hash)||
  !optional(r.sourceKind,v=>v==='AGENT'||v==='MANUAL')||!optional(r.agentIndependentE2E,v=>typeof v==='boolean')||
  !Array.isArray(checks)||!checks.every(c=>record(c)&&typeof c.id==='string'&&c.id&&typeof c.label==='string'&&typeof c.passed==='boolean')||
  new Set(checks.map(c=>c.id)).size!==checks.length||!['revision','execution','results','regressions'].every(k=>checks.some(c=>c.id===k))||
  typeof p.available!=='boolean'||!['LOCAL_TEST_RELEASE','PRIVATE_CLOUD_TEST'].includes(String(p.scope))||typeof p.reason!=='string')throw bad();
 if(r.status==='PASSED'&&(!id(r.revisionId)||!id(r.runId)||!hash(r.revisionHash)||r.engine!=='Apache Spark'||checks.some(c=>!c.passed)))throw bad();
 if(selection.manual?(r.sourceKind!=='MANUAL'||r.agentIndependentE2E!==false||r.runId!==selection.runId||r.revisionId!==selection.revisionId||p.scope!=='PRIVATE_CLOUD_TEST'||p.sourceKind!=='MANUAL'||p.sourceRunId!==selection.runId||p.agentIndependentE2E!==false):r.sourceKind==='MANUAL'||p.sourceKind==='MANUAL')throw bad();
 const frozen=selection.expectedSourceBinding;
 if(frozen&&(frozen.taskId!==r.taskId||frozen.revisionId!==r.revisionId||frozen.runId!==r.runId||(frozen.sourceKind==='MANUAL')!==selection.manual||
  (frozen.scope==='LOCAL_TEST_ONLY'?p.scope!=='LOCAL_TEST_RELEASE':p.scope!=='PRIVATE_CLOUD_TEST')))throw bad();
 const d=value.delivery,b=value.package,v=value.verification;
 if(d!==undefined){
  if(!record(d)||!id(d.id)||!Number.isSafeInteger(d.version)||Number(d.version)<1||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(String(d.status))||typeof d.stage!=='string'||!d.stage||
   !['mode','error'].every(k=>optional(d[k],text))||!['packageId','verificationId'].every(k=>optional(d[k],id))||!optional(d.packageDigest,hash)||
   !optional(d.sourceAgentTaskId,x=>x===r.taskId)||d.sourceRevisionId!==r.revisionId||d.sourceRunId!==r.runId||!id(d.sourceRevisionId)||!id(d.sourceRunId)||
   !optional(d.sourceSqlHash,x=>x===r.revisionHash)||(selection.manual?d.sourceKind!=='MANUAL':d.sourceKind==='MANUAL'))throw bad();
 }
 if(b!==undefined){
  if(!record(d)||!record(b)||!id(b.id)||!hash(b.digest)||d.packageId!==b.id||d.packageDigest!==b.digest||!record(b.manifest)||!record(b.files))throw bad();
  const manifest=b.manifest,source=manifest.source,names=deliveryFileGuide.map(f=>f.name).sort(),files=b.files,entries=manifest.files;
  if(manifest.format!=='shuduo-delivery/v1'||manifest.releaseState!=='NOT_PUBLISHED'||!record(source)||!record(entries)||
   source.runId!==r.runId||source.revisionId!==r.revisionId||source.contextId!==r.contextId||source.sqlHash!==r.revisionHash||source.validationContractId!==r.validationContractId||
   canonical(Object.keys(files).sort())!==canonical(names)||canonical(Object.keys(entries).sort())!==canonical(names)||
   frozen&&b.digest!==frozen.packageDigest)throw bad();
  const attribution=source.attribution;
  if(selection.manual?(!record(attribution)||attribution.kind!=='ENGINEER_ASSISTED'||attribution.originAgentTaskId!==selection.taskId||attribution.agentIndependentE2E!==false):attribution!==undefined)throw bad();
  let total=0;
  for(const name of names){const content=files[name],entry=entries[name];if(typeof content!=='string'||!record(entry))throw bad();const bytes=new TextEncoder().encode(content).length;total+=bytes;if(bytes>250000||entry.bytes!==bytes||entry.sha256!==await digest(content))throw bad();}
  if(total>750000||b.digest!==await digest(canonical(manifest))||source.sqlHash!==await digest(files['main.sql'] as string))throw bad();
 }
 if(record(d)&&(d.packageId!==undefined&&b===undefined||d.verificationId!==undefined&&v===undefined||d.status==='SUCCEEDED'&&(b===undefined||v===undefined)))throw bad();
 if(v!==undefined){
  if(!record(v)||!record(d)||!record(b)||!id(v.id)||v.id!==d.verificationId||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(String(v.status))||
   !['engine','engineVersion','error'].every(k=>optional(v[k],text))||!optional(v.mainSqlExecuted,x=>typeof x==='boolean')||!optional(v.durationMs,x=>typeof x==='number'&&Number.isFinite(x)&&x>=0)||
   v.testSqlValidation!==undefined&&(!record(v.testSqlValidation)||typeof v.testSqlValidation.passed!=='boolean')||
   v.validation!==undefined&&(!record(v.validation)||typeof v.validation.passed!=='boolean'||v.validation.regressions!==undefined&&(!Array.isArray(v.validation.regressions)||!v.validation.regressions.every(x=>record(x)&&typeof x.contextId==='string'&&typeof x.passed==='boolean'))))throw bad();
 }
 if(frozen&&!record(b))throw bad();
 return value as Workflow;
}
