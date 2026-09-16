import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Gauge,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Asset = {
  id: string;
  businessName: string;
  name: string;
  rowCount?: number;
  fields: { name: string; type: string }[];
  executableMetrics: boolean;
};
type QualityRun = {
  id: string;
  status: string;
  ruleVersionId: string;
  evaluatedCount: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  durationMs: number;
};
type QualityAlert = {
  id: string;
  status: string;
  severity: string;
  message: string;
  runId: string;
  recoveryRunId?: string;
};
type RuleVersion = {
  id: string;
  versionNumber: number;
  field: string;
  type: string;
  config: Record<string, unknown>;
  description: string;
  configHash: string;
  status: string;
};
type Rule = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  status: string;
  health?: string;
  currentVersionId: string;
  currentVersion: RuleVersion;
  versions: RuleVersion[];
  runs: QualityRun[];
  alerts: QualityAlert[];
};
type Overview = {
  scope: string;
  publicDeployed: boolean;
  rules: Rule[];
  counts: {
    rules: number;
    healthy: number;
    failed: number;
    runs: number;
    openAlerts: number;
    resolvedAlerts: number;
  };
};
type AgentPlan = {
  id: string;
  status: string;
  explanation?: string;
  error?: string;
  ruleId?: string;
  model?: string;
  usage?: { total_tokens?: number };
  proposal?: {
    kind: string;
    name: string;
    code: string;
    assetId: string;
    field: string;
    type: string;
    config: Record<string, unknown>;
    description: string;
  };
};

const labels: Record<string, string> = {
  HEALTHY: "健康",
  FAILED: "异常",
  PASSED: "通过",
  ACTIVE: "生效中",
  RETIRED: "已退役",
  OPEN: "待恢复",
  RESOLVED: "已恢复",
  QUEUED: "排队中",
  RUNNING: "生成中",
  SUCCEEDED: "方案已验证",
  APPLIED: "规则草稿已创建",
};
const pending = (status?: string) =>
  status === "QUEUED" || status === "RUNNING";
const configText = (version?: RuleVersion) => {
  if (!version) return "—";
  if (version.type === "VALUE_RANGE")
    return `${version.config.min} ≤ ${version.field} ≤ ${version.config.max}`;
  if (version.type === "ALLOWED_VALUES")
    return `${version.field} ∈ ${(version.config.values as string[]).join("、")}`;
  if (version.type === "FRESHNESS_SECONDS")
    return `${version.field} ≤ ${version.config.maxAgeSeconds}s`;
  return `${version.field} · ${version.type}`;
};

