import { sha256, validateDeliveryPackage, validationMatchesFamily } from "./delivery.mjs";
import { publicationAttestationKeys } from "./publication-request.mjs";

const fail = (status,message) => Object.assign(new Error(message),{status});
export function passedCloudReleaseBatch(receipt,item,plan) {
  return receipt?.status==="SUCCEEDED" && receipt.engine==="Apache Spark" &&
    receipt.engineVersion===plan.deployment.runtime.version && receipt.mainSqlExecuted===true && receipt.testDouble!==true &&
    receipt.testSqlValidation?.passed===true && receipt.testSqlValidation.sqlHash===sha256(item.files["tests.sql"]) &&
    validationMatchesFamily(receipt.validation,{id:plan.source.validationContractId,contextIds:plan.fixtures.validationContexts.map(context=>context.id)});
}

// Read the immutable release identity and committed monitor records. This path
// performs no queue, artifact, model or mutation operations.
export function exactPublicationReceipt(store, project, release) {
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
  if (release.status === "CANCELLED" || runs.some(run=>["FAILED","CANCELLED","INTERRUPTED"].includes(run.status)))
    monitoring.status = "NEEDS_ATTENTION";
  else if (runs.every(run=>run.status==="SUCCEEDED")) {
    const item = get("delivery_package",release.packageId), plan = validateDeliveryPackage(item,release.packageDigest);
    const checks = runs.map(run=>{
      const observed = events.filter(event=>event.releaseRunId===run.id && event.type==="BATCH_SUCCEEDED");
      const event = observed[0], triggered = Date.parse(run.triggeredAt), scheduled = Date.parse(run.scheduledTriggerAt);
      const finished = Date.parse(run.finishedAt);
      if (run.schedulerTriggered !== true || run.clockMode !== "FC_TIMER" ||
          run.businessScheduledFor !== release.businessScheduledFor || !Number.isFinite(triggered) ||
          !Number.isFinite(scheduled) || triggered < scheduled || !Number.isFinite(finished) || finished < triggered ||
          !passedCloudReleaseBatch(run,item,plan) || !["main.sql","tests.sql"].every(name=>run.fileHashes?.[name]===item.manifest.files[name].sha256) ||
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
      businessScheduledFor:release.businessScheduledFor},
    runs:runs.map(run=>({id:run.id,sequence:run.sequence,status:run.status,schedulerTriggered:run.schedulerTriggered,
      ...(run.stage ? {stage:run.stage} : {}),
      ...(Number.isFinite(run.reservedDurationMs) ? {reservedDurationMs:run.reservedDurationMs} : {}),
      ...(Number.isFinite(run.durationMs) ? {durationMs:run.durationMs} : {})})),monitoring};
}
