import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  DatabaseZap,
  FileJson2,
  Gauge,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Waves,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type StreamRevision = {
  id: string;
  revisionNumber: number;
  fileName: string;
  lineCount: number;
  contentHash: string;
};
type StreamSource = {
  id: string;
  name: string;
  adapter: string;
  topic: string;
  status: string;
  currentRevisionId: string;
  currentRevision: StreamRevision;
  revisions: StreamRevision[];
};
type StreamRun = {
  id: string;
  status: string;
  sourceRevisionId: string;
  startOffset: number;
  lastOffset: number;
  failedOffset?: number;
  processedCount: number;
  duplicateCount: number;
  checkpointCount: number;
  recovery: boolean;
  lagMs?: number;
  throughputPerSecond?: number;
  durationMs?: number;
  error?: string;
  errorCode?: string;
};
type StreamState = {
  stateKey: string;
  security_code: string;
  price: string;
  volume: number;
  event_time: string;
  lastSequence: number;
};
type Checkpoint = {
  id: string;
  runId: string;
  lastOffset: number;
  eventCount: number;
  duplicateCount: number;
  watermark: string;
  stateHash: string;
};
type StreamAlert = {
  id: string;
  status: string;
  code: string;
  message: string;
  failedOffset: number;
  recoveryRunId?: string;
};
type StreamJob = {
  id: string;
  name: string;
  sourceId: string;
  sourceRevisionId: string;
  targetTable: string;
  adapter: string;
  status: string;
  checkpointEvery: number;
  maxOutOfOrderSeconds: number;
  processedEventCount?: number;
  duplicateCount?: number;
  checkpointCount?: number;
  watermark?: string;
  lagMs?: number;
  throughputPerSecond?: number;
  configHash: string;
  runs: StreamRun[];
  state: StreamState[];
  checkpoints: Checkpoint[];
  alerts: StreamAlert[];
};
type RealtimePlan = {
  id: string;
  status: string;
  message: string;
  explanation?: string;
  error?: string;
  streamJobId?: string;
  proposal?: {
    kind: string;
    name: string;
    sourceId: string;
    targetTable: string;
    checkpointEvery: number;
    maxOutOfOrderSeconds: number;
    configHash: string;
  };
};
type Monitor = {
  scope: string;
  adapter: string;
  kafkaConnected: boolean;
  flinkConnected: boolean;
  publicDeployed: boolean;
  counts: {
    jobs: number;
    running: number;
    caughtUp: number;
    failedRuns: number;
    openAlerts: number;
    resolvedAlerts: number;
  };
};

const labels: Record<string, string> = {
  READY: "待启动",
  RUNNING: "运行中",
  RECOVERING: "恢复中",
  CAUGHT_UP: "已追平",
  FAILED: "失败",
  STOPPED: "已停止",
  INTERRUPTED: "已中断",
  SUCCEEDED: "成功",
  QUEUED: "排队中",
  APPLIED: "草稿已创建",
  OPEN: "待处置",
  RESOLVED: "已恢复",
};
const isRunning = (status?: string) =>
  status === "RUNNING" || status === "RECOVERING";
const compact = (value?: number) =>
  value === undefined ? "—" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);

