import type {BatchArchive} from "../../src/v2/private-batch-archive-client.mjs";

export function BatchArchiveDetail({archive}: {archive: BatchArchive}) {
  const {review, reportVersion, digest, summary} = archive;
  const {source} = summary;
  return <div className="source-report-proposal-v2" style={{overflowWrap:"anywhere"}}>
    <h5>V{reportVersion} · {review.draft.title}</h5>
    <p>{review.draft.requirement}</p>
    <p>审阅时间 <time dateTime={review.reviewedAt}>{new Date(review.reviewedAt).toLocaleString("zh-CN")}</time></p>
    <p>原发布 {source.releaseId} · 批次 {source.batchId}</p>
    <p>代码版本 {source.revisionId} · 业务日期 {summary.provenance.businessDate}</p>
    {summary.metrics.map(metric => <p key={metric.id}>{metric.title} {metric.value}</p>)}
    <p>审阅摘要 {review.reviewedDigest}</p>
    <a className="button" href={"/api/v2/reports/published/batch-archives/" + review.requestId + "?download_digest=" + digest}>下载归档溯源 JSON</a>
  </div>;
}
