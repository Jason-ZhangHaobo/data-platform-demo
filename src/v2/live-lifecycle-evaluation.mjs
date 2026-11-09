import {createHash,randomUUID} from "node:crypto";
import {isDeepStrictEqual} from 'node:util';
import {m1EvaluationCases,validateM1EvaluationCases} from "./evaluation.mjs";
import {validationContractId,contextIds,validationFamilyForContext} from "./context.mjs";
import {deliveryFiles,validateDeliveryPackage,validationMatchesFamily} from "./delivery.mjs";
import {liveContextEvaluationCases,validateLiveContextEvaluationCases,liveContextCaseSetId} from './live-evaluation-cases.mjs';
import {developmentVerificationReport} from './agent-development-workflow.mjs';
import {inspectLifecycleOutcome} from "./lifecycle-evaluation.mjs";
import {inspectLifecycleConsumption,validLifecycleConsumptionSource,verifyLifecycleConsumptionStage} from "./lifecycle-consumption.mjs";
import {liveEvidenceProvenance,nonLiveModelLabel} from './live-lifecycle-provenance.mjs';

const hash=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
const fail=code=>Object.assign(new Error(code),{code});
const ensure=(condition,code)=>{if(!condition)throw fail(code);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const terminal=status=>["SUCCEEDED","FAILED","VALIDATION_FAILED","CANCELLED","INTERRUPTED"].includes(status);
const nativeSource=value=>{const proof=liveEvidenceProvenance(value);return Boolean(value&&!proof.nonNative&&!proof.unconfirmed);};
const declaredSynthetic=value=>liveEvidenceProvenance(value).synthetic;
export const legacyLiveLifecycleContract=Object.freeze({id:"securities-live-agent-reviewed-lifecycle-v1",expectedCaseCount:20,targetRate:0.85,
  scope:"LOCAL_FRESH_MODEL_ENGINEER_REVIEWED",modelEvidenceMode:"LIVE_NEW_TASK",agentIndependentE2E:false,publicDeployed:false,
  stages:["REQUIREMENT","CODE","DEBUG","SCHEDULE_FILE","DEPLOY_FILE","ENGINEER_REVIEW","PUBLISH","MONITOR"]});
export const liveLifecycleContract=Object.freeze({...legacyLiveLifecycleContract,id:"securities-live-agent-reviewed-lifecycle-v2",
  scope:"LOCAL_FRESH_MODEL_ENGINEER_REVIEWED_WITH_CONSUMPTION",externalSystemVerified:false,
  stages:[...legacyLiveLifecycleContract.stages,"CONSUMPTION"]});
export const currentLiveLifecycleContract=Object.freeze({...liveLifecycleContract,id:'securities-live-agent-reviewed-lifecycle-v3',
 scope:'LOCAL_FRESH_MODEL_CONTEXT_CHANGE_WITH_CONSUMPTION',caseSetId:liveContextCaseSetId});
export const liveContractById=id=>[legacyLiveLifecycleContract,liveLifecycleContract,currentLiveLifecycleContract].find(value=>value.id===id);
export function liveLifecycleCases(contractId=liveLifecycleContract.id){
 ensure(liveContractById(contractId),'CASE_CONTRACT_MISMATCH');
 return contractId===currentLiveLifecycleContract.id?liveContextEvaluationCases():m1EvaluationCases();
}
export function liveCaseRequestDigest(definition,contractId=liveLifecycleContract.id){
 return hash(contractId===currentLiveLifecycleContract.id?{kind:definition.kind,message:definition.request,contextId:definition.contextId,
  ...(definition.kind==='DERIVED'?{sourceCaseId:definition.sourceCaseId}:{sql:definition.seedSql})}:{message:definition.request,sql:definition.seedSql,contextId:definition.contextId});
}
export function liveLifecyclePlan(limit=1,{contractId=liveLifecycleContract.id}={}){
 const cases=liveLifecycleCases(contractId);contractId===currentLiveLifecycleContract.id?validateLiveContextEvaluationCases(cases):validateM1EvaluationCases(cases);
 ensure(Number.isSafeInteger(limit)&&limit>=1&&limit<=cases.length,"CASE_LIMIT_INVALID");
 return {contract:liveContractById(contractId),caseSetDigest:hash(cases),selectedCases:cases.slice(0,limit),
  ...(contractId===currentLiveLifecycleContract.id?{coverage:{freshTasks:10,registeredContextChanges:10,registeredContexts:10,additionalPrerequisiteTasks:0}}:{}),
  maximumModelCalls:limit*3,maximumCodeAndRehearsalSparkRuns:limit*4,maximumReviewedReleaseSparkRuns:limit*2,
  maximumTotalSparkRuns:limit*6,maximumTokenReservation:limit*32000,willExecute:false,
  humanReviewRequired:true,notice:"新需求调用真实模型；文件演练后等待工程师在原任务审阅发布。无默认审批、重试授权或费用授权。"};
}

export async function advanceLiveLifecycleCase(definition,checkpoint,adapter,{save=()=>{},pause=()=>new Promise(resolve=>setTimeout(resolve,1000)),maxPolls=180,sourceCheckpoint}={}){
 const contractId=checkpoint?.contractId,v3=contractId===currentLiveLifecycleContract.id;
 ensure([liveLifecycleContract.id,currentLiveLifecycleContract.id].includes(contractId),"CASE_CONTRACT_MISMATCH");
 ensure(Number.isSafeInteger(maxPolls)&&maxPolls>=1&&maxPolls<=600,"POLL_LIMIT_INVALID");
 ensure(isDeepStrictEqual(liveLifecycleCases(contractId).find(item=>item.id===definition.id),definition)&&checkpoint.caseId===definition.id&&checkpoint.requestDigest===liveCaseRequestDigest(definition,contractId),"CASE_CHECKPOINT_MISMATCH");
 ensure(checkpoint.caseSetDigest===liveLifecyclePlan(1,{contractId}).caseSetDigest,"CASE_SET_CHANGED");
 if(v3)ensure(uuid(checkpoint.evaluationRunId),'EVALUATION_RUN_MISMATCH');
  const state=structuredClone(checkpoint);
 if(adapter.testDouble===true||liveEvidenceProvenance(state,sourceCheckpoint).synthetic)state.executionEvidenceMode="TEST_HARNESS";
 const disclose=(...values)=>{
  const proof=liveEvidenceProvenance(...values);
  if(proof.synthetic&&state.executionEvidenceMode!=='TEST_HARNESS'){state.executionEvidenceMode='TEST_HARNESS';persist();}
  ensure(!proof.nonNative&&!proof.unconfirmed,'NON_NATIVE_EVIDENCE_REJECTED');
 };
 const persist=()=>save(structuredClone(state));
 const mark=(status,phase)=>{state.status=status;state.phase=phase;persist();};
 if(state.phase==="CONSUMPTION"||state.consumptionSource!==undefined||state.consumptionStage!==undefined)
  return refreshLiveLifecycleConsumption(definition,state,adapter,{save,sourceCheckpoint});
 async function mutation(name,path,body,recover){
  let action=state.actions[name];
  const bodyHash=hash(body);ensure(!action||action.bodyHash===bodyHash,"MUTATION_INPUT_CHANGED");
  const accepted=value=>{
   if(!value||typeof value.id!=='string')return false;
   if(!v3)return true;
   if(!uuid(value.id))return false;
   if(name!=='agent')return value.sourceAgentTaskId===state.taskId&&value.sourceRevisionId===state.code.revisionId&&value.sourceRunId===state.code.runId;
   return Boolean(value.contextId===definition.contextId&&value.message===definition.request&&value.mode==='LIVE_MODEL'&&value.language==='SPARK_SQL'&&value.sourceRunId===undefined&&
    Number.isSafeInteger(value.version)&&value.version>=1&&Array.isArray(value.attempts)&&
    (definition.kind==='DERIVED'?value.id!==state.derivationSource.taskId&&isDeepStrictEqual(value.derivedFrom,derivedFrom(state.derivationSource))&&
     typeof value.initialSql==='string'&&hash(value.initialSql)===state.derivationSource.revisionHash:value.derivedFrom===undefined));
  };
  if(action?.id)return {id:action.id};
  if(action){
   let prior;try{prior=await recover();}catch{}
   if(!accepted(prior))throw fail("MUTATION_OUTCOME_UNKNOWN");
   disclose(prior);action.id=prior.id;action.status="CONFIRMED";persist();return prior;
  }
  action=state.actions[name]={key:randomUUID(),bodyHash,status:"SUBMITTING"};persist();
  try{
   const value=await adapter.request(path,body,action.key);ensure(accepted(value),"MUTATION_RESPONSE_UNCONFIRMED");
   disclose(value);action.id=value.id;action.status="CONFIRMED";persist();return value;
  }catch(cause){
   let prior;try{prior=await recover();}catch{}
   if(accepted(prior)){disclose(prior);action.id=prior.id;action.status="CONFIRMED";persist();return prior;}
   action.status="UNKNOWN";persist();throw fail("MUTATION_OUTCOME_UNKNOWN");
  }
 }
 async function poll(path,kind){
  for(let count=0;count<maxPolls;count++){
   const current=await adapter.request(path);
   disclose(current);
   if(current.stage==="MODEL_OUTCOME_UNKNOWN")throw fail("MODEL_OUTCOME_UNKNOWN");
   if(current.stage==="MODEL_NOT_SENT")throw fail("MODEL_NOT_SENT");
   if(terminal(current.status))return current;
   if((kind==="agent"&&current.executionMode==="DURABLE_SQL_AGENT_V1")||(kind==="delivery"&&current.mode==="DURABLE_AGENT_DELIVERY_V1")){
    const expectedVersion=current.version;ensure(Number.isSafeInteger(expectedVersion),"RESOURCE_VERSION_MISSING");
    try{await adapter.request(path+"/advance",{expectedVersion});}
    catch{const fresh=await adapter.request(path);if(fresh.version<=expectedVersion)throw fail("ADVANCE_OUTCOME_UNKNOWN");}
   }
   await pause();
  }
  throw fail("STAGE_WAIT_EXPIRED");
 }
 try{
  if(state.status==="SUCCEEDED"){ensure(verifyLiveCaseEvidence(definition,state,{contractId,sourceCheckpoint}),"COMPLETE_EVIDENCE_NOT_VERIFIED");return state;}
  if(state.status==="FAILED")return state;
  if(state.errorCode){state.errorHistory=[...(state.errorHistory??[]),{code:state.errorCode,phase:state.phase}].slice(-20);delete state.errorCode;}
  let body={message:definition.request,sql:definition.seedSql,contextId:definition.contextId};
  if(v3&&definition.kind==='DERIVED'){
   if(!verifiedParent(definition,state,sourceCheckpoint)){
    ensure(!state.actions.agent,'DERIVATION_SOURCE_CHANGED');
    state.errorCode='DERIVATION_SOURCE_NOT_SUCCESSFUL';mark(sourceCheckpoint?.status==='FAILED'?'BLOCKED_SOURCE':'AWAITING_SOURCE','SOURCE_CONTEXT');return state;
   }
   const binding=parentBinding(definition,sourceCheckpoint);
   ensure(!state.derivationSource||isDeepStrictEqual(state.derivationSource,binding),'DERIVATION_SOURCE_CHANGED');
   state.derivationSource=binding;
   if(sourceCheckpoint.executionEvidenceMode==='TEST_HARNESS')state.executionEvidenceMode='TEST_HARNESS';
   persist();
   const parent=await adapter.request(`/agent/tasks/${binding.taskId}`),revision=await adapter.request(`/revisions/${binding.revisionId}`),
    run=await adapter.request(`/runs/${binding.runId}`);
   disclose(parent,revision,run);
   ensure(nativeSource(parent)&&nativeSource(revision)&&nativeSource(run)&&parent.id===binding.taskId&&parent.status==='SUCCEEDED'&&parent.mode==='LIVE_MODEL'&&
    parent.contextId===binding.contextId&&parent.attempts?.at(-1)?.revisionId===binding.revisionId&&parent.attempts.at(-1)?.runId===binding.runId&&
    revision.id===binding.revisionId&&revision.source==='LIVE_MODEL'&&!revision.manualProvenance&&revision.contextId===binding.contextId&&
    revision.hash===binding.revisionHash&&typeof revision.sql==='string'&&hash(revision.sql)===binding.revisionHash&&parent.sql===revision.sql&&
    run.id===binding.runId&&run.agentTaskId===binding.taskId&&developmentVerificationReport(parent,run,revision).status==='PASSED','DERIVATION_SOURCE_NOT_VERIFIED');
   body={message:definition.request,sql:revision.sql,contextId:definition.contextId,language:'SPARK_SQL',derivation:derivationRequest(binding)};
  }
  mark("RUNNING","CODE_AND_DEBUG");
  const started=await mutation("agent","/agent/tasks",body,()=>adapter.request(`/agent/requests/${state.actions.agent.key}`));
  state.taskId=started.id;persist();
  const task=await poll(`/agent/tasks/${started.id}`,"agent");ensure(task.id===started.id,"FRESH_TASK_SOURCE_MISMATCH");
  disclose(task);
  ensure(task.status==="SUCCEEDED","AGENT_TASK_NOT_SUCCESSFUL");
  ensure(nativeSource(task)&&task.mode==="LIVE_MODEL"&&task.contextId===definition.contextId&&task.message===definition.request,"FRESH_TASK_SOURCE_MISMATCH");
  if(v3)ensure(task.sourceRunId===undefined&&(definition.kind==='DERIVED'?task.id!==state.derivationSource.taskId&&isDeepStrictEqual(task.derivedFrom,derivedFrom(state.derivationSource))&&
    typeof task.initialSql==='string'&&hash(task.initialSql)===state.derivationSource.revisionHash:task.derivedFrom===undefined),'DERIVATION_TASK_MISMATCH');
  ensure(Date.parse(task.createdAt)>=Date.parse(state.evaluationStartedAt),"HISTORICAL_TASK_REJECTED");
  const attempt=task.attempts?.at(-1);
  ensure(attempt?.status==="SUCCEEDED"&&typeof attempt.model==="string"&&!nonLiveModelLabel(attempt.model)&&task.attempts.length<=3,"LIVE_MODEL_EVIDENCE_REQUIRED");
  ensure(Number.isSafeInteger(task.usedTokens)&&task.usedTokens>=0&&task.usedTokens<=32000,"MODEL_USAGE_NOT_CONFIRMED");
  const workflow=await adapter.request(`/agent/tasks/${task.id}/workflow`);
  disclose(workflow,workflow.report);
  ensure(nativeSource(workflow.report)&&workflow.report?.status==="PASSED"&&workflow.report.taskId===task.id&&workflow.report.revisionId===attempt.revisionId&&workflow.report.runId===attempt.runId&&
    ["revision","execution","results","regressions"].every(id=>workflow.report.checks?.some(check=>check.id===id&&check.passed===true)),"RESULT_VERIFICATION_INCOMPLETE");
  const revision=await adapter.request(`/revisions/${attempt.revisionId}`),run=await adapter.request(`/runs/${attempt.runId}`),family=validationFamilyForContext(definition.contextId),
   expectedContract=v3?family.id:validationContractId,expectedContexts=v3?family.contextIds:contextIds;
  disclose(revision,run);
  ensure(nativeSource(revision)&&nativeSource(run)&&revision.source==="LIVE_MODEL"&&!revision.manualProvenance&&run.agentTaskId===task.id&&
    revision.id===attempt.revisionId&&revision.hash===hash(revision.sql)&&run.revisionId===revision.id&&run.revisionHash===revision.hash&&
    run.status==="SUCCEEDED"&&run.engine==="Apache Spark"&&run.mainSqlExecuted===true&&run.testDouble!==true&&run.validation?.contractId===expectedContract&&
    run.validation.passed===true&&run.validation.regressions?.length===5&&expectedContexts.every(id=>run.validation.regressions.some(check=>check.contextId===id&&check.passed))&&
    (!v3||developmentVerificationReport(task,run,revision).status==='PASSED'),"CODE_EXECUTION_NOT_VERIFIED");
  state.code={sourceKind:"AGENT",taskId:task.id,createdAt:task.createdAt,revisionId:attempt.revisionId,revisionHash:revision.hash,runId:attempt.runId,model:attempt.model,modelAttempts:task.attempts.length,reportedTokens:task.usedTokens??0,
   ...(v3?{contextId:definition.contextId,validationContractId:expectedContract,...(task.derivedFrom?{derivedFrom:task.derivedFrom,initialSqlHash:hash(task.initialSql)}:{})}:{})};persist();
  mark("RUNNING","DELIVERY_PREPARATION");
  const prepared=await mutation("delivery",`/agent/tasks/${task.id}/prepare-delivery`,{},async()=>{
   const values=await adapter.request(`/agent/deliveries?sourceAgentTaskId=${task.id}`);
   const matches=values.filter(value=>value.sourceRevisionId===attempt.revisionId&&value.sourceRunId===attempt.runId);
   ensure(matches.length===1,"DELIVERY_RECOVERY_AMBIGUOUS");return matches[0];
  });
  const delivery=await poll(`/agent/deliveries/${prepared.id}`,"delivery");
  disclose(delivery);
  ensure(nativeSource(delivery)&&delivery.status==="SUCCEEDED"&&delivery.sourceAgentTaskId===task.id&&delivery.sourceRunId===attempt.runId&&delivery.sourceRevisionId===attempt.revisionId,"DELIVERY_NOT_VERIFIED");
  const current=await adapter.request(`/agent/tasks/${task.id}/workflow`);
  const bundle=current.package,verification=current.verification;
  disclose(current,bundle,verification);
  ensure(nativeSource(bundle)&&nativeSource(bundle.manifest?.source)&&bundle?.id===delivery.packageId&&bundle.digest===delivery.packageDigest&&bundle.manifest?.source?.revisionId===attempt.revisionId&&bundle.manifest.source.runId===attempt.runId,"DELIVERY_SOURCE_MISMATCH");
  ensure(nativeSource(verification)&&verification?.id===delivery.verificationId&&verification.status==="SUCCEEDED"&&verification.engine==="Apache Spark"&&verification.mainSqlExecuted===true&&verification.testSqlValidation?.passed===true&&
    verification.validation?.passed===true&&expectedContexts.every(id=>verification.validation.regressions?.some(check=>check.contextId===id&&check.passed))&&
    (!v3||bundle.manifest.source.validationContractId===expectedContract&&bundle.manifest.source.contextId===definition.contextId&&validationMatchesFamily(verification.validation,family,{requireContract:false})),"FILE_REHEARSAL_INCOMPLETE");
  ensure(deliveryFiles.every(name=>typeof bundle.files?.[name]==="string"&&bundle.files[name].length>0),"DELIVERY_FILES_MISSING");
  try{validateDeliveryPackage(bundle,bundle.digest);}catch{throw fail("DELIVERY_MANIFEST_NOT_VERIFIED");}
  state.delivery={id:delivery.id,packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id};persist();
  mark("AWAITING_ENGINEER_REVIEW","ENGINEER_REVIEW_AND_PUBLICATION");
  const publication=await adapter.request(`/agent/tasks/${task.id}/publication`),release=publication.release;
  disclose(publication,release);
  if(!release)return state;
  ensure(nativeSource(release)&&release.packageId===bundle.id&&release.packageDigest===bundle.digest&&release.sourceRevisionId===attempt.revisionId,"PUBLICATION_SOURCE_MISMATCH");
  if(release.status!=="ACTIVE_LOCAL")throw fail("RELEASE_NOT_ACTIVE");
  if(publication.runs.some(run=>["FAILED","CANCELLED","INTERRUPTED"].includes(run.status)))throw fail("RELEASE_BATCH_FAILED");
  if(publication.runs.length!==2||publication.runs.some(run=>run.status!=="SUCCEEDED")){mark("AWAITING_MONITORING","POST_RELEASE_MONITORING");return state;}
  const detail=await adapter.request(`/releases/${release.id}`);
  const approval=(await adapter.request("/release/approvals")).find(item=>item.id===detail.approvalId);
  const review=(await adapter.request("/delivery/reviews")).find(item=>item.id===approval?.reviewId);
  ensure(nativeSource(approval)&&nativeSource(review)&&approval?.status==="APPROVED"&&approval.packageId===bundle.id&&approval.packageDigest===bundle.digest&&review?.status==="REVIEWED"&&review.packageId===bundle.id&&review.packageDigest===bundle.digest&&
    review.verificationId===verification.id&&["code","assertions","deliveryFiles","localScope"].every(id=>review.attestations?.[id]===true),"ENGINEER_REVIEW_NOT_BOUND");
  const batches=await Promise.all(publication.runs.map(run=>adapter.request(`/release/runs/${run.id}`)));
  disclose(detail,approval,review,...batches);
  ensure(nativeSource(detail)&&new Set(batches.map(run=>run.id)).size===2&&batches.every(run=>nativeSource(run)&&nativeSource(run.source)&&run.releaseId===release.id&&run.packageId===bundle.id&&run.packageDigest===bundle.digest&&run.status==="SUCCEEDED"&&run.engine==="Apache Spark"&&run.mainSqlExecuted===true&&run.testDouble!==true&&
    run.schedulerTriggered===true&&run.clockMode==="WALL_CLOCK_TIMER"&&run.testSqlValidation?.passed===true&&run.testSqlValidation.sqlHash===hash(bundle.files["tests.sql"])&&
    run.source?.validationContractId===expectedContract&&run.source.revisionId===revision.id&&run.source.runId===attempt.runId&&run.source.sqlHash===revision.hash&&
    run.fileHashes?.["main.sql"]===hash(bundle.files["main.sql"])&&run.fileHashes?.["tests.sql"]===hash(bundle.files["tests.sql"])&&
    run.validation?.passed===true&&expectedContexts.every(id=>run.validation.regressions?.some(check=>check.contextId===id&&check.passed))&&
    (!v3||run.source.contextId===definition.contextId&&validationMatchesFamily(run.validation,family,{requireContract:false}))),"PUBLISHED_BATCH_EVIDENCE_INCOMPLETE");
  ensure(detail.health==="HEALTHY"&&detail.successfulRunCount===2&&!publication.alerts.some(alert=>alert.status==="OPEN")&&batches.every(run=>publication.events.some(event=>event.type==="BATCH_SUCCEEDED"&&event.releaseRunId===run.id&&event.releaseId===release.id&&event.packageDigest===bundle.digest&&Date.parse(event.observedAt)>=Date.parse(run.finishedAt))),"POST_RELEASE_MONITORING_INCOMPLETE");
  state.publication={sourceKind:"AGENT",releaseId:release.id,reviewId:review.id,approvalId:approval.id,batchIds:batches.map(run=>run.id),eventIds:publication.events.filter(event=>event.type==="BATCH_SUCCEEDED").map(event=>event.id)};
  const outcome={caseId:definition.id,contextId:definition.contextId,category:definition.category,sourceAgentTaskId:task.id,...(v3?{validationContractId:expectedContract}:{}),
   packageId:bundle.id,releaseId:release.id,scheduledBatchCount:2,localFullLifecycleE2E:true,publicDeployed:false,stages:{
    requirementUnderstanding:{status:"PASSED",evidenceIds:[task.id],requirementSha256:hash(definition.request),liveModel:true},
    codeAndDebug:{status:"PASSED",evidenceIds:[revision.id,run.id],currentRevisionId:revision.id,currentSparkRunId:run.id,currentSparkVersion:run.engineVersion,
      sqlHash:revision.hash,attemptCount:task.attempts.length,regressionCount:run.validation.regressions.length,importedFromFrozenLiveEvidence:false},
    scheduleFiles:{status:"PASSED",evidenceIds:[bundle.id],packageDigest:bundle.digest,files:["schedule.json","calendar.json","manifest"]},
    deploymentFiles:{status:"PASSED",evidenceIds:[bundle.id,verification.id],packageDigest:bundle.digest,files:["deployment.json","main.sql","tests.sql"],actualSparkRehearsal:true,rehearsalStatus:verification.status},
    engineerReview:{status:"PASSED",evidenceIds:[review.id,verification.id],reviewId:review.id,verificationId:verification.id,packageDigest:review.packageDigest,evaluatorAttestation:false,reviewScope:review.scope,attestations:review.attestations},
    localRelease:{status:"PASSED",evidenceIds:[review.id,approval.id,release.id,...batches.map(value=>value.id)],approvalId:approval.id,packageDigest:bundle.digest,approvalBound:true,
      schedulerTriggered:true,actualSparkBatchCount:2,deploymentScope:"LOCAL_ACTUAL",activatedAt:detail.activatedAt,batches:batches.map(value=>({
        id:value.id,releaseId:value.releaseId,packageId:value.packageId,packageDigest:value.packageDigest,status:value.status,engine:value.engine,
        schedulerTriggered:value.schedulerTriggered,clockMode:value.clockMode,validationPassed:value.validation?.passed===true,
        scheduledTriggerAt:value.scheduledTriggerAt,startedAt:value.startedAt,finishedAt:value.finishedAt}))},
    postReleaseMonitoring:{status:"PASSED",evidenceIds:[release.id,...publication.events.map(event=>event.id)],health:detail.health,successfulRunCount:detail.successfulRunCount,openAlertCount:0,
      successfulEvents:publication.events.filter(event=>event.type==="BATCH_SUCCEEDED").map(event=>({id:event.id,type:event.type,releaseId:event.releaseId,releaseRunId:event.releaseRunId,packageDigest:event.packageDigest,observedAt:event.observedAt}))},
   }};
  state.lifecycleOutcome=outcome;
  ensure(verifyCodeThroughMonitoring(definition,state),"COMPLETE_EVIDENCE_NOT_VERIFIED");
  state.consumptionSource=consumptionSourceForState(state);
  ensure(validLifecycleConsumptionSource(state.consumptionSource),"CONSUMPTION_CHECKPOINT_INVALID");
  mark("AWAITING_CONSUMPTION","CONSUMPTION");
  return refreshLiveLifecycleConsumption(definition,state,adapter,{save,sourceCheckpoint});
 }catch(cause){
  state.code=state.code??undefined;
  state.errorCode=/^[A-Z0-9_]{1,80}$/.test(cause.code??"")?cause.code:"EVALUATION_UNCONFIRMED";
  state.status=["MUTATION_OUTCOME_UNKNOWN","MODEL_OUTCOME_UNKNOWN","MODEL_NOT_SENT","ADVANCE_OUTCOME_UNKNOWN","STAGE_WAIT_EXPIRED","EVALUATION_UNCONFIRMED","API_REQUEST_UNCONFIRMED","API_RESPONSE_UNCONFIRMED"].includes(state.errorCode)?"PAUSED":"FAILED";
  persist();
 }
 return state;
}

export function liveCaseCheckpoint(definition,evaluationStartedAt,caseSetDigest,{contractId=liveLifecycleContract.id,evaluationRunId}={}){
 ensure([liveLifecycleContract.id,currentLiveLifecycleContract.id].includes(contractId),'CASE_CONTRACT_MISMATCH');
 ensure(isDeepStrictEqual(liveLifecycleCases(contractId).find(item=>item.id===definition.id),definition),'CASE_CHECKPOINT_MISMATCH');
 if(contractId===currentLiveLifecycleContract.id)ensure(uuid(evaluationRunId),'EVALUATION_RUN_MISMATCH');
 return {contractId,caseId:definition.id,caseSetDigest,evaluationStartedAt,...(contractId===currentLiveLifecycleContract.id?{evaluationRunId}:{}),requestDigest:liveCaseRequestDigest(definition,contractId),status:"NOT_RUN",phase:"REQUIREMENT",actions:{}};
}
const derivationRequest=binding=>({kind:'REGISTERED_CONTEXT_CHANGE',taskId:binding.taskId,revisionId:binding.revisionId,runId:binding.runId,revisionHash:binding.revisionHash});
const derivedFrom=binding=>({...derivationRequest(binding),contextId:binding.contextId,validationContractId:binding.validationContractId});
function parentBinding(definition,parent){
 return {schema:'shuduo-live-derivation-source/v1',evaluationRunId:parent.evaluationRunId,sourceCaseId:definition.sourceCaseId,parentRequestDigest:parent.requestDigest,
  taskId:parent.code.taskId,revisionId:parent.code.revisionId,runId:parent.code.runId,revisionHash:parent.code.revisionHash,
  contextId:parent.code.contextId,validationContractId:parent.code.validationContractId,
  parentCompletedAt:parent.consumptionStage.evidence.checkedAt,
  parentEvidenceDigest:hash({code:parent.code,delivery:parent.delivery,publication:parent.publication,lifecycleOutcome:parent.lifecycleOutcome,
   consumptionSource:parent.consumptionSource,consumptionStage:parent.consumptionStage,executionEvidenceMode:parent.executionEvidenceMode})};
}
function verifiedParent(definition,state,parent){
 const sourceDefinition=liveLifecycleCases(currentLiveLifecycleContract.id).find(item=>item.id===definition.sourceCaseId);
 return Boolean(sourceDefinition?.kind==='FRESH'&&parent?.caseId===sourceDefinition.id&&parent.contractId===currentLiveLifecycleContract.id&&
  uuid(state.evaluationRunId)&&parent.evaluationRunId===state.evaluationRunId&&parent.evaluationStartedAt===state.evaluationStartedAt&&parent.caseSetDigest===state.caseSetDigest&&parent.status==='SUCCEEDED'&&
  sourceDefinition.contextId!==definition.contextId&&validationFamilyForContext(sourceDefinition.contextId)?.id!==validationFamilyForContext(definition.contextId)?.id&&
  verifyLiveCaseEvidence(sourceDefinition,parent,{contractId:currentLiveLifecycleContract.id}));
}
function savedDerivationValid(definition,state){
 if(definition.kind==='FRESH')return state.derivationSource===undefined&&state.code?.derivedFrom===undefined&&state.code?.initialSqlHash===undefined;
 const binding=state.derivationSource,sourceDefinition=liveLifecycleCases(currentLiveLifecycleContract.id).find(item=>item.id===definition.sourceCaseId),
  digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 return Boolean(binding&&Object.keys(binding).length===12&&binding.schema==='shuduo-live-derivation-source/v1'&&binding.evaluationRunId===state.evaluationRunId&&binding.sourceCaseId===sourceDefinition?.id&&sourceDefinition.kind==='FRESH'&&
  binding.contextId===sourceDefinition.contextId&&binding.validationContractId===validationFamilyForContext(sourceDefinition.contextId)?.id&&
  binding.parentRequestDigest===liveCaseRequestDigest(sourceDefinition,currentLiveLifecycleContract.id)&&[binding.taskId,binding.revisionId,binding.runId].every(uuid)&&
  digest(binding.revisionHash)&&digest(binding.parentEvidenceDigest)&&Number.isFinite(Date.parse(binding.parentCompletedAt))&&Date.parse(state.code.createdAt)>=Date.parse(binding.parentCompletedAt)&&
  state.code.taskId!==binding.taskId&&state.code.revisionId!==binding.revisionId&&state.code.runId!==binding.runId&&
  state.code.initialSqlHash===binding.revisionHash&&isDeepStrictEqual(state.code.derivedFrom,derivedFrom(binding)));
}
function verifyCodeThroughMonitoring(definition,state,contractId=state?.contractId??legacyLiveLifecycleContract.id){
 const source=state.code;
 if(!nativeSource(state)||!liveContractById(contractId)||!isDeepStrictEqual(liveLifecycleCases(contractId).find(item=>item.id===definition.id),definition)||
   !source||state.caseId!==definition.id||state.caseSetDigest!==liveLifecyclePlan(1,{contractId}).caseSetDigest||state.requestDigest!==liveCaseRequestDigest(definition,contractId)||
   state.actions?.agent?.id!==source.taskId||state.taskId!==source.taskId||Date.parse(source.createdAt)<Date.parse(state.evaluationStartedAt)||
   !Number.isFinite(Date.parse(source.createdAt))||!Number.isFinite(Date.parse(state.evaluationStartedAt))||!Number.isSafeInteger(source.modelAttempts)||source.modelAttempts<1||source.modelAttempts>3||
   typeof source.model!=="string"||nonLiveModelLabel(source.model)||!/^[a-f0-9]{64}$/.test(source.revisionHash??""))return false;
 if(contractId===currentLiveLifecycleContract.id&&(!uuid(state.evaluationRunId)||!Number.isSafeInteger(source.reportedTokens)||source.reportedTokens<0||source.reportedTokens>32000||
  source.contextId!==definition.contextId||source.validationContractId!==validationFamilyForContext(definition.contextId)?.id||
  state.lifecycleOutcome?.validationContractId!==source.validationContractId||!savedDerivationValid(definition,state)))return false;
 const liveDefinition={caseId:definition.id,contextId:definition.contextId,category:definition.category,requirement:definition.request,
  original:{agentTaskId:source.taskId,revisionId:source.revisionId,runId:source.runId,attemptCount:source.modelAttempts},code:{sqlHash:source.revisionHash}};
 return inspectLifecycleOutcome(liveDefinition,state.lifecycleOutcome,{modelEvidenceMode:"LIVE_NEW_TASK"}).passed;
}
function consumptionSourceForState(state){
 const code=state.code,delivery=state.delivery,publication=state.publication,outcome=state.lifecycleOutcome,release=outcome?.stages?.localRelease,review=outcome?.stages?.engineerReview;
 if(!nativeSource(code)||!nativeSource(publication)||code?.sourceKind!=="AGENT"||publication?.sourceKind!=="AGENT"||state.actions?.delivery?.id!==delivery?.id||
   delivery?.packageId!==outcome?.packageId||delivery?.packageDigest!==release?.packageDigest||delivery?.verificationId!==review?.verificationId||
   publication.releaseId!==outcome?.releaseId||publication.reviewId!==review?.reviewId||publication.approvalId!==release?.approvalId||
   !Array.isArray(release?.batches)||JSON.stringify(publication.batchIds)!==JSON.stringify(release.batches.map(batch=>batch.id)))return undefined;
 return {sourceKind:"AGENT",scope:"LOCAL_TEST_ONLY",taskId:code.taskId,revisionId:code.revisionId,revisionHash:code.revisionHash,developmentRunId:code.runId,
  packageId:delivery.packageId,packageDigest:delivery.packageDigest,verificationId:delivery.verificationId,releaseId:publication.releaseId,
  batches:release.batches.map(batch=>({id:batch.id,finishedAt:batch.finishedAt}))};
}
export function verifyLiveCaseEvidence(definition,state,{contractId=state?.contractId??liveLifecycleContract.id,sourceCheckpoint}={}){
 if(contractId===legacyLiveLifecycleContract.id)
  return Boolean(state&&(state.contractId===undefined||state.contractId===legacyLiveLifecycleContract.id)&&verifyCodeThroughMonitoring(definition,state,contractId));
 if(![liveLifecycleContract.id,currentLiveLifecycleContract.id].includes(contractId)||state?.contractId!==contractId||!verifyCodeThroughMonitoring(definition,state))return false;
 if(contractId===currentLiveLifecycleContract.id&&definition.kind==='DERIVED'&&(!verifiedParent(definition,state,sourceCheckpoint)||
  !isDeepStrictEqual(state.derivationSource,parentBinding(definition,sourceCheckpoint))))return false;
 const source=consumptionSourceForState(state);
 return validLifecycleConsumptionSource(source)&&JSON.stringify(source)===JSON.stringify(state.consumptionSource)&&verifyLifecycleConsumptionStage(source,state.consumptionStage);
}

// Read-only navigation shares the evaluator's established source checks. A URL
// is not execution authority; the destination still rechecks persisted records.
export function validatedLiveConsumptionSource(definition,state,{sourceCheckpoint}={}){
 if(![liveLifecycleContract.id,currentLiveLifecycleContract.id].includes(state?.contractId)||!verifyCodeThroughMonitoring(definition,state))return;
 if(state.contractId===currentLiveLifecycleContract.id&&definition.kind==='DERIVED'&&(!verifiedParent(definition,state,sourceCheckpoint)||
  !isDeepStrictEqual(state.derivationSource,parentBinding(definition,sourceCheckpoint))))return;
 if(state.status==='SUCCEEDED'){
  if(state.phase!=='COMPLETE'||!verifyLiveCaseEvidence(definition,state,{sourceCheckpoint}))return;
 }else if(state.phase!=='CONSUMPTION'||!['AWAITING_CONSUMPTION','PAUSED'].includes(state.status))return;
 const source=consumptionSourceForState(state);
 if(validLifecycleConsumptionSource(source)&&JSON.stringify(source)===JSON.stringify(state.consumptionSource))return structuredClone(source);
}

// This is the only continuation after monitoring has passed. The exact URL is
// rebuilt from the immutable checkpoint and the adapter is never given a body.
// No model/Spark readiness, mutation, authorization or service invocation occurs.
export async function refreshLiveLifecycleConsumption(definition,checkpoint,adapter,{save=()=>{},sourceCheckpoint}={}){
 ensure([liveLifecycleContract.id,currentLiveLifecycleContract.id].includes(checkpoint?.contractId),"CASE_CONTRACT_MISMATCH");
 ensure(verifyCodeThroughMonitoring(definition,checkpoint),"CONSUMPTION_CHECKPOINT_INVALID");
 if(checkpoint.contractId===currentLiveLifecycleContract.id&&definition.kind==='DERIVED')ensure(verifiedParent(definition,checkpoint,sourceCheckpoint)&&
  isDeepStrictEqual(checkpoint.derivationSource,parentBinding(definition,sourceCheckpoint)),'DERIVATION_SOURCE_CHANGED');
 const source=consumptionSourceForState(checkpoint);
 ensure(validLifecycleConsumptionSource(source)&&JSON.stringify(source)===JSON.stringify(checkpoint.consumptionSource),"CONSUMPTION_CHECKPOINT_INVALID");
 if(checkpoint.status==="SUCCEEDED"){
  ensure(checkpoint.phase==="COMPLETE"&&verifyLiveCaseEvidence(definition,checkpoint,{sourceCheckpoint}),"COMPLETE_EVIDENCE_NOT_VERIFIED");
  return structuredClone(checkpoint);
 }
 ensure(checkpoint.phase==="CONSUMPTION"&&["AWAITING_CONSUMPTION","PAUSED"].includes(checkpoint.status),"CONSUMPTION_CHECKPOINT_INVALID");
 const state=structuredClone(checkpoint);
 if(adapter.testDouble===true||liveEvidenceProvenance(state,sourceCheckpoint).synthetic)state.executionEvidenceMode="TEST_HARNESS";
 if(state.errorCode){state.errorHistory=[...(state.errorHistory??[]),{code:state.errorCode,phase:state.phase}].slice(-20);delete state.errorCode;}
 delete state.consumptionStage;
 let report;
 try{
  const query=new URLSearchParams({agent_task_id:source.taskId,package_digest:source.packageDigest,release_id:source.releaseId});
  report=await adapter.request(`/data-services/task-evidence?${query}`);
 }catch{
  state.status="PAUSED";state.phase="CONSUMPTION";state.errorCode="CONSUMPTION_READ_UNCONFIRMED";
  save(structuredClone(state));return state;
 }
 const checked=inspectLifecycleConsumption(source,report);
 if(declaredSynthetic(report))state.executionEvidenceMode='TEST_HARNESS';
 const provenance=liveEvidenceProvenance(report);
 if(provenance.nonNative||provenance.unconfirmed){
  state.status='AWAITING_CONSUMPTION';state.phase='CONSUMPTION';state.errorCode='CONSUMPTION_EVIDENCE_INVALID';
  save(structuredClone(state));return state;
 }
 state.consumptionStage=checked;
 state.status=checked.status==="PASSED"?"SUCCEEDED":"AWAITING_CONSUMPTION";
 state.phase=checked.status==="PASSED"?"COMPLETE":"CONSUMPTION";
 if(checked.status!=="PASSED")state.errorCode=checked.code;
 ensure(checked.status!=="PASSED"||verifyLiveCaseEvidence(definition,state,{sourceCheckpoint}),"COMPLETE_EVIDENCE_NOT_VERIFIED");
 save(structuredClone(state));return state;
}

export function summarizeLiveLifecycle(cases,outcomes,{testDouble=false,contractId=liveLifecycleContract.id}={}){
 const contract=liveContractById(contractId);
 ensure(contract,"CASE_CONTRACT_MISMATCH");
 const all=liveLifecycleCases(contractId);contractId===currentLiveLifecycleContract.id?validateLiveContextEvaluationCases(cases):validateM1EvaluationCases(cases);
 ensure(Array.isArray(outcomes)&&new Set(outcomes.map(item=>item.caseId)).size===outcomes.length&&outcomes.every(item=>all.some(definition=>definition.id===item.caseId)),"OUTCOME_CASE_SET_INVALID");
 ensure(outcomes.every(item=>item.contractId===contractId||contractId===legacyLiveLifecycleContract.id&&item.contractId===undefined),"CASE_CONTRACT_MISMATCH");
 if(contractId===currentLiveLifecycleContract.id){
  ensure(outcomes.every(item=>uuid(item.evaluationRunId))&&new Set(outcomes.map(item=>item.evaluationRunId)).size<=1&&new Set(outcomes.map(item=>item.evaluationStartedAt)).size<=1,'EVALUATION_RUN_MISMATCH');
  const taskIds=outcomes.filter(item=>item.actions?.agent?.id).map(item=>item.actions.agent.id);ensure(new Set(taskIds).size===taskIds.length,'OUTCOME_TASK_SET_INVALID');
 }
 const simulated=testDouble||outcomes.some(declaredSynthetic);
 const rejectedProvenanceCaseCount=outcomes.filter(item=>{const proof=liveEvidenceProvenance(item);return item.errorCode==='NON_NATIVE_EVIDENCE_REJECTED'||proof.nonNative||proof.unconfirmed;}).length;
 const succeeded=simulated?0:outcomes.filter(item=>{const definition=all.find(value=>value.id===item.caseId);return item.status==="SUCCEEDED"&&verifyLiveCaseEvidence(definition,item,
  {contractId,sourceCheckpoint:outcomes.find(parent=>parent.caseId===definition.sourceCaseId)});}).length;
 const attempted=outcomes.filter(item=>item.actions?.agent).length,completed=outcomes.filter(item=>item.taskId&&item.taskId===item.actions?.agent?.id&&["SUCCEEDED","FAILED"].includes(item.status)).length;
 return {contract,executionEvidenceMode:simulated?"TEST_HARNESS":"LIVE_NEW_TASK",succeededCaseCount:succeeded,failedCaseCount:outcomes.filter(item=>item.status==="FAILED").length,
  awaitingReviewCaseCount:outcomes.filter(item=>item.status==="AWAITING_ENGINEER_REVIEW").length,awaitingMonitoringCaseCount:outcomes.filter(item=>item.status==="AWAITING_MONITORING").length,
  awaitingConsumptionCaseCount:outcomes.filter(item=>item.status==="AWAITING_CONSUMPTION").length,
  ...(contractId===currentLiveLifecycleContract.id?{awaitingSourceCaseCount:outcomes.filter(item=>item.status==='AWAITING_SOURCE').length,
   blockedSourceCaseCount:outcomes.filter(item=>item.status==='BLOCKED_SOURCE').length,contextChangeCaseCount:all.filter(item=>item.kind==='DERIVED').length}:{}),
  pausedCaseCount:outcomes.filter(item=>item.status==="PAUSED").length,unconfirmedSubmissionCount:outcomes.filter(item=>item.actions?.agent?.status==="UNKNOWN").length,
  attemptedCaseCount:attempted,completedCaseCount:completed,unexecutedCaseCount:all.length-attempted,
  measurementStatus:simulated?'TEST_HARNESS':attempted===0?'NOT_RUN':'RECORDED_EVIDENCE_ONLY',
  rejectedProvenanceCaseCount,autonomousCompletionRate:null,fullGoalTargetMet:false,
  frozenCaseCount:all.length,completionRate:succeeded/all.length,targetMet:!simulated&&completed===all.length&&succeeded/all.length>=0.85,
  agentIndependentE2E:false,publicDeployed:false,externalSystemVerified:false,
  notice:contractId===legacyLiveLifecycleContract.id?"旧版本机新任务评测只覆盖至监控，不含消费检查；按旧范围保留，不升级为新版或云端验收。":
   "当前分数属于新任务、真实模型、工程师审阅和同源内部消费对照的本机链路；测试替身、人工救援、历史回放和无审阅上线不计成功，不代表外部客户端或云端验收。"};
}
