import { isDeepStrictEqual } from "node:util";
import { validateDeliveryPackage, validationMatchesFamily, sha256 } from "./delivery.mjs";
import { developmentVerificationReport } from "./agent-development-workflow.mjs";
import { privateServiceSourceSelection } from "./private-service-routes.mjs";

const native = value => Boolean(value && [undefined, "AGENT"].includes(value.sourceKind) &&
  value.sourceAttribution === undefined && value.attribution === undefined && value.manualProvenance === undefined && value.testDouble !== true);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const same = isDeepStrictEqual;
const requireProof = value => { if (!value) throw Error("LOCAL_SOURCE_NOT_PROVEN"); };

function currentRecoveryBatches(store, project, release, batches) {
  const restoring = release.restoredAt !== undefined || release.restoredFromReleaseId !== undefined;
  if (!restoring) return undefined;
  requireProof(timestamp(release.restoredAt) && typeof release.restoredFromReleaseId === "string" &&
    release.restoredFromReleaseId !== release.id && Date.parse(release.restoredAt) >= Date.parse(release.activatedAt));
  const records = store.list("release_rollback", project).filter(record => record.toReleaseId === release.id)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const events = store.list("monitor_event", project).filter(event => event.type === "ROLLBACK_ACTIVATED" && event.recoveryReleaseId === release.id);
  const latest = records.filter(record => record.fromReleaseId === release.restoredFromReleaseId &&
    Date.parse(record.createdAt) >= Date.parse(release.restoredAt));
  requireProof(latest.length === 1 && records.at(-1)?.id === latest[0].id && events.length === records.length &&
    batches.every(batch => timestamp(batch.createdAt) && ["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED", "INTERRUPTED"].includes(batch.status)));
  const original = batches.filter(batch => batch.triggerReason !== "ROLLBACK_RECOVERY");
  requireProof(original.length === release.scheduleSpec.runCount && new Set(original.map(batch => batch.sequence)).size === original.length &&
    original.every(batch => [undefined, "LOCAL_TEST_SCHEDULE"].includes(batch.triggerReason) && Number.isSafeInteger(batch.sequence) &&
      batch.sequence >= 1 && batch.sequence <= release.scheduleSpec.runCount && Date.parse(batch.createdAt) < Date.parse(records[0].createdAt)));
  let current;
  for (const [index, record] of records.entries()) {
    const from = typeof record.fromReleaseId === "string" ? store.get("release", record.fromReleaseId, project) : undefined;
    const event = events.filter(event => event.rollbackId === record.id);
    requireProof(native(record) && record.projectId === project && record.status === "SCHEDULED_FOR_VERIFICATION" &&
      timestamp(record.createdAt) && Date.parse(record.createdAt) >= Date.parse(release.activatedAt) &&
      from?.projectId === project && from.id !== release.id && from.mode === undefined && from.publicDeployed === false &&
      event.length === 1 && native(event[0]) && event[0].projectId === project && event[0].releaseId === from.id &&
      event[0].status === "RECOVERY_SCHEDULED" && timestamp(event[0].observedAt) && Date.parse(event[0].observedAt) >= Date.parse(record.createdAt));
    const upper = index + 1 < records.length ? Date.parse(records[index + 1].createdAt) : Infinity;
    const group = batches.filter(batch => batch.triggerReason === "ROLLBACK_RECOVERY" &&
      Date.parse(batch.createdAt) >= Date.parse(record.createdAt) && Date.parse(batch.createdAt) < upper);
    requireProof(group.length === 2 && new Set(group.map(batch => batch.sequence)).size === 2 &&
      group.every(batch => [1, 2].includes(batch.sequence) && Date.parse(batch.createdAt) >= Date.parse(event[0].observedAt) &&
        timestamp(batch.scheduledTriggerAt) && Date.parse(batch.scheduledTriggerAt) >= Date.parse(event[0].observedAt)));
    if (record.id === latest[0].id) {
      requireProof(from.status === "ROLLED_BACK_LOCAL" && from.rolledBackToReleaseId === release.id && timestamp(from.rolledBackAt) &&
        Date.parse(from.rolledBackAt) <= Date.parse(release.restoredAt) && group.every(batch => batch.status === "SUCCEEDED"));
      current = group;
    }
  }
  requireProof(current && batches.length === original.length + records.length * 2);
  return current;
}

