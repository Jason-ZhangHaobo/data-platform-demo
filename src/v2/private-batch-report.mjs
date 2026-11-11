import { validationFamilyForContext } from "./context.mjs";
import { normalizedServiceSourceRows, serviceHash } from "./data-services.mjs";
import { sha256 } from "./delivery.mjs";
import { readPrivateReleaseBatch } from "./private-release-source.mjs";
import { publishedReportTemplate } from "./report-template.mjs";
import { executeWidget } from "./reports.mjs";

const fail = (status, code, message) => Object.assign(Error(message), {status, code});
const unconfirmed = message => fail(409, "PRIVATE_BATCH_REPORT_UNCONFIRMED", message);

export function requirePrivateBatchReportOwner({store, project, actorId, source}) {
  const get = (kind, id) => store.get(kind, id, project);
  const task = get("agent", source.taskId);
  const original = get("release", source.releaseId);
  const selected = get("release_run", source.batchId);
  if (!actorId || task?.submittedBy !== actorId || original?.submittedBy !== actorId ||
      selected?.submittedBy !== actorId || original.sourceAgentTaskId !== task.id || selected.releaseId !== original.id)
    throw fail(404, "PRIVATE_BATCH_REPORT_NOT_FOUND", "当前账号下未找到此任务的原发布批次");
  if (source.kind !== "AGENT" || original.sourceKind !== "AGENT" || selected.sourceKind !== "AGENT" ||
      original.packageDigest !== source.packageDigest || original.sourceRevisionId !== source.revisionId ||
      original.sourceRunId !== source.runId || selected.sourceAgentTaskId !== task.id)
    throw unconfirmed("任务、代码版本、开发运行或交付包与原批次不一致");
  return {task, selected};
}

export function readPrivateBatchReport({store, businessStore, project, actorId, source}) {
  const {task, selected} = requirePrivateBatchReportOwner({store, project, actorId, source});
  const get = (kind, id) => store.get(kind, id, project);
  const {batch, release, bundle, monitoring} = readPrivateReleaseBatch(store, project, selected.id);
  const event = monitoring?.batches.find(item => item.batchId === batch.id);
  const origin = bundle.manifest.source;
  const revision = get("revision", source.revisionId), run = get("run", source.runId);
  if (!event || origin.projectId !== project || origin.runId !== run?.id || origin.revisionId !== revision?.id ||
      revision.author !== actorId || revision.source === "MANUAL" || revision.contextId !== origin.contextId ||
      run.agentTaskId !== task.id || run.revisionId !== revision.id || run.revisionHash !== origin.sqlHash ||
      revision.hash !== origin.sqlHash || sha256(revision.sql) !== origin.sqlHash)
    throw unconfirmed("未核实原发布的代码、监控事件及工程师审阅");

  // The delivery verifier has already checked the fixtures file against the
  // manifest. Use the frozen business definition rather than mutable drafts.
  const context = JSON.parse(bundle.files["fixtures.json"]).context;
  if (origin.outputContract || context.id !== origin.contextId ||
      validationFamilyForContext(context.id)?.id !== origin.validationContractId)
    throw fail(409, "PRIVATE_BATCH_REPORT_CONTRACT_UNSUPPORTED", "此批次不属于已支持的证券客户资产汇总口径");
  const rows = normalizedServiceSourceRows(batch.rows);
  const snapshotDigest = serviceHash(rows);
  if (snapshotDigest !== serviceHash(normalizedServiceSourceRows(context.expected)))
    throw unconfirmed("保存的发布数据未通过原证券测试数据核验");
  const snapshotId = "release-run:" + batch.id;
  const snapshot = businessStore.snapshotEvidence(snapshotId);
  if (!snapshot) throw fail(404, "PRIVATE_BATCH_REPORT_SNAPSHOT_MISSING", "原批次的服务快照尚未保存，无法查看汇总");
  if (!snapshot.integrityVerified || snapshot.contentHash !== snapshotDigest || snapshot.actualRowCount !== rows.length)
    throw unconfirmed("原批次服务快照的内容摘要或行数已变化");

  const metrics = publishedReportTemplate(Object.keys(rows[0]), context.id).widgets
    .filter(widget => widget.type === "KPI").map(widget => executeWidget(widget, rows));
  const result = {
    protocol: "shuduo-private-batch-summary/v1",
    scope: "PRIVATE_CLOUD_TEST",
    source,
    context: {id: context.id, name: context.name, definition: context.definition},
    provenance: {
      publicationReviewDigest: release.reviewDigest, codeDigest: origin.sqlHash,
      monitorEventId: event.eventId, observedAt: event.observedAt,
      businessDate: context.businessDate, snapshotId, snapshotDigest, rowCount: rows.length,
    },
    metrics,
    reportReview: "NOT_INCLUDED",
  };
  return {...result, digest: serviceHash(result)};
}
