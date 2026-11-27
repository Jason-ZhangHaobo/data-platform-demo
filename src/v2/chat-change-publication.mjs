import { rmSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import { sha256, validateDeliveryPackage } from './delivery.mjs';
import { matchesStoredHoldingsRehearsal, matchesScheduledHoldingsBatch } from './delivery-runner.mjs';
import { plannedLocalRuns } from './release-scheduler.mjs';
import { amountInCents, formatCents } from './derived-amounts.mjs';

const scheduleSpec = Object.freeze({triggerAfterSeconds:5, intervalSeconds:30, runCount:2});
const attestations = Object.freeze({code:true, assertions:true, deliveryFiles:true, localScope:true});
const conflict = () => Object.assign(Error('所选派生版本的发布、批准或调度证据不一致，请重新核对原记录'), {status:409,code:'CHAT_PUBLICATION_UNCONFIRMED'});
const elsewhere = () => Object.assign(Error('此交付包已从其他入口发布。请打开所选派生任务的「审阅发布与运行监控」查看原发布。'),
  {status:409,code:'CHAT_PACKAGE_ALREADY_PUBLISHED'});
const time = value => typeof value==='string' ? Date.parse(value) : NaN;
const stableJson = value => JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);

export function chatPublicationBasis(delivery,actor) {
  if (delivery.status!=='SUCCEEDED' || !actor) throw conflict();
  const {intentId,changeRequestId,source,parent}=delivery;
  const evidence={intentId,changeRequestId,source,parent,deliveryId:delivery.delivery.id,packageId:delivery.package.id,
    packageDigest:delivery.package.digest,verificationId:delivery.verification.id,businessDate:delivery.verification.businessDate,
    businessScheduledFor:delivery.verification.scheduledFor,scheduleSpec};
  const reviewDigest=sha256(stableJson({protocol:'shuduo-chat-change-publication/v1',evidence,actor,verification:delivery.verification}));
  const h=sha256('chat-publication:'+reviewDigest);
  const requestId=h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
  return {...evidence,reviewDigest,requestId};
}

export function checkChatPublicationConsent(body,key,basis) {
  const expected={source:basis.source,packageId:basis.packageId,packageDigest:basis.packageDigest,verificationId:basis.verificationId,
    reviewDigest:basis.reviewDigest,attestations,confirm:true};
  if (!same(body?.attestations,attestations) || body?.confirm!==true)
    throw Object.assign(Error('请逐项审阅代码、断言、交付文件和两批本机测试范围，再确认发布'),{status:422});
  if (key!==basis.requestId || !same(body,expected)) throw conflict();
}
const ledger = (project,basis) => project+':chat-change-publication:'+basis.requestId;
function requireUnpublishedPackage(store,project,basis) {
  const prior=store.list('release',project).find(r=>r.packageId===basis.packageId && r.packageDigest===basis.packageDigest);
  if(!prior)return;
  if(prior.chatPublication?.intentId===basis.intentId && prior.chatPublication.changeRequestId===basis.changeRequestId) throw conflict();
  throw elsewhere();
}


