import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {liveLifecyclePlan,liveCaseCheckpoint,advanceLiveLifecycleCase,summarizeLiveLifecycle,verifyLiveCaseEvidence} from '../../src/v2/live-lifecycle-evaluation.mjs';
import {m1EvaluationCases} from '../../src/v2/evaluation.mjs';
import {createDeliveryPackage,sha256} from '../../src/v2/delivery.mjs';
import {contextIds,referenceSql,validationContractId} from '../../src/v2/context.mjs';
import {PROJECT} from '../../src/v2/server.mjs';

// These API receipts are synthetic fixtures. They exercise workflow and report
// consistency only and must never be recorded as real model/Spark acceptance.
function fixture(options={}){
 const definition=m1EvaluationCases()[0],mutations=[],plan=liveLifecyclePlan();
 const time=seconds=>new Date(Date.UTC(2026,8,15,0,0,seconds)).toISOString();
 const checkpoint=liveCaseCheckpoint(definition,time(0),plan.caseSetDigest);
 const revision={id:randomUUID(),projectId:PROJECT,sql:referenceSql,hash:sha256(referenceSql),contextId:definition.contextId};
 const run={id:randomUUID(),projectId:PROJECT,agentTaskId:'unused',revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,validation:{contractId:validationContractId,passed:true,regressions:contextIds.map(contextId=>({contextId,passed:true}))}};
 const task={id:randomUUID(),message:definition.request,contextId:definition.contextId,status:'SUCCEEDED',mode:'LIVE_MODEL',createdAt:time(1),usedTokens:100,attempts:[{status:'SUCCEEDED',model:'qwen3.7-plus',revisionId:revision.id,runId:run.id}]};run.agentTaskId=task.id;
 const bundle={...createDeliveryPackage({run,revision,name:'虚构证券评测'}),id:randomUUID()};
 const verification={id:randomUUID(),status:'SUCCEEDED',engine:'Apache Spark',mainSqlExecuted:true,testSqlValidation:{passed:true},validation:run.validation};
 const delivery={id:randomUUID(),status:'SUCCEEDED',sourceAgentTaskId:task.id,sourceRevisionId:revision.id,sourceRunId:run.id,packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id};
 const review={id:randomUUID(),status:'REVIEWED',packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id,scope:'LOCAL_TEST_RELEASE',attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}};
 const approval={id:randomUUID(),status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest,reviewId:review.id};
 const release={id:randomUUID(),status:'ACTIVE_LOCAL',health:'HEALTHY',successfulRunCount:2,packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revision.id,approvalId:approval.id,activatedAt:time(10)};
 const batches=[0,1].map(index=>({...run,id:randomUUID(),releaseId:release.id,packageId:bundle.id,packageDigest:bundle.digest,schedulerTriggered:true,clockMode:'WALL_CLOCK_TIMER',testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},scheduledTriggerAt:time(11+index*2),startedAt:time(11+index*2),finishedAt:time(12+index*2)}));
 const events=batches.map(batch=>({id:randomUUID(),releaseId:release.id,releaseRunId:batch.id,packageDigest:bundle.digest,type:'BATCH_SUCCEEDED',observedAt:batch.finishedAt}));
 let agentCreated=false,deliveryCreated=false,reviewed=false;
 const adapter={testDouble:true,request:async(path,body)=>{
  if(body!==undefined){
   mutations.push(path);
   if(path==='/agent/tasks'){agentCreated=!options.uncommitted; if(options.postLost)throw Error('synthetic lost response');return task;}
   if(path===`/agent/tasks/${task.id}/prepare-delivery`){deliveryCreated=true;return delivery;}
   throw Error('unexpected write: '+path);
  }
  if(path.startsWith('/agent/requests/')){if(!agentCreated)throw Error('not found');return task;}
  if(path===`/agent/tasks/${task.id}`)return task;
  if(path===`/revisions/${revision.id}`)return revision;
  if(path===`/runs/${run.id}`)return run;
  if(path===`/agent/tasks/${task.id}/workflow`)return {report:{status:'PASSED',taskId:task.id,revisionId:revision.id,runId:run.id,checks:['revision','execution','results','regressions'].map(id=>({id,passed:true}))},...(deliveryCreated?{package:bundle,verification}:{})};
  if(path===`/agent/deliveries/${delivery.id}`)return delivery;
  if(path.startsWith('/agent/deliveries?'))return deliveryCreated?[delivery]:[];
  if(path===`/agent/tasks/${task.id}/publication`)return reviewed?{release,runs:batches,alerts:[],events}:{runs:[],alerts:[],events:[]};
  if(path===`/releases/${release.id}`)return release;
  if(path==='/release/approvals')return [approval];
  if(path==='/delivery/reviews')return [review];
  if(path.startsWith('/release/runs/'))return batches.find(batch=>path.endsWith(batch.id));
  throw Error('unexpected read: '+path);
 }};
 return {definition,checkpoint,adapter,mutations,task,bundle,review,batches,events,run,reviewNow:()=>{reviewed=true;},confirmTask:()=>{agentCreated=true;}};
}
const advance=(f,checkpoint=f.checkpoint)=>advanceLiveLifecycleCase(f.definition,checkpoint,f.adapter,{pause:async()=>{},maxPolls:2});