function sourceSelection(selection) {
  const fields = { taskId: "agent_task_id", packageDigest: "package_digest", releaseId: "release_id" };
  const invalid = () => Object.assign(Error("本机发布来源选择不完整或不合法"), { status: 422, code: "INVALID_LOCAL_SERVICE_SELECTION" });
  if (!selection || typeof selection !== "object" || Array.isArray(selection) || Object.keys(selection).some(key => !Object.hasOwn(fields, key))) throw invalid();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(selection)) {
    if (value === undefined) continue;
    if (typeof value !== "string") throw invalid();
    query.set(fields[key], value);
  }
  const checked = privateServiceSourceSelection(query);
  if (!checked) throw invalid();
  return checked;
}

// Read only persisted, same-project native SQL Agent evidence. This helper does
// not execute package files, touch their directories, run jobs or create calls.
// A missing/ambiguous/corrupt chain is absent, never a fallback to another task.
export function localServiceSources({ store, project, selection = {} }) {
  const selected = sourceSelection(selection), rows = [];
  const get = (kind, id) => {
    const value = typeof id === "string" ? store.get(kind, id, project) : undefined;
    requireProof(value?.projectId === project && native(value));
    return value;
  };
  const deliveries = store.list("agent_delivery_task", project);
  for (const candidate of store.list("release", project)) {
    if (selected.releaseId && candidate.id !== selected.releaseId || selected.packageDigest && candidate.packageDigest !== selected.packageDigest) continue;
    try {
      const release = get("release", candidate.id), bundle = get("delivery_package", release.packageId);
      requireProof(release.status === "ACTIVE_LOCAL" && release.health === "HEALTHY" && release.publicDeployed === false &&
        release.mode === undefined && release.environment === "local-rehearsal" && release.adapter === "local-spark-v1" &&
        release.packageDigest === bundle.digest);
      const plan = validateDeliveryPackage(bundle, bundle.digest), source = plan.source;
      requireProof(native(source) && source.projectId === project && plan.deployment.adapter === "local-spark-v1" &&
        plan.deployment.environment === "local-rehearsal" && release.sourceRevisionId === source.revisionId &&
        (release.sourceCodeHash ?? release.sourceSqlHash) === source.sqlHash &&
        (release.sourceSqlHash === undefined || release.sourceSqlHash === source.sqlHash) && bundle.sourceRunId === source.runId);
      const matching = deliveries.filter(delivery => delivery.packageId === bundle.id && delivery.packageDigest === bundle.digest &&
        delivery.sourceRevisionId === source.revisionId && delivery.sourceRunId === source.runId && delivery.status === "SUCCEEDED");
      requireProof(matching.length === 1);
      const delivery = get("agent_delivery_task", matching[0].id), agent = get("agent", delivery.sourceAgentTaskId);
      if (selected.taskId && agent.id !== selected.taskId) continue;
      const attempt = agent.attempts?.at(-1), revision = get("revision", source.revisionId), development = get("run", source.runId);
      requireProof(agent.status === "SUCCEEDED" && agent.mode === "LIVE_MODEL" && [undefined, "SPARK_SQL"].includes(agent.language) &&
        attempt?.status === "SUCCEEDED" && typeof attempt.model === "string" && attempt.model.length > 0 &&
        !/test.?double|unconfirmed|fixture|stub|synthetic|mock/i.test(attempt.model) &&
        attempt.revisionId === revision.id && attempt.runId === development.id && revision.source === "LIVE_MODEL" &&
        revision.contextId === source.contextId && agent.contextId === source.contextId && revision.hash === source.sqlHash && typeof revision.sql === "string" &&
        sha256(revision.sql) === revision.hash && revision.sql === bundle.files["main.sql"] && development.agentTaskId === agent.id &&
        development.revisionId === revision.id && development.revisionHash === revision.hash &&
        development.engineVersion === plan.deployment.runtime.version &&
        (development.isolation ?? "LOCAL_PROCESS") === JSON.parse(bundle.files["validation.json"]).isolation &&
        Array.isArray(development.rows) && development.rows.length <= 1000 && development.rows.every(row => row && typeof row === "object" && !Array.isArray(row)) &&
        (agent.revisionId === undefined || agent.revisionId === revision.id) && (agent.runId === undefined || agent.runId === development.id) &&
        developmentVerificationReport(agent, development, revision).status === "PASSED");
      requireProof(delivery.mode === "VERIFIED_ARTIFACT_ORCHESTRATION" && delivery.actualExecution === true && delivery.sourceSqlHash === revision.hash);
      // prepare-delivery legitimately reuses an unapproved package made by the
      // package endpoint, or by a cancelled/failed prior delivery. It does not
      // rewrite that package's optional reverse pointer. The current forward
      // chain and verification remain mandatory; conflicting old links do not.
      if (bundle.agentDeliveryTaskId !== undefined && bundle.agentDeliveryTaskId !== delivery.id) {
        const prior = get("agent_delivery_task", bundle.agentDeliveryTaskId);
        requireProof(["FAILED", "CANCELLED"].includes(prior.status) && prior.mode === "VERIFIED_ARTIFACT_ORCHESTRATION" &&
          prior.sourceAgentTaskId === agent.id && prior.sourceRunId === development.id && prior.sourceRevisionId === revision.id &&
          prior.sourceSqlHash === revision.hash && prior.packageId === bundle.id && prior.packageDigest === bundle.digest);
      }
      const family = { id: source.validationContractId, contextIds: plan.fixtures.validationContexts.map(context => context.id) };
      const fileHashes = Object.fromEntries(Object.entries(bundle.manifest.files).map(([name, entry]) => [name, entry.sha256]));
      const executedFiles = record => native(record) && record.status === "SUCCEEDED" && record.engine === "Apache Spark" &&
        record.engineVersion === plan.deployment.runtime.version && record.mainSqlExecuted === true &&
        record.packageDigest === bundle.digest && same(record.source, source) && same(record.fileHashes, fileHashes) &&
        record.testSqlValidation?.passed === true && record.testSqlValidation.sqlHash === sha256(bundle.files["tests.sql"]) &&
        validationMatchesFamily(record.validation, family);
      const verification = get("delivery_verification", delivery.verificationId), approval = get("release_approval", release.approvalId),
        review = get("delivery_review", approval.reviewId);
      requireProof(executedFiles(verification) && verification.scope === "M2A_LOCAL_FILE_REHEARSAL" &&
        [undefined, "LOCAL_FILE_REHEARSAL"].includes(verification.mode) &&
        verification.packageId === bundle.id && verification.agentDeliveryTaskId === delivery.id && verification.published === false &&
        approval.status === "APPROVED" && approval.scope === "LOCAL_TEST_RELEASE" && approval.publicDeploymentApproved === false &&
        approval.packageId === bundle.id && approval.packageDigest === bundle.digest && approval.rehearsalId === verification.id &&
        approval.sourceRevisionId === revision.id && (approval.sourceCodeHash ?? approval.sourceSqlHash) === revision.hash &&
        (approval.sourceSqlHash === undefined || approval.sourceSqlHash === revision.hash) && approval.consumedByReleaseId === release.id &&
        review.status === "REVIEWED" && review.scope === "LOCAL_TEST_RELEASE" && review.publicDeploymentApproved === false &&
        review.packageId === bundle.id && review.packageDigest === bundle.digest && review.verificationId === verification.id &&
        ["code", "assertions", "deliveryFiles", "localScope"].every(key => review.attestations?.[key] === true));
      const batches = store.list("release_run", project).filter(run => run.releaseId === release.id),
        events = store.list("monitor_event", project).filter(event => event.releaseId === release.id);
      requireProof(Number.isSafeInteger(release.scheduleSpec?.runCount) && release.scheduleSpec.runCount >= 2 && release.scheduleSpec.runCount <= 3 &&
        timestamp(release.activatedAt) &&
        !store.list("monitor_alert", project).some(alert => alert.releaseId === release.id && alert.status === "OPEN"));
      const recovery = currentRecoveryBatches(store, project, release, batches);
      if (!recovery) requireProof(batches.length === release.scheduleSpec.runCount);
      const proven = batches.filter(run => {
        if (run.projectId !== project || run.id === development.id || !executedFiles(run) || run.packageId !== bundle.id ||
            run.mode !== "LOCAL_SCHEDULED_RELEASE" || run.clockMode !== "WALL_CLOCK_TIMER" || run.published !== true || run.publicDeployed !== false ||
            run.schedulerTriggered !== true || !Number.isSafeInteger(run.sequence) || run.sequence < 1 || run.sequence > release.scheduleSpec.runCount ||
            (run.revisionId !== undefined && run.revisionId !== revision.id) || (run.revisionHash !== undefined && run.revisionHash !== revision.hash) ||
            ![run.scheduledTriggerAt, run.triggeredAt, run.startedAt, run.finishedAt].every(timestamp) ||
            Date.parse(release.activatedAt) > Date.parse(run.scheduledTriggerAt) || Date.parse(run.scheduledTriggerAt) > Date.parse(run.triggeredAt) ||
            Date.parse(run.triggeredAt) > Date.parse(run.startedAt) || Date.parse(run.startedAt) > Date.parse(run.finishedAt) ||
            !Array.isArray(run.rows) || run.rows.length > 1000 || !run.rows.every(row => row && typeof row === "object" && !Array.isArray(row)) ||
            !developmentVerificationReport(agent, { rows: run.rows }, revision).checks.find(check => check.id === "results")?.passed)
          return false;
        return events.some(event => native(event) && event.projectId === project && event.releaseRunId === run.id &&
          event.packageDigest === bundle.digest && event.type === "BATCH_SUCCEEDED" && event.status === "SUCCEEDED" &&
          event.schedulerTriggered === true && timestamp(event.observedAt) && Date.parse(event.observedAt) >= Date.parse(run.finishedAt));
      });
      requireProof(proven.length >= 2 && proven.length === release.successfulRunCount &&
        (recovery ? recovery.every(batch => proven.some(run => run.id === batch.id)) && proven.length === batches.filter(batch => batch.status === "SUCCEEDED").length
          : new Set(proven.map(run => run.sequence)).size === proven.length));
      for (const run of proven) rows.push({ id: run.id, releaseId: release.id, sourceAgentTaskId: agent.id,
        sourceRevisionId: revision.id, sourceRunId: development.id, packageDigest: bundle.digest,
        sourceKind: "AGENT", scope: "LOCAL_TEST_ONLY", agentIndependentE2E: false, publicDeployed: false,
        status: "SUCCEEDED", published: true, schedulerTriggered: true, clockMode: "WALL_CLOCK_TIMER",
        sequence: run.sequence, engine: run.engine, engineVersion: run.engineVersion, mainSqlExecuted: true,
        testSqlValidation: { passed: true }, validation: { passed: true }, rowCount: run.rows.length, createdAt: run.createdAt });
    } catch (error) {
      // Schema/provenance failures are an unavailable source, not authorization
      // to pick another package. Unexpected IO errors still reach the caller.
      if (error.message !== "LOCAL_SOURCE_NOT_PROVEN" && ![409, 422].includes(error.status)) throw error;
    }
  }
  return rows.sort((a, b) => a.releaseId.localeCompare(b.releaseId) || a.sequence - b.sequence || a.id.localeCompare(b.id));
}
