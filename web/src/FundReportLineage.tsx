import { useEffect, useState } from "react";
import { readPublishedReportLineage } from "../../src/v2/published-report-client.mjs";
import type { PublishedReportLineage, PublishedReportReceipt } from "../../src/v2/published-report-client.mjs";

const releaseLabels = {
  ACTIVE_LOCAL: "当前本机发布",
  SUPERSEDED_LOCAL: "历史发布 · 已替换",
  CANCELLED: "历史发布 · 已停止",
};
const time = (value: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium",
}).format(new Date(value));

export function FundReportLineage({ api, receipt }: { api: <T>(path: string) => Promise<T>; receipt: PublishedReportReceipt }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PublishedReportLineage>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    void readPublishedReportLineage({ request: path => api(path) }, { requestId: receipt.requestId, receipt }).then(
      data => { if (active) setResult(data); },
      cause => { if (active) setError((cause as Error).message); },
    );
    return () => { active = false; };
  }, [api, receipt, open]);

  return <div className="report-lineage-v2">
    <button className="button" aria-expanded={open} aria-controls="report-lineage-details" onClick={() => {
      setResult(undefined);
      setError("");
      setOpen(!open);
    }}>{open ? "收起来源证据" : "核对源快照与运维"}</button>
    {open && <div id="report-lineage-details">
      {!result && !error && <p role="status">正在核对原发布批次…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <div className="report-lineage-grid-v2">
        <section aria-label="源资产快照">
          <h4>源资产快照</h4>
          <dl>
            <dt>快照</dt><dd><code title={result.snapshot.id}>{result.snapshot.id.slice(0, 12)}</code></dd>
            <dt>结果行数</dt><dd>{result.snapshot.rowCount} 行</dd>
            <dt>快照摘要</dt><dd><code title={result.snapshot.contentHash}>{result.snapshot.contentHash.slice(0, 12)}</code></dd>
            <dt>字段</dt><dd>{result.snapshot.fields.map(field => field.label).join("、")}</dd>
          </dl>
        </section>
        <section aria-label="原批次运维记录">
          <h4>原批次运维记录</h4>
          <p role="status">{releaseLabels[result.release.status]}</p>
          <dl>
            <dt>发布</dt><dd><code title={result.release.id}>{result.release.id.slice(0, 12)}</code></dd>
            <dt>批次</dt><dd>第 {result.batch.sequence} 批 · <code title={result.batch.id}>{result.batch.id.slice(0, 12)}</code></dd>
            <dt>监控事件</dt><dd>批次成功 · <code title={result.batch.monitorEvent.id}>{result.batch.monitorEvent.id.slice(0, 12)}</code></dd>
            <dt>记录时间</dt><dd>{time(result.batch.monitorEvent.observedAt)} 北京时间</dd>
          </dl>
        </section>
      </div>}
    </div>}
  </div>;
}
