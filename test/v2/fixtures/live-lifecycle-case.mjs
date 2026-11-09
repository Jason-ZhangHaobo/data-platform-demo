import {randomUUID} from "node:crypto";
import {liveLifecyclePlan,liveCaseCheckpoint} from "../../../src/v2/live-lifecycle-evaluation.mjs";
import {m1EvaluationCases} from "../../../src/v2/evaluation.mjs";
import {createDeliveryPackage,sha256} from "../../../src/v2/delivery.mjs";
import {contextIds,getContext,referenceSql,validationContractId,validationFamilyForContext,referenceSqlForContext} from "../../../src/v2/context.mjs";
import {PROJECT} from "../../../src/v2/server.mjs";

// Public synthetic API receipts; no model, Spark, network or credentials.
export function createLiveLifecycleFixture(options={}){
 const definition=options.definition??m1EvaluationCases()[0],mutations=[],plan=liveLifecyclePlan(1,options.contractId?{contractId:options.contractId}:{}),
  family=validationFamilyForContext(definition.contextId),sql=options.contractId?referenceSqlForContext(definition.contextId):referenceSql;
 const time=seconds=>new Date(Date.UTC(2026,8,15,0,0,seconds+(options.timeOffset??0))).toISOString();
 const checkpoint=liveCaseCheckpoint(definition,options.evaluationStartedAt??time(0),plan.caseSetDigest,options.contractId?{contractId:options.contractId,evaluationRunId:options.evaluationRunId??'00000000-0000-4000-8000-000000000123'}:{});
 const revision={id:randomUUID(),projectId:PROJECT,source:'LIVE_MODEL',sql,hash:sha256(sql),contextId:definition.contextId};
 const run={id:randomUUID(),projectId:PROJECT,agentTaskId:'unused',revisionId:revision.id,revisionHash:revision.hash,
  contextId:definition.contextId,validationContractId:family.id,isolation:'LOCAL_PROCESS',rows:structuredClone(getContext(definition.contextId).expected),
  status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,validation:{contractId:family.id,passed:true,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))}};
 const task={id:randomUUID(),message:definition.request,contextId:definition.contextId,status:'SUCCEEDED',mode:'LIVE_MODEL',createdAt:time(1),usedTokens:100,attempts:[{status:'SUCCEEDED',model:'qwen3.7-plus',revisionId:revision.id,runId:run.id}],
  ...(options.contractId?{version:1,language:'SPARK_SQL',sql,revisionId:revision.id,runId:run.id,validationContractId:family.id}:{}),...(options.derivedFrom?{derivedFrom:options.derivedFrom,initialSql:options.parent.revision.sql}:{})};run.agentTaskId=task.id;
 options.beforeDelivery?.({task,run,revision});
 const deliveryId=randomUUID(),bundle={...createDeliveryPackage({run,revision,...(task.requirements?{agent:task}:{}),name:'虚构证券评测'}),id:randomUUID(),sourceRunId:run.id,agentDeliveryTaskId:deliveryId};
 const {contractId,...rawValidation}=run.validation;
 const executedFiles={status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,packageDigest:bundle.digest,
  source:bundle.manifest.source,fileHashes:Object.fromEntries(Object.entries(bundle.manifest.files).map(([name,value])=>[name,value.sha256])),
  validation:rawValidation,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},rows:structuredClone(run.rows)};
 const verification={...executedFiles,id:randomUUID(),packageId:bundle.id,agentDeliveryTaskId:deliveryId,
  scope:'M2A_LOCAL_FILE_REHEARSAL',mode:'LOCAL_FILE_REHEARSAL',published:false};
 const delivery={id:deliveryId,mode:'VERIFIED_ARTIFACT_ORCHESTRATION',status:'SUCCEEDED',actualExecution:true,sourceSqlHash:revision.hash,
  sourceAgentTaskId:task.id,sourceRevisionId:revision.id,sourceRunId:run.id,packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id};
 const review={id:randomUUID(),status:'REVIEWED',packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id,scope:'LOCAL_TEST_RELEASE',publicDeploymentApproved:false,
  attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}};
 const approval={id:randomUUID(),status:'APPROVED',scope:'LOCAL_TEST_RELEASE',publicDeploymentApproved:false,packageId:bundle.id,packageDigest:bundle.digest,
  reviewId:review.id,rehearsalId:verification.id,sourceRevisionId:revision.id,sourceCodeHash:revision.hash,sourceSqlHash:revision.hash};
 const release={id:randomUUID(),status:'ACTIVE_LOCAL',health:'HEALTHY',successfulRunCount:2,failedRunCount:0,openAlertCount:0,
  environment:'local-rehearsal',adapter:'local-spark-v1',publicDeployed:false,scheduleSpec:{triggerAfterSeconds:1,intervalSeconds:2,runCount:2},
  packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revision.id,sourceCodeHash:revision.hash,sourceSqlHash:revision.hash,approvalId:approval.id,activatedAt:time(10)};
 approval.consumedByReleaseId=release.id;
 const batches=[0,1].map(index=>({...executedFiles,id:randomUUID(),releaseId:release.id,packageId:bundle.id,
  mode:'LOCAL_SCHEDULED_RELEASE',sequence:index+1,published:true,publicDeployed:false,schedulerTriggered:true,clockMode:'WALL_CLOCK_TIMER',
  scheduledTriggerAt:time(11+index*2),triggeredAt:time(11+index*2),startedAt:time(11+index*2),finishedAt:time(12+index*2)}));
 const events=batches.map(batch=>({id:randomUUID(),releaseId:release.id,releaseRunId:batch.id,packageDigest:bundle.digest,type:'BATCH_SUCCEEDED',
  status:'SUCCEEDED',schedulerTriggered:true,observedAt:batch.finishedAt}));
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
 const reads=[],submittedBodies=[];
 const adapter={testDouble:true,request:async(path,body)=>{
  if(body!==undefined){
   mutations.push(path);
   if(path==='/agent/tasks'){submittedBodies.push(structuredClone(body));agentCreated=!options.uncommitted; if(options.postLost)throw Error('synthetic lost response');return task;}
   if(path===`/agent/tasks/${task.id}/prepare-delivery`){deliveryCreated=true;return delivery;}
   throw Error('unexpected write: '+path);
  }
  reads.push(path);
  if(options.parent&&[`/agent/tasks/${options.parent.task.id}`,`/revisions/${options.parent.revision.id}`,`/runs/${options.parent.run.id}`].includes(path))return options.parent.adapter.request(path);
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
 return {definition,checkpoint,adapter,mutations,reads,submittedBodies,task,revision,bundle,delivery,verification,review,approval,release,batches,events,run,consumption,
  reviewNow:()=>{reviewed=true;},confirmTask:()=>{agentCreated=true;},consumeNow:()=>{consumed=true;},failConsumptionRead:value=>{failConsumptionRead=value;}};
}

