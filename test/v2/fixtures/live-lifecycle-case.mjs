import {randomUUID} from "node:crypto";
import {liveLifecyclePlan,liveCaseCheckpoint} from "../../../src/v2/live-lifecycle-evaluation.mjs";
import {m1EvaluationCases} from "../../../src/v2/evaluation.mjs";
import {createDeliveryPackage,sha256} from "../../../src/v2/delivery.mjs";
import {contextIds,referenceSql,validationContractId} from "../../../src/v2/context.mjs";
import {PROJECT} from "../../../src/v2/server.mjs";

// Public synthetic API receipts; no model, Spark, network or credentials.
export function createLiveLifecycleFixture(options={}){
 const definition=options.definition??m1EvaluationCases()[0],mutations=[],plan=liveLifecyclePlan();
 const time=seconds=>new Date(Date.UTC(2026,8,15,0,0,seconds)).toISOString();
 const checkpoint=liveCaseCheckpoint(definition,time(0),plan.caseSetDigest);
 const revision={id:randomUUID(),projectId:PROJECT,source:'LIVE_MODEL',sql:referenceSql,hash:sha256(referenceSql),contextId:definition.contextId};
 const run={id:randomUUID(),projectId:PROJECT,agentTaskId:'unused',revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,validation:{contractId:validationContractId,passed:true,regressions:contextIds.map(contextId=>({contextId,passed:true}))}};
 const task={id:randomUUID(),message:definition.request,contextId:definition.contextId,status:'SUCCEEDED',mode:'LIVE_MODEL',createdAt:time(1),usedTokens:100,attempts:[{status:'SUCCEEDED',model:'qwen3.7-plus',revisionId:revision.id,runId:run.id}]};run.agentTaskId=task.id;
 const bundle={...createDeliveryPackage({run,revision,name:'虚构证券评测'}),id:randomUUID()};
 const verification={id:randomUUID(),status:'SUCCEEDED',engine:'Apache Spark',mainSqlExecuted:true,testSqlValidation:{passed:true},validation:run.validation};
 const delivery={id:randomUUID(),status:'SUCCEEDED',sourceAgentTaskId:task.id,sourceRevisionId:revision.id,sourceRunId:run.id,packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id};
 const review={id:randomUUID(),status:'REVIEWED',packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id,scope:'LOCAL_TEST_RELEASE',attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}};
 const approval={id:randomUUID(),status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest,reviewId:review.id};
 const release={id:randomUUID(),status:'ACTIVE_LOCAL',health:'HEALTHY',successfulRunCount:2,packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revision.id,approvalId:approval.id,activatedAt:time(10)};
 const {contractId,...rawValidation}=run.validation;
 const batches=[0,1].map(index=>({...run,id:randomUUID(),releaseId:release.id,packageId:bundle.id,packageDigest:bundle.digest,source:bundle.manifest.source,
  fileHashes:Object.fromEntries(Object.entries(bundle.manifest.files).map(([name,value])=>[name,value.sha256])),validation:rawValidation,
  schedulerTriggered:true,clockMode:'WALL_CLOCK_TIMER',testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},scheduledTriggerAt:time(11+index*2),startedAt:time(11+index*2),finishedAt:time(12+index*2)}));
 const events=batches.map(batch=>({id:randomUUID(),releaseId:release.id,releaseRunId:batch.id,packageDigest:bundle.digest,type:'BATCH_SUCCEEDED',observedAt:batch.finishedAt}));
 const holdingsServiceId=randomUUID(),cashServiceId=randomUUID(),xapiId=randomUUID(),xapiVersionId=randomUUID();
 const consumption={protocol:'shuduo-local-task-consumption/v1',scope:'LOCAL_TEST_ONLY',taskId:task.id,packageDigest:bundle.digest,releaseId:release.id,
  sourceKind:'AGENT',status:'VERIFIED',checkedAt:time(21),matchingCount:1,truncated:false,externalSystemVerified:false,agentIndependentE2E:false,publicDeployed:false,
  services:[{serviceId:xapiId,serviceType:'XAPI',versionId:xapiVersionId,configHash:sha256('synthetic-xapi'),status:'VERIFIED',sourceKind:'AGENT',releaseId:release.id,
   agentIndependentE2E:false,sourceRunIds:[batches[0].id],fullAssetComposition:true,
   sourceVersions:[{serviceId:holdingsServiceId,versionId:randomUUID(),configHash:sha256('synthetic-holdings-dapi'),releaseId:release.id,sourceReleaseRunId:batches[0].id,
     packageDigest:bundle.digest,sourceKind:'AGENT',fields:['client_id','holding_market_value','security_count']},
    {serviceId:cashServiceId,versionId:randomUUID(),configHash:sha256('synthetic-cash-dapi'),releaseId:release.id,sourceReleaseRunId:batches[0].id,
     packageDigest:bundle.digest,sourceKind:'AGENT',fields:['client_id','available_cash','total_assets']}],
   call:{callId:randomUUID(),versionId:xapiVersionId,configHash:sha256('synthetic-xapi'),resultHash:sha256('synthetic-asset-query-result'),verified:true,rowCount:3,
    applicationId:randomUUID(),applicationStatus:'REVOKED',finishedAt:time(20)}}]};
 let agentCreated=false,deliveryCreated=false,reviewed=false,consumed=Boolean(options.consumed),failConsumptionRead=false;
 const reads=[];
 const adapter={testDouble:true,request:async(path,body)=>{
  if(body!==undefined){
   mutations.push(path);
   if(path==='/agent/tasks'){agentCreated=!options.uncommitted; if(options.postLost)throw Error('synthetic lost response');return task;}
   if(path===`/agent/tasks/${task.id}/prepare-delivery`){deliveryCreated=true;return delivery;}
   throw Error('unexpected write: '+path);
  }
  reads.push(path);
  if(path.startsWith('/data-services/task-evidence?')){
   if(failConsumptionRead)throw Error('SYNTHETIC_CONSUMPTION_READ_UNKNOWN');
   return consumed?consumption:{...consumption,status:'PENDING',services:[],matchingCount:0};
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
 return {definition,checkpoint,adapter,mutations,reads,task,revision,bundle,delivery,verification,review,approval,release,batches,events,run,consumption,
  reviewNow:()=>{reviewed=true;},confirmTask:()=>{agentCreated=true;},consumeNow:()=>{consumed=true;},failConsumptionRead:value=>{failConsumptionRead=value;}};
}

