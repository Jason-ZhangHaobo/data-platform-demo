import {serviceHash} from "./data-services.mjs";
import {reportRequestId} from "./published-report-request.mjs";
import {archiveError, archiveSha, batchArchiveDraft, batchArchiveListPath} from "./private-batch-archive-client.mjs";
import {readPrivateBatchReport, requirePrivateBatchReportOwner} from "./private-batch-report.mjs";

export function createPrivateBatchArchive({store, businessStore, project, now = Date.now}) {
  const kind = "private_batch_report_archive";
  const key = (actorId, requestId) => `${project}:private-batch-archive:${actorId}:${requestId}`;
  const missing = () => archiveError(404, "BATCH_REPORT_ARCHIVE_NOT_FOUND", "当前账号下未找到此报表归档请求");
  const changed = () => archiveError(409, "BATCH_REPORT_ARCHIVE_CHANGED", "已存报表归档与原审阅不一致");
  const read = (actorId, requestId) => {
    const ledger = store.db.prepare("SELECT result_id,signature FROM idempotency WHERE key=?").get(key(actorId, reportRequestId(requestId)));
    const record = ledger && store.get(kind, ledger.result_id, project);
    if (!record || record.actorId !== actorId) throw missing();
    const {digest, ...evidence} = record.receipt;
    const {review, summary} = evidence;
    const {digest:summaryDigest, ...summaryEvidence} = summary;
    if (review.requestId !== requestId || review.reviewerId !== actorId ||
        serviceHash(review.draft) !== ledger.signature || review.reviewedDigest !== ledger.signature || summaryDigest !== review.draft.summaryDigest ||
        batchArchiveListPath(summary.source) !== batchArchiveListPath(review.draft.source) ||
        serviceHash(summaryEvidence) !== summaryDigest || serviceHash(evidence) !== digest) throw changed();
    return record.receipt;
  };
  const matching = (actorId, source) => store.list(kind, project)
    .filter(record => record.actorId === actorId && batchArchiveListPath(record.receipt.review.draft.source) === batchArchiveListPath(source));
  return {
    list(actorId, source) {
      requirePrivateBatchReportOwner({store, project, actorId, source});
      return matching(actorId, source).sort((a, b) => b.receipt.reportVersion - a.receipt.reportVersion).slice(0, 20).map(record => {
        const {review, reportVersion, digest} = read(actorId, record.receipt.review.requestId);
        return {requestId:review.requestId, title:review.draft.title, reportVersion, reviewedAt:review.reviewedAt, digest};
      });
    },
    read,
    submit(actorId, requestId, input) {
      requestId = reportRequestId(requestId);
      if (!actorId || !input || Object.keys(input).length !== 2 ||
          typeof input.reviewedDigest !== "string" || !archiveSha.test(input.reviewedDigest))
        throw archiveError(422, "INVALID_BATCH_REPORT_REVIEW", "归档需要确切的报表方案审阅摘要");
      const draft = batchArchiveDraft(input.draft);
      const reviewedDigest = serviceHash(draft);
      if (reviewedDigest !== input.reviewedDigest)
        throw archiveError(409, "BATCH_REPORT_REVIEW_CHANGED", "报表方案已变化，请重新审阅");
      const saved = store.deduplicate(key(actorId, requestId), reviewedDigest, () => {
        const summary = readPrivateBatchReport({store, businessStore, project, actorId, source:draft.source});
        if (summary.digest !== draft.summaryDigest)
          throw archiveError(409, "BATCH_REPORT_SUMMARY_CHANGED", "原快照汇总已变化，请重新读取并审阅");
        const reportVersion = 1 + matching(actorId, draft.source).reduce((latest, record) => Math.max(latest, record.receipt.reportVersion), 0);
        const review = {requestId, reviewerId:actorId, reviewedAt:new Date(now()).toISOString(), reviewedDigest, draft};
        const evidence = {protocol:"shuduo-private-batch-report-archive/v1", reportVersion, review, summary};
        return store.create(kind, project, {actorId, receipt:{...evidence, digest:serviceHash(evidence)}});
      });
      return {replayed:saved.replayed, receipt:read(actorId, requestId)};
    },
  };
}
