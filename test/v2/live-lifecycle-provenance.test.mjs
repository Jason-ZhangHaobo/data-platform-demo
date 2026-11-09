import test from 'node:test';
import assert from 'node:assert/strict';
import {liveEvidenceProvenance} from '../../src/v2/live-lifecycle-provenance.mjs';
import {liveLifecycleCases,currentLiveLifecycleContract,advanceLiveLifecycleCase,refreshLiveLifecycleConsumption,
  verifyLiveCaseEvidence,summarizeLiveLifecycle} from '../../src/v2/live-lifecycle-evaluation.mjs';
import {createLiveLifecycleFixture} from './fixtures/live-lifecycle-case.mjs';

// Deliberately unflagged synthetic transports falsify provenance checks. These
// fixtures never call a provider/Spark and are not real acceptance evidence.
const contractId=currentLiveLifecycleContract.id,catalog=liveLifecycleCases(contractId);
const fixture=()=>{const f=createLiveLifecycleFixture({definition:catalog[0],contractId});delete f.adapter.testDouble;return f;};
const advance=(f,state=f.checkpoint)=>advanceLiveLifecycleCase(f.definition,state,f.adapter,{pause:async()=>{},maxPolls:2});
async function complete(f=fixture()){
 const waiting=await advance(f);assert.equal(waiting.status,'AWAITING_ENGINEER_REVIEW',waiting.errorCode);
 f.reviewNow();f.consumeNow();const state=await advance(f,waiting);assert.equal(state.status,'SUCCEEDED',state.errorCode);return {f,state};
}
const summary=state=>summarizeLiveLifecycle(catalog,[state],{contractId});

test('provider attempt, rehearsal, batch and consumption metadata disclose nested doubles without a transport flag',async()=>{
 for(const mutate of [f=>{f.task.attempts[0].testDouble=true;},f=>{f.verification.synthetic=true;},
  f=>{f.batches[0].source={...f.batches[0].source,testDouble:true};},f=>{f.events[0].synthetic=true;},
  f=>{f.run.validation.regressions[0].synthetic=true;},
  f=>{f.consumption.services[0].call.testDouble=true;},f=>{f.consumption.services[0].sourceVersions[0].synthetic=true;}]){
  const f=fixture();mutate(f);const {state}=await complete(f),result=summary(state);
  assert.equal(state.executionEvidenceMode,'TEST_HARNESS');assert.equal(result.executionEvidenceMode,'TEST_HARNESS');
  assert.equal(result.succeededCaseCount,0);assert.equal(result.targetMet,false);assert.equal(result.fullGoalTargetMet,false);
 }
});

test('mock/synthetic provider labels cannot satisfy live-model evidence',async()=>{
 for(const model of ['mock-qwen','synthetic-qwen','Qwen-test-double','fixture-provider','unconfirmed']){
  const f=fixture();f.task.attempts[0].model=model;const state=await advance(f);
  assert.equal(state.status,'FAILED');assert.equal(state.errorCode,'LIVE_MODEL_EVIDENCE_REQUIRED');
  assert.equal(state.executionEvidenceMode,'TEST_HARNESS');assert.equal(summary(state).succeededCaseCount,0);
  assert.deepEqual(f.mutations,['/agent/tasks']);
 }
});

test('manual rescue and service-planning declarations stop the native chain even with an AGENT label',async()=>{
 for(const fields of [{manualContinuation:{kind:'MANUAL_SUCCESS_REFERENCE'}},{assistedContinuation:{}},
  {repairComparison:{}},{developmentReference:{}},{manualDeliveryTaskId:'manual-task'},
  {executionMode:'DURABLE_PRIVATE_SERVICE_AGENT_V1'},{completionScope:'DATA_SERVICE_DESIGN'}]){
  const f=fixture();Object.assign(f.task,{sourceKind:'AGENT',...fields});const state=await advance(f);
  assert.equal(state.status,'FAILED');assert.equal(state.errorCode,'NON_NATIVE_EVIDENCE_REJECTED');
  assert.equal(summary(state).succeededCaseCount,0);assert.equal(summary(state).rejectedProvenanceCaseCount,1);assert.deepEqual(f.mutations,['/agent/tasks']);
 }
});

test('saved reports reject manual provenance at each stage, not just on the task label',async()=>{
 const {state}=await complete();assert.equal(verifyLiveCaseEvidence(catalog[0],state),true);
 for(const [path,fields] of [
  [['code'],{manualProvenance:{kind:'ENGINEER_EDIT'}}],
  [['delivery'],{manualDeliveryTaskId:'manual-task'}],
  [['publication'],{source:{kind:'MANUAL_RUN'}}],
  [['lifecycleOutcome','stages','codeAndDebug'],{repairComparison:{}}],
  [['lifecycleOutcome','stages','engineerReview'],{sourceAttribution:'ENGINEER_ASSISTED'}],
  [['consumptionStage','evidence','services',0,'call'],{manualContinuation:{}}],
 ]){
  const saved=structuredClone(state);let target=saved;for(const key of path)target=target[key];Object.assign(target,fields);
  assert.equal(verifyLiveCaseEvidence(catalog[0],saved),false,JSON.stringify(path));
  const result=summary(saved);assert.equal(result.rejectedProvenanceCaseCount,1);assert.equal(result.succeededCaseCount,0);
 }
});

