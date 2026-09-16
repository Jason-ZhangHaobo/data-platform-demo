import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCheck2,
  HeartPulse,
  LoaderCircle,
  Radar,
  RefreshCw,
  Send,
  ShieldAlert,
  Wrench,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type DomainCount = { failures: number; running: number; succeeded: number };
type Incident = {
  id: string;
  domain: string;
  title: string;
  status: string;
  severity: string;
  errorCode: string;
  message: string;
  sourceKind: string;
  sourceId: string;
  sourceCreatedAt: string;
  resourceType: string;
  resourceId: string;
  recoveryKind?: string;
  recoveryId?: string;
  resolutionMode?: string;
  resolvedAt?: string;
};
type Evidence = {
  id: string;
  status: string;
  createdAt: string;
  durationMs?: number;
  errorCode?: string;
  error?: string;
  actualExecution?: boolean;
};
type IncidentDetail = Incident & {
  sourceEvidence: Evidence;
  recoveryEvidence?: Evidence;
  acknowledgements: {
    id: string;
    type: string;
    actor: string;
    note: string;
    evidenceId?: string;
    observedAt: string;
  }[];
};
type ActivityItem = {
  id: string;
  kind: string;
  domain: string;
  status: string;
  createdAt: string;
  durationMs?: number;
  errorCode?: string;
};
type Overview = {
  scope: string;
  publicDeployed: boolean;
  fullLifecycleE2E: boolean;
  externalModelContextAllowed: boolean;
  health: string;
  counts: {
    incidents: number;
    open: number;
    acknowledged: number;
    resolved: number;
    activities: number;
  };
  domainCounts: Record<string, DomainCount>;
  incidents: Incident[];
  recentActivity: ActivityItem[];
};
type Diagnosis = {
  incidentId: string;
  diagnosis: string;
  recommendedActions: string[];
  evidenceIds: string[];
  confidence: number;
  executable: boolean;
  requiresHumanApproval: boolean;
};
type DiagnosisTask = {
  id: string;
  status: string;
  message: string;
  diagnosis?: Diagnosis;
  error?: string;
  model?: string;
  usage?: { total_tokens?: number };
};
type LifecycleReport = {
  evaluationRunId: string;
  frozenCaseCount: number;
  completedCaseCount: number;
  succeededCaseCount: number;
  failedCaseCount: number;
  localFullLifecycleRate: number;
  targetMet: boolean;
  totalScheduledBatches: number;
  fullLifecycleE2E: boolean;
  deploymentScope: string;
  publicDeployed: boolean;
  detourCounts: {
    blocked: number;
    cancelled: number;
    failed: number;
    rescued: number;
  };
};

const labels: Record<string, string> = {
  HEALTHY: "健康",
  DEGRADED: "降级",
  OBSERVING: "观察中",
  OPEN: "待处置",
  ACKNOWLEDGED: "已确认",
  RESOLVED: "已恢复",
  SUCCEEDED: "成功",
  PASSED: "通过",
  FAILED: "失败",
  VALIDATION_FAILED: "验证失败",
  RUNNING: "运行中",
  QUEUED: "排队中",
  SCHEDULED: "已计划",
};
const pending = (status?: string) =>
  status === "QUEUED" || status === "RUNNING";
const domainOrder = [
  "数据开发",
  "离线同步",
  "实时同步",
  "调度发布",
  "数据质量",
  "数据服务",
  "数据报表",
  "安全审计",
];

