import { isDeepStrictEqual as same } from "node:util";
import { resolveDeliverySchedule, sha256 } from "./delivery.mjs";
import { assertSyncSqlRehearsal } from "./delivery-runner.mjs";
import { localScheduleSpec, plannedLocalRuns } from "./release-scheduler.mjs";

const ttlMs = 15 * 60_000;
const attestations = ["code", "assertions", "deliveryFiles", "localScope"];
const fail = (code, message) => Object.assign(Error(message), { status: 409, code });
const invalid = () => fail("SYNC_RELEASE_SOURCE_CHANGED", "批准须绑定原持仓快照、包、审阅、成功演练及两批计时计划");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = value => sha256(JSON.stringify(value));

export function assertSyncSqlConsent({ bundle, plan, verification, review, consent, actorId, enabled }) {
  const input = plan?.source?.syncInput;
  if (!input) {
    if (consent !== undefined) throw invalid();
    return;
  }
  const spec = consent?.scheduleSpec;
  if (!enabled || !verification || !review || actorId !== input.actorId ||
      !exact(consent, ["scope", "packageDigest", "verificationId", "snapshotHash", "businessDate", "scheduleSpec", "confirmFrozenFictionalData"]) ||
      consent.scope !== "LOCAL_TEST_RELEASE" || consent.confirmFrozenFictionalData !== true ||
      consent.packageDigest !== plan.digest || consent.verificationId !== verification.id ||
      consent.snapshotHash !== input.snapshotHash || consent.businessDate !== plan.fixtures.context.businessDate ||
      !exact(spec, ["triggerAfterSeconds", "intervalSeconds", "runCount"]) || spec.runCount !== 2 ||
      !Number.isInteger(spec.triggerAfterSeconds) || !Number.isInteger(spec.intervalSeconds) ||
      !same(localScheduleSpec(spec), spec) ||
      review.status !== "REVIEWED" || review.scope !== "LOCAL_FILE_REVIEW" || review.publicDeploymentApproved !== false ||
      review.reviewer?.id !== input.actorId || review.packageId !== bundle.id || review.packageDigest !== bundle.digest ||
      review.verificationId !== verification.id || verification.packageId !== bundle.id ||
      !exact(review.attestations, attestations) || !attestations.every(key => review.attestations[key] === true))
    throw invalid();
  assertSyncSqlRehearsal(plan, bundle, verification);
  const occurrence = resolveDeliverySchedule(plan, verification.scheduledFor);
  if (!occurrence.eligible || occurrence.businessDate !== consent.businessDate ||
      !same(occurrence, verification.occurrence)) throw invalid();
  return structuredClone(consent);
}

export const syncApprovalExpiry = now => new Date(now + ttlMs).toISOString();

export function syncSqlReviewDigest(verification, review) {
  return digest({ verification, review });
}

export function assertSyncSqlApproval({ bundle, plan, approval, verification, review, spec, actorId, enabled }) {
  const consent = assertSyncSqlConsent({ bundle, plan, verification, review, consent: approval.syncConsent, actorId, enabled });
  const approvedAt = Date.parse(approval.approvedAt), expiresAt = Date.parse(approval.expiresAt);
  if (!consent || approval.status !== "APPROVED" || approval.scope !== "LOCAL_TEST_RELEASE" ||
      approval.publicDeploymentApproved !== false || approval.approver?.id !== actorId ||
      approval.packageId !== bundle.id || approval.packageDigest !== bundle.digest || approval.reviewId !== review.id ||
      approval.rehearsalId !== verification.id || approval.sourceRevisionId !== plan.source.revisionId ||
      approval.sourceSqlHash !== plan.source.sqlHash || !same(spec, consent.scheduleSpec) ||
      approval.syncReviewDigest !== syncSqlReviewDigest(verification, review) ||
      !Number.isFinite(approvedAt) || expiresAt - approvedAt !== ttlMs) throw invalid();
}

