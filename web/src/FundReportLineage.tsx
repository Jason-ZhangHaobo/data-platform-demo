import { useEffect, useState } from "react";
import { readPublishedReportLineage, readPublishedReportDevelopment, readPublishedReportConsumption } from "../../src/v2/published-report-client.mjs";
import type { PublishedReportConsumption, PublishedReportDevelopment, PublishedReportLineage, PublishedReportReceipt } from "../../src/v2/published-report-client.mjs";
import { SqlColumnLineagePanel } from "./SqlColumnLineagePanel";
import { FundReportQualityPanel } from './FundReportQualityPanel';

const releaseLabels = {
  ACTIVE_LOCAL: "当前本机发布",
  SUPERSEDED_LOCAL: "历史发布 · 已替换",
  CANCELLED: "历史发布 · 已停止",
};
const time = (value: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium",
}).format(new Date(value));

export function FundReportLineage({ api, receipt, canWrite }: {
  api: <T>(path: string, body?: unknown) => Promise<T>; receipt: PublishedReportReceipt; canWrite: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PublishedReportLineage>();
  const [error, setError] = useState("");
  const [qualityOpen, setQualityOpen] = useState(false);
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
      setQualityOpen(false);
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
      </div>
      <details className="report-development-v2">
        <summary>查看原批次字段来源</summary>
        {result.columnLineage ? <SqlColumnLineagePanel items={[result.columnLineage]} /> :
          <p role="status">此报表回执没有字段来源证据。快照和运维记录仍可查看。</p>}
      </details>
      <details className="report-development-v2" onToggle={event => setQualityOpen(event.currentTarget.open)}>
        <summary>查看原批次质量检测</summary>
        {qualityOpen && <FundReportQualityPanel api={api} requestId={receipt.requestId} lineage={result} canWrite={canWrite} />}
      </details>
      <DevelopmentEvidence api={api} receipt={receipt} lineage={result} />
      {result.source.kind === "AGENT" && <ConsumptionEvidence api={api} lineage={result} />}</>}
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
        <h4>原开发 SQL <small>{result.revision.source === "ENGINEER_AUTHORED" ? "工程师编写" :
          lineage.release.modelMode === "SYNTHETIC_MODEL" ? "模型替身生成" : "Agent 生成"} · 只读</small></h4>
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

function ConsumptionEvidence({ api, lineage }: { api: <T>(path: string) => Promise<T>; lineage: PublishedReportLineage }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PublishedReportConsumption>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    void readPublishedReportConsumption({ request: path => api(path) }, { requestId: lineage.requestId, lineage }).then(
      data => { if (active) setResult(data); },
      cause => { if (active) setError((cause as Error).message); },
    );
    return () => { active = false; };
  }, [api, lineage, open]);
  return <div className="report-development-v2">
    <button className="button" aria-expanded={open} onClick={() => {
      setResult(undefined); setError(""); setOpen(!open);
    }}>{open ? "收起同批次调用" : "核对同批次接口调用"}</button>
    {open && <section aria-label="同批次接口调用">
      {!result && !error && <p role="status">正在核对报表批次的原接口调用…</p>}
      {error && <p role="alert">{error}</p>}
      {result?.status === "UNAVAILABLE" && <p role="status">该发布已停止或替换，保留原报表及批次运维记录。</p>}
      {result?.status === "VERIFIED" && <p role="status">同一报表批次的 DAPI 与 XAPI 已通过独立对照。</p>}
      {result?.status === "PENDING" && <p role="status">此报表批次尚缺通过核验的 DAPI 或 XAPI 调用。</p>}
      {result?.consumption?.services.length ? <ul>{result.consumption.services.map(service => (
        <li key={service.serviceId}>{service.serviceType} · {service.name} · 版本 {service.versionId.slice(0, 8)}
          {service.call && <> · 调用 {service.call.callId.slice(0, 8)} · {service.call.rowCount}{service.serviceType==="XAPI"?" 个组合日期组":" 行"}
            {service.call.applicationStatus === "REVOKED" ? " · 应用已撤销" : ""}</>}
          {service.status === "PENDING" && " · 待直接授权调用"}
          {service.status === "NEEDS_ATTENTION" && " · 调用证据待核对"}</li>
      ))}</ul> : null}
      {result && <a className="button" href={`?module=agent-center&task=${encodeURIComponent(lineage.source.taskId!)}#agent-publication`}>返回原 Agent 发布</a>}
    </section>}
  </div>;
}
