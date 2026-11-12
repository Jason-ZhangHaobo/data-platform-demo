import { useEffect, useRef, useState } from "react";
import { fundReportContractId } from "../../src/v2/distribution-report-contract.mjs";
import { FundReportLineage } from "./FundReportLineage";
import type { PublishedReportReceipt } from "../../src/v2/published-report-client.mjs";
import { readPublishedReportResult } from "../../src/v2/published-report-client.mjs";
import { reportRequestId } from "../../src/v2/published-report-request.mjs";
import { boundPublishedReports, checkedPublishedReportExport } from "./published-report-read";
import type { PublishedReportResult } from "./published-report-read";
import { DistributionReportResults } from "./DistributionReportResults";
import { ReportWidget } from "./ReportsWorkbench";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type HistoryResult = { key: string; result?: PublishedReportResult; receipt?: PublishedReportReceipt; error?: string };

export function AgentReportHistory({ api, local, canWrite }: { api: Api; local: boolean; canWrite: boolean }) {
  const initial = new URLSearchParams(window.location.search).getAll("report_request");
  const [request, setRequest] = useState(initial.length === 1 ? initial[0] : "");
  const [draft, setDraft] = useState(request);
  const [state, setState] = useState<HistoryResult>();
  const [retry, setRetry] = useState(0);
  const [inputError, setInputError] = useState(initial.length > 1 ? "链接包含多个报表请求编号，请核对后重新输入。" : "");
  useEffect(() => {
    if (!local || !request) return;
    let active = true;
    setState(undefined);
    const load = async () => {
      try {
        const { receipt, overview } = await readPublishedReportResult({ request: path => api(path) }, { requestId: request });
        const { batchId, ...source } = receipt.source;
        const [result] = boundPublishedReports(overview, { ...source, batchIds: [batchId] });
        if (!result || result.runId !== receipt.reportRunId || result.versionId !== receipt.reportVersionId)
          throw Error("未找到与原请求对应的固定运行。");
        if (active) setState({ key: request, result, receipt });
      } catch (error) {
        if (active) setState({ key: request, error: (error as Error).message });
      }
    };
    void load();
    return () => { active = false; };
  }, [local, request, retry, api]);
  const show = state?.key === request ? state : undefined;
  return (
    <section className="agent-publication-card agent-report-results-v2 agent-report-history-v2" aria-label="Data Agent 报表回看">
      <header className="agent-workflow-title"><h3>Data Agent · 报表回看</h3>
        <a className="button" href="?module=agent-center">回到 Agent 工作台</a>
      </header>
      {!local ? <p role="status">原报表回看当前在本机工作台开放。</p> : <>
        <form className="report-history-form-v2" onSubmit={event => {
          event.preventDefault();
          try {
            const id = reportRequestId(draft.trim());
            const url = new URL(window.location.href);
            url.searchParams.set("report_request", id);
            window.history.replaceState(null, "", url);
            setInputError("");
            setState(undefined);
            setRequest(id);
            setRetry(value => value + 1);
          } catch {
            setInputError("请输入原报表创建请求的 UUID。");
          }
        }}>
          <label>原报表请求编号<input value={draft} onChange={event => setDraft(event.currentTarget.value)} maxLength={36} /></label>
          <button className="button" type="submit" disabled={!draft.trim()}>读取原报表</button>
        </form>
        {inputError && <p role="alert">{inputError}</p>}
        {request && !show && <p role="status">正在读取原报表运行…</p>}
        {show?.error && <p role="alert">{show.error}</p>}
        {show?.result && show.receipt && <HistoricalResult key={show.result.key} result={show.result} receipt={show.receipt} api={api} canWrite={canWrite} />}
      </>}
    </section>
  );
}

function HistoricalResult({ result, receipt, api, canWrite }: { result: PublishedReportResult; receipt: PublishedReportReceipt; api: Api; canWrite: boolean }) {
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function download() {
    setExporting(true); setExportError("");
    try {
      const value = await checkedPublishedReportExport(
        await api("/reports/published/requests/" + receipt.requestId + "/export"), result, { originalRequest: true });
      if (!active.current) return;
      const url = URL.createObjectURL(new Blob([value.content], { type: value.contentType }));
      const link = document.createElement("a");
      link.href = url; link.download = value.fileName; link.hidden = true;
      try { document.body.appendChild(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (error) { if (active.current) setExportError((error as Error).message); }
    finally { if (active.current) setExporting(false); }
  }
  return <>
    <div className="agent-report-heading-v2"><div><h4>{result.name} · V{result.versionNumber}</h4><p>{result.description}</p></div>
      <div><small>{result.exportable ? "原请求运行" : "固定历史运行"} · 只读</small>
        <button className="button" disabled={exporting} onClick={() => void download()}>导出原运行 CSV</button></div>
    </div>
    {exportError && <p role="alert">{exportError}</p>}
    <small>批次 <code title={result.sourceBatchId}>{result.sourceBatchId.slice(0, 8)}</code>
      {" · 运行 "}<code title={result.runId}>{result.runId.slice(0, 8)}</code>
      {" · 结果 "}<code title={result.resultHash}>{result.resultHash.slice(0, 12)}</code></small>
    {result.outputContractId === fundReportContractId && <FundReportLineage key={result.key} api={api} receipt={receipt} canWrite={canWrite} />}
    {result.outputContractId
      ? <DistributionReportResults key={result.key} contractId={result.outputContractId} widgets={result.widgets} sourceEvidence={result.sourceEvidence} />
      : <div className="report-widgets-v2">{result.widgets.map(widget => <ReportWidget key={widget.id} widget={widget} />)}</div>}
  </>;
}
