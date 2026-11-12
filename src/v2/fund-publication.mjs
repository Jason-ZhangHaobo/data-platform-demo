import { isDeepStrictEqual as same } from "node:util";
import { resolveDeliverySchedule, sha256, validateDeliveryPackage } from "./delivery.mjs";
import { fundAgentAttributionKind, verifiedFundRun } from "./fund-delivery.mjs";
import { isFundContext } from "./fund-contexts.mjs";
import { plannedLocalRuns } from "./release-scheduler.mjs";

const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => Object.assign(new Error("基金本机发布须确认同一包、演练、业务日及两个冻结样例批次"), {
  status: 409, code: "FUND_PUBLICATION_SOURCE_CHANGED",
});
const fundAgentSchedule = Object.freeze({ triggerAfterSeconds: 5, intervalSeconds: 30, runCount: 2 });
const attestations = ["code", "assertions", "deliveryFiles", "localScope"];

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
  const attribution = bundle.manifest.source.attribution;
  const agent = attribution?.kind === fundAgentAttributionKind;
  if (!agent && attribution?.kind !== "ENGINEER_AUTHORED") throw fail();
  const preflight = agent ? fundAgentPublicationPreflight({ bundle, verification, review, localClassicSpark, schedulerMode }) : undefined;
  const businessDate = preflight?.businessDate ?? assertFundRehearsal(bundle, verification).businessDate;
  const spec = consent?.scheduleSpec;
  if (!localClassicSpark || schedulerMode !== "LOCAL_TIMER" ||
      !exact(consent, ["scope", "packageDigest", "verificationId", "businessDate", "scheduleSpec", "confirmFrozenFictionalData", ...(agent ? ["preflightDigest"] : [])]) ||
      consent.scope !== "LOCAL_TEST_RELEASE" || consent.packageDigest !== bundle.digest ||
      consent.verificationId !== verification.id || consent.businessDate !== businessDate ||
      consent.confirmFrozenFictionalData !== true || !exact(spec, ["triggerAfterSeconds", "intervalSeconds", "runCount"]) ||
      spec.runCount !== 2 || ![spec.triggerAfterSeconds, spec.intervalSeconds].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 300) ||
      review?.status !== "REVIEWED" || review.scope !== "LOCAL_FILE_REVIEW" || review.publicDeploymentApproved !== false ||
      review.packageId !== bundle.id || review.packageDigest !== bundle.digest || review.verificationId !== verification.id) throw fail();
  if (preflight) {
    if (!preflight.ready || consent.preflightDigest !== preflight.digest || !same(spec, preflight.scheduleSpec)) throw fail();
  }
  return structuredClone(consent);
}

export function fundAgentPublicationPreflight({ bundle, verification, review, localClassicSpark, schedulerMode }) {
  const source = bundle?.manifest?.source, attribution = source?.attribution;
  if (attribution?.kind !== fundAgentAttributionKind) throw fail();
  const occurrence = assertFundRehearsal(bundle, verification);
  const ready = Boolean(localClassicSpark && schedulerMode === "LOCAL_TIMER" && review?.status === "REVIEWED" &&
    review.scope === "LOCAL_FILE_REVIEW" && review.publicDeploymentApproved === false &&
    review.reviewer?.id === attribution.actorId && review.packageId === bundle.id &&
    review.packageDigest === bundle.digest && review.verificationId === verification.id &&
    exact(review.attestations, attestations) && attestations.every(key => review.attestations[key] === true));
  const evidence = { protocol: "shuduo-fund-agent-publication-preflight/v1", scope: "LOCAL_TEST_RELEASE",
    taskId: attribution.originAgentTaskId, sourceRunId: source.runId, revisionId: source.revisionId,
    packageId: bundle.id, packageDigest: bundle.digest, verificationId: verification.id,
    businessDate: occurrence.businessDate, modelMode: attribution.modelMode, scheduleSpec: fundAgentSchedule,
    reviewId: ready ? review.id : null, ready };
  return { ...evidence, digest: sha256(JSON.stringify(evidence)) };
}

export function assertFundRelease({ bundle, verification, review, approval, spec, localClassicSpark, schedulerMode }) {
  assertFundConsent({ bundle, verification, review, consent: approval?.fundConsent, localClassicSpark, schedulerMode });
  if (approval.status !== "APPROVED" || approval.scope !== "LOCAL_TEST_RELEASE" || approval.publicDeploymentApproved !== false ||
      approval.packageId !== bundle.id || approval.packageDigest !== bundle.digest || approval.rehearsalId !== verification.id ||
      approval.reviewId !== review.id || approval.sourceRevisionId !== bundle.manifest.source.revisionId ||
      approval.sourceSqlHash !== bundle.manifest.source.sqlHash || !same(approval.fundConsent.scheduleSpec, spec) ||
      bundle.manifest.source.attribution?.kind === fundAgentAttributionKind &&
      approval.approver?.id !== bundle.manifest.source.attribution.actorId) throw fail();
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

export function assertFundAgentMonitoring({ bundle, verification, release, batches, events, alerts }) {
  const successful = batches.filter(item => item.status === "SUCCEEDED");
  if (release.health === "HEALTHY" && (successful.length !== 2 || release.successfulRunCount !== 2 ||
      release.failedRunCount !== 0 || alerts.some(alert => alert.status === "OPEN"))) throw fail();
  for (const batch of successful) {
    const related = events.filter(event => event.type === "BATCH_SUCCEEDED" && event.releaseRunId === batch.id);
    if (!verifiedFundRun(batch, bundle.manifest.source.contextId) || batch.engineVersion !== verification.engineVersion ||
        batch.schedulerTriggered !== true || batch.mode !== "LOCAL_SCHEDULED_RELEASE" || batch.publicDeployed !== false ||
        batch.clockMode !== "WALL_CLOCK_TIMER" || !["LOCAL_SPARK_PROCESS", "TEST_HARNESS"].includes(batch.executionEvidenceMode) ||
        !same(batch.source, verification.source) || !same(batch.occurrence, verification.occurrence) ||
        !same(batch.fileHashes, verification.fileHashes) || !same(batch.testSqlValidation, verification.testSqlValidation) ||
        related.length !== 1 || related[0].releaseId !== batch.releaseId || related[0].packageDigest !== bundle.digest ||
        related[0].status !== "SUCCEEDED" || related[0].schedulerTriggered !== true) throw fail();
  }
}
