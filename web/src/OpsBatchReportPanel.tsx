import {useEffect, useRef, useState} from "react";
import {readPrivateBatchSummary} from "../../src/v2/private-batch-report-client.mjs";
import type {PrivateBatchSummary} from "../../src/v2/private-batch-report-client.mjs";
import type {PublishedReportBinding} from "../../src/v2/published-report-request.mjs";
import {OpsBatchArchivePanel} from "./OpsBatchArchivePanel";
import {privateBatchReportPath} from "../../src/v2/private-batch-report-request.mjs";

type Api = <T>(path: string, body?: unknown, options?: {idempotencyKey?: string}) => Promise<T>;
export function OpsBatchReportPanel({api, source, sequence, serviceHref}: {api: Api; source: PublishedReportBinding; sequence: number;serviceHref?:string}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{revision: number; report?: PrivateBatchSummary; message?: string}>();
  const generation = useRef(0);
  const request = useRef(api);
  request.current = api;
  useEffect(() => {
    const current = ++generation.current;
    readPrivateBatchSummary({request:request.current}, {source}).then(
      report => { if (current === generation.current) setResult({revision, report}); },
      (error: Error) => { if (current === generation.current) setResult({revision, message:error.message}); },
    );
    return () => { generation.current++; };
  }, [revision, source]);
  const current = result?.revision === revision ? result : undefined;
  const report = current?.report;
  return <section id="ops-batch-report" className="ops-live-evaluation-v2" aria-labelledby="ops-batch-report-title">
    <header><div><h3 id="ops-batch-report-title">第 {sequence} 批客户资产汇总</h3><p>私有发布 · 汇总只读</p></div>
      <button className="button" disabled={!current} onClick={() => setRevision(value => value + 1)}>重新读取汇总</button>
    </header>
    {!current && <p role="status">正在核对固定发布、快照和汇总…</p>}
    {current?.message && <p role="alert">{current.message}</p>}
    {report && <>
      <p><strong>{report.context.name}</strong> · 业务日期 {report.provenance.businessDate}</p>
      <p>{report.context.definition}</p>
      <div className="report-widgets-v2">
        {report.metrics.map(metric => <article key={metric.id} className="report-kpi-v2"><span>{metric.title}</span><strong>{metric.value}</strong></article>)}
      </div>
      <details><summary>查看发布与快照溯源</summary>
        <p>批次 {source.batchId} · 代码版本 {source.revisionId}</p>
        <p>服务快照 {report.provenance.snapshotId} · {report.provenance.rowCount} 位客户</p>
        <p>快照摘要 {report.provenance.snapshotDigest}</p>
        <p>发布审阅摘要 {report.provenance.publicationReviewDigest}</p>
        <p>监控事件 {report.provenance.monitorEventId}</p>
        <p>此汇总来自已核验的发布快照。报表需求与审阅记录未包含在此附件。</p>
      </details>
      <div className="agent-delivery-actions">
        <a className="button" href={"/api/v2"+privateBatchReportPath(source,report.digest)}>下载批次溯源 JSON</a>
        {serviceHref&&<a className="button" href={serviceHref}>查看本批次授权调用</a>}
      </div>
    </>}
    <OpsBatchArchivePanel api={api} source={source} summary={report}/>
  </section>;
}