export function RealtimeWorkbench({
  api,
  canWrite,
}: {
  api: Api;
  canWrite: boolean;
}) {
  const [sources, setSources] = useState<StreamSource[]>([]),
    [jobs, setJobs] = useState<StreamJob[]>([]),
    [plans, setPlans] = useState<RealtimePlan[]>([]),
    [monitor, setMonitor] = useState<Monitor>();
  const [selectedJobId, setSelectedJobId] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [sourceName, setSourceName] = useState("虚构证券行情事件源"),
    [sourceFile, setSourceFile] = useState("quotes_fault.jsonl"),
    [jobName, setJobName] = useState("证券行情快照实时同步"),
    [targetTable, setTargetTable] = useState("realtime_quotes_review"),
    [checkpointEvery, setCheckpointEvery] = useState(2),
    [maxOutOfOrderSeconds, setMaxOutOfOrderSeconds] = useState(2);
  const [agentMessage, setAgentMessage] = useState(
      "基于当前虚构证券行情源，生成写入realtime_quotes_agent的实时同步草稿，每2条事件保存Checkpoint，允许2秒乱序",
    ),
    [agentPlan, setAgentPlan] = useState<RealtimePlan>();

  const selectedJob = jobs.find((job) => job.id === selectedJobId),
    selectedSource = sources.find((source) => source.id === selectedJob?.sourceId),
    latestRevision = selectedSource?.currentRevision,
    openAlerts = useMemo(
      () => jobs.flatMap((job) => job.alerts).filter((alert) => alert.status === "OPEN"),
      [jobs],
    );

  const reload = async () => {
    const [nextSources, nextJobs, nextPlans, nextMonitor] = await Promise.all([
      api<StreamSource[]>("/streams/sources"),
      api<StreamJob[]>("/streams/jobs"),
      api<RealtimePlan[]>("/streams/agent/plans"),
      api<Monitor>("/streams/monitor"),
    ]);
    setSources(nextSources);
    setJobs(nextJobs);
    setPlans(nextPlans);
    setMonitor(nextMonitor);
    if (!sourceId && nextSources[0]) setSourceId(nextSources[0].id);
    if (!selectedJobId && nextJobs[0]) setSelectedJobId(nextJobs[0].id);
    if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);
  };
  useEffect(() => {
    reload().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    const pending = jobs.some((job) => isRunning(job.status));
    if (!pending) return;
    const timer = setInterval(() => {
      reload().catch((cause) => setError((cause as Error).message));
    }, 600);
    return () => clearInterval(timer);
  }, [jobs.map((job) => `${job.id}:${job.status}`).join("|")]);
  useEffect(() => {
    if (!agentPlan || !["QUEUED", "RUNNING"].includes(agentPlan.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<RealtimePlan>(
          `/streams/agent/plans/${agentPlan.id}`,
        );
        setAgentPlan(current);
        if (!["QUEUED", "RUNNING"].includes(current.status)) await reload();
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [agentPlan?.id, agentPlan?.status]);

  const action = async (
    name: string,
    work: () => Promise<unknown>,
    message: string,
  ) => {
    setBusy(name);
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
  const createSource = () =>
    action(
      "source",
      async () => {
        const source = await api<StreamSource>("/streams/sources", {
          name: sourceName,
          adapter: "local-event-log-v1",
          topic: "market.quotes.demo",
          fileName: sourceFile,
        });
        setSourceId(source.id);
      },
      "事件日志源已登记为不可变版本",
    );
  const createJob = () =>
    action(
      "job",
      async () => {
        const job = await api<StreamJob>("/streams/jobs", {
          name: jobName,
          sourceId,
          targetTable,
          checkpointEvery,
          maxOutOfOrderSeconds,
        });
        setSelectedJobId(job.id);
      },
      "实时任务草稿已绑定当前源版本，尚未启动",
    );
  const start = () =>
    selectedJob &&
    action(
      "start",
      () => api(`/streams/jobs/${selectedJob.id}/start`, {}),
      "已提交后台逐事件处理，可离开页面",
    );
  const stop = () =>
    selectedJob &&
    action(
      "stop",
      () => api(`/streams/jobs/${selectedJob.id}/stop`, {}),
      "停止请求已提交，终止证据将被保留",
    );
  const createRecoveryRevision = () =>
    selectedSource &&
    action(
      "revision",
      () =>
        api(`/streams/sources/${selectedSource.id}/revisions`, {
          fileName: "quotes_recovered.jsonl",
        }),
      "修正日志已登记；Checkpoint之前的前缀仍需后端校验",
    );
  const recover = () =>
    selectedJob &&
    latestRevision &&
    action(
      "recover",
      () =>
        api(`/streams/jobs/${selectedJob.id}/recover`, {
          sourceRevisionId: latestRevision.id,
        }),
      "已从最近可信Checkpoint提交恢复",
    );
  const planWithAgent = () =>
    action(
      "agent",
      async () => {
        const plan = await api<RealtimePlan>("/streams/agent/plans", {
          message: agentMessage,
        });
        setAgentPlan(plan);
      },
      "Data Agent正在基于源摘要与事件契约生成方案",
    );
  const applyPlan = () =>
    agentPlan &&
    action(
      "apply-plan",
      async () => {
        const job = await api<StreamJob>(
          `/streams/agent/plans/${agentPlan.id}/apply`,
          {},
        );
        setSelectedJobId(job.id);
        setAgentPlan(
          await api<RealtimePlan>(`/streams/agent/plans/${agentPlan.id}`),
        );
      },
      "Agent方案已应用为READY草稿，仍未自动启动",
    );

  return (
    <div className="realtime-workbench">
      {(notice || error) && (
        <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>
          {error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          {error || notice}
        </div>
      )}
      <section className="stream-boundary-card">
        <div className="stream-live-mark"><Radio size={17} /><span>LOCAL EVENT LOG</span></div>
        <div><span className="eyebrow">REAL EXECUTION · EXPLICIT BOUNDARY</span><h3>真实处理事件，不伪装云流计算</h3><p>当前逐行消费版本化 JSONL，并真实保存幂等、状态、Watermark 与 Checkpoint；Kafka、Flink 和公网均未连接。</p></div>
        <div className="stream-adapters" aria-label="实时连接边界">
          <span className="connected"><i />事件日志 已连接</span>
          <span><i />Kafka 未连接</span>
          <span><i />Flink 未连接</span>
        </div>
      </section>

      <section className="stream-kpis">
        <div><Waves size={16} /><span>任务</span><strong>{monitor?.counts.jobs ?? jobs.length}</strong><small>{monitor?.counts.running ?? 0} 运行中</small></div>
        <div><Gauge size={16} /><span>已追平</span><strong>{monitor?.counts.caughtUp ?? 0}</strong><small>有限日志消费完毕</small></div>
        <div><AlertTriangle size={16} /><span>开放告警</span><strong>{monitor?.counts.openAlerts ?? openAlerts.length}</strong><small>{monitor?.counts.resolvedAlerts ?? 0} 已恢复</small></div>
        <div><ShieldCheck size={16} /><span>运行范围</span><strong>本机</strong><small>public=false</small></div>
      </section>

      <section className="stream-agent-card">
        <header><div className="stream-agent-icon"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · CONTRACT GROUNDED</span><h3>让 Agent 配置实时任务，由人确认是否启动</h3><p>只发送实时源摘要和固定事件契约；不发送事件行，不连接Kafka/Flink，不自动执行。</p></div></header>
        <div className="stream-agent-compose"><textarea aria-label="向Data Agent描述实时同步需求" rows={2} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={planWithAgent} disabled={!canWrite || !!busy || ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "")}>{busy === "agent" || ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "") ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}生成受治理方案</button></div>
        {agentPlan && <div className="stream-agent-result"><span className={`status-pill ${agentPlan.status.toLowerCase()}`}>{labels[agentPlan.status] ?? agentPlan.status}</span><div><strong>{agentPlan.proposal?.name ?? "正在读取源摘要"}</strong><p>{agentPlan.explanation ?? agentPlan.error ?? "生成中…"}</p>{agentPlan.proposal && <code>Checkpoint/{agentPlan.proposal.checkpointEvery} → {agentPlan.proposal.targetTable} · {agentPlan.proposal.configHash.slice(0, 12)}</code>}</div><button className="button" onClick={applyPlan} disabled={!canWrite || !!busy || agentPlan.status !== "SUCCEEDED"}><CheckCircle2 size={14} />确认创建草稿</button></div>}
        <small>{plans.length}条方案 · 方案应用后仍需显式启动</small>
      </section>

      <div className="stream-main-grid">
        <aside className="stream-job-list">
          <header><div><span className="eyebrow">STREAM JOBS</span><h3>实时任务</h3></div><span>{jobs.length}</span></header>
          {jobs.map((job) => <button key={job.id} className={job.id === selectedJobId ? "active" : ""} onClick={() => setSelectedJobId(job.id)}><Activity size={16} /><div><strong>{job.name}</strong><code>{job.targetTable} · CP/{job.checkpointEvery}</code></div><span className={`status-pill ${job.status.toLowerCase()}`}>{labels[job.status] ?? job.status}</span></button>)}
          {!jobs.length && <div className="ingestion-empty"><Waves size={25} /><p>创建第一个实时任务草稿。</p></div>}
        </aside>
        <section className="stream-job-detail">
          {selectedJob ? <>
            <header><div><span className="eyebrow">{selectedJob.adapter} · VERSION BOUND</span><h3>{selectedJob.name}</h3><p>{selectedSource?.topic} → {selectedJob.targetTable}</p></div><div className="stream-actions"><button className="button primary" onClick={start} disabled={!canWrite || !!busy || isRunning(selectedJob.status) || ["FAILED", "INTERRUPTED"].includes(selectedJob.status)}>{busy === "start" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}启动</button><button className="button" onClick={stop} disabled={!canWrite || !!busy || !isRunning(selectedJob.status)}><Square size={14} />停止</button></div></header>
            <div className="stream-proof-grid"><div><span>状态</span><strong>{labels[selectedJob.status] ?? selectedJob.status}</strong></div><div><span>唯一事件</span><strong>{compact(selectedJob.processedEventCount)}</strong></div><div><span>重复事件</span><strong>{compact(selectedJob.duplicateCount)}</strong></div><div><span>Checkpoint</span><strong>{selectedJob.checkpoints.length}</strong></div><div><span>延迟</span><strong>{compact(selectedJob.lagMs)} ms</strong></div><div><span>吞吐</span><strong>{compact(selectedJob.throughputPerSecond)}/s</strong></div></div>
            {["FAILED", "INTERRUPTED"].includes(selectedJob.status) && <div className="stream-recovery"><AlertTriangle size={18} /><div><strong>恢复必须保留Checkpoint前缀</strong><p>先登记修正事件日志，再由后端比较已处理前缀；不一致时拒绝跳过。</p></div><button className="button" onClick={createRecoveryRevision} disabled={!canWrite || !!busy || latestRevision?.fileName === "quotes_recovered.jsonl"}><RefreshCw size={14} />登记修正版本</button><button className="button primary" onClick={recover} disabled={!canWrite || !!busy || latestRevision?.fileName !== "quotes_recovered.jsonl"}><RotateCcw size={14} />从Checkpoint恢复</button></div>}
            <div className="stream-evidence-grid">
              <section><header><h4>最新证券状态</h4><span>{selectedJob.state.length}只</span></header><div className="stream-table-wrap"><table><thead><tr><th>证券</th><th>价格</th><th>成交量</th><th>序号</th></tr></thead><tbody>{selectedJob.state.map((row) => <tr key={row.stateKey}><td><code>{row.security_code}</code></td><td>{row.price}</td><td>{row.volume}</td><td>{row.lastSequence}</td></tr>)}</tbody></table></div></section>
              <section><header><h4>Checkpoint</h4><span>{selectedJob.checkpoints.length}个</span></header><div className="stream-checkpoints">{selectedJob.checkpoints.slice(0, 4).map((item) => <article key={item.id}><Clock3 size={14} /><div><strong>offset {item.lastOffset} · {item.eventCount}事件</strong><code>{item.stateHash.slice(0, 12)}</code></div></article>)}{!selectedJob.checkpoints.length && <p>启动后生成持久Checkpoint。</p>}</div></section>
            </div>
            <section className="stream-run-history"><header><h4>运行与故障证据</h4><span>{selectedJob.runs.length}次运行 · {selectedJob.alerts.length}条告警</span></header>{selectedJob.runs.map((run) => <article key={run.id}><span className={`status-pill ${run.status.toLowerCase()}`}>{labels[run.status] ?? run.status}</span><code>{run.id.slice(0, 8)}</code><div><strong>{run.recovery ? "断点恢复" : "初始消费"}</strong><span>offset {run.startOffset}→{run.lastOffset} · 新增{run.processedCount} · 重复{run.duplicateCount}</span></div><small>{run.error ? `${run.errorCode} · ${run.error}` : `${run.durationMs ?? 0}ms · ${compact(run.throughputPerSecond)}/s`}</small></article>)}</section>
          </> : <div className="ingestion-empty"><Activity size={26} /><p>创建或选择实时任务。</p></div>}
        </section>
      </div>

      <section className="stream-create-card">
        <header><div><span className="eyebrow">MANUAL CONTROL</span><h3>手动登记源与任务</h3></div><DatabaseZap size={20} /></header>
        <div className="stream-create-columns">
          <fieldset><legend><FileJson2 size={15} />1. 事件日志源</legend><label>名称<input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label><label>合成日志<select value={sourceFile} onChange={(event) => setSourceFile(event.target.value)}><option value="quotes_fault.jsonl">故障样例 · offset2负价格</option><option value="quotes_recovered.jsonl">修正样例 · 前缀兼容</option></select></label><button className="button" onClick={createSource} disabled={!canWrite || !!busy}>登记源版本</button></fieldset>
          <fieldset><legend><Waves size={15} />2. 实时任务草稿</legend><label>源<select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>{sources.map((source) => <option key={source.id} value={source.id}>{source.name} · V{source.currentRevision.revisionNumber}</option>)}</select></label><label>名称<input value={jobName} onChange={(event) => setJobName(event.target.value)} /></label><label>目标表<input value={targetTable} onChange={(event) => setTargetTable(event.target.value)} /></label><div><label>Checkpoint<input type="number" min={1} max={100} value={checkpointEvery} onChange={(event) => setCheckpointEvery(Number(event.target.value))} /></label><label>乱序秒数<input type="number" min={0} max={300} value={maxOutOfOrderSeconds} onChange={(event) => setMaxOutOfOrderSeconds(Number(event.target.value))} /></label></div><button className="button" onClick={createJob} disabled={!canWrite || !sourceId || !!busy}>创建版本化任务</button></fieldset>
        </div>
      </section>
    </div>
  );
}
