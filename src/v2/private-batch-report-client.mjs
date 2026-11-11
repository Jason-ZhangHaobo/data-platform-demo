import {privateBatchReportPath} from "./private-batch-report-request.mjs";
import {reportEvidenceDigest} from "./report-provenance-client.mjs";

const fields = [
  ["total_assets", "total_assets"], ["holding_value", "holding_market_value"], ["available_cash", "available_cash"],
];
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

export async function checkedPrivateBatchReport(value, {source, downloadDigest} = {}) {
  const evidence = value?.provenance;
  const invalid = () => Error("返回的批次、快照或汇总摘要与所选来源不一致");
  if (!keys(value, ["protocol", "scope", "source", "context", "provenance", "metrics", "reportReview", "digest"]) ||
      value.protocol !== "shuduo-private-batch-summary/v1" || value.scope !== "PRIVATE_CLOUD_TEST" ||
      value.reportReview !== "NOT_INCLUDED" || !value.source ||
      !keys(evidence, ["publicationReviewDigest", "codeDigest", "monitorEventId", "observedAt", "businessDate", "snapshotId", "snapshotDigest", "rowCount"]) ||
      evidence.snapshotId !== "release-run:" + value.source.batchId ||
      ![value.digest, evidence.codeDigest, evidence.publicationReviewDigest, evidence.snapshotDigest].every(item => text(item, 64) && digest.test(item)) ||
      !text(evidence.monitorEventId, 36) || !uuid.test(evidence.monitorEventId) ||
      !text(evidence.observedAt, 35) || !Number.isFinite(Date.parse(evidence.observedAt)) ||
      !text(evidence.businessDate, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.businessDate) ||
      !Number.isSafeInteger(evidence.rowCount) || evidence.rowCount < 1 || evidence.rowCount > 1000 ||
      !keys(value.context, ["id", "name", "definition"]) || !text(value.context.id, 100) ||
      !text(value.context.name, 200) || !text(value.context.definition, 2000) ||
      !Array.isArray(value.metrics) || value.metrics.length !== fields.length ||
      !value.metrics.every((metric, index) => keys(metric, ["id", "title", "value", "field", "type", "aggregation", "evaluatedCount"]) &&
        metric.id === fields[index][0] && metric.field === fields[index][1] && metric.type === "KPI" && metric.aggregation === "SUM" &&
        metric.evaluatedCount === evidence.rowCount && text(metric.title, 200) && text(metric.value, 80) && /^-?\d+\.\d{2}$/.test(metric.value))) throw invalid();
  const actualPath = privateBatchReportPath(value.source);
  if (source && actualPath !== privateBatchReportPath(source)) throw invalid();
  const {digest: claimed, ...body} = value;
  if (await reportEvidenceDigest(body) !== claimed || (downloadDigest !== undefined && claimed !== downloadDigest)) throw invalid();
  return value;
}

export async function readPrivateBatchSummary(client, {source, downloadDigest}) {
  return checkedPrivateBatchReport(await client.request(privateBatchReportPath(source, downloadDigest)), {source, downloadDigest});
}
