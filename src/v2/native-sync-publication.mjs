import {validateDeliveryPackage} from './delivery.mjs';
import {assertSyncSqlApproval,assertSyncSqlReleasePlan,assertSyncSqlBatch} from './sync-sql-publication.mjs';
import {assertSyncSqlRehearsal} from './delivery-runner.mjs';
import {certifiedSyncSqlSource} from './sync-sql-service-source.mjs';
import {publishedReportHash} from './published-report-source.mjs';
const fail=()=>Object.assign(Error('原发布批准、批次或监控证据未能完整核对'),{status:409,code:'NATIVE_SYNC_PUBLICATION_UNCONFIRMED'});
const time=v=>Date.parse(v);
export function nativeSyncMonitor({store,project,bundle,approval,verification,review,timeUnitMs=1000}){
 const plan=validateDeliveryPackage(bundle,bundle.digest),release=store.get('release',approval.consumedByReleaseId,project),batches=store.list('release_run',project).filter(b=>b.releaseId===release?.id).sort((a,b)=>a.sequence-b.sequence);
 if(!release)throw fail();
 const args={bundle,plan,approval,verification,review,release,batches,enabled:true,timeUnitMs,historical:true};assertSyncSqlReleasePlan(args);
 const events=store.list('monitor_event',project).filter(e=>e.releaseId===release.id),alerts=store.list('monitor_alert',project).filter(a=>a.releaseId===release.id);
 const stopEvents=events.filter(e=>e.type==='RELEASE_CANCELLED');if(stopEvents.length!==(release.status==='CANCELLED'?1:0)||stopEvents.some(e=>e.packageDigest!==bundle.digest||!Number.isFinite(time(e.observedAt))))throw fail();
 if(events.some(e=>e.type!=='RELEASE_CANCELLED'&&!batches.some(b=>b.id===e.releaseRunId))||alerts.some(a=>!batches.some(b=>b.id===a.releaseRunId)))throw fail();
 const runs=batches.map(run=>{
  if(run.published!==true||run.publicDeployed!==false||run.fullLifecycleE2E!==false||!['SCHEDULED','RUNNING','SUCCEEDED','FAILED','INTERRUPTED','CANCELLED'].includes(run.status))throw fail();
  const ownEvents=events.filter(e=>e.releaseRunId===run.id),ownAlerts=alerts.filter(a=>a.releaseRunId===run.id);
  if(run.schedulerTriggered===true){
   assertSyncSqlBatch({...args,run,expectedStatus:run.status});
   if(run.mode!=='LOCAL_SCHEDULED_RELEASE'||!(time(run.startedAt)>=time(run.triggeredAt)))throw fail();
  }else if(!['SCHEDULED','CANCELLED'].includes(run.status)||run.triggeredAt!==undefined||run.resultUnknown===true)throw fail();
  if(run.status==='SCHEDULED'&&(ownEvents.length||ownAlerts.length||run.finishedAt!==undefined))throw fail();
  if(run.status==='RUNNING'&&(run.schedulerTriggered!==true||ownEvents.length||run.resultUnknown===true||run.finishedAt!==undefined))throw fail();
  if(['SUCCEEDED','FAILED'].includes(run.status)){
   if(run.schedulerTriggered!==true||!(time(run.finishedAt)>=time(run.startedAt))||run.resultUnknown===true||ownEvents.length!==1)throw fail();
   const event=ownEvents[0];if(event.type!==(run.status==='SUCCEEDED'?'BATCH_SUCCEEDED':'BATCH_FAILED')||event.status!==run.status||event.packageDigest!==bundle.digest||event.sourceRevisionId!==plan.source.revisionId||event.snapshotHash!==plan.source.syncInput.snapshotHash||event.schedulerTriggered!==true||!(time(event.observedAt)>=time(run.finishedAt)))throw fail();
   if(run.status==='SUCCEEDED')assertSyncSqlRehearsal(plan,bundle,{...run,published:false,schedulerTriggered:false,mode:'LOCAL_FILE_REHEARSAL'},release.businessScheduledFor);
   if(run.status==='FAILED'&&!ownAlerts.some(a=>['OPEN','RESOLVED'].includes(a.status)))throw fail();
  }
  if(run.status==='INTERRUPTED'&&(run.resultUnknown!==true||run.schedulerTriggered!==true||ownEvents.length!==1||ownEvents[0].type!=='BATCH_RESULT_UNKNOWN'||ownEvents[0].packageDigest!==bundle.digest||ownEvents[0].status!=='INTERRUPTED'||ownEvents[0].schedulerTriggered!==true||!(time(ownEvents[0].observedAt)>=time(run.triggeredAt))||!ownAlerts.some(a=>a.status==='OPEN')))throw fail();
  if(run.status==='CANCELLED'&&release.status!=='CANCELLED')throw fail();
  return {id:run.id,sequence:run.sequence,status:run.status,scheduledTriggerAt:run.scheduledTriggerAt,schedulerTriggered:run.schedulerTriggered===true,resultUnknown:run.resultUnknown===true,...(run.triggeredAt?{triggeredAt:run.triggeredAt}:{}),...(run.finishedAt?{finishedAt:run.finishedAt}:{}),...(run.status==='SUCCEEDED'?{rowCount:run.rows.length,regressionCount:run.validation.regressions.length}:{})};
 });
 const completed=release.status==='ACTIVE_LOCAL'&&runs.every(r=>r.status==='SUCCEEDED');
 if(completed)for(const batch of batches)certifiedSyncSqlSource({store,project,run:batch,enabled:true,timeUnitMs});
 return {releaseId:release.id,status:release.status,health:completed?'HEALTHY':runs.some(r=>r.resultUnknown)?'RESULT_UNKNOWN':runs.some(r=>r.status==='FAILED')?'FAILED':release.status==='CANCELLED'?'CANCELLED':'OBSERVING',businessDate:plan.fixtures.context.businessDate,runs,monitorEventCount:events.length,openAlertCount:alerts.filter(a=>a.status==='OPEN').length,completed};
}
export function nativeSyncPublicationReceipt({store,project,request,preflight,bundle,now=Date.now(),timeUnitMs=1000}){
 if(preflight.review.status!=='REVIEWED'||preflight.review.id!==request.reviewId||preflight.evidence.syncRehearsalDigest!==request.syncRehearsalDigest)throw fail();
 const id=store.deduplicatedId(project+':release-approval:'+request.requestId),approval=id&&store.get('release_approval',id,project);
 const result={protocol:'shuduo-native-sync-publication/v1',scope:'LOCAL_TEST_RELEASE',readOnly:true,binding:request,phase:'NOT_FOUND',publicDeployed:false,fullLifecycleE2E:false};
 if(approval){
  if(approval.packageId!==request.packageId||approval.packageDigest!==request.packageDigest||approval.rehearsalId!==request.verificationId||approval.reviewId!==request.reviewId||approval.syncRehearsalDigest!==request.syncRehearsalDigest)throw fail();
  const plan=validateDeliveryPackage(bundle,bundle.digest),verification=store.get('delivery_verification',request.verificationId,project),review=store.get('delivery_review',request.reviewId,project);
  assertSyncSqlApproval({bundle,plan,approval,verification,review,spec:preflight.consentBasis.scheduleSpec,actorId:plan.source.syncInput.actorId,enabled:true});
  result.approval={id:approval.id,expiresAt:approval.expiresAt};result.phase=now>=time(approval.expiresAt)?'EXPIRED':'APPROVED';
  if(approval.consumedByReleaseId){result.phase='RELEASED';result.monitor=nativeSyncMonitor({store,project,bundle,approval,verification,review,timeUnitMs});}
 }
 return {...result,evidenceDigest:publishedReportHash(result)};
}
