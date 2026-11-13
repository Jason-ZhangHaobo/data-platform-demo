import {distributionMetadataForContext} from '../../src/v2/output-contract-metadata.mjs';
import type {ValidationDetailsReport} from './validation-details';
import type {ServiceSourceBinding} from './service-source-binding';
import {deliveryFileGuide} from './delivery-presentation.ts';
import {checkedAssistedDevelopmentReference,sameAssistedDevelopmentReference} from '../../src/v2/assisted-development-reference.mjs';
import type {AssistedDevelopmentReference} from '../../src/v2/assisted-development-reference.mjs';
import {sqlRequirementProtocol,sqlRequirementReportMatches} from '../../src/v2/sql-requirement-contract.mjs';
import type {SqlRequirementReport} from '../../src/v2/sql-requirement-contract.mjs';
import type {FundExecutionBinding} from '../../src/v2/fund-preparation-client.mjs';

export type Delivery = {id:string;version:number;status:string;stage:string;mode?:string;sourceKind?:string;packageId?:string;packageDigest?:string;verificationId?:string;sourceRevisionId?:string;sourceRunId?:string;sourcePinned?:boolean;rehearsalPinned?:boolean;error?:string};
type PreparationSource = {revisionId:string;revisionHash:string;runId:string;requirementBinding?:{protocol:string;taskId:string;basisDigest:string;reportDigest:string}};
export type FundReviewBasis = {status:"READY";digest:string} | {status:"UNAVAILABLE"};
export type FileReview={id:string;status:"REVIEWED";packageId:string;packageDigest:string;verificationId:string;reviewedAt:string;scope:"LOCAL_FILE_REVIEW";fundRehearsalDigest?:string};
export type Workflow = {
 preparationSource?:PreparationSource;
 eventDrivenRehearsal?:true;
 fileReview?:FileReview;
 report:{developmentReference?:AssistedDevelopmentReference;taskId:string;sourceKind?:string;agentIndependentE2E?:boolean;contextId?:string;validationContractId?:string;validationDetails?:ValidationDetailsReport;status:string;summary:string;definition?:string;checks:{id:string;label:string;passed:boolean}[];revisionId?:string;revisionHash?:string;runId?:string;rowCount:number;engine?:string;engineVersion?:string;notice:string};
 delivery?:Delivery;
 package?:{id:string;digest:string;manifest:unknown;files:Record<string,string>};
 verification?:{id:string;status:string;engine?:string;engineVersion?:string;mainSqlExecuted?:boolean;durationMs?:number;error?:string;workerResult?:"CONFIRMED"|"PENDING";testSqlValidation?:{passed:boolean};validation?:{passed:boolean;regressions?:{contextId:string;passed:boolean}[]};fundReview?:FundReviewBasis};
 publication:{available:boolean;scope:string;reason:string};
};
export type WorkflowSelection={taskId:string;contextId?:string;revisionId?:string;runId?:string;manual:boolean;assisted?:boolean;expectedSourceBinding?:ServiceSourceBinding;fundPreparation?:FundExecutionBinding};
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const id=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown)=>typeof v==='string';
const optional=(v:unknown,check:(v:unknown)=>boolean)=>v===undefined||check(v);
const nonnegative=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const canonical=(v:unknown)=>JSON.stringify(v,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=async(v:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const bad=()=>Error('核验与交付回执的结构、原任务或版本关系未确认；保留原记录，重新读取，不自动计算或发布。');
export function exactDeliveryAdvance(workflow: Workflow | undefined, delivery: Delivery) {
 const expectedVersion = delivery.version;
 if ((!delivery.sourcePinned && !delivery.rehearsalPinned) || delivery.stage === "PACKAGE_PERSISTING") return {expectedVersion};
 const bundle = workflow?.package;
 if (!bundle || workflow.delivery?.id !== delivery.id || workflow.delivery.version !== expectedVersion ||
   bundle.id !== delivery.packageId || bundle.digest !== delivery.packageDigest || workflow.verification?.id !== delivery.verificationId) throw bad();
 return {expectedVersion,rehearsal:{packageId:bundle.id,packageDigest:bundle.digest,
   ...(delivery.verificationId ? {verificationId:delivery.verificationId} : {})}};
}

export type CloudPublicationPreflight = {reviewDigest:string;businessDate:string;businessScheduledFor:string;plannedBatchCount:2};
export async function checkedCloudPublicationPreflight(value:unknown, workflow:Workflow):Promise<CloudPublicationPreflight> {
 const {report,delivery,package:bundle,verification}=workflow;
 if(!delivery||!bundle||!verification||!record(bundle.manifest)||!record(bundle.manifest.files)||!record(bundle.manifest.source)||
  !record(value)||value.protocol!=="shuduo-cloud-publication-preflight/v1"||value.schedulerAvailable!==true||!hash(value.reviewDigest)||
  !record(value.basis)||!record(value.package))throw bad();
 const basis=value.basis, evidence=basis.evidence, source=bundle.manifest.source;
 if(basis.scope!=="PRIVATE_CLOUD_TEST"||basis.plannedBatchCount!==2||!record(evidence)||evidence.status!=="REVIEW_EVIDENCE_READY"||
  evidence.scope!==basis.scope||evidence.taskId!==report.taskId||evidence.deliveryId!==delivery.id||evidence.contextId!==report.contextId||
  evidence.validationContractId!==report.validationContractId||!hash(evidence.requestSha256)||
  canonical(evidence.requirementBinding)!==canonical(source.requirement)||!record(evidence.development)||
  evidence.development.revisionId!==report.revisionId||evidence.development.revisionHash!==report.revisionHash||evidence.development.runId!==report.runId||
  !record(evidence.delivery)||evidence.delivery.packageId!==bundle.id||evidence.delivery.packageDigest!==bundle.digest||
  evidence.delivery.verificationId!==verification.id||!record(evidence.delivery.fileHashes)||
  canonical(value.package)!==canonical({digest:bundle.digest,manifest:bundle.manifest,files:bundle.files}))throw bad();
 if(source.fundDevelopment!==undefined){
  const fund=evidence.fund, lookthrough=source.fundLookthrough;
  if(!record(fund)||!record(lookthrough)||fund.businessDate!==lookthrough.businessDate||fund.businessDate!==basis.businessDate||
     fund.modelMode!=="LIVE_MODEL"||canonical(fund.development)!==canonical(source.fundDevelopment)||
     !record(fund.rehearsal)||Object.keys(fund.rehearsal).length!==2||
     !hash(fund.rehearsal.jobDigest)||!hash(fund.rehearsal.resultDigest))throw bad();
 }else if(evidence.fund!==undefined)throw bad();
 const fileHashes=evidence.delivery.fileHashes, manifestFiles=bundle.manifest.files;
 if(Object.keys(fileHashes).length!==deliveryFileGuide.length||!deliveryFileGuide.every(({name})=>{
   const file=manifestFiles[name];return record(file)&&fileHashes[name]===file.sha256;
 }))throw bad();
 const schedule=JSON.parse(bundle.files['schedule.json']),calendar=JSON.parse(bundle.files['calendar.json']),fixtures=JSON.parse(bundle.files['fixtures.json']);
 const businessDate=fixtures.context?.businessDate, days=calendar.tradingDays;
 const index=Array.isArray(days)?days.indexOf(businessDate):-1;
 const businessScheduledFor=index>=0&&days[index+1]?`${days[index+1]}T${schedule.at}+08:00`:undefined;
 if(typeof businessDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)||!businessScheduledFor||
  !Number.isFinite(Date.parse(businessScheduledFor))||basis.businessDate!==businessDate||basis.businessScheduledFor!==businessScheduledFor||
  await digest(JSON.stringify(basis))!==value.reviewDigest)throw bad();
 return {reviewDigest:value.reviewDigest,businessDate,businessScheduledFor,plannedBatchCount:2};
}
export function frozenRequirementProposal(bundle:Workflow['package'],taskId:string):SqlRequirementReport|undefined{
 if(!bundle||!record(bundle.manifest)||!record(bundle.manifest.source))return;
 const source=bundle.manifest.source;let proof:unknown;
 try{proof=JSON.parse(bundle.files['validation.json']);}catch{throw bad();}
 if(!record(proof))throw bad();const report=proof.requirements,binding=source.requirement;
 if(report===undefined&&binding===undefined)return;
 if(!record(binding)||Object.keys(binding).length!==4||!['protocol','taskId','basisDigest','reportDigest'].every(k=>Object.hasOwn(binding,k))||
  binding.protocol!=='shuduo-sql-requirements/v1'||binding.taskId!==taskId||!hash(binding.basisDigest)||!hash(binding.reportDigest)||!record(report)||
  report.status!=='MODEL_PROPOSED'||report.contextId!==source.contextId||report.sqlHash!==source.sqlHash||report.revisionId!==source.revisionId||
  !sqlRequirementReportMatches(report,{id:taskId,contextId:String(source.contextId),message:String(report.request),revisionId:String(source.revisionId),
    humanClarified:report.humanClarified===true,directAutonomousEligible:report.directAutonomousEligible===false?false:undefined,clarificationOriginTaskId:typeof report.clarificationOriginTaskId==='string'?report.clarificationOriginTaskId:undefined,
    clarification:report.clarification,
    attempts:[{attempt:report.attempt,revisionId:source.revisionId,model:report.model}]})||report.basis.digest!==binding.basisDigest)throw bad();
 return report;
}

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
 if(selection.assisted&&(!selection.manual||r.developmentReference===undefined))throw bad();
 const isolatedFund=Boolean(selection.fundPreparation&&p.scope==='PRIVATE_CLOUD_TEST');
 if(selection.fundPreparation&&selection.manual)throw bad();
 if(r.developmentReference!==undefined){if(!selection.manual)throw bad();checkedAssistedDevelopmentReference(r.developmentReference);}
 const frozen=selection.expectedSourceBinding;
 if(frozen&&(frozen.taskId!==r.taskId||frozen.revisionId!==r.revisionId||frozen.runId!==r.runId||(frozen.sourceKind==='MANUAL')!==selection.manual||
  (frozen.scope==='LOCAL_TEST_ONLY'?p.scope!=='LOCAL_TEST_RELEASE':p.scope!=='PRIVATE_CLOUD_TEST')))throw bad();
 const preparation=value.preparationSource;
 if(preparation!==undefined){
  if(selection.manual||p.scope!=='PRIVATE_CLOUD_TEST'||r.status!=='PASSED'||!record(preparation)||
   Object.keys(preparation).some(k=>!['revisionId','revisionHash','runId','requirementBinding'].includes(k))||
   preparation.revisionId!==r.revisionId||preparation.revisionHash!==r.revisionHash||preparation.runId!==r.runId)throw bad();
  const requirement=preparation.requirementBinding;
  if(!optional(requirement,x=>record(x)&&Object.keys(x).length===4&&x.protocol===sqlRequirementProtocol&&
   x.taskId===r.taskId&&hash(x.basisDigest)&&hash(x.reportDigest))||
   (requirement!==undefined)!==checks.some(c=>c.id==='requirement'&&c.passed===true))throw bad();
 }
 const d=value.delivery,b=value.package,v=value.verification;
 let signedFund=false;
 if(d!==undefined){
  if(!record(d)||!id(d.id)||!Number.isSafeInteger(d.version)||Number(d.version)<1||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(String(d.status))||typeof d.stage!=='string'||!d.stage||
   !['mode','error'].every(k=>optional(d[k],text))||!['packageId','verificationId'].every(k=>optional(d[k],id))||!optional(d.packageDigest,hash)||
   !optional(d.sourceAgentTaskId,x=>x===r.taskId)||d.sourceRevisionId!==r.revisionId||d.sourceRunId!==r.runId||!id(d.sourceRevisionId)||!id(d.sourceRunId)||
   !optional(d.sourceSqlHash,x=>x===r.revisionHash)||(selection.manual?d.sourceKind!=='MANUAL':d.sourceKind==='MANUAL')||
   !['sourcePinned','rehearsalPinned'].every(k=>optional(d[k],v=>typeof v==='boolean'))||
   (d.sourcePinned||d.rehearsalPinned)&&(selection.manual||d.mode!=='DURABLE_AGENT_DELIVERY_V1'))throw bad();
 }
 if(record(d)&&!sameAssistedDevelopmentReference(d.developmentReference,r.developmentReference))throw bad();
 if(value.eventDrivenRehearsal!==undefined&&(value.eventDrivenRehearsal!==true||selection.manual||
   p.scope!=='PRIVATE_CLOUD_TEST'||!record(d)||d.sourcePinned!==true))throw bad();
 if(b!==undefined){
  if(!record(d)||!record(b)||!id(b.id)||!hash(b.digest)||d.packageId!==b.id||d.packageDigest!==b.digest||!record(b.manifest)||!record(b.files))throw bad();
  const manifest=b.manifest,source=manifest.source,names=deliveryFileGuide.map(f=>f.name).sort(),files=b.files,entries=manifest.files;
  if(manifest.format!=='shuduo-delivery/v1'||manifest.releaseState!=='NOT_PUBLISHED'||!record(source)||!record(entries)||
   source.runId!==r.runId||source.revisionId!==r.revisionId||source.contextId!==r.contextId||source.sqlHash!==r.revisionHash||source.validationContractId!==r.validationContractId||
   canonical(Object.keys(files).sort())!==canonical(names)||canonical(Object.keys(entries).sort())!==canonical(names)||
   frozen&&b.digest!==frozen.packageDigest||record(preparation)&&canonical(preparation.requirementBinding)!==canonical(source.requirement))throw bad();
  const attribution=source.attribution;
  signedFund=source.fundSignedExecution!==undefined;
  if(signedFund&&!selection.fundPreparation)throw bad();
  if (isolatedFund) {
   const origin=source.fundDevelopment;
   if(signedFund||!record(origin)||Object.keys(origin).length!==3||
      !['jobDigest','resultDigest','testSqlDigest'].every(k=>hash(origin[k]))||
      origin.testSqlDigest!==await digest(files['tests.sql'] as string))throw bad();
  } else if(source.fundDevelopment!==undefined)throw bad();
 if(record(attribution)&&!sameAssistedDevelopmentReference(attribution.developmentReference,r.developmentReference))throw bad();
  if(selection.fundPreparation){
   if(!record(attribution)||attribution.kind!=='FUND_AGENT_GENERATED'||attribution.originAgentTaskId!==selection.taskId||
    attribution.agentIndependentE2E!==false||!['LIVE_MODEL','SYNTHETIC_MODEL'].includes(String(attribution.modelMode))||
    canonical(attribution.preparation)!==canonical(selection.fundPreparation))throw bad();
  }else if(selection.manual?(!record(attribution)||attribution.kind!=='ENGINEER_ASSISTED'||attribution.originAgentTaskId!==selection.taskId||attribution.agentIndependentE2E!==false):attribution!==undefined)throw bad();
  let total=0;
  for(const name of names){const content=files[name],entry=entries[name];if(typeof content!=='string'||!record(entry))throw bad();const bytes=new TextEncoder().encode(content).length;total+=bytes;if(bytes>250000||entry.bytes!==bytes||entry.sha256!==await digest(content))throw bad();}
  if(total>750000||b.digest!==await digest(canonical(manifest))||source.sqlHash!==await digest(files['main.sql'] as string))throw bad();
  const metadata=distributionMetadataForContext(r.contextId as string);
  if(metadata){
   const binding=source.outputContract;
   if(!record(binding)||Object.keys(binding).length!==2||binding.id!==metadata.id||binding.metadataHash!==await digest(canonical(metadata)))throw bad();
   let fixture;try{fixture=JSON.parse(files['fixtures.json'] as string);}catch{throw bad();}
   if(!record(fixture)||canonical(fixture.outputContract)!==canonical(metadata))throw bad();
  }else if(source.outputContract!==undefined)throw bad();
  const requirements=frozenRequirementProposal(b as Workflow['package'],r.taskId);
  if(selection.fundPreparation&&requirements?.basis.digest!==selection.fundPreparation.basisDigest)throw bad();
  if(requirements){
   const {digest:basisDigest,...basis}=requirements.basis;
   if(!record(source.requirement)||await digest(canonical(requirements))!==source.requirement.reportDigest||
    basisDigest!==await digest(JSON.stringify(basis))||await digest(requirements.request)!==(basis as Record<string,unknown>).requestDigest)throw bad();
   if(requirements.clarification){const {digest:cd,...content}=requirements.clarification;if(cd!==await digest(canonical(content)))throw bad();}
  }
 }
 if(record(d)&&(d.packageId!==undefined&&b===undefined||d.verificationId!==undefined&&v===undefined||d.status==='SUCCEEDED'&&(b===undefined||v===undefined)))throw bad();
 if(v!==undefined){
  if(!record(v)||!record(d)||!record(b)||!id(v.id)||v.id!==d.verificationId||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(String(v.status))||
   !['engine','engineVersion','error'].every(k=>optional(v[k],text))||!optional(v.mainSqlExecuted,x=>typeof x==='boolean')||!optional(v.durationMs,x=>typeof x==='number'&&Number.isFinite(x)&&x>=0)||
   v.testSqlValidation!==undefined&&(!record(v.testSqlValidation)||typeof v.testSqlValidation.passed!=='boolean')||
   v.validation!==undefined&&(!record(v.validation)||typeof v.validation.passed!=='boolean'||v.validation.regressions!==undefined&&(!Array.isArray(v.validation.regressions)||!v.validation.regressions.every(x=>record(x)&&typeof x.contextId==='string'&&typeof x.passed==='boolean'))))throw bad();
  if(v.workerResult!==undefined&&(p.scope!=="PRIVATE_CLOUD_TEST"||selection.manual||
    !(v.status==="FAILED"&&(v.workerResult==="CONFIRMED"||v.workerResult==="PENDING")||
      v.status==="RUNNING"&&v.workerResult==="PENDING")))throw bad();
  const basis=v.fundReview;
  if(signedFund&&v.status==='SUCCEEDED'){
   if(!record(basis)||!(basis.status==='READY'&&hash(basis.digest)||basis.status==='UNAVAILABLE'&&basis.digest===undefined))throw bad();
  }else if(basis!==undefined)throw bad();
 }
 if(value.fileReview!==undefined){
  const f=value.fileReview;
  if((!selection.fundPreparation&&!distributionMetadataForContext(r.contextId as string))||!record(f)||Object.keys(f).length!==(signedFund?8:7)||
   (signedFund?!hash(f.fundRehearsalDigest):f.fundRehearsalDigest!==undefined)||!id(f.id)||f.status!=='REVIEWED'||f.scope!=='LOCAL_FILE_REVIEW'||!text(f.reviewedAt)||
   !record(b)||!record(v)||f.packageId!==b.id||f.packageDigest!==b.digest||f.verificationId!==v.id||v.status!=='SUCCEEDED')throw bad();
 }
 if(frozen&&!record(b))throw bad();
 return value as Workflow;
}
