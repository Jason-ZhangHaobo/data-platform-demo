import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  Download,
  Gauge,
  LoaderCircle,
  PieChart,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  TableProperties,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Asset = {
  id: string;
  businessName: string;
  name: string;
  rowCount?: number;
  reportable: boolean;
  fields: { name: string; type: string }[];
};
type Snapshot = {
  id: string;
  rowCount: number;
  contentHash: string;
  assetEvidenceHash: string;
  actualMaterialization: boolean;
};
type Dataset = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  fields: string[];
  status: string;
  currentSnapshotId?: string;
  currentSnapshot?: Snapshot;
  snapshots: Snapshot[];
};
type WidgetResult = {
  id: string;
  type: "KPI" | "BAR" | "PIE";
  title: string;
  aggregation: string;
  field?: string;
  dimension?: string;
  value?: string;
  series?: { group: string; value: string }[];
  evaluatedCount: number;
};
type ReportRun = {
  id: string;
  status: string;
  widgets: WidgetResult[];
  resultHash: string;
  datasetContentHash: string;
  durationMs: number;
  publicDeployed: boolean;
};
type ReportVersion = {
  id: string;
  versionNumber: number;
  datasetId: string;
  datasetSnapshotId: string;
  widgets: Omit<WidgetResult, "value" | "series" | "evaluatedCount">[];
  description: string;
  configHash: string;
  status: string;
};
type Report = {
  id: string;
  name: string;
  code: string;
  datasetId: string;
  status: string;
  lastRunId?: string;
  currentVersion: ReportVersion;
  versions: ReportVersion[];
  runs: ReportRun[];
};
type Overview = {
  scope: string;
  publicDeployed: boolean;
  datasets: Dataset[];
  reports: Report[];
  counts: {
    datasets: number;
    readyDatasets: number;
    reports: number;
    verifiedReports: number;
    runs: number;
  };
};
type AgentPlan = {
  id: string;
  status: string;
  explanation?: string;
  error?: string;
  reportId?: string;
  model?: string;
  usage?: { total_tokens?: number };
  proposal?: {
    name: string;
    code: string;
    datasetId: string;
    widgets: { id: string; type: string; title: string }[];
  };
};

const labels: Record<string, string> = {
  DRAFT: "草稿",
  READY: "快照就绪",
  VERIFIED: "已验证",
  VERIFIED_LOCAL: "本机已验证",
  SUCCEEDED: "成功",
  QUEUED: "排队中",
  RUNNING: "生成中",
  APPLIED: "报表草稿已创建",
};
const pending = (status?: string) =>
  status === "QUEUED" || status === "RUNNING";
const colors = ["#2f7351", "#82a765", "#d3a555", "#5e8f8c", "#8c79a8", "#bb7962"];
const numberValue = (value: string) => Number(value || 0);

