import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {summarizeLifecycleEvaluation} from '../../src/v2/lifecycle-evaluation.mjs';

export const frozenEvidence=JSON.parse(readFileSync(new URL('../../fixtures/e2e/m1-code-evidence.json',import.meta.url),'utf8'));
export function lifecycleOutcome(item){
 const id=kind=>`${kind}-${item.caseId}`,digest=createHash('sha256').update(id('package')).digest('hex');
 const batchIds=[id('batch-one'),id('batch-two')];
 const time=second=>`2026-09-15T00:00:0${second}.000Z`;
 return {caseId:item.caseId,contextId:item.contextId,category:item.category,sourceAgentTaskId:item.original.agentTaskId,
  packageId:id('package'),releaseId:id('release'),scheduledBatchCount:2,localFullLifecycleE2E:true,publicDeployed:false,detours:[],
  stages:{
   requirementUnderstanding:{status:'PASSED',evidenceIds:[item.original.agentTaskId],requirementSha256:createHash('sha256').update(item.requirement).digest('hex'),liveModel:true},
   codeAndDebug:{status:'PASSED',evidenceIds:[item.original.revisionId,item.original.runId,id('revision'),id('run')],currentRevisionId:id('revision'),currentSparkRunId:id('run'),currentSparkVersion:'3.5.9',sqlHash:item.code.sqlHash,attemptCount:item.original.attemptCount,regressionCount:5,importedFromFrozenLiveEvidence:true},
   scheduleFiles:{status:'PASSED',evidenceIds:[id('package')],packageDigest:digest,files:['schedule.json','calendar.json','manifest']},
   deploymentFiles:{status:'PASSED',evidenceIds:[id('package'),id('verification')],packageDigest:digest,files:['deployment.json','main.sql','tests.sql'],actualSparkRehearsal:true,rehearsalStatus:'SUCCEEDED'},
   engineerReview:{status:'PASSED',evidenceIds:[id('review'),id('verification')],reviewId:id('review'),verificationId:id('verification'),packageDigest:digest,evaluatorAttestation:true,reviewScope:'LOCAL_TEST_RELEASE'},
   localRelease:{status:'PASSED',evidenceIds:[id('review'),id('approval'),id('release'),...batchIds],approvalId:id('approval'),packageDigest:digest,approvalBound:true,schedulerTriggered:true,actualSparkBatchCount:2,deploymentScope:'LOCAL_ACTUAL',activatedAt:time(0),batches:batchIds.map((batch,index)=>({id:batch,releaseId:id('release'),packageId:id('package'),packageDigest:digest,status:'SUCCEEDED',engine:'Apache Spark',schedulerTriggered:true,clockMode:'WALL_CLOCK_TIMER',validationPassed:true,scheduledTriggerAt:time(index*2+1),startedAt:time(index*2+1),finishedAt:time(index*2+2)}))},
   postReleaseMonitoring:{status:'PASSED',evidenceIds:[id('release'),id('event-one'),id('event-two')],health:'HEALTHY',successfulRunCount:2,openAlertCount:0,successfulEvents:batchIds.map((batch,index)=>({id:id(index?'event-two':'event-one'),type:'BATCH_SUCCEEDED',releaseId:id('release'),releaseRunId:batch,packageDigest:digest,observedAt:time(index*2+2)}))},
  }};
}
export function lifecycleReport(outcomes=frozenEvidence.cases.map(lifecycleOutcome)){
 return {...summarizeLifecycleEvaluation(frozenEvidence,outcomes),evaluationRunId:'fictional-evaluation-run',outcomes};
}
