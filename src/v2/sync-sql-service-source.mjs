import { isDeepStrictEqual as same } from "node:util";
import { validateDeliveryPackage } from "./delivery.mjs";
import { assertSyncSqlRehearsal } from "./delivery-runner.mjs";
import { assertSyncSqlBatch } from "./sync-sql-publication.mjs";
import { assertSyncSqlOutputSchema, readSyncSqlInput, syncSqlDeliverySource, syncSqlRowsMatch } from "./sync-sql-input.mjs";
import { assertSqlRequirementPackageSource } from "./sql-requirements.mjs";

export const syncServiceProtocol = "shuduo-sync-sql-consumption-source/v1";
const invalid = () => Object.assign(Error("冻结持仓的原发布、双批运行或监控证据未通过核对"),
  { status: 409, code: "SYNC_SERVICE_SOURCE_UNCONFIRMED" });
const time = value => typeof value === "string" ? Date.parse(value) : NaN;

export function syncSqlPageShape(expectedRows, parameters) {
  const {page, pageSize, clientId} = parameters ?? {};
  if (clientId !== undefined || !Number.isSafeInteger(expectedRows) || expectedRows < 1 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(page) || page < 1) return;
  const totalPages = Math.ceil(expectedRows / pageSize);
  if (page > totalPages) return;
  return {page, pageSize, totalPages, rowCount:Math.min(pageSize, expectedRows - (page - 1) * pageSize)};
}

export async function readSyncSqlPaginationCoverage({entry, expectedRows, calls, application, recheckCall}) {
  if (entry.status !== "VERIFIED" || entry.sourceRunIds.length !== 1) return;
  const groups = new Map();
  for (const call of calls) {
    if (call.serviceId !== entry.serviceId || call.serviceVersionId !== entry.versionId ||
        call.statusCode !== 200 || call.outcome !== "SUCCEEDED" || call.customerAccessHash !== undefined) continue;
    const shape = syncSqlPageShape(expectedRows, call.parameters);
    if (!shape || call.rowCount !== shape.rowCount) continue;
    const app = application(call.applicationId);
    if (app?.scope !== "LOCAL_TEST_ONLY" || !["ACTIVE","EXPIRED","REVOKED"].includes(app.status) || Object.hasOwn(app,"customerAccess") ||
        app.versionGrants?.[entry.serviceId] !== entry.versionId) continue;
    const key = `${call.applicationId}:${shape.pageSize}`;
    const group = groups.get(key) ?? {applicationId:call.applicationId, pageSize:shape.pageSize,
      totalPages:shape.totalPages, candidates:new Map()};
    const samePage = group.candidates.get(shape.page) ?? [];
    samePage.push(call);
    group.candidates.set(shape.page,samePage);
    groups.set(key,group);
  }
  let best;
  for (const {applicationId,pageSize,totalPages,candidates} of groups.values()) {
    const pages = [];
    for (const [page, receipts] of candidates) {
      for (const saved of receipts) {
        try {
          const proof = saved.id === entry.call?.callId ? entry.call : await recheckCall(entry.serviceId,saved.id,{pinnedVersionId:entry.versionId});
          if (!proof.verified || proof.independentResultVerified !== true || proof.coverage !== undefined ||
              proof.callId !== saved.id || proof.versionId !== entry.versionId || proof.configHash !== entry.configHash ||
              proof.rowCount !== saved.rowCount) continue;
          pages.push(page);
          break;
        } catch (error) {
          if (![400,403,404,409,422,504].includes(error.status)) throw error;
        }
      }
    }
    const summary = { status:pages.length===totalPages?"COMPLETE":"INCOMPLETE", applicationId,pageSize,totalPages,
      verifiedPages:pages.sort((left,right)=>left-right) };
    if (summary.status === "COMPLETE") return summary;
    if (!best || pages.length * best.totalPages > best.verifiedPages.length * totalPages) best = summary;
  }
  return best;
}

