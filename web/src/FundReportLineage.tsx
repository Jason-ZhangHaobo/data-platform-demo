import { useEffect, useState } from "react";
import { readPublishedReportLineage, readPublishedReportDevelopment } from "../../src/v2/published-report-client.mjs";
import type { PublishedReportDevelopment, PublishedReportLineage, PublishedReportReceipt } from "../../src/v2/published-report-client.mjs";

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
      {result && <><div className="report-lineage-grid-v2">
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
      </div><DevelopmentEvidence api={api} receipt={receipt} lineage={result} /></>}
    </div>}
  </div>;
}

function DevelopmentEvidence({ api, receipt, lineage }: {
  api: <T>(path: string) => Promise<T>; receipt: PublishedReportReceipt; lineage: PublishedReportLineage;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PublishedReportDevelopment>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    void readPublishedReportDevelopment({ request: path => api(path) }, { requestId: receipt.requestId, receipt, lineage }).then(
      data => { if (active) setResult(data); },
      cause => { if (active) setError((cause as Error).message); },
    );
    return () => { active = false; };
  }, [api, receipt, lineage, open]);

  return <div className="report-development-v2">
    <button className="button" aria-expanded={open} aria-controls="report-development-details" onClick={() => {
      setResult(undefined);
      setError("");
      setOpen(!open);
    }}>{open ? "返回来源证据" : "查看原开发版本与核验"}</button>
    {open && <section id="report-development-details" aria-label="原开发版本与核验">
      {!result && !error && <p role="status">正在核对原 SQL 与独立断言…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <>
        <h4>原开发 SQL <small>工程师编写 · 只读</small></h4>
        <p>版本 <code title={result.revision.id}>{result.revision.id.slice(0, 12)}</code>
          {" · 摘要 "}<code title={result.revision.hash}>{result.revision.hash.slice(0, 12)}</code></p>
        <pre aria-label="原开发 SQL" tabIndex={0}><code>{result.revision.sql}</code></pre>
        <h4>独立核验通过</h4>
        <p>{result.run.engine} {result.run.engineVersion} · {result.run.rowCount} 行 · {result.run.durationMs} 毫秒
          {" · 开发运行 "}<code title={result.run.id}>{result.run.id.slice(0, 12)}</code></p>
        <ul>{result.verification.assertions.map(assertion => <li key={assertion}>{assertion}</li>)}</ul>
        <p>断言摘要 <code title={result.verification.assertionDigest}>{result.verification.assertionDigest.slice(0, 12)}</code>
          {" · 文件演练测试 SQL "}<code title={result.verification.testSqlDigest}>{result.verification.testSqlDigest.slice(0, 12)}</code></p>
      </>}
    </section>}
  </div>;
}