export function activateSyncSqlRelease({ store, project, bundle, plan, approval, verification, review, spec,
  actorId, enabled, now, timeUnitMs, artifact, unpack }) {
  assertSyncSqlApproval({ bundle, plan, approval, verification, review, spec, actorId, enabled });
  const result = store.deduplicate(`${project}:sync-sql-release:${approval.id}`,
    digest({ approvalId: approval.id, packageId: bundle.id, digest: bundle.digest, spec }), () => {
      const currentApproval = store.get("release_approval", approval.id, project);
      if (!same(currentApproval, approval) ||
          !same(store.get("delivery_review", review.id, project), review) ||
          !same(store.get("delivery_verification", verification.id, project), verification) ||
          currentApproval.consumedByReleaseId) throw invalid();
      const activated = now();
      if (activated < Date.parse(approval.approvedAt) || activated >= Date.parse(approval.expiresAt))
        throw fail("SYNC_RELEASE_APPROVAL_EXPIRED", "测试发布批准已过期，请重新核对确切版本");
      const activatedAt = new Date(activated).toISOString();
      const release = store.create("release", project, {
        approvalId: approval.id, packageId: bundle.id, packageDigest: bundle.digest, artifact,
        sourceRevisionId: plan.source.revisionId, sourceSqlHash: plan.source.sqlHash, sourceCodeHash: plan.source.sqlHash,
        syncInput: plan.source.syncInput, status: "ACTIVE_LOCAL", health: "OBSERVING",
        environment: plan.deployment.environment, adapter: plan.deployment.adapter,
        scheduleSpec: spec, businessScheduledFor: verification.scheduledFor, activatedAt, publicDeployed: false, fullLifecycleE2E: false,
      });
      const artifactDirectory = unpack(release.id);
      const batches = plannedLocalRuns({ releaseId: release.id, packageId: bundle.id, packageDigest: bundle.digest,
        businessScheduledFor: release.businessScheduledFor, spec, nowMs: activated, timeUnitMs });
      for (const batch of batches)
        store.create("release_run", project, { ...batch, sourceRevisionId: release.sourceRevisionId, snapshotHash: release.syncInput.snapshotHash });
      store.update("release_approval", approval.id, project, { consumedByReleaseId: release.id, consumedAt: activatedAt });
      return store.update("release", release.id, project, { artifactDirectory });
    });
  const release = store.get("release", result.id, project);
  if (release?.approvalId !== approval.id || release?.packageDigest !== bundle.digest ||
      !same(release.syncInput, plan.source.syncInput) || !same(release.scheduleSpec, spec) ||
      store.get("release_approval", approval.id, project)?.consumedByReleaseId !== release.id) throw invalid();
  return { release, replayed: result.replayed };
}

export function assertSyncSqlBatch({ bundle, plan, approval, verification, review, release, run, batches, enabled, timeUnitMs }) {
  assertSyncSqlApproval({ bundle, plan, approval, verification, review, spec: release.scheduleSpec,
    actorId: plan.source.syncInput.actorId, enabled });
  const activated = Date.parse(release.activatedAt);
  if (release.status !== "ACTIVE_LOCAL" || release.approvalId !== approval.id || approval.consumedByReleaseId !== release.id ||
      approval.consumedAt !== release.activatedAt || !Number.isFinite(activated) ||
      activated < Date.parse(approval.approvedAt) || activated >= Date.parse(approval.expiresAt) ||
      release.packageId !== bundle.id || release.packageDigest !== bundle.digest || release.sourceRevisionId !== plan.source.revisionId ||
      release.sourceSqlHash !== plan.source.sqlHash || !same(release.syncInput, plan.source.syncInput) ||
      release.businessScheduledFor !== verification.scheduledFor || release.publicDeployed !== false || run.status !== "RUNNING")
    throw invalid();
  const expected = plannedLocalRuns({ releaseId: release.id, packageId: bundle.id, packageDigest: bundle.digest,
    businessScheduledFor: release.businessScheduledFor, spec: release.scheduleSpec, nowMs: activated, timeUnitMs });
  if (batches.length !== expected.length || !batches.some(batch => batch.id === run.id) ||
      !expected.every(planned => batches.filter(batch => batch.sequence === planned.sequence &&
        ["releaseId", "packageId", "packageDigest", "businessScheduledFor", "scheduledTriggerAt", "triggerReason"]
          .every(key => batch[key] === planned[key]) &&
        batch.sourceRevisionId === release.sourceRevisionId && batch.snapshotHash === release.syncInput.snapshotHash &&
        batch.publicDeployed === false).length === 1) ||
      run.schedulerTriggered !== true || run.clockMode !== "WALL_CLOCK_TIMER" ||
      !(Date.parse(run.triggeredAt) >= Date.parse(run.scheduledTriggerAt))) throw invalid();
}
