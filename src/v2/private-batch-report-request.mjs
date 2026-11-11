import { publishedReportSource } from "./published-report-request.mjs";

export const privateBatchReportRoute = "/reports/published/batch-summary";
const digest = /^[a-f0-9]{64}$/;
const invalid = () => Object.assign(Error("批次报表需要一个确切的 Agent 发布来源和合法下载摘要"), {
  status: 422, code: "INVALID_PRIVATE_BATCH_REPORT_REQUEST",
});

function reportSource(input) {
  const source = publishedReportSource(input);
  if (source.kind !== "AGENT") throw invalid();
  return source;
}

export function privateBatchReportQuery(params) {
  const values = new URLSearchParams(params);
  if (new Set(values.keys()).size !== values.size) throw invalid();
  const downloadDigest = values.get("download_digest");
  if (downloadDigest !== null && !digest.test(downloadDigest)) throw invalid();
  values.delete("download_digest");
  return {source: reportSource(Object.fromEntries(values)), downloadDigest};
}

export function privateBatchReportPath(input, downloadDigest) {
  const params = new URLSearchParams(reportSource(input));
  if (downloadDigest !== undefined) {
    if (!digest.test(downloadDigest)) throw invalid();
    params.set("download_digest", downloadDigest);
  }
  return privateBatchReportRoute + "?" + params;
}
