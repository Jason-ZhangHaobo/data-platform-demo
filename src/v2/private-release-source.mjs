import { exactPublicationReceipt } from "./cloud-release-evidence.mjs";
import { verifiedPrivateServiceSource } from "./data-services.mjs";

export function readPrivateReleaseBatch(store, project, id) {
  const get = (kind, value) => typeof value === "string" ? store.get(kind, value, project) : undefined;
  const run = get("release_run", id);
  const release = get("release", run?.releaseId);
  const bundle = get("delivery_package", run?.packageId);
  const approval = get("release_approval", release?.approvalId);
  const batch = verifiedPrivateServiceSource({run, release, bundle, approval,
    ...(release?.manualDeliveryTaskId ? {
      delivery: get("manual_delivery_task", release.manualDeliveryTaskId),
      verification: get("delivery_verification", release.verificationId),
      review: get("delivery_review", release.reviewId),
      releaseRuns: store.list("release_run", project).filter(item => item.releaseId === release.id),
    } : {}),
  });
  let monitoring;
  if ([release, run, approval].some(record => Object.hasOwn(record, "reviewDigest"))) {
    const fail = message => Object.assign(Error(message), {status:409, code:"PUBLICATION_MONITORING_UNCONFIRMED"});
    if (typeof release.reviewDigest !== "string" || run.reviewDigest !== release.reviewDigest || approval.reviewDigest !== release.reviewDigest)
      throw fail("原发布审阅摘要不一致");
    ({monitoring} = exactPublicationReceipt(store, project, release));
    if (monitoring.status !== "VERIFIED" || !monitoring.batches.some(item => item.batchId === batch.id))
      throw fail("原发布的两个批次及同包监控尚未核验");
  }
  return {batch, release, bundle, monitoring};
}