export function ReportsWorkbench({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const [overview, setOverview] = useState<Overview>(),
    [assets, setAssets] = useState<Asset[]>([]),
    [plans, setPlans] = useState<AgentPlan[]>([]),
    [selectedReportId, setSelectedReportId] = useState("");
  const [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [datasetName, setDatasetName] = useState("证券持仓报表数据集"),
    [datasetCode, setDatasetCode] = useState("holdings_report_dataset_review"),
    [assetId, setAssetId] = useState("landing:raw_positions"),
    [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [reportName, setReportName] = useState("财富顾问持仓结构报告"),
    [reportCode, setReportCode] = useState("advisor_holdings_report_review"),
    [reportDescription, setReportDescription] = useState("展示持仓市值、证券数量、资产类别和行业分布");
  const [agentMessage, setAgentMessage] = useState(
      "基于已就绪的证券持仓数据集，生成包含持仓市值、证券数量、资产类别分布和行业分布的聚合报表草稿，不运行、不导出",
    ),
    [agentPlan, setAgentPlan] = useState<AgentPlan>();

  const datasets = overview?.datasets ?? [],
    reports = overview?.reports ?? [],
    selectedReport = reports.find((report) => report.id === selectedReportId),
    selectedDataset = datasets.find((dataset) => dataset.id === selectedDatasetId),
    selectedAsset = assets.find((asset) => asset.id === assetId),
    reportableAssets = useMemo(() => assets.filter((asset) => asset.reportable), [assets]),
    latestRun = selectedReport?.runs.find((run) => run.id === selectedReport.lastRunId) ?? selectedReport?.runs[0];

  const reload = async () => {
    const [nextOverview, nextAssets, nextPlans] = await Promise.all([
      api<Overview>("/reports/overview"),
      api<Asset[]>("/assets"),
      api<AgentPlan[]>("/reports/agent/plans"),
    ]);
    setOverview(nextOverview);
    setAssets(nextAssets);
    setPlans(nextPlans);
    if (!selectedReportId && nextOverview.reports[0])
      setSelectedReportId(nextOverview.reports[0].id);
    if (!selectedDatasetId && nextOverview.datasets[0])
      setSelectedDatasetId(nextOverview.datasets[0].id);
    if (!assetId && nextAssets.find((asset) => asset.reportable))
      setAssetId(nextAssets.find((asset) => asset.reportable)!.id);
    if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);
  };
  useEffect(() => {
    reload().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (!agentPlan || !pending(agentPlan.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<AgentPlan>(
          `/reports/agent/plans/${agentPlan.id}`,
        );
        setAgentPlan(current);
        if (!pending(current.status)) await reload();
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [agentPlan?.id, agentPlan?.status]);

  const action = async (
    key: string,
    work: () => Promise<unknown>,
    message: string,
  ) => {
    setBusy(key);
    setError("");
    try {
      await work();
      await reload();
      setNotice(message);
    } catch (cause) {
      setError((cause as Error).message);
      await reload().catch(() => undefined);
    } finally {
      setBusy("");
    }
  };
  const createDataset = () =>
    action(
      "dataset",
      async () => {
        const dataset = await api<Dataset>("/reports/datasets", {
          name: datasetName,
          code: datasetCode,
          assetId,
          fields: selectedAsset?.fields.map((field) => field.name) ?? [],
        });
        setSelectedDatasetId(dataset.id);
      },
      "数据集草稿已创建；还没有复制业务行",
    );
  const refreshDataset = (id: string) =>
    action(
      `refresh:${id}`,
      () => api(`/reports/datasets/${id}/refresh`, {}),
      "实际资产行已物化为独立不可变快照",
    );
  const widgetsFor = (dataset?: Dataset) => {
    const fields = new Set(dataset?.fields ?? []);
    if (fields.has("market_value"))
      return [
        { id: "holding_value", type: "KPI", title: "持仓市值", aggregation: "SUM", field: "market_value" },
        { id: "security_count", type: "KPI", title: "证券数量", aggregation: "COUNT_DISTINCT", field: "security_code" },
        { id: "asset_class_distribution", type: "PIE", title: "资产类别分布", aggregation: "SUM", field: "market_value", dimension: "asset_class" },
        { id: "industry_distribution", type: "BAR", title: "行业分布", aggregation: "SUM", field: "market_value", dimension: "industry" },
      ];
    return [
      { id: "total_assets", type: "KPI", title: "客户总资产", aggregation: "SUM", field: "total_assets" },
      { id: "client_assets", type: "BAR", title: "客户资产分布", aggregation: "SUM", field: "total_assets", dimension: "client_id" },
    ];
  };
  const createReport = () =>
    selectedDataset &&
    action(
      "report",
      async () => {
        const report = await api<Report>("/reports", {
          name: reportName,
          code: reportCode,
          datasetId: selectedDataset.id,
          widgets: widgetsFor(selectedDataset),
          description: reportDescription,
        });
        setSelectedReportId(report.id);
      },
      "报表草稿已固定当前数据集快照，尚未运行",
    );
  const runReport = () =>
    selectedReport &&
    action(
      "run",
      () => api(`/reports/${selectedReport.id}/run`, {}),
      "报表组件已在固定快照上实际聚合",
    );
  const download = async () => {
    if (!selectedReport) return;
    setBusy("export");
    setError("");
    try {
      const exported = await api<{
        fileName: string;
        contentType: string;
        content: string;
      }>(`/reports/${selectedReport.id}/export`),
        url = URL.createObjectURL(
          new Blob([exported.content], { type: exported.contentType }),
        ),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("已导出聚合结果CSV，不包含客户或持仓明细行");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const generatePlan = () =>
    action(
      "agent",
      async () => {
        const plan = await api<AgentPlan>("/reports/agent/plans", {
          message: agentMessage,
        });
        setAgentPlan(plan);
      },
      "Data Agent正在读取数据集字段和快照摘要",
    );
  const applyPlan = () =>
    agentPlan &&
    action(
      "apply-plan",
      async () => {
        const report = await api<Report>(
          `/reports/agent/plans/${agentPlan.id}/apply`,
          {},
        );
        setSelectedReportId(report.id);
        setAgentPlan(
          await api<AgentPlan>(`/reports/agent/plans/${agentPlan.id}`),
        );
      },
      "Agent方案已创建为报表草稿，运行数仍为0",
    );

  return (
    <div className="reports-workbench-v2">
      <section className="reports-hero-v2">
        <div><span className="eyebrow">ANALYTICS · M4F</span><h2>从可信快照到可解释图表</h2><p>数据集物化实际资产行；报表固定快照后执行聚合组件，导出只包含聚合结果。</p></div>
        <div className="reports-kpis-v2"><div><Database size={15} /><strong>{overview?.counts.readyDatasets ?? 0}</strong><span>就绪数据集</span></div><div><BarChart3 size={15} /><strong>{overview?.counts.verifiedReports ?? 0}</strong><span>已验证报表</span></div><div><Play size={15} /><strong>{overview?.counts.runs ?? 0}</strong><span>实际运行</span></div><div><Gauge size={15} /><strong>{latestRun?.widgets.length ?? 0}</strong><span>当前组件</span></div></div>
      </section>
      {(notice || error) && <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>{error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</div>}

      <section className="reports-agent-v2">
        <header><div className="reports-agent-icon-v2"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · SNAPSHOT GROUNDED</span><h3>用自然语言设计报表，人确认后再运行</h3><p>模型只看字段和快照摘要，不读取业务行；未知字段或数据集由后端拒绝。</p></div></header>
        <div className="reports-agent-compose-v2"><textarea aria-label="向Data Agent描述报表需求" rows={2} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={generatePlan} disabled={!canWrite || !!busy || pending(agentPlan?.status)}>{busy === "agent" || pending(agentPlan?.status) ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}生成报表方案</button></div>
        {agentPlan && <div className="reports-agent-result-v2"><span className={`status-pill ${agentPlan.status.toLowerCase()}`}>{labels[agentPlan.status] ?? agentPlan.status}</span><div><strong>{agentPlan.proposal?.name ?? "正在匹配数据集与字段"}</strong><p>{agentPlan.explanation ?? agentPlan.error ?? "生成中…"}</p>{agentPlan.proposal && <code>{agentPlan.proposal.datasetId} · {agentPlan.proposal.widgets.length}个聚合组件</code>}</div><button className="button" onClick={applyPlan} disabled={!canWrite || !!busy || agentPlan.status !== "SUCCEEDED"}><CheckCircle2 size={14} />确认创建草稿</button></div>}
        <small>{plans.length}条Agent方案 · 不自动运行、导出或发布</small>
      </section>

      <div className="reports-main-v2">
        <aside className="reports-catalog-v2">
          <header><div><span className="eyebrow">REPORTS</span><h3>报表目录</h3></div><span>{reports.length}</span></header>
          {reports.map((report) => <button key={report.id} className={report.id === selectedReportId ? "active" : ""} onClick={() => setSelectedReportId(report.id)}><BarChart3 size={16} /><div><strong>{report.name}</strong><code>{report.code} · V{report.currentVersion.versionNumber}</code></div><span className={`status-pill ${report.status.toLowerCase()}`}>{labels[report.status] ?? report.status}</span><ChevronRight size={13} /></button>)}
          {!reports.length && <div className="ingestion-empty"><BarChart3 size={25} /><p>先创建并刷新数据集。</p></div>}
          <div className="reports-dataset-list-v2"><header><strong>数据集</strong><span>{datasets.length}</span></header>{datasets.map((dataset) => <button key={dataset.id} className={dataset.id === selectedDatasetId ? "active" : ""} onClick={() => setSelectedDatasetId(dataset.id)}><TableProperties size={14} /><div><strong>{dataset.name}</strong><code>{dataset.fields.length}字段 · {dataset.currentSnapshot?.rowCount ?? 0}行</code></div><span className={`status-pill ${dataset.status.toLowerCase()}`}>{labels[dataset.status] ?? dataset.status}</span></button>)}</div>
        </aside>
        <section className="reports-canvas-v2">
          {selectedReport ? <>
            <header><div><span className="eyebrow">{selectedReport.code} · SNAPSHOT PINNED</span><h3>{selectedReport.name}</h3><p>{selectedReport.currentVersion.description}</p></div><div><button className="button primary" onClick={runReport} disabled={!canWrite || !!busy}>{busy === "run" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}实际运行</button><button className="button" onClick={download} disabled={!latestRun || !!busy}><Download size={14} />导出聚合CSV</button></div></header>
            <div className="reports-proof-v2"><div><span>状态</span><strong>{labels[selectedReport.status] ?? selectedReport.status}</strong></div><div><span>快照</span><code>{selectedReport.currentVersion.datasetSnapshotId.slice(0, 8)}</code></div><div><span>报表版本</span><strong>V{selectedReport.currentVersion.versionNumber}</strong></div><div><span>运行</span><strong>{selectedReport.runs.length}</strong></div><div><span>公网</span><strong>未部署</strong></div></div>
            {latestRun ? <div className="report-widgets-v2">{latestRun.widgets.map((widget) => <ReportWidget key={widget.id} widget={widget} />)}</div> : <div className="reports-empty-canvas-v2"><Sparkles size={28} /><strong>草稿已固定快照，尚未计算</strong><p>点击“实际运行”后才生成KPI与分布，不使用预设结果。</p></div>}
            {latestRun && <footer className="reports-run-proof-v2"><CheckCircle2 size={14} />运行 {latestRun.id.slice(0, 8)} · 结果摘要 {latestRun.resultHash.slice(0, 12)} · {latestRun.durationMs}ms · public=false</footer>}
          </> : <div className="reports-empty-canvas-v2"><BarChart3 size={28} /><strong>创建第一张聚合报表</strong><p>数据集必须先完成实际快照。</p></div>}
        </section>
      </div>

      <section className="reports-builder-v2">
        <header><div><span className="eyebrow">DATASET → REPORT</span><h3>手动构建</h3></div><Sparkles size={19} /></header>
        <div className="reports-builder-steps-v2">
          <fieldset><legend>1. 数据集草稿</legend><label>可报表资产<select value={assetId} onChange={(event) => setAssetId(event.target.value)}>{reportableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.businessName} · {asset.rowCount ?? 0}行</option>)}</select></label><label>名称<input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} /></label><label>代码<input value={datasetCode} onChange={(event) => setDatasetCode(event.target.value)} /></label><button className="button" onClick={createDataset} disabled={!canWrite || !selectedAsset || !!busy}><Database size={13} />创建数据集</button></fieldset>
          <fieldset><legend>2. 物化快照</legend><label>数据集<select value={selectedDatasetId} onChange={(event) => setSelectedDatasetId(event.target.value)}>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.status}</option>)}</select></label><div className="dataset-proof-v2"><span>字段 {selectedDataset?.fields.length ?? 0}</span><span>快照 {selectedDataset?.snapshots.length ?? 0}</span><span>行 {selectedDataset?.currentSnapshot?.rowCount ?? 0}</span></div><button className="button" onClick={() => selectedDataset && refreshDataset(selectedDataset.id)} disabled={!canWrite || !selectedDataset || !!busy}><RefreshCw size={13} />刷新实际快照</button></fieldset>
          <fieldset><legend>3. 报表草稿</legend><label>名称<input value={reportName} onChange={(event) => setReportName(event.target.value)} /></label><label>代码<input value={reportCode} onChange={(event) => setReportCode(event.target.value)} /></label><label>说明<input value={reportDescription} onChange={(event) => setReportDescription(event.target.value)} /></label><button className="button" onClick={createReport} disabled={!canWrite || selectedDataset?.status !== "READY" || !!busy}><PieChart size={13} />创建{widgetsFor(selectedDataset).length}组件报表</button></fieldset>
        </div>
      </section>
      <footer className="reports-boundary-v2"><TableProperties size={14} />报表基于本机不可变快照实际聚合；导出不含明细行，尚未接入公网分享、受邀认证或生产BI引擎。</footer>
    </div>
  );
}

function ReportWidget({ widget }: { widget: WidgetResult }) {
  if (widget.type === "KPI")
    return <article className="report-kpi-v2"><span>{widget.title}</span><strong>{widget.value}</strong><small>{widget.aggregation}({widget.field}) · {widget.evaluatedCount}行</small></article>;
  const series = widget.series ?? [],
    max = Math.max(...series.map((item) => numberValue(item.value)), 1),
    total = series.reduce((sum, item) => sum + numberValue(item.value), 0),
    stops = series.reduce<{ value: number; colors: string[] }>((state, item, index) => {
      const start = state.value,
        end = start + (total ? (numberValue(item.value) / total) * 100 : 0);
      state.colors.push(`${colors[index % colors.length]} ${start}% ${end}%`);
      state.value = end;
      return state;
    }, { value: 0, colors: [] });
  return <article className={`report-chart-v2 ${widget.type.toLowerCase()}`}><header><div>{widget.type === "PIE" ? <PieChart size={16} /> : <BarChart3 size={16} />}<strong>{widget.title}</strong></div><small>{widget.aggregation}({widget.field}) BY {widget.dimension}</small></header>{widget.type === "PIE" ? <div className="report-pie-body-v2"><div className="report-donut-v2" style={{ background: `conic-gradient(${stops.colors.join(",")})` }}><span>{series.length}<small>分类</small></span></div><div className="report-legend-v2">{series.map((item, index) => <div key={item.group}><i style={{ background: colors[index % colors.length] }} /><span>{item.group}</span><strong>{item.value}</strong></div>)}</div></div> : <div className="report-bars-v2">{series.map((item, index) => <div key={item.group}><span>{item.group}</span><div><i style={{ width: `${(numberValue(item.value) / max) * 100}%`, background: colors[index % colors.length] }} /></div><strong>{item.value}</strong></div>)}</div>}</article>;
}
