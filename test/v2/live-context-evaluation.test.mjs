import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {m1EvaluationCases} from '../../src/v2/evaluation.mjs';
import {allContextIds,contextIds,validationFamilyForContext} from '../../src/v2/context.mjs';
import {liveContextEvaluationCases,validateLiveContextEvaluationCases} from '../../src/v2/live-evaluation-cases.mjs';
import {liveLifecyclePlan,liveLifecycleCases,currentLiveLifecycleContract,liveLifecycleContract,legacyLiveLifecycleContract,
 advanceLiveLifecycleCase,verifyLiveCaseEvidence,summarizeLiveLifecycle,refreshLiveLifecycleConsumption} from '../../src/v2/live-lifecycle-evaluation.mjs';
import {createLiveLifecycleFixture} from './fixtures/live-lifecycle-case.mjs';

const contractId=currentLiveLifecycleContract.id,catalog=liveContextEvaluationCases();
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const v3=(definition=catalog[0],options={})=>createLiveLifecycleFixture({definition,contractId,...options});
const advance=(f,state=f.checkpoint,sourceCheckpoint)=>advanceLiveLifecycleCase(f.definition,state,f.adapter,{pause:async()=>{},maxPolls:2,sourceCheckpoint});
async function complete(f,sourceCheckpoint){
 const waiting=await advance(f,f.checkpoint,sourceCheckpoint);assert.equal(waiting.status,'AWAITING_ENGINEER_REVIEW',waiting.errorCode);
 f.reviewNow();f.consumeNow();const state=await advance(f,waiting,sourceCheckpoint);assert.equal(state.status,'SUCCEEDED',state.errorCode);return state;
}
async function parentAndChild(options={}){
 const parent=v3(),parentState=await complete(parent),definition=catalog.find(item=>item.sourceCaseId===parent.definition.id);
 const child=v3(definition,{parent,timeOffset:300,evaluationStartedAt:parent.checkpoint.evaluationStartedAt,
  derivedFrom:{kind:'REGISTERED_CONTEXT_CHANGE',taskId:parent.task.id,revisionId:parent.revision.id,runId:parent.run.id,revisionHash:parent.revision.hash,
   contextId:parent.definition.contextId,validationContractId:validationFamilyForContext(parent.definition.contextId).id},...options});
 return {parent,parentState,child};
}

test('v3 has twenty fixed tasks, both registered families and ten source-bound context changes without changing historical cases',()=>{
 const before=fingerprint(m1EvaluationCases()),oldDigest='c97cce1aacd9d5ba02e8b188019e252445aeec6c7db501f5838179ca9de7aa7e';
 assert.equal(before,oldDigest);for(const id of [legacyLiveLifecycleContract.id,liveLifecycleContract.id])assert.equal(liveLifecyclePlan(20,{contractId:id}).caseSetDigest,oldDigest);
 assert.equal(catalog.length,20);assert.equal(new Set(catalog.map(item=>item.id)).size,20);assert.equal(catalog.filter(item=>item.kind==='FRESH').length,10);
 for(const context of allContextIds)assert.equal(catalog.filter(item=>item.contextId===context).length,2);
 for(const child of catalog.filter(item=>item.kind==='DERIVED')){
  const parent=catalog.find(item=>item.id===child.sourceCaseId);assert.equal(parent.kind,'FRESH');
  assert.notEqual(validationFamilyForContext(child.contextId).id,validationFamilyForContext(parent.contextId).id);
  assert.equal(child.seedSql,undefined,'derived SQL must be read from the original verified source, not guessed from a template');
 }
 const plan=liveLifecyclePlan(20,{contractId});assert.equal(plan.maximumModelCalls,60);assert.equal(plan.maximumTotalSparkRuns,120);assert.equal(plan.willExecute,false);
 assert.notEqual(plan.caseSetDigest,oldDigest);assert.equal(fingerprint(m1EvaluationCases()),before);
 assert.throws(()=>validateLiveContextEvaluationCases(catalog.slice(1)));const changed=structuredClone(catalog);changed[10].sourceCaseId=changed[1].id;assert.throws(()=>validateLiveContextEvaluationCases(changed));
});