export function activateChatPublication({store,project,basis,reviewer,artifact,now,timeUnitMs,unpack}) {
  let directory;
  const register=()=>{
    // Another front end may have published this exact artifact separately.
    // It cannot supply consent for this chat or authorize another pair of runs.
    requireUnpublishedPackage(store,project,basis);
    const activated=now(), stamp=new Date(activated).toISOString();
    const common={packageId:basis.packageId,packageDigest:basis.packageDigest,scope:'LOCAL_TEST_RELEASE',publicDeploymentApproved:false};
    const marker={intentId:basis.intentId,changeRequestId:basis.changeRequestId,requestId:basis.requestId,reviewDigest:basis.reviewDigest};
    const review=store.create('delivery_review',project,{...common,verificationId:basis.verificationId,
      reviewer,reviewNote:'已审阅当前派生版本，并确认同一冻结业务日的两个本机测试批次。',attestations,reviewedAt:stamp,status:'REVIEWED',chatPublication:marker});
    const source={sourceRevisionId:basis.source.revisionId,sourceCodeHash:basis.source.revisionHash,sourceSqlHash:basis.source.revisionHash};
    const approval=store.create('release_approval',project,{...common,...source,reviewId:review.id,rehearsalId:basis.verificationId,
      reviewer:reviewer.displayName,reviewedBy:reviewer,approver:reviewer,reviewNote:review.reviewNote,
      decision:'APPROVED',status:'APPROVED',approvedAt:stamp,chatTimerUnitMs:timeUnitMs,chatPublication:marker});
    const release=store.create('release',project,{packageId:basis.packageId,packageDigest:basis.packageDigest,...source,approvalId:approval.id,
      chatPublication:marker, sourceAgentTaskId:basis.source.taskId,sourceRunId:basis.source.runId,verificationId:basis.verificationId,
      environment:'local-rehearsal',adapter:'local-spark-v1',scheduleSpec,chatTimerUnitMs:timeUnitMs,activatedAt:stamp,businessScheduledFor:basis.businessScheduledFor,
      artifact,status:'ACTIVE_LOCAL',health:'OBSERVING',fullLifecycleE2E:false,publicDeployed:false});
    for (const planned of plannedLocalRuns({releaseId:release.id,packageId:basis.packageId,packageDigest:basis.packageDigest,
      businessScheduledFor:basis.businessScheduledFor,spec:scheduleSpec,nowMs:activated,timeUnitMs})){
      store.create('release_run',project,{...planned,sourceRevisionId:basis.source.revisionId,sourceSqlHash:basis.source.revisionHash,
        sourceAgentTaskId:basis.source.taskId,sourceRunId:basis.source.runId,chatPublication:marker});
    }
    store.update('release_approval',approval.id,project,{consumedByReleaseId:release.id,consumedAt:stamp});
    directory=unpack(release.id);
    return store.update('release',release.id,project,{artifactDirectory:directory});
  };
  try {
    return store.deduplicate(ledger(project,basis),basis.reviewDigest,register);
  } catch (error) {
    if(directory)rmSync(directory,{recursive:true,force:true});
    throw error;
  }
}

