import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  FileSearch,
  Gauge,
  GitBranch,
  Layers3,
  LoaderCircle,
  Network,
  Play,
  Save,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
} from "lucide-react";
import { ContractsPanel } from "./ContractsPanel";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Field = {
  name: string;
  type: string;
  nullable: boolean;
  distinctCount?: number;
};
type Asset = {
  id: string;
  kind: string;
  name: string;
  businessName: string;
  system: string;
  domain: string;
  description: string;
  status: string;
  rowCount?: number;
  eventCount?: number;
  fields: Field[];
  tags: string[];
  evidenceHash: string;
  versionId?: string;
  executableMetrics: boolean;
  owner?: string;
  classification: string;
  annotation?: { revision: number };
};
type LineageNode = Asset;
type LineageEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  fieldMappings: { source: string; target: string }[];
  evidenceId: string;
  evidenceHash: string;
};
type Lineage = {
  focusAssetId: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  derivation: string;
  sqlColumnLineageParsed: boolean;
};
type MetricRun = {
  id: string;
  status: string;
  rowCount: number;
  values: { group: string; value: string }[];
  resultHash: string;
  durationMs: number;
};
type Metric = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  aggregation: string;
  field?: string;
  groupBy?: string;
  definition: string;
  unit: string;
  runs: MetricRun[];
};
type StandardCheck = {
  id: string;
  status: string;
  evaluatedCount: number;
  passedCount: number;
  failedCount: number;
};
type Standard = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  field: string;
  semanticType: string;
  description: string;
  checks: StandardCheck[];
};
type AssetDetail = Asset & {
  lineage: Lineage;
  metrics: Metric[];
  standards: Standard[];
};
type AgentTask = {
  id: string;
  message: string;
  status: string;
  insight?: {
    answer: string;
    assetIds: string[];
    lineageFocusAssetId: string;
    caveats: string[];
  };
  error?: string;
  model?: string;
  usage?: { total_tokens?: number };
};

const kindLabels: Record<string, string> = {
  FIXTURE_TABLE: "Spark输入",
  SOURCE_TABLE: "源表",
  LANDING_TABLE: "落地表",
  STREAM_SOURCE: "实时源",
  STREAM_STATE_TABLE: "实时状态",
  PUBLISHED_DATASET: "发布数据集",
  DAPI: "DAPI",
  XAPI: "XAPI",
};
const statusLabels: Record<string, string> = {
  READY: "已就绪",
  SUCCEEDED: "成功",
  CAUGHT_UP: "已追平",
  PUBLISHED: "已发布",
  PUBLISHED_LOCAL: "本机发布",
  VERIFIED_FIXTURE: "已验证样例",
  FAILED: "失败",
  QUEUED: "排队中",
  RUNNING: "运行中",
  PASSED: "通过",
};
const pending = (status?: string) =>
  status === "QUEUED" || status === "RUNNING";