test('all v3 tasks separately reach reviewed publication and consumption, while synthetic outcomes never become genuine success',async()=>{
 const completed=new Map(),fixtures=new Map();
 for(let index=0;index<catalog.length;index++){
  const definition=catalog[index],parent=fixtures.get(definition.sourceCaseId),parentState=completed.get(definition.sourceCaseId);
  const f=v3(definition,{timeOffset:index*30,evaluationStartedAt:'2026-09-15T00:00:00.000Z',...(parent?{parent,derivedFrom:{kind:'REGISTERED_CONTEXT_CHANGE',taskId:parent.task.id,
   revisionId:parent.revision.id,runId:parent.run.id,revisionHash:parent.revision.hash,contextId:parent.definition.contextId,
   validationContractId:validationFamilyForContext(parent.definition.contextId).id}}:{})});
  const parentOriginal=parent&&JSON.stringify({task:parent.task,run:parent.run,approval:parent.approval,mutations:parent.mutations});
  const state=await complete(f,parentState);assert.equal(verifyLiveCaseEvidence(definition,state,{sourceCheckpoint:parentState}),true);
  assert.equal(f.submittedBodies.length,1);assert.equal(state.code.validationContractId,validationFamilyForContext(definition.contextId).id);
  assert.deepEqual(f.mutations,['/agent/tasks',`/agent/tasks/${f.task.id}/prepare-delivery`]);
  if(parent){
   assert.equal(f.submittedBodies[0].sql,parent.revision.sql);assert.deepEqual(f.submittedBodies[0].derivation,f.task.derivedFrom&&Object.fromEntries(['kind','taskId','revisionId','runId','revisionHash'].map(key=>[key,f.task.derivedFrom[key]])));
   assert.notEqual(state.delivery.packageDigest,parentState.delivery.packageDigest);assert.notEqual(state.publication.approvalId,parentState.publication.approvalId);
   assert.equal(JSON.stringify({task:parent.task,run:parent.run,approval:parent.approval,mutations:parent.mutations}),parentOriginal);
   assert.equal(verifyLiveCaseEvidence(definition,state),false,'a child cannot be scored without its original successful parent checkpoint');
  }
  completed.set(definition.id,state);fixtures.set(definition.id,f);
 }
 const summary=summarizeLiveLifecycle(catalog,[...completed.values()],{contractId});assert.equal(summary.frozenCaseCount,20);assert.equal(summary.completedCaseCount,20);
 assert.equal(summary.succeededCaseCount,0);assert.equal(summary.completionRate,0);assert.equal(summary.targetMet,false);assert.equal(summary.contextChangeCaseCount,10);
 assert.equal(summary.executionEvidenceMode,'TEST_HARNESS');assert.equal(summary.agentIndependentE2E,false);assert.equal(summary.externalSystemVerified,false);
});

test('stock-family cases reject old-family execution, rehearsal and published batch receipts',async()=>{
 const definition=catalog.find(item=>item.kind==='FRESH'&&item.contextId==='stock-cash-t1');
 const badCode=v3(definition);badCode.run.validation.contractId=validationFamilyForContext('holdings-t1').id;assert.equal((await advance(badCode)).errorCode,'CODE_EXECUTION_NOT_VERIFIED');
 const badFiles=v3(definition);badFiles.verification.validation.regressions=contextIds.map(contextId=>({contextId,passed:true}));assert.equal((await advance(badFiles)).errorCode,'FILE_REHEARSAL_INCOMPLETE');
 const badPublish=v3(definition),waiting=await advance(badPublish);badPublish.reviewNow();badPublish.batches[0].source={...badPublish.batches[0].source,validationContractId:validationFamilyForContext('holdings-t1').id};
 assert.equal((await advance(badPublish,waiting)).errorCode,'PUBLISHED_BATCH_EVIDENCE_INCOMPLETE');
});

test('missing, unsuccessful or foreign-evaluation parents never trigger substitute or preparatory tasks',async()=>{
 const {parentState,child}=await parentAndChild();
 for(const parent of [undefined,{...parentState,status:'FAILED'},{...parentState,status:'AWAITING_CONSUMPTION'},{...parentState,evaluationStartedAt:'2025-01-01T00:00:00.000Z'},
  {...parentState,evaluationRunId:'00000000-0000-4000-8000-000000000999'}]){
  const state=await advance(child,child.checkpoint,parent);assert.ok(['AWAITING_SOURCE','BLOCKED_SOURCE'].includes(state.status));assert.equal(state.errorCode,'DERIVATION_SOURCE_NOT_SUCCESSFUL');
  assert.equal(state.actions.agent,undefined);assert.equal(child.mutations.length,0);assert.equal(child.reads.length,0);
 }
 const blocked=await advance(child,child.checkpoint,{...parentState,status:'FAILED'}),summary=summarizeLiveLifecycle(catalog,[{...parentState,status:'FAILED'},blocked],{contractId});
 assert.equal(summary.frozenCaseCount,20);assert.equal(summary.blockedSourceCaseCount,1);assert.equal(summary.unexecutedCaseCount,19);assert.equal(summary.targetMet,false);
});