export function certifiedSyncSqlSource({ store, project, run, enabled, timeUnitMs = 1000 }) {
  const get = (kind, id) => typeof id === "string" ? store.get(kind, id, project) : undefined;
  const release = get("release", run?.releaseId);
  const bundle = get("delivery_package", release?.packageId);
  if (!run?.snapshotHash && !run?.source?.syncInput && !release?.syncInput && !bundle?.manifest?.source?.syncInput) return;
  if (!enabled || !bundle || release?.health !== "HEALTHY" || release.successfulRunCount !== 2 ||
      release.openAlertCount !== 0 || release.failedRunCount !== 0 || release.fullLifecycleE2E !== false) throw invalid();
  const plan = validateDeliveryPackage(bundle, release.packageDigest);
  const input = plan.source.syncInput;
  if (!input || plan.source.projectId !== project || !same(run, get("release_run", run.id))) throw invalid();
  const approval = get("release_approval", release.approvalId);
  const verification = get("delivery_verification", approval?.rehearsalId);
  const review = get("delivery_review", approval?.reviewId);
  const development = get("run", plan.source.runId);
  const revision = get("revision", plan.source.revisionId);
  const agent = get("agent", input.agentTaskId);
  if (!approval || !verification || !review || !development || !revision || !agent ||
      development.status !== "SUCCEEDED" || development.validation?.selectedPassed !== true ||
      development.revisionId !== revision.id || development.revisionHash !== plan.source.sqlHash ||
      revision.hash !== plan.source.sqlHash || revision.sql !== bundle.files["main.sql"] ||
      !same(input, syncSqlDeliverySource({ agent, run: development, revision }))) throw invalid();
  const context = readSyncSqlInput({ store, project, actorId: revision.author, binding: revision.syncInput });
  if (!same(context, plan.fixtures.context) || !syncSqlRowsMatch(development.rows, context)) throw invalid();
  assertSyncSqlOutputSchema(development.columns);
  assertSqlRequirementPackageSource(bundle, { agent: input.developmentMode === "MANUAL" ? undefined : agent, run: development, revision });
  const batches = store.list("release_run", project).filter(batch => batch.releaseId === release.id)
    .sort((a, b) => a.sequence - b.sequence);
  const events = store.list("monitor_event", project).filter(event => event.releaseId === release.id);
  if (store.list("monitor_alert", project).some(alert => alert.releaseId === release.id && alert.status === "OPEN")) throw invalid();
  for (const batch of batches) {
    assertSyncSqlBatch({ bundle, plan, approval, verification, review, release, run: batch, batches, enabled, timeUnitMs, expectedStatus: "SUCCEEDED" });
    if (batch.mode !== "LOCAL_SCHEDULED_RELEASE" || batch.published !== true || batch.fullLifecycleE2E !== false ||
        !(time(batch.startedAt) >= time(batch.triggeredAt) && time(batch.finishedAt) >= time(batch.startedAt))) throw invalid();
    assertSyncSqlRehearsal(plan, bundle, { ...batch, published: false, schedulerTriggered: false, mode: "LOCAL_FILE_REHEARSAL" }, release.businessScheduledFor);
    const succeeded = events.filter(event => event.type === "BATCH_SUCCEEDED" && event.releaseRunId === batch.id);
    if (succeeded.length !== 1 || succeeded[0].packageDigest !== bundle.digest || succeeded[0].schedulerTriggered !== true ||
        succeeded[0].status !== "SUCCEEDED" || !(time(succeeded[0].observedAt) >= time(batch.finishedAt))) throw invalid();
  }
  if (batches.length !== 2 || !batches.some(batch => batch.id === run.id)) throw invalid();
  return { expected: context.expected, sourceEvidence: {
    protocol: syncServiceProtocol, scope: "LOCAL_TEST_ONLY", sourceTaskId: agent.id, sourceRevisionId: revision.id,
    sourceRunId: development.id, releaseId: release.id, packageDigest: bundle.digest, approvalId: approval.id,
    sourceReleaseRunId: run.id, batchIds: batches.map(batch => batch.id), businessDate: context.businessDate,
    snapshotHash: input.snapshotHash, syncRunId: input.runId, metadataVersionId: input.metadataVersionId,
    developmentMode: input.developmentMode, agentIndependentE2E: false,
  } };
}

export function syncSqlServiceSources({ store, project, selection, canRead, certify }) {
  const rows = [];
  for (const run of store.list("release_run", project)) {
    if (!canRead(run) || selection.releaseId && selection.releaseId !== run.releaseId ||
        selection.packageDigest && selection.packageDigest !== run.packageDigest) continue;
    try {
      const evidence = certify(run)?.sourceEvidence;
      if (!evidence || selection.taskId && (evidence.developmentMode === "MANUAL" || evidence.sourceTaskId !== selection.taskId)) continue;
      rows.push({
        id: run.id, releaseId: run.releaseId, packageDigest: run.packageDigest, sourceRevisionId: evidence.sourceRevisionId,
        sourceAgentTaskId: evidence.sourceTaskId, sourceRunId: evidence.sourceRunId, scope: evidence.scope,
        sourceKind: evidence.developmentMode === "MANUAL" ? "MANUAL" : "AGENT", agentIndependentE2E: false,
        publicDeployed: false, published: true, schedulerTriggered: true, clockMode: run.clockMode, sequence: run.sequence,
        status: run.status, engine: run.engine, engineVersion: run.engineVersion, mainSqlExecuted: true,
        validation: { passed: true }, testSqlValidation: { passed: true }, rowCount: run.rows.length,
        createdAt: run.createdAt, sourceEvidence: evidence,
      });
    } catch (error) { if (![409, 422].includes(error.status)) throw error; }
  }
  return rows.sort((a, b) => a.releaseId.localeCompare(b.releaseId) || a.sequence - b.sequence);
}

export async function readSyncSqlCallEvidence({ store, project, manager, evidence }) {
  const matching = manager.listCalls().filter(call => {
    if (call.outcome !== "SUCCEEDED" || call.statusCode !== 200 || call.rowCount < 1) return false;
    const version = store.get("data_service_version", call.serviceVersionId, project);
    return same(version?.sourceEvidence, evidence);
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (matching.length > 20) throw invalid();
  const proofs = [];
  for (const call of matching) {
    const proof = await manager.recheckCall(call.serviceId, call.id, { pinnedVersionId: call.serviceVersionId });
    const application = manager.application(call.applicationId);
    if (!proof.verified || !proof.independentResultVerified || !same(call, store.get("service_call", call.id, project))) throw invalid();
    proofs.push({ ...proof, serviceId: call.serviceId, serviceType: call.serviceType, applicationStatus: application.status,
      finishedAt: call.finishedAt, paginationHash: call.paginationHash });
  }
  return proofs;
}