export function QualityWorkbench({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const [overview, setOverview] = useState<Overview>(),
    [assets, setAssets] = useState<Asset[]>([]),
    [plans, setPlans] = useState<AgentPlan[]>([]),
    [selectedRuleId, setSelectedRuleId] = useState("");
  const [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [agentMessage, setAgentMessage] = useState(
      "为证券持仓明细的security_code生成非空质量规则草稿，只生成规则，不自动执行",
    ),
    [agentPlan, setAgentPlan] = useState<AgentPlan>();
  const [name, setName] = useState("持仓市值合理范围"),
    [code, setCode] = useState("holding_value_range_review"),
    [assetId, setAssetId] = useState("landing:raw_positions"),
    [field, setField] = useState("market_value"),
    [type, setType] = useState("VALUE_RANGE"),
    [min, setMin] = useState("0.00"),
    [max, setMax] = useState("5000.00"),
    [description, setDescription] = useState("受控阈值用于验证质量失败、告警与恢复");
  const [nextMin, setNextMin] = useState("0.00"),
    [nextMax, setNextMax] = useState("10000.00"),
    [nextDescription, setNextDescription] = useState("校准后允许当前虚构证券持仓范围");

  const rules = overview?.rules ?? [],
    selectedRule = rules.find((rule) => rule.id === selectedRuleId),
    selectedAsset = assets.find((asset) => asset.id === assetId),
    executableAssets = useMemo(
      () => assets.filter((asset) => asset.executableMetrics),
      [assets],
    );

  const reload = async () => {
    const [nextOverview, nextAssets, nextPlans] = await Promise.all([
      api<Overview>("/quality/overview"),
      api<Asset[]>("/assets"),
      api<AgentPlan[]>("/quality/agent/plans"),
    ]);
    setOverview(nextOverview);
    setAssets(nextAssets);
    setPlans(nextPlans);
    if (!selectedRuleId && nextOverview.rules[0])
      setSelectedRuleId(nextOverview.rules[0].id);
    if (!assetId && nextAssets.find((asset) => asset.executableMetrics))
      setAssetId(nextAssets.find((asset) => asset.executableMetrics)!.id);
    if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);
  };
  useEffect(() => {
    reload().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (!selectedAsset) return;
    const names = new Set(selectedAsset.fields.map((item) => item.name));
    if (!names.has(field)) setField(selectedAsset.fields[0]?.name ?? "");
  }, [assetId, assets.length]);
  useEffect(() => {
    if (!agentPlan || !pending(agentPlan.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<AgentPlan>(
          `/quality/agent/plans/${agentPlan.id}`,
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
  const ruleConfig = () => {
    if (type === "VALUE_RANGE") return { min, max };
    if (type === "ALLOWED_VALUES") return { values: ["股票", "债券", "基金"] };
    if (type === "FRESHNESS_SECONDS") return { maxAgeSeconds: 300 };
    return {};
  };
  const createRule = () =>
    action(
      "create",
      async () => {
        const rule = await api<Rule>("/quality/rules", {
          name,
          code,
          assetId,
          field,
          type,
          config: ruleConfig(),
          description,
        });
        setSelectedRuleId(rule.id);
      },
      "质量规则已绑定资产与当前配置版本，尚未运行",
    );
  const runRule = () =>
    selectedRule &&
    action(
      "run",
      () => api(`/quality/rules/${selectedRule.id}/run`, {}),
      "规则已在实际资产行上执行，结果和告警已保存",
    );
  const createVersion = () =>
    selectedRule &&
    action(
      "version",
      () =>
        api(`/quality/rules/${selectedRule.id}/versions`, {
          type: selectedRule.currentVersion.type,
          config: { min: nextMin, max: nextMax },
          description: nextDescription,
        }),
      "质量规则新版本已生效，旧版本和失败记录仍保留",
    );
  const generatePlan = () =>
    action(
      "agent",
      async () => {
        const plan = await api<AgentPlan>("/quality/agent/plans", {
          message: agentMessage,
        });
        setAgentPlan(plan);
      },
      "Data Agent正在读取字段元数据和聚合质量结果",
    );
  const applyPlan = () =>
    agentPlan &&
    action(
      "apply-plan",
      async () => {
        const rule = await api<Rule>(
          `/quality/agent/plans/${agentPlan.id}/apply`,
          {},
        );
        setSelectedRuleId(rule.id);
        setAgentPlan(
          await api<AgentPlan>(`/quality/agent/plans/${agentPlan.id}`),
        );
      },
      "Agent方案已创建为规则草稿，运行数仍为0",
    );

  return (
    <div className="quality-workbench-v2">
      <section className="quality-hero-v2">
        <div><span className="eyebrow">DATA QUALITY · M4D</span><h2>让失败可重现，让修复有证据</h2><p>每次检测绑定资产摘要和规则版本；失败产生告警，校准新版本后重新检测并关联恢复。</p></div>
        <div className="quality-kpis-v2"><div><ShieldCheck size={15} /><strong>{overview?.counts.healthy ?? 0}</strong><span>健康规则</span></div><div><ShieldAlert size={15} /><strong>{overview?.counts.failed ?? 0}</strong><span>异常规则</span></div><div><Activity size={15} /><strong>{overview?.counts.runs ?? 0}</strong><span>实际运行</span></div><div><AlertTriangle size={15} /><strong>{overview?.counts.openAlerts ?? 0}</strong><span>开放告警</span></div></div>
      </section>
      {(notice || error) && <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>{error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</div>}

      <section className="quality-agent-v2">
        <header><div className="quality-agent-icon-v2"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · METADATA + AGGREGATED EVIDENCE</span><h3>让 Agent 建议规则，人决定是否创建与运行</h3><p>模型只看字段元数据和失败计数，不接收业务行、无效样本或客户标识。</p></div></header>
        <div className="quality-agent-compose-v2"><textarea aria-label="向Data Agent描述质量需求" rows={2} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={generatePlan} disabled={!canWrite || !!busy || pending(agentPlan?.status)}>{busy === "agent" || pending(agentPlan?.status) ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}生成规则方案</button></div>
        {agentPlan && <div className="quality-agent-result-v2"><span className={`status-pill ${agentPlan.status.toLowerCase()}`}>{labels[agentPlan.status] ?? agentPlan.status}</span><div><strong>{agentPlan.proposal?.name ?? "正在分析字段与质量摘要"}</strong><p>{agentPlan.explanation ?? agentPlan.error ?? "生成中…"}</p>{agentPlan.proposal && <code>{agentPlan.proposal.type} · {agentPlan.proposal.assetId}.{agentPlan.proposal.field}</code>}</div><button className="button" onClick={applyPlan} disabled={!canWrite || !!busy || agentPlan.status !== "SUCCEEDED"}><CheckCircle2 size={14} />确认创建规则</button></div>}
        <small>{plans.length}条Agent方案 · 创建后不自动运行或解除告警</small>
      </section>

      <div className="quality-main-v2">
        <aside className="quality-rule-list-v2">
          <header><div><span className="eyebrow">RULES</span><h3>质量规则</h3></div><span>{rules.length}</span></header>
          {rules.map((rule) => <button key={rule.id} className={rule.id === selectedRuleId ? "active" : ""} onClick={() => setSelectedRuleId(rule.id)}><Gauge size={16} /><div><strong>{rule.name}</strong><code>{rule.currentVersion.type} · {rule.currentVersion.field}</code></div><span className={`status-pill ${(rule.health ?? rule.status).toLowerCase()}`}>{labels[rule.health ?? rule.status] ?? rule.health ?? rule.status}</span><ChevronRight size={13} /></button>)}
          {!rules.length && <div className="ingestion-empty"><Gauge size={25} /><p>创建第一条实际质量规则。</p></div>}
        </aside>
        <section className="quality-detail-v2">
          {selectedRule ? <>
            <header><div><span className="eyebrow">{selectedRule.code} · V{selectedRule.currentVersion.versionNumber}</span><h3>{selectedRule.name}</h3><p>{selectedRule.assetId}</p></div><button className="button primary" onClick={runRule} disabled={!canWrite || !!busy}>{busy === "run" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}实际检测</button></header>
            <div className="quality-proof-v2"><div><span>健康度</span><strong>{labels[selectedRule.health ?? selectedRule.status] ?? selectedRule.health ?? selectedRule.status}</strong></div><div><span>规则表达</span><strong>{configText(selectedRule.currentVersion)}</strong></div><div><span>版本</span><strong>{selectedRule.versions.length}</strong></div><div><span>检测</span><strong>{selectedRule.runs.length}</strong></div><div><span>开放告警</span><strong>{selectedRule.alerts.filter((item) => item.status === "OPEN").length}</strong></div></div>
            {selectedRule.alerts[0] && <div className={`quality-alert-v2 ${selectedRule.alerts[0].status.toLowerCase()}`}>{selectedRule.alerts[0].status === "OPEN" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}<div><strong>{selectedRule.alerts[0].message}</strong><p>{selectedRule.alerts[0].status === "OPEN" ? `失败批次 ${selectedRule.alerts[0].runId.slice(0, 8)}` : `恢复批次 ${selectedRule.alerts[0].recoveryRunId?.slice(0, 8)}`}</p></div><span>{labels[selectedRule.alerts[0].status]}</span></div>}
            <div className="quality-evidence-v2">
              <section><header><div><History size={15} /><h4>运行历史</h4></div><span>{selectedRule.runs.length}</span></header>{selectedRule.runs.map((run) => <article key={run.id}><span className={`status-pill ${run.status.toLowerCase()}`}>{labels[run.status] ?? run.status}</span><code>{run.id.slice(0, 8)}</code><div><strong>{run.passedCount}/{run.evaluatedCount}通过</strong><p>失败{run.failedCount} · {(run.passRate * 100).toFixed(1)}% · {run.durationMs}ms</p></div></article>)}</section>
              <section><header><div><RefreshCw size={15} /><h4>版本历史</h4></div><span>{selectedRule.versions.length}</span></header>{selectedRule.versions.map((version) => <article key={version.id}><span className={`status-pill ${version.status.toLowerCase()}`}>V{version.versionNumber}</span><div><strong>{configText(version)}</strong><p>{version.description}</p><code>{version.configHash.slice(0, 12)}</code></div></article>)}</section>
            </div>
            {selectedRule.currentVersion.type === "VALUE_RANGE" && <details className="quality-version-form-v2" open={selectedRule.health === "FAILED"}><summary><SlidersHorizontal size={14} />校准为新版本</summary><div><label>最小值<input value={nextMin} onChange={(event) => setNextMin(event.target.value)} /></label><label>最大值<input value={nextMax} onChange={(event) => setNextMax(event.target.value)} /></label><label className="wide">版本说明<input value={nextDescription} onChange={(event) => setNextDescription(event.target.value)} /></label><button className="button" onClick={createVersion} disabled={!canWrite || !!busy}><RefreshCw size={14} />创建V{selectedRule.currentVersion.versionNumber + 1}</button></div></details>}
          </> : <div className="ingestion-empty"><Gauge size={26} /><p>创建或选择质量规则。</p></div>}
        </section>
      </div>

      <section className="quality-create-v2">
        <header><div><span className="eyebrow">MANUAL RULE</span><h3>手动创建规则</h3></div><SlidersHorizontal size={19} /></header>
        <div><label>规则名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>规则代码<input value={code} onChange={(event) => setCode(event.target.value)} /></label><label>实际资产<select value={assetId} onChange={(event) => setAssetId(event.target.value)}>{executableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.businessName} · {asset.rowCount ?? 0}行</option>)}</select></label><label>字段<select value={field} onChange={(event) => setField(event.target.value)}>{selectedAsset?.fields.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><label>规则类型<select value={type} onChange={(event) => setType(event.target.value)}><option>VALUE_RANGE</option><option>NOT_NULL</option><option>UNIQUE</option><option>ALLOWED_VALUES</option><option>FRESHNESS_SECONDS</option></select></label>{type === "VALUE_RANGE" && <><label>最小值<input value={min} onChange={(event) => setMin(event.target.value)} /></label><label>最大值<input value={max} onChange={(event) => setMax(event.target.value)} /></label></>}<label className="wide">规则说明<input value={description} onChange={(event) => setDescription(event.target.value)} /></label></div>
        <footer><span>创建只保存规则V1；必须显式点击“实际检测”才会读取资产行。</span><button className="button" onClick={createRule} disabled={!canWrite || !assetId || !field || !!busy}><ShieldCheck size={14} />创建规则草稿</button></footer>
      </section>
      <footer className="quality-boundary-v2"><ShieldAlert size={14} />当前只检测本机合成落地/实时状态行；不是公司生产质量中心，未连接公网告警渠道。</footer>
    </div>
  );
}
