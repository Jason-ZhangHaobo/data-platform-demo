import { isDeepStrictEqual as same } from "node:util";
import { resolveDeliverySchedule, sha256, validateDeliveryPackage } from "./delivery.mjs";
import { verifiedFundRun } from "./fund-delivery.mjs";
import { fundContextId, fundOutputContract } from "./fund-lookthrough.mjs";
import { assertFundBatch } from "./fund-publication.mjs";

const reject = () => Object.assign(new Error("基金组合消费需要同一发布的两个成功批次及完整监控证据"), {
  status: 409, code: "FUND_CONSUMPTION_SOURCE_UNPROVEN",
});
const requireProof = condition => { if (!condition) throw reject(); };
const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const reviewChecks = ["code", "assertions", "deliveryFiles", "localScope"];

export function fundConsumptionSelection(batchId, query) {
  const releaseId = query.get("release_id"), packageDigest = query.get("package_digest");
  if (query.size !== 2 || !idPattern.test(batchId) || !idPattern.test(releaseId ?? "") || !/^[a-f0-9]{64}$/.test(packageDigest ?? ""))
    throw Object.assign(new Error("需要确切发布、包摘要和批次编号"), { status: 422, code: "FUND_CONSUMPTION_SELECTION_INVALID" });
  return { batchId, releaseId, packageDigest };
}

