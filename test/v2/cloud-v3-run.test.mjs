import test from "node:test";
import assert from "node:assert/strict";
import { cloudV3CompletionReceipt, cloudV3CompletionScope, cloudV3FailureReceipt, summarizeCloudV3Progress } from "../../scripts/cloud-v3-run.mjs";
import { currentLiveLifecycleContract } from "../../src/v2/live-lifecycle-evaluation.mjs";
import {cloudV3PhaseAttribution} from '../../src/v2/cloud-v3-phase-attribution.mjs';

test("an HTTPS completion requires both matched batches and the original approved application", () => {
  const source = "a".repeat(40);
  const state = { origin: "https://fixture.example", reviewedSource: source, submission: {
    windowApprovalDigest: "b".repeat(64),
    application: { applicationSource: source, inspectionDigest: "c".repeat(64) },
  } };
  const matched = [{ status: "MATCHED" }, { status: "MATCHED" }];
  const local = [{ status: "MATCHED_ONLY" }, { status: "MATCHED_ONLY" }];
  assert.equal(cloudV3CompletionScope(state, matched), "INVITED_CLOUD_MATCHED");
  assert.equal(cloudV3CompletionScope({ origin: "http://127.0.0.1:3100" }, local), "LOCAL_MATCHED_ONLY");
  for (const input of [matched.slice(0, 1), local, [matched[0], local[1]]])
    assert.throws(() => cloudV3CompletionScope(state, input));
  assert.throws(() => cloudV3CompletionScope({ ...state, reviewedSource: "d".repeat(40) }, matched));
  assert.throws(() => cloudV3CompletionScope({ ...state, submission: undefined }, matched));
});

test("a settled failure is separately classified and binds the original HTTPS application", () => {
  const source="a".repeat(40), taskId="00000000-0000-4000-8000-000000000001";
  const timestamp=new Date().toISOString(), item={taskId,caseId:"fixture-case",evaluationStartedAt:timestamp,
    actions:{agent:{status:"CONFIRMED",id:taskId}}};
  const state={origin:"https://fixture.example",reviewedSource:source,submission:{
    windowApprovalDigest:"b".repeat(64),application:{applicationSource:source,inspectionDigest:"c".repeat(64)},
  }};
  const original={state,text:"fixture checkpoint"};
  const failure={stage:"FAILED",taskVersion:4,finishedAt:timestamp,modelAttempts:1,ledgerTokens:12,
    sparkRunIds:[],sparkDurationMs:0};
  assert.equal(cloudV3FailureReceipt(original,item,failure,timestamp).scope,"INVITED_CLOUD_SETTLED_FAILURE");
  assert.throws(()=>cloudV3FailureReceipt({...original,state:{...state,submission:undefined}},item,failure,timestamp));
  assert.throws(()=>cloudV3FailureReceipt(original,{...item,actions:{...item.actions,delivery:{status:"UNKNOWN"}}},failure,timestamp));
  assert.throws(()=>cloudV3FailureReceipt(original,item,{...failure,sparkDurationMs:100},timestamp));
});

test("reviewed cloud scoring keeps the frozen denominator and waits for all original cases to settle", () => {
  const score = statuses => summarizeCloudV3Progress(currentLiveLifecycleContract,
    statuses.map((status,index)=>({status,caseId:String(index)})));
  const successes = Array(17).fill("CLOUD_CHAIN_VERIFIED");
  const incomplete = score([...successes,"CLOUD_FAILURE_SETTLED","SOURCE_FAILED","TEST_HARNESS"]);
  assert.equal(incomplete.requiredSuccesses,17);
  assert.equal(incomplete.reviewedCloudSuccesses,17);
  assert.equal(incomplete.settledCloudFailures,1);
  assert.equal(incomplete.cloudSourceBlocked,1);
  assert.equal(incomplete.testHarnessCases,1);
  assert.equal(incomplete.pendingCloudCases,1);
  assert.equal(incomplete.cloudCoverage,0.9);
  assert.equal(incomplete.reviewedCloudCompletionRate,null);
  assert.equal(incomplete.reviewedCloudTargetStatus,"INCOMPLETE_BLOCKED_SOURCE");
  const met = score([...successes,...Array(3).fill("CLOUD_FAILURE_SETTLED")]);
  assert.equal(met.reviewedCloudCompletionRate,0.85);
  assert.equal(met.reviewedCloudTargetStatus,"MET");
  assert.equal(met.directAutonomousCompletionRate,null);
  assert.equal(met.recordedPhaseAttributionCases,0);
  assert.equal(met.fullGoalTargetMet,false);
  assert.equal(score([...successes.slice(1),...Array(4).fill("CLOUD_FAILURE_SETTLED")]).reviewedCloudTargetStatus,"NOT_MET");
  assert.throws(()=>score(successes),/冻结案例分母/);
  assert.throws(()=>summarizeCloudV3Progress(currentLiveLifecycleContract,Array(20).fill({caseId:"duplicate"})),/冻结案例分母/);
});

