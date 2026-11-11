import {publishedReportSource, reportRequestId} from "./published-report-request.mjs";
import {checkedPrivateBatchReport} from "./private-batch-report-client.mjs";
import {reportEvidenceDigest} from "./report-provenance-client.mjs";

export const batchArchiveRoute = "/reports/published/batch-archives";
export const archiveSha = /^[a-f0-9]{64}$/;
export const archiveError = (status, code, message) => Object.assign(Error(message), {status, code});
const invalid = () => archiveError(422, "INVALID_BATCH_REPORT_REVIEW", "请核对原批次、报表名称、需求和汇总摘要");
const unconfirmed = () => archiveError(409, "BATCH_REPORT_ARCHIVE_UNCONFIRMED", "报表归档、审阅摘要或原请求不一致");

export function batchArchiveSource(input) {
  const source = publishedReportSource(input);
  if (source.kind !== "AGENT") throw invalid();
  return source;
}
export const batchArchiveListPath = source => batchArchiveRoute + "?" + new URLSearchParams(batchArchiveSource(source));
export const batchArchiveRequestPath = id => batchArchiveRoute + "/" + reportRequestId(id);

export function batchArchiveDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["source", "summaryDigest", "title", "requirement"].includes(key)) ||
      typeof input.summaryDigest !== "string" || !archiveSha.test(input.summaryDigest) ||
      typeof input.title !== "string" || input.title.trim().length < 2 || input.title.length > 80 ||
      typeof input.requirement !== "string" || input.requirement.trim().length < 4 || input.requirement.length > 1000)
    throw invalid();
  return {source: batchArchiveSource(input.source), summaryDigest:input.summaryDigest, title:input.title.trim(), requirement:input.requirement.trim()};
}

export async function prepareBatchArchive(input) {
  const draft = batchArchiveDraft(input);
  return {draft, reviewedDigest:await reportEvidenceDigest(draft)};
}

export async function checkedBatchArchive(receipt, expected = {}) {
  const {digest, ...evidence} = receipt ?? {}, review = evidence.review;
  if (evidence.protocol !== "shuduo-private-batch-report-archive/v1" ||
      !Number.isSafeInteger(evidence.reportVersion) || evidence.reportVersion < 1 ||
      !review || !Number.isFinite(Date.parse(review.reviewedAt)) ||
      (expected.requestId && review.requestId !== expected.requestId) ||
      (expected.reviewedDigest && review.reviewedDigest !== expected.reviewedDigest) ||
      !archiveSha.test(digest ?? "") || await reportEvidenceDigest(evidence) !== digest) throw unconfirmed();
  reportRequestId(review.requestId);
  reportRequestId(review.reviewerId);
  const {draft, reviewedDigest} = await prepareBatchArchive(review.draft);
  if (reviewedDigest !== review.reviewedDigest ||
      (expected.source && batchArchiveListPath(expected.source) !== batchArchiveListPath(draft.source))) throw unconfirmed();
  await checkedPrivateBatchReport(evidence.summary, {source:draft.source, downloadDigest:draft.summaryDigest});
  return receipt;
}

export async function readBatchArchive(client, {requestId, source, reviewedDigest, downloadDigest}) {
  if (downloadDigest !== undefined && !archiveSha.test(downloadDigest)) throw invalid();
  const path = batchArchiveRequestPath(requestId) + (downloadDigest ? "?download_digest=" + downloadDigest : "");
  const receipt = await checkedBatchArchive(await client.request(path), {requestId, source, reviewedDigest});
  if (downloadDigest && receipt.digest !== downloadDigest) throw unconfirmed();
  return receipt;
}

export async function listBatchArchives(client, source) {
  const result = await client.request(batchArchiveListPath(source));
  if (!result || typeof result.canArchive !== "boolean" || !Array.isArray(result.entries) || result.entries.length > 20)
    throw unconfirmed();
  reportRequestId(result.actorId);
  for (const entry of result.entries) {
    if (!entry || typeof entry.title !== "string" || !Number.isSafeInteger(entry.reportVersion) || entry.reportVersion < 1 ||
        !archiveSha.test(entry.digest ?? "") || !Number.isFinite(Date.parse(entry.reviewedAt))) throw unconfirmed();
    reportRequestId(entry.requestId);
  }
  return result;
}

export async function submitBatchArchive(client, {requestId, draft, reviewedDigest}) {
  const normalized = await prepareBatchArchive(draft);
  if (normalized.reviewedDigest !== reviewedDigest) throw unconfirmed();
  const receipt = await client.request(batchArchiveRoute, {
    method:"POST", idempotencyKey:reportRequestId(requestId), body:normalized,
  });
  return checkedBatchArchive(receipt, {requestId, source:normalized.draft.source, reviewedDigest});
}