export function OperationsWorkbench({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const [overview, setOverview] = useState<Overview>(),
    [selectedIncidentId, setSelectedIncidentId] = useState(""),
    [detail, setDetail] = useState<IncidentDetail>(),
    [diagnoses, setDiagnoses] = useState<DiagnosisTask[]>([]),
    [diagnosisTask, setDiagnosisTask] = useState<DiagnosisTask>(),
    [lifecycle, setLifecycle] = useState<LifecycleReport>();
  const [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [message, setMessage] = useState("诊断当前事故，引用已有失败与恢复证据，给出不自动执行的处置建议"),
    [resolveKind, setResolveKind] = useState("offline_sync_run"),
    [resolveId, setResolveId] = useState(""),
    [resolveNote, setResolveNote] = useState("同一资源的新批次已验证成功");

  const incidents = overview?.incidents ?? [],
    selected = incidents.find((incident) => incident.id === selectedIncidentId),
    openDomains = useMemo(
      () =>
        domainOrder.filter(
          (domain) => (overview?.domainCounts[domain]?.failures ?? 0) > 0,
        ).length,
      [overview],
    );

  const reload = async () => {
    const [nextOverview, nextDiagnoses, nextLifecycle] = await Promise.all([
      api<Overview>("/operations/overview"),
      api<DiagnosisTask[]>("/operations/agent/diagnoses"),
      api<LifecycleReport>("/evaluations/full-lifecycle/latest").catch(
        () => undefined,
      ),
    ]);
    setOverview(nextOverview);
    setDiagnoses(nextDiagnoses);
    setLifecycle(nextLifecycle);
    const nextId =
      nextOverview.incidents.find((incident) => incident.id === selectedIncidentId)?.id ??
      nextOverview.incidents.find((incident) => incident.status !== "RESOLVED")?.id ??
      nextOverview.incidents[0]?.id;
    if (nextId && nextId !== selectedIncidentId) setSelectedIncidentId(nextId);
    if (!diagnosisTask && nextDiagnoses[0]) setDiagnosisTask(nextDiagnoses[0]);
  };
  useEffect(() => {
    reload().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (!selectedIncidentId) return;
    api<IncidentDetail>(`/operations/incidents/${selectedIncidentId}`)
      .then(setDetail)
      .catch((cause) => setError((cause as Error).message));
  }, [selectedIncidentId, overview?.counts.incidents]);
  useEffect(() => {
    if (!diagnosisTask || !pending(diagnosisTask.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<DiagnosisTask>(
          `/operations/agent/diagnoses/${diagnosisTask.id}`,
        );
        setDiagnosisTask(current);
        if (!pending(current.status)) setDiagnoses(await api<DiagnosisTask[]>("/operations/agent/diagnoses"));
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [diagnosisTask?.id, diagnosisTask?.status]);

  const action = async (
    key: string,
    work: () => Promise<unknown>,
    done: string,
  ) => {
    setBusy(key);
    setError("");
    try {
      await work();
      await reload();
      if (selectedIncidentId)
        setDetail(
          await api<IncidentDetail>(
            `/operations/incidents/${selectedIncidentId}`,
          ),
        );
      setNotice(done);
    } catch (cause) {
      setError((cause as Error).message);
      await reload().catch(() => undefined);
    } finally {
      setBusy("");
    }
  };
  const refresh = () =>
    action(
      "refresh",
      () => api("/operations/refresh", {}),
      "已扫描实际失败与恢复证据，事故按源运行幂等归一",
    );
  const acknowledge = () =>
    selected &&
    action(
      "ack",
      () =>
        api(`/operations/incidents/${selected.id}/acknowledge`, {
          actor: "local-operator",
          note: "已确认事故，正在核对同资源的新运行证据",
        }),
      "事故已确认；状态不是已解决",
    );
  const resolve = () =>
    selected &&
    action(
      "resolve",
      () =>
        api(`/operations/incidents/${selected.id}/resolve`, {
          actor: "local-operator",
          evidenceKind: resolveKind,
          evidenceId: resolveId,
          note: resolveNote,
        }),
      "同资源、晚于失败的成功证据已验证，事故已恢复",
    );
  const diagnose = () =>
    action(
      "diagnose",
      async () => {
        const task = await api<DiagnosisTask>(
          "/operations/agent/diagnoses",
          { message: `${message}。事故ID：${selectedIncidentId}` },
        );
        setDiagnosisTask(task);
      },
      "运维 Agent 正在读取事故与聚合证据",
    );

  return (
    <div className="ops-workbench-v2">
      <section className={`ops-hero-v2 ${(overview?.health ?? "HEALTHY").toLowerCase()}`}>
        <div><span className="eyebrow">PLATFORM OPERATIONS · M4G</span><h2>一张事故视图，串起失败与恢复</h2><p>归一开发、同步、发布、质量、服务和报表运行；每个结论都引用实际源运行或恢复运行。</p></div>
        <div className="ops-health-v2"><HeartPulse size={22} /><strong>{labels[overview?.health ?? "HEALTHY"]}</strong><span>{overview?.counts.open ?? 0}开放 · {overview?.counts.resolved ?? 0}已恢复</span><small>public=false</small></div>
      </section>
      {(notice || error) && <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>{error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</div>}

      <section className="ops-toolbar-v2"><div><Radar size={17} /><span>已覆盖 {domainOrder.length} 个运行域 · {overview?.counts.activities ?? 0} 条活动 · {openDomains} 个域有历史失败</span></div><button className="button" onClick={refresh} disabled={!canWrite || !!busy}>{busy === "refresh" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}扫描最新证据</button></section>

      {lifecycle && <section className="ops-e2e-v2"><div className="ops-e2e-score-v2"><span>LOCAL FULL E2E</span><strong>{lifecycle.succeededCaseCount}/{lifecycle.frozenCaseCount}</strong><small>{(lifecycle.localFullLifecycleRate * 100).toFixed(0)}% · 目标≥85%</small></div><div><span className="eyebrow">COMPLETE LIFECYCLE EVALUATION</span><h3>需求 → 代码调试 → 调度部署 → 审阅 → 上线 → 监控</h3><p>20条均绑定原真实Agent代码证据、当前Spark文件演练、四项审阅记录、摘要审批和两个墙上时钟Spark批次。</p><div className="ops-e2e-detours-v2"><span>{lifecycle.totalScheduledBatches}个上线批次</span><span>{lifecycle.detourCounts.blocked}次阻塞</span><span>{lifecycle.detourCounts.cancelled}次取消</span><span>{lifecycle.detourCounts.rescued}次救援</span></div></div><div className="ops-e2e-boundary-v2"><CheckCircle2 size={18} /><strong>{lifecycle.targetMet ? "本机门槛通过" : "门槛未通过"}</strong><span>{lifecycle.deploymentScope}</span><small>公网：未部署</small><code>{lifecycle.evaluationRunId.slice(0, 8)}</code></div></section>}

      <section className="ops-domains-v2">{domainOrder.map((domain) => { const count = overview?.domainCounts[domain] ?? { failures: 0, running: 0, succeeded: 0 }; return <article key={domain} className={count.failures ? "has-failure" : ""}><div><Activity size={15} /><strong>{domain}</strong></div><span>{count.succeeded}成功</span><span>{count.running}进行</span><span>{count.failures}失败</span></article>; })}</section>

      <section className="ops-agent-v2">
        <header><div className="ops-agent-icon-v2"><Bot size={20} /></div><div><span className="eyebrow">OPS AGENT · EVIDENCE GROUNDED</span><h3>诊断事故并给出建议，不替人执行处置</h3><p>模型只看事故、错误码与聚合计数；证据ID必须命中事故，建议固定不可执行。</p></div></header>
        <div className="ops-agent-compose-v2"><textarea aria-label="向运维Agent描述诊断需求" rows={2} value={message} onChange={(event) => setMessage(event.target.value)} /><button className="button primary" onClick={diagnose} disabled={!canWrite || !selectedIncidentId || !overview?.externalModelContextAllowed || !!busy || pending(diagnosisTask?.status)}>{busy === "diagnose" || pending(diagnosisTask?.status) ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}诊断当前事故</button></div>
        {!overview?.externalModelContextAllowed && <div className="ops-agent-privacy-v2"><ShieldAlert size={14} />运维摘要外发默认关闭；需你明确授权后才会调用外部模型。当前不会发送事故、错误码或运行状态。</div>}
        {diagnosisTask && <div className="ops-agent-result-v2"><span className={`status-pill ${diagnosisTask.status.toLowerCase()}`}>{labels[diagnosisTask.status] ?? diagnosisTask.status}</span><div><strong>{diagnosisTask.diagnosis?.diagnosis ?? diagnosisTask.error ?? "正在关联事故证据…"}</strong>{diagnosisTask.diagnosis && <ol>{diagnosisTask.diagnosis.recommendedActions.map((item) => <li key={item}>{item}</li>)}</ol>}<small>{diagnosisTask.diagnosis ? `置信度 ${(diagnosisTask.diagnosis.confidence * 100).toFixed(0)}% · 证据 ${diagnosisTask.diagnosis.evidenceIds.map((id) => id.slice(0, 8)).join("、")} · 不可执行` : ""}</small></div></div>}
        <small>{diagnoses.length}次受治理诊断 · 所有动作仍需人工审批和独立执行</small>
      </section>

      <div className="ops-main-v2">
        <aside className="ops-incident-list-v2"><header><div><span className="eyebrow">INCIDENTS</span><h3>事故队列</h3></div><span>{incidents.length}</span></header>{incidents.map((incident) => <button key={incident.id} className={incident.id === selectedIncidentId ? "active" : ""} onClick={() => setSelectedIncidentId(incident.id)}><ShieldAlert size={16} /><div><strong>{incident.title}</strong><code>{incident.errorCode} · {incident.sourceId.slice(0, 8)}</code></div><span className={`status-pill ${incident.status.toLowerCase()}`}>{labels[incident.status] ?? incident.status}</span><ChevronRight size={13} /></button>)}{!incidents.length && <div className="ingestion-empty"><CheckCircle2 size={25} /><p>尚未归一事故，扫描实际证据。</p></div>}</aside>
        <section className="ops-incident-detail-v2">{detail ? <><header><div><span className="eyebrow">{detail.domain} · {detail.severity}</span><h3>{detail.title}</h3><p>{detail.message}</p></div><span className={`status-pill ${detail.status.toLowerCase()}`}>{labels[detail.status]}</span></header><div className="ops-proof-v2"><div><span>源类型</span><code>{detail.sourceKind}</code></div><div><span>源运行</span><code>{detail.sourceId.slice(0, 8)}</code></div><div><span>资源</span><code>{detail.resourceId?.slice(0, 12)}</code></div><div><span>恢复模式</span><strong>{detail.resolutionMode ?? "待恢复"}</strong></div><div><span>业务行</span><strong>未保存</strong></div></div><div className="ops-timeline-v2"><article className="failed"><CircleDot size={16} /><div><span>失败证据</span><strong>{detail.sourceEvidence.status} · {detail.sourceEvidence.errorCode ?? detail.errorCode}</strong><code>{detail.sourceEvidence.id}</code></div></article>{detail.acknowledgements.map((event) => <article key={event.id}><Clock3 size={16} /><div><span>{event.type === "ACKNOWLEDGED" ? "人工确认" : "人工恢复"}</span><strong>{event.note}</strong><code>{event.actor} · {event.observedAt}</code></div></article>)}{detail.recoveryEvidence && <article className="recovered"><CheckCircle2 size={16} /><div><span>恢复证据</span><strong>{detail.recoveryEvidence.status} · {detail.resolutionMode}</strong><code>{detail.recoveryEvidence.id}</code></div></article>}</div>{detail.status === "OPEN" && <button className="button" onClick={acknowledge} disabled={!canWrite || !!busy}><FileCheck2 size={14} />确认事故</button>}{detail.status === "ACKNOWLEDGED" && <details className="ops-resolve-v2"><summary><Wrench size={14} />使用成功运行证据解除</summary><div><label>证据类型<select value={resolveKind} onChange={(event) => setResolveKind(event.target.value)}><option>offline_sync_run</option><option>stream_run</option><option>quality_run</option><option>release_run</option><option>data_service_test</option></select></label><label>证据ID<input value={resolveId} onChange={(event) => setResolveId(event.target.value)} /></label><label className="wide">说明<input value={resolveNote} onChange={(event) => setResolveNote(event.target.value)} /></label><button className="button primary" onClick={resolve} disabled={!canWrite || !resolveId || !!busy}>验证并解除</button></div></details>}</> : <div className="ingestion-empty"><Radar size={25} /><p>选择事故查看证据链。</p></div>}</section>
      </div>

      <section className="ops-activity-v2"><header><div><Activity size={17} /><h3>跨模块运行活动</h3></div><span>最近 {overview?.recentActivity.length ?? 0}</span></header><div>{overview?.recentActivity.slice(0, 18).map((item) => <article key={`${item.kind}:${item.id}`}><span className={`status-pill ${item.status.toLowerCase()}`}>{labels[item.status] ?? item.status}</span><strong>{item.domain}</strong><code>{item.kind} · {item.id.slice(0, 8)}</code><small>{item.durationMs === undefined ? "—" : `${item.durationMs}ms`}</small></article>)}</div></section>
      <footer className="ops-boundary-v2"><Radar size={14} />当前聚合本机持久化运行与事故证据；不是公网、多实例、云监控或完整成本中心，也不自动执行Agent建议。</footer>
    </div>
  );
}