test("cloud completion cannot be created from consumer matches alone, unsettled model usage or missing human review timing", () => {
  const id = n => "00000000-0000-4000-8000-"+String(n).padStart(12,"0");
  const time = second => new Date(Date.UTC(2026,8,1,0,0,second)).toISOString();
  const hex = n => n.toString(16).padStart(64,"0");
  const source="a".repeat(40), taskId=id(1), batchIds=[id(8),id(9)];
  const state={origin:"https://fixture.example",reviewedSource:source,submission:{submittedAt:time(0),
    windowApprovalDigest:hex(1),application:{applicationSource:source,inspectionDigest:hex(2)}}};
  const original={state,text:"synthetic scoring fixture"};
  const item={taskId,caseId:"fixture",requestDigest:hex(3),
    code:{taskId,sourceKind:"AGENT",model:"qwen3-coder-plus",createdAt:time(1),revisionId:id(2),runId:id(3),revisionHash:hex(4),
      requirementBinding:{protocol:"shuduo-sql-requirements/v1",taskId,basisDigest:hex(5),reportDigest:hex(6)},
      modelAttempts:1,accountedTokens:12,reportedTokens:12,reservedTokens:0,unattributedTokens:0},
    rehearsal:{id:id(6),status:"SUCCEEDED",stage:"AWAITING_ENGINEER_REVIEW"},
    actions:{agent:{id:taskId,status:"CONFIRMED"},delivery:{id:id(4),packageId:id(5),packageDigest:hex(7),status:"CONFIRMED"},
      publication:{id:id(7),status:"CONFIRMED",packageId:id(5),packageDigest:hex(7),verificationId:id(6),sourceRunId:id(3),
        reviewId:id(10),approvalId:id(11),reviewDigest:hex(8),batchIds,
        approvalTiming:{readyAt:time(2),reviewedAt:time(4),approvedAt:time(4)},
        monitoring:batchIds.map((batchId,index)=>({batchId,eventId:id(12+index),observedAt:time(6+index)}))}},
    consumption:Object.fromEntries(batchIds.map((batchId,index)=>[batchId,{batchId,status:"MATCHED",
      ...Object.fromEntries(["sourceDigest","planDigest","reportDigest","dapiCallIdDigest","xapiCallIdDigest",
        "dapiRowsDigest","xapiRowsDigest"].map((key,offset)=>[key,hex(20+index*10+offset)]))}]))};
  const historical=cloudV3CompletionReceipt(original,item,time(9));
  assert.equal(historical.scope,"INVITED_CLOUD_MATCHED");
  assert.equal(historical.deliveryPreparationEvidence,undefined);
  assert.equal(historical.publicationInitiationEvidence,undefined);
  const withSchedule=structuredClone(item);
  const preparationEvidence={trigger:"SIGNED_BACKGROUND_EVENT",taskId:withSchedule.taskId,
    revisionId:withSchedule.code.revisionId,revisionHash:withSchedule.code.revisionHash,developmentRunId:withSchedule.code.runId,
    deliveryId:withSchedule.actions.delivery.id,packageId:withSchedule.actions.delivery.packageId,
    packageDigest:withSchedule.actions.delivery.packageDigest};
  withSchedule.actions.delivery.preparationEvidence=preparationEvidence;
  withSchedule.actions.publication.scheduledBatches=batchIds.map((batchId,index)=>({
    batchId,clockMode:"FC_TIMER",scheduledTriggerAt:time(4),triggeredAt:time(5),
    finishedAt:time(6+index),workerResultDigest:hex(60+index),
  }));
  const initiation={trigger:"INVITED_SESSION_CONFIRMATION",originalRequestDigest:hex(73),acceptedAt:time(4),
    taskId,revisionId:withSchedule.code.revisionId,developmentRunId:withSchedule.code.runId,
    releaseId:withSchedule.actions.publication.id,approvalId:withSchedule.actions.publication.approvalId,
    packageDigest:withSchedule.actions.publication.packageDigest,reviewDigest:withSchedule.actions.publication.reviewDigest};
  withSchedule.actions.publication.initiationEvidence=initiation;
  const receipt=cloudV3CompletionReceipt(original,withSchedule,time(9));
  assert.equal(receipt.scope,"INVITED_CLOUD_MATCHED");
  assert.deepEqual(receipt.deliveryPreparationEvidence,preparationEvidence);
  assert.deepEqual(receipt.publicationInitiationEvidence,initiation);
  const phaseInput=structuredClone(withSchedule);
  phaseInput.developmentDriverEvidence={taskId,revisionId:phaseInput.code.revisionId,developmentRunId:phaseInput.code.runId,
    attempts:[{attempt:1,modelTrigger:'SIGNED_BACKGROUND_EVENT',spark:{runId:phaseInput.code.runId,submissionTriggers:['SIGNED_BACKGROUND_EVENT']}}]};
  phaseInput.actions.publication.initiationEvidence={...initiation,trigger:'SIGNED_PUBLICATION_WAKE',wakeId:id(28)};
  const phases=cloudV3PhaseAttribution(phaseInput,{approvalTimingVerified:true});
  assert.deepEqual(phases.phases,{requirements:'STRUCTURED_MODEL_RESULT',code:'SIGNED_BACKGROUND_EVENT',sparkDebugging:'SIGNED_BACKGROUND_EVENT',
    deliveryFiles:'SIGNED_BACKGROUND_EVENT',fileRehearsal:'ORIGIN_UNCONFIRMED',publication:'SIGNED_PUBLICATION_WAKE',
    schedulingAndMonitoring:'FC_TIMER_AND_SIGNED_WORKER_RESULT',authorizedConsumption:'MATCHED_RESULTS_CALLER_UNCONFIRMED'});
  assert.deepEqual(phases.approval,{status:'RECORDED',waitMs:2000});
  assert.equal(phases.directAutonomousEligible,false);
  assert.deepEqual(phases.unconfirmedAutonomousStages,['fileRehearsal','authorizedConsumption']);
  const revised=structuredClone(phaseInput);
  revised.developmentDriverEvidence.attempts[0].spark.submissionTriggers.push('OWNER_ADVANCE');
  revised.humanClarified=true;
  const mixed=cloudV3PhaseAttribution(revised,{approvalTimingVerified:true});
  assert.equal(mixed.phases.sparkDebugging,'MULTIPLE_DRIVERS_RECORDED');
  assert.equal(mixed.ownerAdvanceRecorded,true);
  assert.equal(mixed.intervention,'BUSINESS_CLARIFICATION');
  const rescued=cloudV3PhaseAttribution({...revised,manualContinuation:{revisionId:id(29)}});
  assert.equal(rescued.intervention,'ENGINEER_RESCUE');
  assert.equal(rescued.businessClarificationRecorded,true);
  assert.equal(cloudV3PhaseAttribution({...phaseInput,code:{...phaseInput.code,sourceKind:'MANUAL'}}).intervention,'NON_NATIVE_SOURCE');
  const withoutInitiation=structuredClone(phaseInput);
  delete withoutInitiation.actions.publication.initiationEvidence;
  const historicalPhases=cloudV3PhaseAttribution(withoutInitiation).phases;
  assert.equal(historicalPhases.publication,'ORIGIN_UNCONFIRMED');
  assert.equal(historicalPhases.schedulingAndMonitoring,'FC_TIMER_AND_SIGNED_WORKER_RESULT');
  assert.equal(cloudV3PhaseAttribution({...phaseInput,developmentDriverEvidence:undefined}).phases.code,'ORIGIN_UNCONFIRMED');
  assert.equal(cloudV3PhaseAttribution({...phaseInput,code:{...phaseInput.code,model:'synthetic'}}).executionEvidence,'TEST_HARNESS');
  assert.equal(cloudV3PhaseAttribution({actions:{agent:{status:'PREPARED'}}}),undefined);
  for(const invalid of [{trigger:"AGENT"}, {approvalId:id(99)}, {acceptedAt:time(6)}]){
    const wrong=structuredClone(withSchedule);
    Object.assign(wrong.actions.publication.initiationEvidence,invalid);
    assert.throws(()=>cloudV3CompletionReceipt(original,wrong,time(9)));
  }
  const incorrectPreparation=structuredClone(withSchedule);
  incorrectPreparation.actions.delivery.preparationEvidence.packageId=id(25);
  assert.throws(()=>cloudV3CompletionReceipt(original,incorrectPreparation,time(9)));
  for(const invalidate of [
    batches=>{batches[0].clockMode="MANUAL";},
    batches=>{batches[0].triggeredAt=time(3);},
    batches=>{batches[0].finishedAt=time(8);},
    batches=>{batches[0].workerResultDigest=batches[1].workerResultDigest;},
  ]){
    const altered=structuredClone(withSchedule);
    invalidate(altered.actions.publication.scheduledBatches);
    assert.throws(()=>cloudV3CompletionReceipt(original,altered,time(9)));
  }
  for (const mutate of [
    value=>delete value.code.requirementBinding,
    value=>{value.code.reservedTokens=12;},
    value=>delete value.actions.publication.approvalTiming,
    value=>{value.actions.publication.approvalTiming.approvedAt=time(1);},
    value=>{value.actions.publication.monitoring[0].batchId=batchIds[1];},
    value=>{value.actions.publication.cancelled=true;},
    value=>{value.humanClarified=true;},
    value=>{value.code.model="fixture";},
    value=>{value.consumption[batchIds[0]].dapiCallIdDigest=value.consumption[batchIds[1]].dapiCallIdDigest;},
  ]) {
    const bad=structuredClone(item);
    mutate(bad);
    assert.throws(()=>cloudV3CompletionReceipt(original,bad,time(9)));
  }
});
