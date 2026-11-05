import {createHash,randomUUID} from "node:crypto";
import {m1EvaluationCases,validateM1EvaluationCases} from "./evaluation.mjs";
import {validationContractId,contextIds} from "./context.mjs";
import {deliveryFiles,validateDeliveryPackage} from "./delivery.mjs";
import {inspectLifecycleOutcome} from "./lifecycle-evaluation.mjs";
import {inspectLifecycleConsumption,validLifecycleConsumptionSource,verifyLifecycleConsumptionStage} from "./lifecycle-consumption.mjs";

const hash=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
const fail=code=>Object.assign(new Error(code),{code});
const ensure=(condition,code)=>{if(!condition)throw fail(code);};
const terminal=status=>["SUCCEEDED","FAILED","VALIDATION_FAILED","CANCELLED","INTERRUPTED"].includes(status);
const nativeSource=value=>Boolean(value&&(value.sourceKind===undefined||value.sourceKind==="AGENT")&&value.sourceAttribution===undefined&&value.attribution===undefined);
export const legacyLiveLifecycleContract=Object.freeze({id:"securities-live-agent-reviewed-lifecycle-v1",expectedCaseCount:20,targetRate:0.85,
  scope:"LOCAL_FRESH_MODEL_ENGINEER_REVIEWED",modelEvidenceMode:"LIVE_NEW_TASK",agentIndependentE2E:false,publicDeployed:false,
  stages:["REQUIREMENT","CODE","DEBUG","SCHEDULE_FILE","DEPLOY_FILE","ENGINEER_REVIEW","PUBLISH","MONITOR"]});
export const liveLifecycleContract=Object.freeze({...legacyLiveLifecycleContract,id:"securities-live-agent-reviewed-lifecycle-v2",
  scope:"LOCAL_FRESH_MODEL_ENGINEER_REVIEWED_WITH_CONSUMPTION",externalSystemVerified:false,
  stages:[...legacyLiveLifecycleContract.stages,"CONSUMPTION"]});
export function liveLifecyclePlan(limit=1){
 const cases=m1EvaluationCases();validateM1EvaluationCases(cases);
 ensure(Number.isSafeInteger(limit)&&limit>=1&&limit<=cases.length,"CASE_LIMIT_INVALID");
 return {contract:liveLifecycleContract,caseSetDigest:hash(cases),selectedCases:cases.slice(0,limit),
  maximumModelCalls:limit*3,maximumCodeAndRehearsalSparkRuns:limit*4,maximumReviewedReleaseSparkRuns:limit*2,
  maximumTotalSparkRuns:limit*6,maximumTokenReservation:limit*32000,willExecute:false,
  humanReviewRequired:true,notice:"新需求调用真实模型；文件演练后等待工程师在原任务审阅发布。无默认审批、重试授权或费用授权。"};
}