export function AssetWorkbench({
  api,
  canWrite,
  initialAssetId,
  handoffMessage,
}: {
  api: Api;
  canWrite: boolean;
  initialAssetId?: string;
  handoffMessage?: string;
}) {
  const [assets, setAssets] = useState<Asset[]>([]),
    [metrics, setMetrics] = useState<Metric[]>([]),
    [standards, setStandards] = useState<Standard[]>([]),
    [agentTasks, setAgentTasks] = useState<AgentTask[]>([]),
    [detail, setDetail] = useState<AssetDetail>();
  const [selectedId, setSelectedId] = useState(initialAssetId ?? ""),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState(""),
    [tab, setTab] = useState<"overview" | "fields" | "lineage" | "governance">("overview"),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [agentMessage, setAgentMessage] = useState(
      "找出可以计算财富顾问客户持仓市值的资产，解释它从哪里来、有哪些下游影响和当前证据边界",
    ),
    [agentTask, setAgentTask] = useState<AgentTask>();
  useEffect(() => {
    if (handoffMessage) setAgentMessage(handoffMessage);
  }, [handoffMessage]);
  const [businessName, setBusinessName] = useState(""),
    [description, setDescription] = useState(""),
    [domain, setDomain] = useState("财富管理"),
    [owner, setOwner] = useState("数据产品负责人"),
    [tagText, setTagText] = useState("持仓,T+1");
  const [metricName, setMetricName] = useState("持仓市值"),
    [metricCode, setMetricCode] = useState("holding_market_value_v2"),
    [aggregation, setAggregation] = useState("SUM"),
    [metricField, setMetricField] = useState("market_value"),
    [groupBy, setGroupBy] = useState("asset_class"),
    [metricDefinition, setMetricDefinition] = useState("按资产类别汇总持仓明细market_value，不含现金");
  const [standardName, setStandardName] = useState("证券代码格式"),
    [standardCode, setStandardCode] = useState("security_code_format_v2"),
    [standardField, setStandardField] = useState("security_code"),
    [semanticType, setSemanticType] = useState("SECURITY_CODE"),
    [standardDescription, setStandardDescription] = useState("虚构证券代码必须使用SEC-前缀");

  const nodeById = useMemo(
      () => new Map(detail?.lineage.nodes.map((node) => [node.id, node]) ?? []),
      [detail],
    ),
    executableAssets = assets.filter((asset) => asset.executableMetrics),
    assetKinds = [...new Set(assets.map((asset) => asset.kind))];

  const loadLists = async (search = query, filter = kind) => {
    const params = new URLSearchParams({
        ...(search.trim() ? { q: search.trim() } : {}),
        ...(filter ? { kind: filter } : {}),
      }),
      [nextAssets, nextMetrics, nextStandards, nextTasks] = await Promise.all([
        api<Asset[]>(`/assets${params.size ? `?${params}` : ""}`),
        api<Metric[]>("/metrics"),
        api<Standard[]>("/standards"),
        api<AgentTask[]>("/assets/agent/tasks"),
      ]);
    setAssets(nextAssets);
    setMetrics(nextMetrics);
    setStandards(nextStandards);
    setAgentTasks(nextTasks);
    const nextSelected =
      nextAssets.find((asset) => asset.id === selectedId)?.id ??
      nextAssets.find((asset) => asset.id === initialAssetId)?.id ??
      nextAssets.find((asset) => asset.id === "landing:raw_positions")?.id ??
      nextAssets[0]?.id;
    if (nextSelected && nextSelected !== selectedId) setSelectedId(nextSelected);
    if (!agentTask && nextTasks[0]) setAgentTask(nextTasks[0]);
  };
  const loadDetail = async (id: string) => {
    const next = await api<AssetDetail>(`/assets/${encodeURIComponent(id)}`);
    setDetail(next);
    setBusinessName(next.businessName);
    setDescription(next.description);
    setDomain(next.domain);
    setOwner(next.owner ?? "数据产品负责人");
    setTagText(next.tags.join(","));
    const fieldNames = new Set(next.fields.map((field) => field.name));
    if (fieldNames.has("market_value")) setMetricField("market_value");
    else if (fieldNames.has("price")) setMetricField("price");
    else setMetricField(next.fields[0]?.name ?? "");
    if (fieldNames.has("asset_class")) setGroupBy("asset_class");
    else setGroupBy("");
    if (fieldNames.has("security_code")) setStandardField("security_code");
    else setStandardField(next.fields[0]?.name ?? "");
  };
  useEffect(() => {
    loadLists().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (selectedId)
      loadDetail(selectedId).catch((cause) => setError((cause as Error).message));
  }, [selectedId]);
  useEffect(() => {
    if (!agentTask || !pending(agentTask.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<AgentTask>(`/assets/agent/tasks/${agentTask.id}`);
        setAgentTask(current);
        if (!pending(current.status)) setAgentTasks(await api<AgentTask[]>("/assets/agent/tasks"));
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [agentTask?.id, agentTask?.status]);

  const action = async (
    name: string,
    work: () => Promise<unknown>,
    message: string,
  ) => {
    setBusy(name);
    setError("");
    try {
      await work();
      await loadLists();
      if (selectedId) await loadDetail(selectedId);
      setNotice(message);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const search = () =>
    action("search", () => loadLists(query, kind), "已按实际资产字段与说明检索");
  const askAgent = () =>
    action(
      "agent",
      async () => {
        const task = await api<AgentTask>("/assets/agent/tasks", {
          message: agentMessage,
        });
        setAgentTask(task);
      },
      "Data Agent正在读取资产摘要和版本绑定血缘",
    );
  const saveAnnotation = () =>
    detail &&
    action(
      "annotation",
      () =>
        api(`/assets/${encodeURIComponent(detail.id)}/annotation`, {
          businessName,
          description,
          domain,
          owner,
          classification: "INTERNAL_DEMO",
          tags: tagText.split(",").map((item) => item.trim()).filter(Boolean),
        }),
      "资产说明已保存为新版本",
    );
  const createMetric = () =>
    detail &&
    action(
      "metric",
      () =>
        api("/metrics", {
          name: metricName,
          code: metricCode,
          assetId: detail.id,
          aggregation,
          ...(aggregation === "COUNT_ROWS" ? {} : { field: metricField }),
          ...(groupBy ? { groupBy } : {}),
          definition: metricDefinition,
        }),
      "指标定义已绑定当前资产证据",
    );
  const runMetric = (id: string) =>
    action(
      `metric-run:${id}`,
      () => api(`/metrics/${id}/run`, {}),
      "指标已在实际资产行上执行并保存结果摘要",
    );
  const createStandard = () =>
    detail &&
    action(
      "standard",
      () =>
        api("/standards", {
          name: standardName,
          code: standardCode,
          assetId: detail.id,
          field: standardField,
          semanticType,
          description: standardDescription,
        }),
      "数据标准已绑定当前字段",
    );
  const checkStandard = (id: string) =>
    action(
      `standard-check:${id}`,
      () => api(`/standards/${id}/check`, {}),
      "标准已在实际资产行上检查",
    );

  return (
    <div className="asset-workbench-v2">
      <section className="asset-hero-v2">
        <div><span className="eyebrow">ASSET GRAPH · M4C</span><h2>资产不是登记表，而是可验证的关系网络</h2><p>目录由真实源版本、同步配置、实时状态、发布批次和数据服务关系生成；业务说明可版本化补充。</p></div>
        <div className="asset-kpis-v2"><div><strong>{assets.length}</strong><span>当前资产</span></div><div><strong>{detail?.lineage.edges.length ?? 0}</strong><span>关联血缘</span></div><div><strong>{metrics.length}</strong><span>指标</span></div><div><strong>{standards.length}</strong><span>标准</span></div></div>
      </section>

      <form className="asset-search-v2" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <Search size={17} />
        <input aria-label="搜索数据资产" placeholder="搜索业务名称、表、字段、标签，例如 market_value" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="资产类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option>{assetKinds.map((item) => <option key={item} value={item}>{kindLabels[item] ?? item}</option>)}</select>
        <button className="button primary" disabled={!!busy}>{busy === "search" ? <LoaderCircle className="spin" size={15} /> : <FileSearch size={15} />}搜索</button>
      </form>

      {(notice || error) && <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>{error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</div>}

      <section className="asset-agent-v2">
        <header><div className="asset-agent-icon-v2"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · GROUNDED DISCOVERY</span><h3>找数据、解释口径、看下游影响</h3><p>模型只接收资产摘要、版本绑定关系和已检查的契约摘要；引用未知资产即失败，不读取业务行。</p></div></header>
        <div className="asset-agent-compose-v2"><textarea aria-label="向Data Agent询问数据资产" rows={2} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={askAgent} type="button" disabled={!canWrite || !!busy || pending(agentTask?.status)}>{busy === "agent" || pending(agentTask?.status) ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}询问资产 Agent</button></div>
        {agentTask && <div className="asset-agent-answer-v2"><span className={`status-pill ${agentTask.status.toLowerCase()}`}>{statusLabels[agentTask.status] ?? agentTask.status}</span><div><strong>{agentTask.insight?.answer ?? agentTask.error ?? "正在分析资产关系…"}</strong>{agentTask.insight?.caveats.map((item) => <p key={item}>边界：{item}</p>)}{agentTask.usage?.total_tokens && <small>{agentTask.model} · {agentTask.usage.total_tokens} Token</small>}</div><div className="asset-citations-v2">{agentTask.insight?.assetIds.map((id) => <button type="button" key={id} onClick={() => { setSelectedId(id); setTab("lineage"); }}>{id}<ChevronRight size={12} /></button>)}</div></div>}
        <small>{agentTasks.length}次受治理问答 · 不自动修改资产</small>
      </section>

      <div className="asset-main-v2">
        <aside className="asset-catalog-v2">
          <header><div><span className="eyebrow">CATALOG</span><h3>资产目录</h3></div><span>{assets.length}</span></header>
          {assets.map((asset) => <button key={asset.id} className={asset.id === selectedId ? "active" : ""} onClick={() => setSelectedId(asset.id)}><Database size={16} /><div><strong>{asset.businessName}</strong><code>{asset.name}</code><small>{kindLabels[asset.kind] ?? asset.kind} · {asset.fields.length}字段</small></div><span className={`status-pill ${asset.status.toLowerCase()}`}>{statusLabels[asset.status] ?? asset.status}</span></button>)}
          {!assets.length && <div className="ingestion-empty"><FileSearch size={25} /><p>没有符合条件的资产。</p></div>}
        </aside>
        <section className="asset-detail-v2">
          {detail ? <>
            <header className="asset-detail-head-v2"><div><span className="eyebrow">{kindLabels[detail.kind] ?? detail.kind} · {detail.system}</span><h3>{detail.businessName}</h3><code>{detail.id}</code></div><div><span className={`status-pill ${detail.status.toLowerCase()}`}>{statusLabels[detail.status] ?? detail.status}</span><small>evidence {detail.evidenceHash.slice(0, 12)}</small></div></header>
            <div className="asset-tabs-v2" role="tablist" aria-label="资产详情视图">{[["overview", "概览"], ["fields", `字段 ${detail.fields.length}`], ["lineage", `血缘 ${detail.lineage.edges.length}`], ["governance", "指标、标准与契约"]].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id as typeof tab)}>{label}</button>)}</div>
            {tab === "overview" && <div className="asset-overview-v2">
              <div className="asset-proof-v2"><div><span>真实行数</span><strong>{detail.rowCount ?? "—"}</strong></div><div><span>业务域</span><strong>{detail.domain}</strong></div><div><span>责任人</span><strong>{detail.owner ?? "待补充"}</strong></div><div><span>说明版本</span><strong>V{detail.annotation?.revision ?? 0}</strong></div></div>
              <article className="asset-description-v2"><Layers3 size={18} /><div><strong>{detail.description}</strong><p>{detail.tags.join(" · ")}</p></div></article>
              <details className="asset-annotation-v2"><summary><Tag size={14} />编辑业务说明</summary><div><label>业务名称<input value={businessName} onChange={(event) => setBusinessName(event.target.value)} /></label><label>业务域<input value={domain} onChange={(event) => setDomain(event.target.value)} /></label><label>负责人<input value={owner} onChange={(event) => setOwner(event.target.value)} /></label><label>标签<input value={tagText} onChange={(event) => setTagText(event.target.value)} /></label><label className="wide">说明<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></label><button className="button" onClick={saveAnnotation} disabled={!canWrite || !!busy}><Save size={14} />保存新版本</button></div></details>
            </div>}
            {tab === "fields" && <div className="asset-fields-v2"><table><thead><tr><th>#</th><th>字段</th><th>类型</th><th>可空</th><th>基数</th></tr></thead><tbody>{detail.fields.map((field, index) => <tr key={field.name}><td>{index + 1}</td><td><code>{field.name}</code></td><td>{field.type}</td><td>{field.nullable ? "是" : "否"}</td><td>{field.distinctCount ?? "—"}</td></tr>)}</tbody></table></div>}
            {tab === "lineage" && <div className="asset-lineage-v2">
              <div className="lineage-boundary-v2"><ShieldCheck size={16} /><div><strong>当前是版本绑定血缘</strong><p>同步字段映射真实可追溯；Spark SQL字段级表达式解析尚未完成，页面不会冒充完整血缘。</p></div></div>
              <div className="lineage-edges-v2">{detail.lineage.edges.map((edge) => <article key={edge.id}><div><span>{kindLabels[nodeById.get(edge.from)?.kind ?? ""] ?? nodeById.get(edge.from)?.kind}</span><strong>{nodeById.get(edge.from)?.businessName ?? edge.from}</strong><code>{edge.from}</code></div><div className="lineage-arrow-v2"><span>{edge.type}</span><ArrowRight size={21} /><small>{edge.fieldMappings.length}字段映射</small></div><div><span>{kindLabels[nodeById.get(edge.to)?.kind ?? ""] ?? nodeById.get(edge.to)?.kind}</span><strong>{nodeById.get(edge.to)?.businessName ?? edge.to}</strong><code>{edge.to}</code></div></article>)}</div>
            </div>}
            {tab === "governance" && <div className="asset-governance-v2">
              {!detail.executableMetrics && <div className="lineage-boundary-v2"><AlertTriangle size={16} /><div><strong>该资产首版只读</strong><p>指标与标准执行目前只对有实际本机行数据的落地表和实时状态表开放。</p></div></div>}
              <div className="governance-columns-v2">
                <section><header><div><Gauge size={17} /><h4>指标定义</h4></div><span>{detail.metrics.length}</span></header>{detail.metrics.map((metric) => <article key={metric.id}><div><strong>{metric.name}</strong><code>{metric.aggregation}({metric.field ?? "*"}){metric.groupBy ? ` BY ${metric.groupBy}` : ""}</code><p>{metric.definition}</p></div><button className="button" onClick={() => runMetric(metric.id)} disabled={!canWrite || !!busy}><Play size={13} />执行</button>{metric.runs[0] && <div className="governance-result-v2"><CheckCircle2 size={13} />{metric.runs[0].values.map((value) => `${value.group}:${value.value}`).join(" · ")}</div>}</article>)}{detail.executableMetrics && <details><summary>新建指标</summary><div className="governance-form-v2"><label>名称<input value={metricName} onChange={(event) => setMetricName(event.target.value)} /></label><label>代码<input value={metricCode} onChange={(event) => setMetricCode(event.target.value)} /></label><label>聚合<select value={aggregation} onChange={(event) => setAggregation(event.target.value)}><option>SUM</option><option>COUNT_DISTINCT</option><option>COUNT_ROWS</option></select></label><label>字段<select value={metricField} onChange={(event) => setMetricField(event.target.value)}>{detail.fields.map((field) => <option key={field.name}>{field.name}</option>)}</select></label><label>分组<select value={groupBy} onChange={(event) => setGroupBy(event.target.value)}><option value="">不分组</option>{detail.fields.map((field) => <option key={field.name}>{field.name}</option>)}</select></label><label className="wide">口径<input value={metricDefinition} onChange={(event) => setMetricDefinition(event.target.value)} /></label><button className="button" onClick={createMetric} disabled={!canWrite || !!busy}><Sparkles size={13} />创建指标</button></div></details>}</section>
                <section><header><div><ShieldCheck size={17} /><h4>数据标准</h4></div><span>{detail.standards.length}</span></header>{detail.standards.map((standard) => <article key={standard.id}><div><strong>{standard.name}</strong><code>{standard.field} · {standard.semanticType}</code><p>{standard.description}</p></div><button className="button" onClick={() => checkStandard(standard.id)} disabled={!canWrite || !!busy}><Activity size={13} />检查</button>{standard.checks[0] && <div className={`governance-result-v2 ${standard.checks[0].status.toLowerCase()}`}>{standard.checks[0].status === "PASSED" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{standard.checks[0].passedCount}/{standard.checks[0].evaluatedCount}通过</div>}</article>)}{detail.executableMetrics && <details><summary>新建标准</summary><div className="governance-form-v2"><label>名称<input value={standardName} onChange={(event) => setStandardName(event.target.value)} /></label><label>代码<input value={standardCode} onChange={(event) => setStandardCode(event.target.value)} /></label><label>字段<select value={standardField} onChange={(event) => setStandardField(event.target.value)}>{detail.fields.map((field) => <option key={field.name}>{field.name}</option>)}</select></label><label>语义<select value={semanticType} onChange={(event) => setSemanticType(event.target.value)}><option>SECURITY_CODE</option><option>CLIENT_ID</option><option>DECIMAL_18_2</option><option>TRADE_DATE</option></select></label><label className="wide">说明<input value={standardDescription} onChange={(event) => setStandardDescription(event.target.value)} /></label><button className="button" onClick={createStandard} disabled={!canWrite || !!busy}><Network size={13} />创建标准</button></div></details>}</section>
              </div>
              <ContractsPanel api={api} canWrite={canWrite} asset={detail} />
            </div>}
          </> : <div className="ingestion-empty"><Database size={26} /><p>选择一个资产查看证据。</p></div>}
        </section>
      </div>
      <footer className="asset-boundary-v2"><GitBranch size={14} />目录、血缘与数据契约来自当前版本和实际检查证据；全部数据为虚构证券样例，未连接公司目录、真实用户或公网资产。</footer>
    </div>
  );
}
