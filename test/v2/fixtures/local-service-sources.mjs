import { createDeliveryPackage, sha256 } from "../../../src/v2/delivery.mjs";
import { getContext, referenceSqlForContext, validationFamilyForContext } from "../../../src/v2/context.mjs";

// Stored synthetic proof only. No executor, model, timer, network or credentials.
// Every record is in the supplied MetadataStore and has its real generated ID.
export function seedLocalServiceSource({ store, project, contextId = "holdings-t1" }) {
  const family = validationFamilyForContext(contextId), sql = referenceSqlForContext(contextId),
    validation = { passed: true, contractId: family.id, regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) },
    time = seconds => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  let agent = store.create("agent", project, { status: "SUCCEEDED", mode: "LIVE_MODEL", language: "SPARK_SQL", contextId, sql, message: "虚构证券客户资产同源交付",
    validationContractId: family.id, attempts: [], usedTokens: 100 });
  const revision = store.create("revision", project, { source: "LIVE_MODEL", contextId, sql, hash: sha256(sql) });
  const codeRun = store.create("run", project, { agentTaskId: agent.id, revisionId: revision.id, revisionHash: revision.hash, contextId,
    status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    validationContractId: family.id, validation, rows: getContext(contextId).expected });
  agent = store.update("agent", agent.id, project, { revisionId: revision.id, runId: codeRun.id,
    attempts: [{ status: "SUCCEEDED", model: "qwen3.7-plus", revisionId: revision.id, runId: codeRun.id }] });
  let bundle = store.create("delivery_package", project, { ...createDeliveryPackage({ run: codeRun, revision }), sourceRunId: codeRun.id });
  let delivery = store.create("agent_delivery_task", project, { mode: "VERIFIED_ARTIFACT_ORCHESTRATION", status: "SUCCEEDED", actualExecution: true,
    sourceAgentTaskId: agent.id, sourceRunId: codeRun.id, sourceRevisionId: revision.id, sourceSqlHash: revision.hash,
    packageId: bundle.id, packageDigest: bundle.digest });
  bundle = store.update("delivery_package", bundle.id, project, { agentDeliveryTaskId: delivery.id });
  const files = { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    packageDigest: bundle.digest, source: bundle.manifest.source,
    fileHashes: Object.fromEntries(Object.entries(bundle.manifest.files).map(([name, value]) => [name, value.sha256])),
    validation: { passed: true, regressions: validation.regressions },
    testSqlValidation: { passed: true, sqlHash: sha256(bundle.files["tests.sql"]) }, rows: getContext(contextId).expected };
  const verification = store.create("delivery_verification", project, { ...files, packageId: bundle.id, agentDeliveryTaskId: delivery.id,
    mode: "LOCAL_FILE_REHEARSAL", scope: "M2A_LOCAL_FILE_REHEARSAL", published: false });
  delivery = store.update("agent_delivery_task", delivery.id, project, { verificationId: verification.id });
  const review = store.create("delivery_review", project, { status: "REVIEWED", scope: "LOCAL_TEST_RELEASE", publicDeploymentApproved: false,
    packageId: bundle.id, packageDigest: bundle.digest, verificationId: verification.id,
    attestations: { code: true, assertions: true, deliveryFiles: true, localScope: true } });
  let approval = store.create("release_approval", project, { status: "APPROVED", scope: "LOCAL_TEST_RELEASE", publicDeploymentApproved: false,
    packageId: bundle.id, packageDigest: bundle.digest, rehearsalId: verification.id, reviewId: review.id,
    sourceRevisionId: revision.id, sourceCodeHash: revision.hash, sourceSqlHash: revision.hash });
  const release = store.create("release", project, { status: "ACTIVE_LOCAL", health: "HEALTHY", publicDeployed: false,
    environment: "local-rehearsal", adapter: "local-spark-v1", packageId: bundle.id, packageDigest: bundle.digest, approvalId: approval.id,
    sourceRevisionId: revision.id, sourceCodeHash: revision.hash, sourceSqlHash: revision.hash, activatedAt: time(10),
    scheduleSpec: { triggerAfterSeconds: 1, intervalSeconds: 2, runCount: 2 }, successfulRunCount: 2, failedRunCount: 0, openAlertCount: 0 });
  approval = store.update("release_approval", approval.id, project, { consumedByReleaseId: release.id });
  const batches = [0, 1].map(index => {const batch=store.create("release_run", project, { ...files, packageId: bundle.id, releaseId: release.id,
    mode: "LOCAL_SCHEDULED_RELEASE", clockMode: "WALL_CLOCK_TIMER", published: true, publicDeployed: false, schedulerTriggered: true,
    triggerReason: "LOCAL_TEST_SCHEDULE", sequence: index + 1, scheduledTriggerAt: time(11 + index * 2), triggeredAt: time(11 + index * 2), startedAt: time(11 + index * 2), finishedAt: time(12 + index * 2) });
    return store.update("release_run",batch.id,project,{createdAt:time(10)});});
  const events = batches.map(batch => store.create("monitor_event", project, { releaseId: release.id, releaseRunId: batch.id,
    packageDigest: bundle.digest, type: "BATCH_SUCCEEDED", status: "SUCCEEDED", schedulerTriggered: true, observedAt: batch.finishedAt }));
  return { agent, revision, codeRun, delivery, bundle, verification, review, approval, release, batches, events,
    selection: { taskId: agent.id, packageDigest: bundle.digest, releaseId: release.id } };
}