test('derived creation with an unknown outcome freezes the parent tuple and recovers only its original task key',async()=>{
 const {parent,parentState,child}=await parentAndChild({postLost:true,uncommitted:true}),parentBefore=JSON.stringify(parent.task);
 const paused=await advance(child,child.checkpoint,parentState);assert.equal(paused.status,'PAUSED');assert.equal(paused.errorCode,'MUTATION_OUTCOME_UNKNOWN');
 const again=await advance(child,JSON.parse(JSON.stringify(paused)),parentState);assert.equal(again.status,'PAUSED');assert.equal(child.submittedBodies.length,1);
 assert.deepEqual(again.derivationSource,paused.derivationSource);assert.deepEqual(again.actions.agent,paused.actions.agent);
 child.confirmTask();const restored=await advance(child,again,parentState);assert.equal(restored.status,'AWAITING_ENGINEER_REVIEW');assert.equal(child.submittedBodies.length,1);
 assert.equal(restored.taskId,child.task.id);assert.equal(JSON.stringify(parent.task),parentBefore);
 const changed=structuredClone(parentState);changed.code.revisionHash='f'.repeat(64);
 const mismatched=await advance(child,again,changed);assert.equal(mismatched.status,'FAILED');assert.equal(mismatched.errorCode,'DERIVATION_SOURCE_CHANGED');assert.equal(child.submittedBodies.length,1);
});

test('a derived case must retain original child genealogy and refresh only its own consumption without replaying its parent',async()=>{
 const {parent,parentState,child}=await parentAndChild(),waiting=await advance(child,child.checkpoint,parentState);child.reviewNow();
 const consumption=await advance(child,waiting,parentState);assert.equal(consumption.status,'AWAITING_CONSUMPTION');const parentMutations=[...parent.mutations],writes=[...child.mutations],readCount=child.reads.length;
 child.consumeNow();const completeState=await refreshLiveLifecycleConsumption(child.definition,consumption,child.adapter,{sourceCheckpoint:parentState});assert.equal(completeState.status,'SUCCEEDED');
 assert.deepEqual(child.mutations,writes);assert.deepEqual(parent.mutations,parentMutations);assert.equal(child.reads.length,readCount+1);assert.match(child.reads.at(-1),/^\/data-services\/task-evidence\?/);
 const wrong=structuredClone(completeState);wrong.code.derivedFrom.taskId=child.task.id;assert.equal(verifyLiveCaseEvidence(child.definition,wrong,{sourceCheckpoint:parentState}),false);
 const missingParent=structuredClone(parentState);missingParent.status='FAILED';assert.equal(verifyLiveCaseEvidence(child.definition,completeState,{sourceCheckpoint:missingParent}),false);
 await assert.rejects(refreshLiveLifecycleConsumption(child.definition,consumption,child.adapter,{sourceCheckpoint:missingParent}),{code:'DERIVATION_SOURCE_CHANGED'});
});

test('explicit synthetic provider receipts remain disclosed even if the transport adapter has no test flag',async()=>{
 const f=v3();delete f.adapter.testDouble;f.task.synthetic=true;
 const state=await complete(f);assert.equal(state.executionEvidenceMode,'TEST_HARNESS');
 const summary=summarizeLiveLifecycle(liveLifecycleCases(contractId),[state],{contractId});assert.equal(summary.succeededCaseCount,0);assert.equal(summary.targetMet,false);
});

test('malformed or unrelated creation receipts remain unknown and never acknowledge the wrong task',async()=>{
 const f=v3(),original=f.adapter.request;
 f.adapter.request=async(path,body,...args)=>{
  const result=await original(path,body,...args);
  return path==='/agent/tasks'||path.startsWith('/agent/requests/')?{...result,contextId:'stock-cash-t1'}:result;
 };
 const paused=await advance(f);assert.equal(paused.status,'PAUSED');assert.equal(paused.errorCode,'MUTATION_OUTCOME_UNKNOWN');assert.equal(paused.actions.agent.id,undefined);
 assert.equal(f.submittedBodies.length,1);assert.equal((await advance(f,paused)).status,'PAUSED');assert.equal(f.submittedBodies.length,1);
 f.adapter.request=original;const restored=await advance(f,paused);assert.equal(restored.status,'AWAITING_ENGINEER_REVIEW');assert.equal(f.submittedBodies.length,1);
});