export async function advanceLiveLifecycleCase(definition,checkpoint,adapter,{save=()=>{},pause=()=>new Promise(resolve=>setTimeout(resolve,1000)),maxPolls=180}={}){
 ensure(checkpoint?.contractId===liveLifecycleContract.id,"CASE_CONTRACT_MISMATCH");
 ensure(Number.isSafeInteger(maxPolls)&&maxPolls>=1&&maxPolls<=600,"POLL_LIMIT_INVALID");
 ensure(checkpoint.caseId===definition.id&&checkpoint.requestDigest===hash({message:definition.request,sql:definition.seedSql,contextId:definition.contextId}),"CASE_CHECKPOINT_MISMATCH");
 ensure(checkpoint.caseSetDigest===liveLifecyclePlan().caseSetDigest,"CASE_SET_CHANGED");
  const state=structuredClone(checkpoint);
 if(adapter.testDouble===true||state.executionEvidenceMode==="TEST_HARNESS")state.executionEvidenceMode="TEST_HARNESS";
 const persist=()=>save(structuredClone(state));
 const mark=(status,phase)=>{state.status=status;state.phase=phase;persist();};
 if(state.phase==="CONSUMPTION"||state.consumptionSource!==undefined||state.consumptionStage!==undefined)
  return refreshLiveLifecycleConsumption(definition,state,adapter,{save});
 async function mutation(name,path,body,recover){
  let action=state.actions[name];
  const bodyHash=hash(body);ensure(!action||action.bodyHash===bodyHash,"MUTATION_INPUT_CHANGED");
  if(action?.id)return {id:action.id};
  if(action){
   let prior;try{prior=await recover();}catch{}
   if(!prior?.id)throw fail("MUTATION_OUTCOME_UNKNOWN");
   action.id=prior.id;action.status="CONFIRMED";persist();return prior;
  }
  action=state.actions[name]={key:randomUUID(),bodyHash,status:"SUBMITTING"};persist();
  try{
   const value=await adapter.request(path,body,action.key);ensure(typeof value?.id==="string","MUTATION_RESPONSE_UNCONFIRMED");
   action.id=value.id;action.status="CONFIRMED";persist();return value;
  }catch(cause){
   let prior;try{prior=await recover();}catch{}
   if(prior?.id){action.id=prior.id;action.status="CONFIRMED";persist();return prior;}
   action.status="UNKNOWN";persist();throw fail("MUTATION_OUTCOME_UNKNOWN");
  }
 }
 async function poll(path,kind){
  for(let count=0;count<maxPolls;count++){
   const current=await adapter.request(path);
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
  if(state.status==="SUCCEEDED"){ensure(verifyLiveCaseEvidence(definition,state),"COMPLETE_EVIDENCE_NOT_VERIFIED");return state;}
  if(state.status==="FAILED")return state;
  if(state.errorCode){state.errorHistory=[...(state.errorHistory??[]),{code:state.errorCode,phase:state.phase}].slice(-20);delete state.errorCode;}
  mark("RUNNING","CODE_AND_DEBUG");
  const body={message:definition.request,sql:definition.seedSql,contextId:definition.contextId};
  const started=await mutation("agent","/agent/tasks",body,()=>adapter.request(`/agent/requests/${state.actions.agent.key}`));
  state.taskId=started.id;persist();
  const task=await poll(`/agent/tasks/${started.id}`,"agent");ensure(task.id===started.id,"FRESH_TASK_SOURCE_MISMATCH");
  ensure(task.status==="SUCCEEDED","AGENT_TASK_NOT_SUCCESSFUL");
  ensure(nativeSource(task)&&task.mode==="LIVE_MODEL"&&task.contextId===definition.contextId&&task.message===definition.request,"FRESH_TASK_SOURCE_MISMATCH");
  ensure(Date.parse(task.createdAt)>=Date.parse(state.evaluationStartedAt),"HISTORICAL_TASK_REJECTED");
  const attempt=task.attempts?.at(-1);
  ensure(attempt?.status==="SUCCEEDED"&&typeof attempt.model==="string"&&!/test.?double|unconfirmed|fixture|stub/i.test(attempt.model)&&task.attempts.length<=3,"LIVE_MODEL_EVIDENCE_REQUIRED");
  ensure(Number.isSafeInteger(task.usedTokens)&&task.usedTokens>=0&&task.usedTokens<=32000,"MODEL_USAGE_NOT_CONFIRMED");
  const workflow=await adapter.request(`/agent/tasks/${task.id}/workflow`);
  ensure(nativeSource(workflow.report)&&workflow.report?.status==="PASSED"&&workflow.report.taskId===task.id&&workflow.report.revisionId===attempt.revisionId&&workflow.report.runId===attempt.runId&&
    ["revision","execution","results","regressions"].every(id=>workflow.report.checks?.some(check=>check.id===id&&check.passed===true)),"RESULT_VERIFICATION_INCOMPLETE");
  const revision=await adapter.request(`/revisions/${attempt.revisionId}`),run=await adapter.request(`/runs/${attempt.runId}`);
  ensure(nativeSource(revision)&&nativeSource(run)&&revision.source==="LIVE_MODEL"&&!revision.manualProvenance&&run.agentTaskId===task.id&&
    revision.id===attempt.revisionId&&revision.hash===hash(revision.sql)&&run.revisionId===revision.id&&run.revisionHash===revision.hash&&
    run.status==="SUCCEEDED"&&run.engine==="Apache Spark"&&run.mainSqlExecuted===true&&run.testDouble!==true&&run.validation?.contractId===validationContractId&&
    run.validation.passed===true&&run.validation.regressions?.length===5&&contextIds.every(id=>run.validation.regressions.some(check=>check.contextId===id&&check.passed)),"CODE_EXECUTION_NOT_VERIFIED");
  state.code={sourceKind:"AGENT",taskId:task.id,createdAt:task.createdAt,revisionId:attempt.revisionId,revisionHash:revision.hash,runId:attempt.runId,model:attempt.model,modelAttempts:task.attempts.length,reportedTokens:task.usedTokens??0};persist();
  mark("RUNNING","DELIVERY_PREPARATION");
  const prepared=await mutation("delivery",`/agent/tasks/${task.id}/prepare-delivery`,{},async()=>{
   const values=await adapter.request(`/agent/deliveries?sourceAgentTaskId=${task.id}`);
   const matches=values.filter(value=>value.sourceRevisionId===attempt.revisionId&&value.sourceRunId===attempt.runId);
   ensure(matches.length===1,"DELIVERY_RECOVERY_AMBIGUOUS");return matches[0];
  });
  const delivery=await poll(`/agent/deliveries/${prepared.id}`,"delivery");
  ensure(nativeSource(delivery)&&delivery.status==="SUCCEEDED"&&delivery.sourceAgentTaskId===task.id&&delivery.sourceRunId===attempt.runId&&delivery.sourceRevisionId===attempt.revisionId,"DELIVERY_NOT_VERIFIED");
  const current=await adapter.request(`/agent/tasks/${task.id}/workflow`);
  const bundle=current.package,verification=current.verification;
  ensure(nativeSource(bundle)&&nativeSource(bundle.manifest?.source)&&bundle?.id===delivery.packageId&&bundle.digest===delivery.packageDigest&&bundle.manifest?.source?.revisionId===attempt.revisionId&&bundle.manifest.source.runId===attempt.runId,"DELIVERY_SOURCE_MISMATCH");
  ensure(nativeSource(verification)&&verification?.id===delivery.verificationId&&verification.status==="SUCCEEDED"&&verification.engine==="Apache Spark"&&verification.mainSqlExecuted===true&&verification.testSqlValidation?.passed===true&&
    verification.validation?.passed===true&&contextIds.every(id=>verification.validation.regressions?.some(check=>check.contextId===id&&check.passed)),"FILE_REHEARSAL_INCOMPLETE");
  ensure(deliveryFiles.every(name=>typeof bundle.files?.[name]==="string"&&bundle.files[name].length>0),"DELIVERY_FILES_MISSING");
  try{validateDeliveryPackage(bundle,bundle.digest);}catch{throw fail("DELIVERY_MANIFEST_NOT_VERIFIED");}
  state.delivery={id:delivery.id,packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id};persist();
  mark("AWAITING_ENGINEER_REVIEW","ENGINEER_REVIEW_AND_PUBLICATION");
  const publication=await adapter.request(`/agent/tasks/${task.id}/publication`),release=publication.release;
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
  ensure(nativeSource(detail)&&new Set(batches.map(run=>run.id)).size===2&&batches.every(run=>nativeSource(run)&&nativeSource(run.source)&&run.releaseId===release.id&&run.packageId===bundle.id&&run.packageDigest===bundle.digest&&run.status==="SUCCEEDED"&&run.engine==="Apache Spark"&&run.mainSqlExecuted===true&&run.testDouble!==true&&
    run.schedulerTriggered===true&&run.clockMode==="WALL_CLOCK_TIMER"&&run.testSqlValidation?.passed===true&&run.testSqlValidation.sqlHash===hash(bundle.files["tests.sql"])&&
    run.source?.validationContractId===validationContractId&&run.source.revisionId===revision.id&&run.source.runId===attempt.runId&&run.source.sqlHash===revision.hash&&
    run.fileHashes?.["main.sql"]===hash(bundle.files["main.sql"])&&run.fileHashes?.["tests.sql"]===hash(bundle.files["tests.sql"])&&
    run.validation?.passed===true&&contextIds.every(id=>run.validation.regressions?.some(check=>check.contextId===id&&check.passed))),"PUBLISHED_BATCH_EVIDENCE_INCOMPLETE");
  ensure(detail.health==="HEALTHY"&&detail.successfulRunCount===2&&!publication.alerts.some(alert=>alert.status==="OPEN")&&batches.every(run=>publication.events.some(event=>event.type==="BATCH_SUCCEEDED"&&event.releaseRunId===run.id&&event.releaseId===release.id&&event.packageDigest===bundle.digest&&Date.parse(event.observedAt)>=Date.parse(run.finishedAt))),"POST_RELEASE_MONITORING_INCOMPLETE");
  state.publication={sourceKind:"AGENT",releaseId:release.id,reviewId:review.id,approvalId:approval.id,batchIds:batches.map(run=>run.id),eventIds:publication.events.filter(event=>event.type==="BATCH_SUCCEEDED").map(event=>event.id)};
  const outcome={caseId:definition.id,contextId:definition.contextId,category:definition.category,sourceAgentTaskId:task.id,
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
  return refreshLiveLifecycleConsumption(definition,state,adapter,{save});
 }catch(cause){
  state.code=state.code??undefined;
  state.errorCode=/^[A-Z0-9_]{1,80}$/.test(cause.code??"")?cause.code:"EVALUATION_UNCONFIRMED";
  state.status=["MUTATION_OUTCOME_UNKNOWN","MODEL_OUTCOME_UNKNOWN","MODEL_NOT_SENT","ADVANCE_OUTCOME_UNKNOWN","STAGE_WAIT_EXPIRED","EVALUATION_UNCONFIRMED","API_REQUEST_UNCONFIRMED","API_RESPONSE_UNCONFIRMED"].includes(state.errorCode)?"PAUSED":"FAILED";
  persist();
 }
 return state;
}

export function liveCaseCheckpoint(definition,evaluationStartedAt,caseSetDigest){
 return {contractId:liveLifecycleContract.id,caseId:definition.id,caseSetDigest,evaluationStartedAt,requestDigest:hash({message:definition.request,sql:definition.seedSql,contextId:definition.contextId}),status:"NOT_RUN",phase:"REQUIREMENT",actions:{}};
}
function verifyCodeThroughMonitoring(definition,state){
 const source=state.code;
 if(!source||state.caseId!==definition.id||state.caseSetDigest!==liveLifecyclePlan().caseSetDigest||state.requestDigest!==hash({message:definition.request,sql:definition.seedSql,contextId:definition.contextId})||
   state.actions?.agent?.id!==source.taskId||state.taskId!==source.taskId||Date.parse(source.createdAt)<Date.parse(state.evaluationStartedAt)||
   !Number.isFinite(Date.parse(source.createdAt))||!Number.isFinite(Date.parse(state.evaluationStartedAt))||!Number.isSafeInteger(source.modelAttempts)||source.modelAttempts<1||source.modelAttempts>3||
   typeof source.model!=="string"||/test.?double|unconfirmed|fixture|stub/i.test(source.model)||!/^[a-f0-9]{64}$/.test(source.revisionHash??""))return false;
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
export function verifyLiveCaseEvidence(definition,state,{contractId=liveLifecycleContract.id}={}){
 if(contractId===legacyLiveLifecycleContract.id)
  return Boolean(state&&(state.contractId===undefined||state.contractId===legacyLiveLifecycleContract.id)&&verifyCodeThroughMonitoring(definition,state));
 if(contractId!==liveLifecycleContract.id||state?.contractId!==contractId||!verifyCodeThroughMonitoring(definition,state))return false;
 const source=consumptionSourceForState(state);
 return validLifecycleConsumptionSource(source)&&JSON.stringify(source)===JSON.stringify(state.consumptionSource)&&verifyLifecycleConsumptionStage(source,state.consumptionStage);
}

// Read-only navigation shares the evaluator's established source checks. A URL
// is not execution authority; the destination still rechecks persisted records.
export function validatedLiveConsumptionSource(definition,state){
 if(state?.contractId!==liveLifecycleContract.id||!verifyCodeThroughMonitoring(definition,state))return;
 if(state.status==='SUCCEEDED'){
  if(state.phase!=='COMPLETE'||!verifyLiveCaseEvidence(definition,state))return;
 }else if(state.phase!=='CONSUMPTION'||!['AWAITING_CONSUMPTION','PAUSED'].includes(state.status))return;
 const source=consumptionSourceForState(state);
 if(validLifecycleConsumptionSource(source)&&JSON.stringify(source)===JSON.stringify(state.consumptionSource))return structuredClone(source);
}

// This is the only continuation after monitoring has passed. The exact URL is
// rebuilt from the immutable checkpoint and the adapter is never given a body.
// No model/Spark readiness, mutation, authorization or service invocation occurs.
export async function refreshLiveLifecycleConsumption(definition,checkpoint,adapter,{save=()=>{}}={}){
 ensure(checkpoint?.contractId===liveLifecycleContract.id,"CASE_CONTRACT_MISMATCH");
 ensure(verifyCodeThroughMonitoring(definition,checkpoint),"CONSUMPTION_CHECKPOINT_INVALID");
 const source=consumptionSourceForState(checkpoint);
 ensure(validLifecycleConsumptionSource(source)&&JSON.stringify(source)===JSON.stringify(checkpoint.consumptionSource),"CONSUMPTION_CHECKPOINT_INVALID");
 if(checkpoint.status==="SUCCEEDED"){
  ensure(checkpoint.phase==="COMPLETE"&&verifyLiveCaseEvidence(definition,checkpoint),"COMPLETE_EVIDENCE_NOT_VERIFIED");
  return structuredClone(checkpoint);
 }
 ensure(checkpoint.phase==="CONSUMPTION"&&["AWAITING_CONSUMPTION","PAUSED"].includes(checkpoint.status),"CONSUMPTION_CHECKPOINT_INVALID");
 const state=structuredClone(checkpoint);
 if(adapter.testDouble===true||state.executionEvidenceMode==="TEST_HARNESS")state.executionEvidenceMode="TEST_HARNESS";
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
 state.consumptionStage=checked;
 state.status=checked.status==="PASSED"?"SUCCEEDED":"AWAITING_CONSUMPTION";
 state.phase=checked.status==="PASSED"?"COMPLETE":"CONSUMPTION";
 if(checked.status!=="PASSED")state.errorCode=checked.code;
 ensure(checked.status!=="PASSED"||verifyLiveCaseEvidence(definition,state),"COMPLETE_EVIDENCE_NOT_VERIFIED");
 save(structuredClone(state));return state;
}

export function summarizeLiveLifecycle(cases,outcomes,{testDouble=false,contractId=liveLifecycleContract.id}={}){
 const contract=contractId===liveLifecycleContract.id?liveLifecycleContract:contractId===legacyLiveLifecycleContract.id?legacyLiveLifecycleContract:undefined;
 ensure(contract,"CASE_CONTRACT_MISMATCH");
 const all=m1EvaluationCases();validateM1EvaluationCases(cases);
 ensure(Array.isArray(outcomes)&&new Set(outcomes.map(item=>item.caseId)).size===outcomes.length&&outcomes.every(item=>all.some(definition=>definition.id===item.caseId)),"OUTCOME_CASE_SET_INVALID");
 ensure(outcomes.every(item=>item.contractId===contractId||contractId===legacyLiveLifecycleContract.id&&item.contractId===undefined),"CASE_CONTRACT_MISMATCH");
 const simulated=testDouble||outcomes.some(item=>item.executionEvidenceMode==="TEST_HARNESS");
 const succeeded=simulated?0:outcomes.filter(item=>item.status==="SUCCEEDED"&&verifyLiveCaseEvidence(all.find(definition=>definition.id===item.caseId),item,{contractId})).length;
 const attempted=outcomes.filter(item=>item.actions?.agent).length,completed=outcomes.filter(item=>item.taskId&&item.taskId===item.actions?.agent?.id&&["SUCCEEDED","FAILED"].includes(item.status)).length;
 return {contract,executionEvidenceMode:simulated?"TEST_HARNESS":"LIVE_NEW_TASK",succeededCaseCount:succeeded,failedCaseCount:outcomes.filter(item=>item.status==="FAILED").length,
  awaitingReviewCaseCount:outcomes.filter(item=>item.status==="AWAITING_ENGINEER_REVIEW").length,awaitingMonitoringCaseCount:outcomes.filter(item=>item.status==="AWAITING_MONITORING").length,
  awaitingConsumptionCaseCount:outcomes.filter(item=>item.status==="AWAITING_CONSUMPTION").length,
  pausedCaseCount:outcomes.filter(item=>item.status==="PAUSED").length,unconfirmedSubmissionCount:outcomes.filter(item=>item.actions?.agent?.status==="UNKNOWN").length,
  attemptedCaseCount:attempted,completedCaseCount:completed,unexecutedCaseCount:all.length-attempted,
  frozenCaseCount:all.length,completionRate:succeeded/all.length,targetMet:!simulated&&completed===all.length&&succeeded/all.length>=0.85,
  agentIndependentE2E:false,publicDeployed:false,externalSystemVerified:false,
  notice:contractId===legacyLiveLifecycleContract.id?"旧版本机新任务评测只覆盖至监控，不含消费检查；按旧范围保留，不升级为新版或云端验收。":
   "当前分数属于新任务、真实模型、工程师审阅和同源内部消费对照的本机链路；测试替身、人工救援、历史回放和无审阅上线不计成功，不代表外部客户端或云端验收。"};
}