test('planning makes no API calls and declares the full worst-case resource envelope',()=>{
 const plan=JSON.parse(execFileSync(process.execPath,['scripts/run-live-lifecycle-evaluation.mjs','--plan'],{encoding:'utf8',timeout:10000}));
 assert.equal(plan.willExecute,false);assert.equal(plan.maximumModelCalls,3);assert.equal(plan.maximumTotalSparkRuns,6);assert.equal(plan.humanReviewRequired,true);
 assert.equal(liveLifecyclePlan(20).maximumModelCalls,60);assert.throws(()=>liveLifecyclePlan(21));
});
test('a fresh task prepares immutable files then waits for an actual review, without approving or publishing',async()=>{
 const f=fixture(),state=await advance(f);assert.equal(state.status,'AWAITING_ENGINEER_REVIEW');
 assert.deepEqual(f.mutations,['/agent/tasks',`/agent/tasks/${f.task.id}/prepare-delivery`]);
 const resumed=await advance(f,JSON.parse(JSON.stringify(state)));assert.equal(resumed.status,'AWAITING_ENGINEER_REVIEW');assert.equal(f.mutations.length,2);
});
test('lost creation replies are read by the original key and do not cause a second model task',async()=>{
 const committed=fixture({postLost:true}),restored=await advance(committed);assert.equal(restored.status,'AWAITING_ENGINEER_REVIEW');assert.equal(committed.mutations.filter(path=>path==='/agent/tasks').length,1);
 const unknown=fixture({postLost:true,uncommitted:true}),paused=await advance(unknown);assert.equal(paused.status,'PAUSED');assert.equal(paused.errorCode,'MUTATION_OUTCOME_UNKNOWN');
 const stillPaused=await advance(unknown,paused);assert.equal(stillPaused.status,'PAUSED');assert.equal(unknown.mutations.length,1);
 unknown.confirmTask();assert.equal((await advance(unknown,stillPaused)).status,'AWAITING_ENGINEER_REVIEW');assert.equal(unknown.mutations.filter(path=>path==='/agent/tasks').length,1);
});
test('post-review receipts must share the current source, batch and monitoring version',async()=>{
 const f=fixture(),waiting=await advance(f);f.reviewNow();const completed=await advance(f,waiting);
 assert.equal(completed.status,'SUCCEEDED');assert.equal(verifyLiveCaseEvidence(f.definition,completed),true);assert.equal(f.mutations.length,2);
 const simulated=summarizeLiveLifecycle(m1EvaluationCases(),[completed],{testDouble:true});assert.equal(simulated.succeededCaseCount,0);assert.equal(simulated.targetMet,false);
 assert.equal(summarizeLiveLifecycle(m1EvaluationCases(),[completed]).succeededCaseCount,0);
 const bad=structuredClone(completed);bad.lifecycleOutcome.stages.postReleaseMonitoring.successfulEvents[0].packageDigest='0'.repeat(64);
 assert.equal(verifyLiveCaseEvidence(f.definition,bad),false);assert.equal(summarizeLiveLifecycle(m1EvaluationCases(),[bad]).succeededCaseCount,0);
});
test('historical tasks, missing review attestations and wrong-batch evidence cannot pass',async()=>{
 const old=fixture();old.task.createdAt='2025-01-01T00:00:00.000Z';assert.equal((await advance(old)).errorCode,'HISTORICAL_TASK_REJECTED');assert.equal(old.mutations.length,1);
 const wrong=fixture();const state=await advance(wrong);wrong.reviewNow();wrong.review.attestations.code=false;assert.equal((await advance(wrong,state)).errorCode,'ENGINEER_REVIEW_NOT_BOUND');
 const batch=fixture();const next=await advance(batch);batch.reviewNow();batch.batches[0].packageDigest='0'.repeat(64);assert.equal((await advance(batch,next)).errorCode,'PUBLISHED_BATCH_EVIDENCE_INCOMPLETE');
});

test('unknown durable model outcomes pause on the original task without retry consent',async()=>{
 const f=fixture();f.task.status='QUEUED';f.task.executionMode='DURABLE_SQL_AGENT_V1';f.task.stage='MODEL_OUTCOME_UNKNOWN';f.task.version=3;
 const state=await advance(f);assert.equal(state.status,'PAUSED');assert.equal(state.errorCode,'MODEL_OUTCOME_UNKNOWN');assert.equal(state.taskId,f.task.id);
 assert.deepEqual(f.mutations,['/agent/tasks']);
});
test('a lost advance reply with unchanged version stops instead of repeating the write',async()=>{
 const f=fixture();f.task.status='QUEUED';f.task.executionMode='DURABLE_SQL_AGENT_V1';f.task.stage='READY_FOR_MODEL';f.task.version=1;
 const state=await advance(f);assert.equal(state.status,'PAUSED');assert.equal(state.errorCode,'ADVANCE_OUTCOME_UNKNOWN');
 assert.equal(f.mutations.filter(path=>path.endsWith('/advance')).length,1);
});
