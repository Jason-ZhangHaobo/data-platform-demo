import { sha256, validateDeliveryPackage, validationMatchesFamily } from "./delivery.mjs";
import { fundRehearsalMatchesPlan } from "./fund-delivery.mjs";
import { publicationAttestationKeys } from "./publication-request.mjs";
import { storedWorkerBatchResult } from "./worker-result-evidence.mjs";

const fail = (status,message) => Object.assign(new Error(message),{status});
const originalBatchResult = (store,project,run) =>
  storedWorkerBatchResult(store,run,run.remoteSubmission?.prepared?.job,`${project}:cloud-release-result:${run.id}`);
export function exactPublicationReviewBasis(evidence,{businessDate,businessScheduledFor}) {
  return {evidence,businessDate,businessScheduledFor,plannedBatchCount:2,scope:"PRIVATE_CLOUD_TEST"};
}

export function passedCloudReleaseBatch(receipt,item,plan) {
  if (plan.source.fundDevelopment) return Boolean(receipt && fundRehearsalMatchesPlan(receipt,plan,item.files["tests.sql"]));
  return receipt?.status==="SUCCEEDED" && receipt.engine==="Apache Spark" &&
    receipt.engineVersion===plan.deployment.runtime.version && receipt.mainSqlExecuted===true && receipt.testDouble!==true &&
    receipt.testSqlValidation?.passed===true && receipt.testSqlValidation.sqlHash===sha256(item.files["tests.sql"]) &&
    validationMatchesFamily(receipt.validation,{id:plan.source.validationContractId,contextIds:plan.fixtures.validationContexts.map(context=>context.id)});
}

// Derived only from the original batch and the clock. The signed timer remains
// responsible for settling Worker results and their monitoring evidence.
export function projectCloudReleaseBatchStage(run, now) {
  const job=run.remoteSubmission?.prepared?.job;
  if (run.status==="RUNNING" && run.schedulerTriggered===true && run.clockMode==="FC_TIMER" &&
      run.sourceKind==="AGENT" && typeof run.reviewDigest==="string" && /^[a-f0-9]{64}$/.test(run.reviewDigest) &&
      ["SUBMITTING","WAITING_FOR_WORKER_RESULT"].includes(run.stage) &&
      job && job.jobId===run.id && job.projectId===run.projectId) {
    const deadline=Date.parse(job.expiresAt), triggered=Date.parse(run.triggeredAt);
    if (deadline>triggered && now>=deadline) return {...run,stage:"WORKER_RESULT_UNCONFIRMED"};
  }
  return run;
}

function publicationFailureEvidence(store,project,release,runs,events) {
  if (!runs.some(run=>run.status==="FAILED")) return {};
  const batches=runs.map(run=>{
    const result=originalBatchResult(store,project,run);
    const observed=events.filter(event=>event.releaseRunId===run.id &&
      ["BATCH_SUCCEEDED","BATCH_FAILED"].includes(event.type));
    const event=observed[0], triggered=Date.parse(run.triggeredAt), scheduled=Date.parse(run.scheduledTriggerAt);
    if (!result || run.stage!=="COMPLETED" || run.schedulerTriggered!==true || run.clockMode!=="FC_TIMER" ||
        run.businessScheduledFor!==release.businessScheduledFor || !(scheduled<=triggered && triggered<=Date.parse(result.finishedAt)) ||
        observed.length!==1 || event.type!==(result.status==="FAILED"?"BATCH_FAILED":"BATCH_SUCCEEDED") ||
        event.status!==result.status || event.packageDigest!==release.packageDigest ||
        !(Date.parse(event.observedAt)>=Date.parse(result.finishedAt))) return;
    return {...result,eventId:event.id};
  });
  const confirmed=release.status==="COMPLETED_CLOUD_TEST" && batches.every(Boolean);
  return {
    failureEvidence:{status:confirmed?"CONFIRMED":"PENDING",
      batches:runs.map((run,index)=>({id:run.id,status:batches[index]?"CONFIRMED":"PENDING"}))},
    ...(confirmed?{settledFailure:{batches}}:{}),
  };
}

