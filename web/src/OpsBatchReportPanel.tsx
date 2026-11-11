import {useEffect, useRef, useState} from "react";
import {readPrivateBatchSummary} from "../../src/v2/private-batch-report-client.mjs";
import type {PrivateBatchSummary} from "../../src/v2/private-batch-report-client.mjs";
import type {PublishedReportBinding} from "../../src/v2/published-report-request.mjs";

type Api = <T>(path: string) => Promise<T>;
export function OpsBatchReportPanel({api, source, sequence}: {api: Api; source: PublishedReportBinding; sequence: number}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{revision: number; report?: PrivateBatchSummary; message?: string}>();
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState("");
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
  const download = async () => {
    if (!report || downloading) return;
    const version = generation.current;
    setNotice("");
    setDownloading(true);
    try {
      const file = await readPrivateBatchSummary({request:api}, {source, downloadDigest:report.digest});
      if (version !== generation.current) return;
      const href = URL.createObjectURL(new Blob([JSON.stringify(file)], {type:"application/json"}));
      const link = document.createElement("a");
      link.href = href;
      link.download = "shuduo-batch-report-" + source.batchId.slice(0, 8) + ".json";
      try { document.body.appendChild(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000); }
      setNotice("汇总摘要已复核，已请求浏览器下载。");
    } catch (error) {
      if (version === generation.current) setNotice("下载未确认。" + (error as Error).message);
    } finally {
      if (version === generation.current) setDownloading(false);
    }
  };
  return <section id="ops-batch-report" className="ops-live-evaluation-v2" aria-labelledby="ops-batch-report-title">
    <header><div><h3 id="ops-batch-report-title">第 {sequence} 批客户资产汇总</h3><p>私有发布 · 只读</p></div>
      <button className="button" disabled={!current || downloading} onClick={() => {setNotice(""); setRevision(value => value + 1);}}>重新读取汇总</button>
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
      <button className="button" disabled={downloading} onClick={() => void download()}>下载批次溯源 JSON</button>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