function validateAuthority({store,project,basis,bundle,release,actor}) {
  const {source}=basis,marker=release.chatPublication;
  const approval=store.get('release_approval',release.approvalId,project);
  const review=approval && store.get('delivery_review',approval.reviewId,project);
  if (!same(marker,{intentId:basis.intentId,changeRequestId:basis.changeRequestId,requestId:basis.requestId,reviewDigest:basis.reviewDigest}) ||
      store.deduplicatedId(ledger(project,basis),basis.reviewDigest)!==release.id ||
      !same(marker,approval?.chatPublication) || !same(marker,review?.chatPublication) ||
      ![release,approval,review].every(r=>r.packageId===bundle.id && r.packageDigest===bundle.digest) ||
      !same(review.attestations,attestations) || review.status!=='REVIEWED' || review.verificationId!==basis.verificationId ||
      review.reviewer?.id!==actor || (actor==='local-engineer')!==(review.reviewer.role==='LOCAL_DEVELOPMENT') ||
      !same(approval.approver,review.reviewer) || !same(approval.reviewedBy,review.reviewer) ||
      approval.status!=='APPROVED' || approval.decision!=='APPROVED' || approval.rehearsalId!==basis.verificationId ||
      [review,approval].some(r=>r.publicDeploymentApproved!==false || r.scope!=='LOCAL_TEST_RELEASE') ||
      release.publicDeployed!==false || release.fullLifecycleE2E!==false || approval.consumedByReleaseId!==release.id ||
      !Number.isFinite(time(release.activatedAt)) || approval.consumedAt!==release.activatedAt ||
      ![review.reviewedAt,approval.approvedAt].every(t=>t===release.activatedAt) ||
      release.sourceAgentTaskId!==source.taskId || release.sourceRunId!==source.runId || release.verificationId!==basis.verificationId ||
      ![release,approval].every(r=>r.sourceRevisionId===source.revisionId && r.sourceSqlHash===source.revisionHash && r.sourceCodeHash===source.revisionHash) ||
      !same(release.scheduleSpec,scheduleSpec) || release.businessScheduledFor!==basis.businessScheduledFor ||
      release.adapter!=='local-spark-v1' || release.environment!=='local-rehearsal') throw conflict();
  const batches=store.list('release_run',project).filter(r=>r.releaseId===release.id).sort((a,b)=>a.sequence-b.sequence);
  // Previously registered pairs carried each absolute trigger time. Reconstruct
  // their original unit only when the entire pair matches the frozen schedule.
  const activated=time(release.activatedAt);
  const unit=release.chatTimerUnitMs ?? ((time(batches[0]?.scheduledTriggerAt)-activated)/scheduleSpec.triggerAfterSeconds);
  if(!Number.isSafeInteger(unit) || unit<1 || release.chatTimerUnitMs!==approval.chatTimerUnitMs) throw conflict();
  const expected=plannedLocalRuns({releaseId:release.id,packageId:bundle.id,packageDigest:bundle.digest,businessScheduledFor:basis.businessScheduledFor,
    spec:scheduleSpec,nowMs:activated,timeUnitMs:unit});
  if (batches.length!==2 || batches.some((run,index)=>!same(run.chatPublication,marker) ||
      ['releaseId','packageId','packageDigest','sequence','businessScheduledFor','scheduledTriggerAt','triggerReason'].some(k=>run[k]!==expected[index][k]) ||
      run.sourceRevisionId!==source.revisionId || run.sourceRunId!==source.runId || run.sourceSqlHash!==source.revisionHash ||
      run.sourceAgentTaskId!==source.taskId || run.publicDeployed!==false || run.published!==true || run.fullLifecycleE2E!==false)) throw conflict();
  return {review,approval,batches};
}

export function assertChatRunClaim(args,run){
  const {batches}=validateAuthority(args);
  const current=batches.find(b=>b.id===run.id);
  if(args.release.status!=='ACTIVE_LOCAL' || current?.status!=='RUNNING' || !current.schedulerTriggered ||
     current.clockMode!=='WALL_CLOCK_TIMER' || current.mode!=='LOCAL_SCHEDULED_RELEASE' ||
     !(time(current.triggeredAt)>=time(current.scheduledTriggerAt))) throw conflict();
}

export function checkedChatRunResult(bundle,result,scheduledFor) {
  if(result.status==='SUCCEEDED' && (!matchesStoredHoldingsRehearsal(validateDeliveryPackage(bundle,bundle.digest),bundle,result,scheduledFor) ||
      result.validation.selectedPassed===false)) throw conflict();
  return result;
}