test('a saved nested synthetic marker and a synthetic model label cannot be reclassified by reporting',async()=>{
 const {state}=await complete();
 for(const [path,fields] of [[['code'],{model:'synthetic-qwen'}],
  [['lifecycleOutcome','stages','codeAndDebug'],{testDouble:true}],
  [['consumptionStage','evidence','services',0,'call'],{synthetic:true}]]){
  const saved=structuredClone(state);let target=saved;for(const key of path)target=target[key];Object.assign(target,fields);
  const result=summary(saved);assert.equal(result.measurementStatus,'TEST_HARNESS');assert.equal(result.succeededCaseCount,0);
  assert.equal(result.targetMet,false);assert.equal(result.autonomousCompletionRate,null);
 }
});

test('read-only consumption refresh rejects a concealed manual source and remembers a nested synthetic call',async()=>{
 for(const fields of [{manualDeliveryTaskId:'manual-task'},{testDouble:true}]){
  const f=fixture(),waiting=await advance(f);f.reviewNow();
  const pending=await advance(f,waiting);assert.equal(pending.status,'AWAITING_CONSUMPTION');
  f.consumeNow();Object.assign(f.consumption.services[0].call,fields);const writes=[...f.mutations],reads=f.reads.length;
  const state=await refreshLiveLifecycleConsumption(f.definition,pending,f.adapter);
  assert.deepEqual(f.mutations,writes);assert.equal(f.reads.length,reads+1);
  if(fields.testDouble)assert.equal(state.executionEvidenceMode,'TEST_HARNESS');
  else {assert.equal(state.status,'AWAITING_CONSUMPTION');assert.equal(state.errorCode,'CONSUMPTION_EVIDENCE_INVALID');}
  assert.equal(summary(state).succeededCaseCount,0);
 }
});

test('temporary queued receipts retain their synthetic provenance after the terminal receipt changes',async()=>{
 const f=fixture(),original=f.adapter.request,saved=[];let observed=false;
 f.adapter.request=async(path,...args)=>{
  const result=await original(path,...args);
  if(path===`/agent/tasks/${f.task.id}`&&!observed){observed=true;return {...result,status:'QUEUED',attempts:[{testDouble:true}]};}
  return result;
 };
 const waiting=await advanceLiveLifecycleCase(f.definition,f.checkpoint,f.adapter,{maxPolls:2,save:state=>saved.push(structuredClone(state)),
  pause:async()=>assert.equal(saved.at(-1).executionEvidenceMode,'TEST_HARNESS','disclose before a pause/crash, not only when a terminal stage is saved')});
 assert.equal(waiting.status,'AWAITING_ENGINEER_REVIEW');f.reviewNow();f.consumeNow();
 const state=await advance(f,waiting);assert.equal(state.status,'SUCCEEDED');assert.equal(state.executionEvidenceMode,'TEST_HARNESS');assert.equal(summary(state).succeededCaseCount,0);
});

test('fictional business data and required engineer review are not confused with execution substitutes or rescue',async()=>{
 const f=fixture();f.task.rows=[{synthetic:true,sourceKind:'MANUAL'}];f.task.messageMetadata={mock:true};
 f.run.rows[0].synthetic=true;f.review.attestations.code=true;
 const {state}=await complete(f);assert.equal(state.executionEvidenceMode,undefined);
 assert.deepEqual(liveEvidenceProvenance({rows:[{testDouble:true}],fixtures:{manualDeliveryTaskId:'example'},sql:'-- synthetic',
  files:{'main.sql':'-- mock'},message:'synthetic fictional securities',expected:{sourceKind:'MANUAL'}}),
  {synthetic:false,nonNative:false,unconfirmed:false});
 const result=summary(state);assert.equal(result.measurementStatus,'RECORDED_EVIDENCE_ONLY');assert.equal(result.fullGoalTargetMet,false);
 assert.equal(result.autonomousCompletionRate,null);assert.equal(result.agentIndependentE2E,false);assert.equal(result.publicDeployed,false);
});

test('unmeasured plans and oversized provenance cannot silently become a measured target',()=>{
 const result=summarizeLiveLifecycle(catalog,[],{contractId});assert.equal(result.measurementStatus,'NOT_RUN');
 assert.equal(result.autonomousCompletionRate,null);assert.equal(result.fullGoalTargetMet,false);assert.equal(result.unexecutedCaseCount,20);
 assert.equal(liveEvidenceProvenance({attempts:Array.from({length:4097},()=>({}))}).unconfirmed,true);
 const cyclic={};cyclic.source=cyclic;assert.equal(liveEvidenceProvenance(cyclic).unconfirmed,false);
});
