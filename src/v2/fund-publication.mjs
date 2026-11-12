import { isDeepStrictEqual as same } from "node:util";
import { resolveDeliverySchedule, sha256, validateDeliveryPackage } from "./delivery.mjs";
import { verifiedFundRun } from "./fund-delivery.mjs";
import { isFundContext } from "./fund-contexts.mjs";
import { plannedLocalRuns } from "./release-scheduler.mjs";

const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => Object.assign(new Error("基金本机发布须确认同一包、演练、业务日及两个冻结样例批次"), {
  status: 409, code: "FUND_PUBLICATION_SOURCE_CHANGED",
});

export function assertFundRehearsal(bundle, verification) {
  if (!isFundContext(bundle?.manifest?.source?.contextId)) return;
  const plan = validateDeliveryPackage(bundle, bundle.digest);
  if (!verifiedFundRun(verification, plan.source.contextId) || verification.engineVersion !== plan.deployment.runtime.version ||
      verification.packageId !== bundle.id || verification.packageDigest !== bundle.digest ||
      verification.mode !== "LOCAL_FILE_REHEARSAL" || verification.published !== false ||
      verification.schedulerTriggered !== false || !same(verification.source, plan.source) ||
      verification.testSqlValidation?.passed !== true ||
      verification.testSqlValidation.sqlHash !== sha256(bundle.files["tests.sql"])) throw fail();
  const occurrence = resolveDeliverySchedule(plan, verification.occurrence?.scheduledFor);
  if (!occurrence.eligible || occurrence.businessDate !== plan.source.fundLookthrough.businessDate ||
      !same(verification.occurrence, occurrence)) throw fail();
  return occurrence;
}

export function assertFundConsent({ bundle, verification, review, consent, localClassicSpark, schedulerMode }) {
  if (!isFundContext(bundle?.manifest?.source?.contextId)) {
    if (consent !== undefined) throw fail();
    return;
  }
  if (bundle.manifest.source.attribution?.kind !== "ENGINEER_AUTHORED")
    throw Object.assign(new Error("基金 Agent 文件演练仅支持本机文件审阅"), { status: 409, code: "FUND_AGENT_REHEARSAL_ONLY" });
  const occurrence = assertFundRehearsal(bundle, verification);
  const spec = consent?.scheduleSpec;
  if (!localClassicSpark || schedulerMode !== "LOCAL_TIMER" ||
      !exact(consent, ["scope", "packageDigest", "verificationId", "businessDate", "scheduleSpec", "confirmFrozenFictionalData"]) ||
      consent.scope !== "LOCAL_TEST_RELEASE" || consent.packageDigest !== bundle.digest ||
      consent.verificationId !== verification.id || consent.businessDate !== occurrence.businessDate ||
      consent.confirmFrozenFictionalData !== true || !exact(spec, ["triggerAfterSeconds", "intervalSeconds", "runCount"]) ||
      spec.runCount !== 2 || ![spec.triggerAfterSeconds, spec.intervalSeconds].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 300) ||
      review?.status !== "REVIEWED" || review.scope !== "LOCAL_FILE_REVIEW" || review.publicDeploymentApproved !== false ||
      review.packageId !== bundle.id || review.packageDigest !== bundle.digest || review.verificationId !== verification.id) throw fail();
  return structuredClone(consent);
}

export function assertFundRelease({ bundle, verification, review, approval, spec, localClassicSpark, schedulerMode }) {
  assertFundConsent({ bundle, verification, review, consent: approval?.fundConsent, localClassicSpark, schedulerMode });
  if (approval.status !== "APPROVED" || approval.scope !== "LOCAL_TEST_RELEASE" || approval.publicDeploymentApproved !== false ||
      approval.packageId !== bundle.id || approval.packageDigest !== bundle.digest || approval.rehearsalId !== verification.id ||
      approval.reviewId !== review.id || approval.sourceRevisionId !== bundle.manifest.source.revisionId ||
      approval.sourceSqlHash !== bundle.manifest.source.sqlHash || !same(approval.fundConsent.scheduleSpec, spec)) throw fail();
}

export function assertFundBatch({ bundle, verification, review, approval, release, run, batches, localClassicSpark, schedulerMode, timeUnitMs }) {
  assertFundRelease({ bundle, verification, review, approval, spec: release.scheduleSpec, localClassicSpark, schedulerMode });
  const source = bundle.manifest.source;
  if (approval.consumedByReleaseId !== release.id || release.packageId !== bundle.id || release.packageDigest !== bundle.digest ||
      release.sourceRevisionId !== source.revisionId || release.sourceSqlHash !== source.sqlHash || release.publicDeployed !== false ||
      release.adapter !== "local-spark-v1" || release.environment !== "local-rehearsal" ||
      !same(release.fundLookthrough, source.fundLookthrough) || release.businessScheduledFor !== verification.occurrence.scheduledFor ||
      batches.length !== 2 || new Set(batches.map(batch => batch.sequence)).size !== 2 || !batches.some(batch => batch.id === run.id) ||
      batches.some(batch => ![1, 2].includes(batch.sequence) || batch.packageId !== bundle.id || batch.packageDigest !== bundle.digest ||
        batch.businessScheduledFor !== release.businessScheduledFor || batch.triggerReason !== "LOCAL_TEST_SCHEDULE")) throw fail();
  const planned = plannedLocalRuns({ releaseId: release.id, packageId: bundle.id, packageDigest: bundle.digest,
    businessScheduledFor: release.businessScheduledFor, spec: release.scheduleSpec, nowMs: Date.parse(release.activatedAt), timeUnitMs });
  if (batches.some(batch => batch.scheduledTriggerAt !== planned[batch.sequence - 1].scheduledTriggerAt)) throw fail();
}
