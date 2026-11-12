import {DistributionReportResults} from './DistributionReportResults';
import { lazy,Suspense,useEffect, useRef, useState } from "react";
import { BarChart3, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { ReportWidget } from "./ReportsWorkbench";
import { securitiesReportTemplate } from "./report-template";
import { boundPublishedReports, checkedPublishedReportExport, publishedReportSourceKey } from "./published-report-read";
import type { PublishedReportResult, PublishedReportSource } from "./published-report-read";
import {PublishedReportCreator} from './PublishedReportCreator';
import {PublishedReportAgent} from './PublishedReportAgent';
const ReportProvenancePanel=lazy(async()=>({default:(await import('./ReportProvenancePanel')).ReportProvenancePanel}));

type Api = <T>(path: string,body?:unknown,options?:{idempotencyKey?:string}) => Promise<T>;
export function AgentReportPanel({ api, source, canCreate=false, fund=false, sync=false }: { api: Api; source: PublishedReportSource;canCreate?:boolean;fund?:boolean;sync?:boolean }) {
  const key = publishedReportSourceKey(source), active = useRef(key), epoch = useRef(0), alive = useRef(true);
  active.current = key;
  const [record, setRecord] = useState<{ key: string; results: PublishedReportResult[] }>(),
    [read, setRead] = useState<{ key: string; state: "LOADING" | "READY" | "ERROR"; error?: string }>(),
    [selected, setSelected] = useState(""), [exporting, setExporting] = useState(false), [notice, setNotice] = useState(""),[manualCreateOpen,setManualCreateOpen]=useState(sync);
  const results = record?.key === key ? record.results : [],
    result = results.find(r => r.key === selected) ?? results[0],
    ready = read?.key === key && read.state === "READY";
  const refresh = async () => {
    const sequence = ++epoch.current, same = () => alive.current && active.current === key && sequence === epoch.current;
    setRead({ key, state: "LOADING" }); setNotice("");
    try {
      const value = boundPublishedReports(await api<unknown>("/reports/overview"), source);
      if (same()) { setRecord({ key, results: value }); setRead({ key, state: "READY" }); }
    } catch (e) { if (same()) setRead({ key, state: "ERROR", error: (e as Error).message }); }
  };
  useEffect(() => {
    alive.current = true; setSelected(""); setExporting(false); setNotice(""); void refresh();
    return () => { alive.current = false; epoch.current++; };
  }, [key]);
  const download = async () => {
    if (!ready || !result?.exportable || exporting) return;
    const current = key, chosen = result; setExporting(true); setNotice("");
    try {
      const value = await checkedPublishedReportExport(await api<unknown>(`/reports/${chosen.reportId}/export`), chosen);
      if (!alive.current || active.current !== current) return;
      const url = URL.createObjectURL(new Blob([value.content], { type: value.contentType })), link = document.createElement("a");
      link.href = url; link.download = value.fileName; link.hidden = true;
      try { document.body.appendChild(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      setNotice("聚合CSV的版本、运行和内容摘要已核对；编号已脱敏。");
    } catch (e) { if (alive.current && active.current === current) setNotice(`导出尚未确认：${(e as Error).message}`); }
    finally { if (alive.current && active.current === current) setExporting(false); }
  };
  const notes = securitiesReportTemplate(result?.fields).notes;
  return <section id="agent-report-results" className="agent-publication-card agent-report-results-v2" aria-label="同源资产报表">
    <header className="agent-workflow-title"><BarChart3 size={18} /><h3>{fund ? "发布结果 → 基金组合报表" : "发布结果 → 资产分析报表"}</h3><button className="button" onClick={() => void refresh()} disabled={read?.state === "LOADING" || exporting}><RefreshCw size={14} />重读报表</button></header>
    <p>{source.kind === "MANUAL" ? "手工开发结果，保留工程师与测试审阅归因；不计Agent自主完成。" : "当前Agent任务的本机发布结果。"}仅匹配确切成功批次与固定快照。查看不会计算；创建须显式确认，将物化并聚合已发布结果，不运行新SQL、模型或Spark。</p>
    <small>发布 {source.releaseId.slice(0, 8)} · 包 {source.packageDigest.slice(0, 12)} · {source.batchIds.length}个已确认成功批次</small>
    {!sync && <PublishedReportAgent api={api} source={source} canWrite={canCreate} onCreated={receipt=>{setSelected(`${receipt.reportId}:${receipt.reportVersionId}:${receipt.reportRunId}`);void refresh();}}/>}
    <details open={manualCreateOpen} onToggle={e=>setManualCreateOpen(e.currentTarget.open)}><summary>手动创建与原请求恢复</summary>{manualCreateOpen&&<PublishedReportCreator key={key} api={api} source={source} canCreate={canCreate} defaultName={fund ? "基金组合敞口报告" : sync ? "冻结持仓客户资产报告" : undefined} onCreated={receipt=>{setSelected(`${receipt.reportId}:${receipt.reportVersionId}:${receipt.reportRunId}`);void refresh();}}/>}</details>
    {read?.key === key && read.state === "LOADING" && <p role="status"><LoaderCircle size={14} className="spin" />正在核对同源报表…</p>}
    {read?.key === key && read.state === "ERROR" && <p role="status">{read.error} {result && "下方保留上次确认的历史结果，当前导出已关闭。"}</p>}
    {ready && !result && <p role="status">此发布版本尚无已核验报表。未切换到其他任务或全局最新结果；需先用此确切批次生成快照与报表。</p>}
    {result && <>
      {results.length > 1 && <label>此发布的报表运行<select value={result.key} onChange={e => { setSelected(e.target.value); setNotice(""); }} disabled={exporting}>{results.map(r => <option key={r.key} value={r.key}>{r.name} · V{r.versionNumber} · {r.runId.slice(0, 8)}</option>)}</select></label>}
      <div className="agent-report-heading-v2"><div><h4>{result.name} · V{result.versionNumber}</h4><p>{result.description}</p></div><button className="button" disabled={!ready || !result.exportable || exporting} onClick={() => void download()}>{exporting ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}导出同版本CSV</button></div>
      <small>来源批次 {result.sourceBatchId.slice(0, 8)} · 快照 {result.snapshotId.slice(0, 8)} · 报表运行 {result.runId.slice(0, 8)}</small>
      {sync ? <a className="button" href={"?module=assets&asset="+encodeURIComponent("dataset:sync-holdings:"+result.sourceBatchId)}>查看原批次资产血缘</a> :
      <Suspense fallback={<p>正在加载溯源核对…</p>}><ReportProvenancePanel key={result.key} api={api} reportId={result.reportId} versionId={result.versionId} runId={result.runId} resultHash={result.resultHash}/></Suspense>}
      {result.outputContractId?<DistributionReportResults key={result.key} contractId={result.outputContractId} widgets={result.widgets} sourceEvidence={result.sourceEvidence}/>:<div className="report-widgets-v2">{result.widgets.map(widget => <ReportWidget key={widget.id} widget={widget} />)}</div>}
      <aside className="report-template-notes-v2" aria-label="报表指标范围">{!result.outputContractId&&notes.map(note => <p key={note}>{note}</p>)}{!result.exportable && <p>这是固定历史版本；当前导出接口指向另一次运行，因此未开放导出，不替换为新版本。</p>}</aside>
      <small>结果摘要 {result.resultHash.slice(0, 12)} · 本机聚合结果，不代表公网或完整Agent E2E验收</small>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