// Read the immutable release identity and committed monitor records. This path
// performs no queue, artifact, model or mutation operations.
export function exactPublicationReceipt(store, project, release, now=Date.now()) {
  const get = (kind,id) => {
    const value=store.get(kind,id,project);
    if (!value) throw fail(404,"未找到原发布证据");
    return value;
  };
  const review = get("delivery_review",release.reviewId), approval = get("release_approval",release.approvalId);
  const runs = store.list("release_run",project).filter(run=>run.releaseId===release.id).sort((a,b)=>a.sequence-b.sequence);
  if (release.scope !== "PRIVATE_CLOUD_TEST" || typeof release.reviewDigest!=="string" ||
      !/^[a-f0-9]{64}$/.test(release.reviewDigest) || review.status !== "REVIEWED" || approval.status !== "APPROVED" ||
      !publicationAttestationKeys.every(key=>review.attestations?.[key]===true) ||
      review.verificationId !== release.verificationId ||
      approval.reviewId !== review.id || approval.rehearsalId !== release.verificationId ||
      approval.sourceRevisionId !== release.sourceRevisionId || approval.sourceCodeHash !== release.sourceCodeHash ||
      [review,approval].some(value=>value.reviewDigest!==release.reviewDigest || value.packageDigest!==release.packageDigest ||
        value.packageId!==release.packageId || value.submittedBy!==release.submittedBy ||
        value.sourceRunId!==release.sourceRunId || value.scope!==release.scope) ||
      runs.length!==2 || runs.some((run,index)=>run.sequence!==index+1 || run.packageId!==release.packageId ||
        run.packageDigest!==release.packageDigest || run.sourceAgentTaskId!==release.sourceAgentTaskId ||
        run.sourceRunId!==release.sourceRunId || run.reviewDigest!==release.reviewDigest))
    throw fail(409,"发布、人工审阅、批准及调度批次的原记录不一致");
  const events = store.list("monitor_event",project).filter(event=>event.releaseId===release.id);
  const openAlertCount = store.list("monitor_alert",project).filter(alert=>alert.releaseId===release.id && alert.status==="OPEN").length;
  const monitoring = {status:"PENDING",health:release.health,openAlertCount};
  const failure=publicationFailureEvidence(store,project,release,runs,events);
  const verification = store.get("delivery_verification",release.verificationId,project);
  const approvalTiming = verification?.status === "SUCCEEDED" && verification.packageId === release.packageId &&
    verification.packageDigest === release.packageDigest &&
    [verification.finishedAt,review.reviewedAt,approval.approvedAt].every(value=>typeof value==="string" && Number.isFinite(Date.parse(value))) &&
    Date.parse(verification.finishedAt) <= Date.parse(review.reviewedAt) &&
    Date.parse(review.reviewedAt) <= Date.parse(approval.approvedAt) ?
    {readyAt:verification.finishedAt,reviewedAt:review.reviewedAt,approvedAt:approval.approvedAt} : undefined;
  if (release.status === "CANCELLED" || runs.some(run=>["FAILED","CANCELLED","INTERRUPTED"].includes(run.status)))
    monitoring.status = "NEEDS_ATTENTION";
  else if (runs.every(run=>run.status==="SUCCEEDED")) {
    const item = get("delivery_package",release.packageId), plan = validateDeliveryPackage(item,release.packageDigest);
    const checks = runs.map(run=>{
      const observed = events.filter(event=>event.releaseRunId===run.id && event.type==="BATCH_SUCCEEDED");
      const event = observed[0], triggered = Date.parse(run.triggeredAt), scheduled = Date.parse(run.scheduledTriggerAt);
      const original = originalBatchResult(store,project,run);
      const finished = Date.parse(run.finishedAt);
      if (run.schedulerTriggered !== true || run.clockMode !== "FC_TIMER" ||
          run.businessScheduledFor !== release.businessScheduledFor || !Number.isFinite(triggered) ||
          !Number.isFinite(scheduled) || triggered < scheduled || !Number.isFinite(finished) || finished < triggered ||
          !original || !passedCloudReleaseBatch(run,item,plan) ||
          (plan.source.fundDevelopment && (release.fundBusinessDate!==plan.source.fundLookthrough.businessDate ||
            run.fundBusinessDate!==release.fundBusinessDate)) ||
          !["main.sql","tests.sql"].every(name=>run.fileHashes?.[name]===item.manifest.files[name].sha256) ||
          observed.length!==1 || event.status!=="SUCCEEDED" || event.packageDigest!==release.packageDigest ||
          !(Date.parse(event.observedAt)>=finished)) return;
      return {batchId:run.id,eventId:event.id,observedAt:event.observedAt};
    });
    if (release.status==="COMPLETED_CLOUD_TEST" && release.health==="HEALTHY" && openAlertCount===0 && checks.every(Boolean)) {
      monitoring.status="VERIFIED";
      monitoring.batches=checks;
    } else monitoring.status="UNCONFIRMED";
  }
  return {protocol:"shuduo-cloud-publication-receipt/v1",
    release:{id:release.id, taskId:release.sourceAgentTaskId, sourceRunId:release.sourceRunId,
      sourceRevisionId:release.sourceRevisionId, sourceCodeHash:release.sourceCodeHash, packageId:release.packageId,
      packageDigest:release.packageDigest, verificationId:release.verificationId, reviewDigest:release.reviewDigest,
      reviewId:review.id, approvalId:approval.id, status:release.status, scope:release.scope,
      businessScheduledFor:release.businessScheduledFor,...(approvalTiming?{approvalTiming}:{})},
    runs:runs.map(record=>{
      const run=projectCloudReleaseBatchStage(record,now);
      return {id:run.id,sequence:run.sequence,status:run.status,schedulerTriggered:run.schedulerTriggered,
        ...(run.stage ? {stage:run.stage} : {}),
        ...(Number.isFinite(run.reservedDurationMs) ? {reservedDurationMs:run.reservedDurationMs} : {}),
        ...(Number.isFinite(run.durationMs) ? {durationMs:run.durationMs} : {})};
    }),monitoring,...failure};
}
