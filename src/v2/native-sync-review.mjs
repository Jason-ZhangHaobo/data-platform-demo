import {isDeepStrictEqual as same} from 'node:util';
import {validateDeliveryPackage,resolveDeliverySchedule} from './delivery.mjs';
import {readSyncSqlInput,syncSqlDeliverySource} from './sync-sql-input.mjs';
import {storedSyncSqlReviewEvidence,assertSyncSqlConsent} from './sync-sql-publication.mjs';
import {publishedReportHash} from './published-report-source.mjs';

const fail=()=>Object.assign(Error('冻结持仓审阅依据与原任务、代码、交付或成功演练不一致'),{status:409,code:'SYNC_REVIEW_PREFLIGHT_CHANGED'});
export function nativeSyncReviewPreflight({store,project,actor,agent,delivery,bundle,verification,schedulerEnabled}) {
 const plan=validateDeliveryPackage(bundle,bundle.digest),source=plan.source,input=source.syncInput;
 if(!input||actor!==agent?.submittedBy||actor!==input.actorId||agent.id!==input.agentTaskId||
  agent.sourceKind==='MANUAL'||agent.repairComparison!==undefined||agent.sourceAttribution!==undefined||
  delivery?.sourceKind==='MANUAL'||delivery?.mode!=='VERIFIED_ARTIFACT_ORCHESTRATION'||delivery.status!=='SUCCEEDED'||
  delivery.projectId!==project||delivery.sourceAgentTaskId!==agent.id||delivery.submittedBy!==actor||
  delivery.packageId!==bundle.id||delivery.packageDigest!==bundle.digest||delivery.verificationId!==verification?.id||
  delivery.sourceRunId!==source.runId||delivery.sourceRevisionId!==source.revisionId||delivery.sourceSqlHash!==source.sqlHash||
  bundle.projectId!==project||source.projectId!==project||verification?.projectId!==project||
  verification.packageId!==bundle.id)throw fail();
 const run=store.get('run',source.runId,project),revision=store.get('revision',source.revisionId,project);
 if(!same(syncSqlDeliverySource({agent,run,revision}),input)||source.sqlHash!==revision.hash||
  run.status!=='SUCCEEDED'||run.revisionId!==revision.id||run.revisionHash!==revision.hash||
  !same(readSyncSqlInput({store,project,actorId:actor,binding:revision.syncInput}),plan.fixtures.context))throw fail();
 const evidence=storedSyncSqlReviewEvidence(plan,bundle,verification),occurrence=resolveDeliverySchedule(plan,verification.scheduledFor);
 if(!occurrence.eligible||!same(occurrence,verification.occurrence)||occurrence.businessDate!==plan.fixtures.context.businessDate)throw fail();
 const candidates=store.list('delivery_review',project).filter(r=>r.packageId===bundle.id&&r.packageDigest===bundle.digest&&r.reviewer?.id===actor);
 const current=candidates.find(r=>r.verificationId===verification.id&&r.syncRehearsalDigest===evidence.syncRehearsalDigest&&Number.isFinite(Date.parse(r.reviewedAt))&&r.status==='REVIEWED'&&r.scope==='LOCAL_FILE_REVIEW'&&r.publicDeploymentApproved===false&&
  same(r.attestations,{code:true,assertions:true,deliveryFiles:true,localScope:true}));
 const scheduleSpec={triggerAfterSeconds:5,intervalSeconds:30,runCount:2};
 const consentBasis={scope:'LOCAL_TEST_RELEASE',packageDigest:bundle.digest,verificationId:verification.id,snapshotHash:input.snapshotHash,businessDate:occurrence.businessDate,scheduleSpec};
 if(current)assertSyncSqlConsent({bundle,plan,verification,review:current,consent:{...consentBasis,confirmFrozenFictionalData:true},actorId:actor,enabled:true});
 const result={protocol:'shuduo-native-sync-review-preflight/v1',scope:'LOCAL_FILE_REVIEW',readOnly:true,
  binding:{taskId:agent.id,deliveryId:delivery.id,packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id},
  evidence,review:{status:current?'REVIEWED':candidates.length?'STALE_REVIEW':'NEEDS_REVIEW',...(current?{id:current.id,reviewedAt:current.reviewedAt}:{})},
  consentBasis,batches:[{sequence:1,afterSeconds:5,businessDate:occurrence.businessDate},{sequence:2,afterSeconds:35,businessDate:occurrence.businessDate}],
  schedulerEnabled:Boolean(schedulerEnabled),publicationApproved:false,
  provenance:{newSparkRuns:0,newModelCalls:0,cloudRequests:0,publicDeployed:false,fullLifecycleE2E:false,countsTowardLiveEvaluation:false}};
 return {...result,evidenceDigest:publishedReportHash(result)};
}