function verifyFundPublication({ store, project, selection, timeUnitMs }, includeHistorical) {
  const read = (kind, id) => {
    const record = typeof id === "string" && store.get(kind, id, project);
    requireProof(record?.id === id && record.projectId === project);
    return record;
  };
  const release = read("release", selection.releaseId);
  const bundle = read("delivery_package", release.packageId);
  const source = bundle.manifest?.source;
  const active = release.status === "ACTIVE_LOCAL" && release.health === "HEALTHY";
  const superseded = release.status === "SUPERSEDED_LOCAL" && release.health === "HEALTHY";
  const stopped = release.status === "CANCELLED" && release.health === "STOPPED";
  requireProof(source?.contextId === fundContextId && source.projectId === project &&
    bundle.digest === selection.packageDigest && release.packageDigest === bundle.digest &&
    (active || includeHistorical && (superseded || stopped)) && release.mode === undefined &&
    release.successfulRunCount === 2 && release.failedRunCount === 0 && release.openAlertCount === 0 &&
    !store.list("monitor_alert", project).some(alert => alert.releaseId === release.id && alert.status === "OPEN"));

  const plan = validateDeliveryPackage(bundle, bundle.digest);
  const approval = read("release_approval", release.approvalId);
  const review = read("delivery_review", approval.reviewId);
  const verification = read("delivery_verification", approval.rehearsalId);
  const revision = read("revision", source.revisionId), development = read("run", source.runId);
  const selected = read("release_run", selection.batchId);
  const batches = store.list("release_run", project).filter(batch => batch.releaseId === release.id)
    .sort((left, right) => left.sequence - right.sequence);
  assertFundBatch({ bundle, verification, review, approval, release, run: selected, batches,
    localClassicSpark: true, schedulerMode: "LOCAL_TIMER", timeUnitMs });
  requireProof(reviewChecks.every(key => review.attestations?.[key] === true) &&
    revision.contextId === source.contextId && revision.source === "MANUAL" &&
    revision.hash === source.sqlHash && revision.sql === bundle.files["main.sql"] && sha256(revision.sql) === source.sqlHash &&
    release.sourceCodeHash === source.sqlHash && bundle.sourceRunId === development.id && development.revisionId === revision.id &&
    development.revisionHash === source.sqlHash && development.engineVersion === plan.deployment.runtime.version && verifiedFundRun(development));

  const fileHashes = Object.fromEntries(Object.entries(bundle.manifest.files).map(([name, entry]) => [name, entry.sha256]));
  const occurrence = resolveDeliverySchedule(plan, release.businessScheduledFor);
  const events = store.list("monitor_event", project).filter(event => event.releaseId === release.id && event.type === "BATCH_SUCCEEDED");
  const mode = batches[0].executionEvidenceMode;
  requireProof(same(verification.fileHashes, fileHashes) && events.length === 2 &&
    ["LOCAL_SPARK_PROCESS", "TEST_HARNESS"].includes(mode) &&
    timestamp(batches[0].finishedAt) <= timestamp(batches[1].triggeredAt));
  for (const batch of batches) {
    const matching = events.filter(event => event.releaseRunId === batch.id);
    const event = matching[0];
    requireProof(batch.projectId === project && verifiedFundRun(batch) && batch.engineVersion === plan.deployment.runtime.version &&
      batch.executionEvidenceMode === mode && batch.published === true && batch.publicDeployed === false &&
      batch.schedulerTriggered === true && batch.mode === "LOCAL_SCHEDULED_RELEASE" && batch.clockMode === "WALL_CLOCK_TIMER" &&
      same(batch.source, source) && same(batch.occurrence, occurrence) && same(batch.fileHashes, fileHashes) &&
      batch.testSqlValidation?.passed === true && batch.testSqlValidation.sqlHash === fileHashes["tests.sql"] &&
      timestamp(batch.scheduledTriggerAt) <= timestamp(batch.triggeredAt) && timestamp(batch.triggeredAt) <= timestamp(batch.startedAt) &&
      timestamp(batch.startedAt) <= timestamp(batch.finishedAt) && matching.length === 1 && event.projectId === project &&
      event.packageDigest === bundle.digest && event.status === "SUCCEEDED" && event.schedulerTriggered === true &&
      timestamp(batch.finishedAt) <= timestamp(event.observedAt));
  }

  const lastFinished = timestamp(batches.at(-1).finishedAt);
  if (superseded) requireProof(idPattern.test(release.supersededByReleaseId ?? "") && release.supersededByReleaseId !== release.id &&
    timestamp(release.supersededAt) >= lastFinished);
  if (stopped) {
    const closingEvents = store.list("monitor_event", project).filter(event =>
      event.releaseId === release.id && event.type === "RELEASE_CANCELLED");
    requireProof(closingEvents.length === 1 && closingEvents[0].projectId === project && closingEvents[0].packageDigest === bundle.digest &&
      timestamp(release.cancelledAt) >= lastFinished && timestamp(closingEvents[0].observedAt) >= timestamp(release.cancelledAt));
  }

  const contract = fundOutputContract();
  const rows = selected.rows.map(row => Object.fromEntries(contract.fields.map(field => [field.name, row[field.name]])))
    .sort((left, right) => {
      for (const key of contract.keyFields) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
      }
      return 0;
    });
  const eligibleForService = active && mode === "LOCAL_SPARK_PROCESS";
  const evidence = {
    protocol: "shuduo-fund-consumption-source/v1", scope: "LOCAL_TEST_ONLY", upstreamKind: "ENGINEER_AUTHORED",
    releaseId: release.id, packageDigest: bundle.digest, batchId: selected.id, batchSequence: selected.sequence,
    revisionId: revision.id, developmentRunId: development.id, contractId: contract.id, keyFields: contract.keyFields,
    businessDate: occurrence.businessDate, inputDigest: source.fundLookthrough.inputHash, assertionDigest: source.fundLookthrough.assertionHash,
    testSqlDigest: fileHashes["tests.sql"], resultDigest: sha256(JSON.stringify(rows)), rowCount: rows.length,
    batches: batches.map(batch => ({ id: batch.id, sequence: batch.sequence, finishedAt: batch.finishedAt,
      monitorEventId: events.find(event => event.releaseRunId === batch.id).id })),
    engineClassification: mode, eligibleForService, agentIndependentE2E: false, publicDeployed: false,
  };
  return { evidence, rows, release, selected, revision, development, verification, event: events.find(event => event.releaseRunId === selected.id) };
}

export function resolveFundConsumptionSource(args) {
  const { evidence, rows } = verifyFundPublication(args, false);
  return { evidence, rows: evidence.eligibleForService ? rows : undefined };
}

export function resolveFundReportPublication(args) {
  const { evidence, release, selected, event, revision, development, verification } = verifyFundPublication(args, true);
  requireProof(evidence.engineClassification === "LOCAL_SPARK_PROCESS");
  return { evidence, revision, development, verification, status: release.status, batch: {
    id: selected.id, sequence: selected.sequence, status: selected.status, scheduledAt: selected.scheduledTriggerAt,
    startedAt: selected.startedAt, finishedAt: selected.finishedAt,
    monitorEvent: { id: event.id, type: event.type, status: event.status, observedAt: event.observedAt },
  } };
}