function batchSummary(run,events,alerts,plan,bundle) {
  const {id,sequence,status,schedulerTriggered,scheduledTriggerAt,triggeredAt,finishedAt}=run;
  const summary={id,sequence,status,schedulerTriggered,scheduledTriggerAt,...(triggeredAt?{triggeredAt}:{}),...(finishedAt?{finishedAt}:{}),
    ...(run.resultUnknown===true?{resultUnknown:true}:{})};
  if(!['SCHEDULED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(status)) throw conflict();
  if(schedulerTriggered) {
    if (!(time(triggeredAt)>=time(scheduledTriggerAt)) || !(time(run.startedAt)>=time(triggeredAt)) ||
        run.clockMode!=='WALL_CLOCK_TIMER' || run.mode!=='LOCAL_SCHEDULED_RELEASE') throw conflict();
  } else if (!['SCHEDULED','CANCELLED','FAILED'].includes(status) || triggeredAt) throw conflict();
  if (status==='SCHEDULED' && (finishedAt || events.length || alerts.length) || status==='RUNNING' && (finishedAt || events.length || alerts.length)) throw conflict();
  if (['SUCCEEDED','FAILED','INTERRUPTED'].includes(status)) {
    const type=status==='SUCCEEDED'?'BATCH_SUCCEEDED':status==='FAILED'?'BATCH_FAILED':'BATCH_RESULT_UNKNOWN';
    if (events.length!==1 || events[0].type!==type || events[0].status!==status || events[0].schedulerTriggered!==schedulerTriggered ||
        !(time(events[0].observedAt)>=time(finishedAt??triggeredAt)) || (status==='INTERRUPTED' && run.resultUnknown!==true) ||
        (status!=='SUCCEEDED' && !alerts.length)) throw conflict();
  }
  if (status==='SUCCEEDED'){
    if (!schedulerTriggered || run.resultUnknown || !(time(finishedAt)>=time(run.startedAt)) ||
        !matchesScheduledHoldingsBatch(plan,bundle,run) ||
        run.validation.selectedPassed===false) throw conflict();
    const cents=run.rows.map(row=>amountInCents(row.total_assets));
    if(cents.some(v=>v===undefined))throw conflict();
    Object.assign(summary,{engine:run.engine,engineVersion:run.engineVersion,assertionCount:run.validation.regressions.length,
      rowCount:run.rows.length,totalAssets:formatCents(cents.reduce((a,b)=>a+b,0n)),testSqlPassed:true});
  }
  return summary;
}

export function chatPublicationView({store,project,basis,bundle,actor,canPublish}) {
  const base={protocol:'shuduo-chat-change-publication/v1',...basis,scope:'LOCAL_TEST_RELEASE',publicDeployed:false,canPublish,monitoringVerified:false};
  const id=store.deduplicatedId(ledger(project,basis),basis.reviewDigest);
  if(!id) {
    if(store.deduplicatedId(ledger(project,basis))) throw conflict();
    requireUnpublishedPackage(store,project,basis);
    return {...base,phase:'READY',runs:[],events:[],alerts:[]};
  }
  const release=store.get('release',id,project);
  if(!release) throw conflict();
  const {review,approval,batches}=validateAuthority({store,project,basis,bundle,release,actor});
  const plan=validateDeliveryPackage(bundle,bundle.digest);
  const events=store.list('monitor_event',project).filter(e=>e.releaseId===id);
  const alerts=store.list('monitor_alert',project).filter(a=>a.releaseId===id);
  if(!['ACTIVE_LOCAL','CANCELLED'].includes(release.status) ||
     events.filter(e=>e.type==='RELEASE_CANCELLED').length!==(release.status==='CANCELLED'?1:0) ||
     events.some(e=>e.packageDigest!==bundle.digest || !Number.isFinite(time(e.observedAt)) ||
     (e.type==='RELEASE_CANCELLED' ? release.status!=='CANCELLED' : !batches.some(b=>b.id===e.releaseRunId))) ||
     alerts.some(a=>!['OPEN','RESOLVED'].includes(a.status) || !batches.some(b=>b.id===a.releaseRunId))) throw conflict();
  const runs=batches.map(run=>batchSummary(run,events.filter(e=>e.releaseRunId===run.id),alerts.filter(a=>a.releaseRunId===run.id),plan,bundle));
  const monitoringVerified=release.status==='ACTIVE_LOCAL' && runs.every(r=>r.status==='SUCCEEDED') && !alerts.some(a=>a.status==='OPEN');
  if ((release.health==='HEALTHY' && !monitoringVerified) || (monitoringVerified && release.health!=='HEALTHY')) throw conflict();
  return {...base,phase:'PUBLISHED',reviewId:review.id,reviewActorScope:review.reviewer.role==='LOCAL_DEVELOPMENT'?'LOCAL_DEVELOPER':'SIGNED_MEMBER',
    approvalId:approval.id,release:{id,status:release.status,health:release.health},runs,monitoringVerified,
    events:events.map(({id,type,releaseRunId,observedAt,status})=>({id,type,releaseRunId,observedAt,status})),
    alerts:alerts.map(({id,status,releaseRunId})=>({id,status,releaseRunId}))};
}
