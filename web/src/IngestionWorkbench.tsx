import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  FileSpreadsheet,
  GitBranch,
  LoaderCircle,
  Network,
  Play,
  Radio,
  RefreshCw,
  ScanSearch,
  Send,
  Table2,
} from "lucide-react";
import { RealtimeWorkbench } from "./RealtimeWorkbench";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Column = {
  name: string;
  ordinal: number;
  type: string;
  nullable: boolean;
  distinctCount: number;
};
type Metadata = {
  id: string;
  revisionId: string;
  status: string;
  classification: string;
  rowCount: number;
  bytes: number;
  contentHash: string;
  schemaHash: string;
  columns: Column[];
  change: {
    changed: boolean;
    added: string[];
    removed: string[];
    typeChanged: { name: string; from: string; to: string }[];
  };
};
type Source = {
  id: string;
  name: string;
  sourceType: string;
  status: string;
  currentRevisionId: string;
  currentMetadataId?: string;
  currentRevision: {
    id: string;
    revisionNumber: number;
    fileName: string;
  };
  revisions: { id: string; revisionNumber: number; fileName: string }[];
  metadataVersions: Metadata[];
  tests: { id: string; status: string; rowCount?: number; durationMs: number }[];
};
type SyncRun = {
  id: string;
  status: string;
  readCount?: number;
  inserted?: number;
  updated?: number;
  unchanged?: number;
  finalCount?: number;
  targetHash?: string;
  watermark?: string;
  durationMs: number;
  error?: string;
  actualExecution: boolean;
};
type SyncTask = {
  id: string;
  name: string;
  sourceId: string;
  sourceRevisionId: string;
  metadataVersionId: string;
  targetTable: string;
  mode: string;
  status: string;
  keyFields: string[];
  watermarkField?: string;
  configHash: string;
  runs: SyncRun[];
};
type AgentPlan = {
  id: string;
  message: string;
  status: string;
  proposal?: {
    kind: string;
    name: string;
    sourceId: string;
    sourceRevisionId: string;
    metadataVersionId: string;
    targetTable: string;
    mode: string;
    keyFields: string[];
    watermarkField?: string;
    configHash: string;
  };
  explanation?: string;
  error?: string;
  syncTaskId?: string;
};

const fixtureFiles = [
  ["positions_baseline.csv", "持仓全量 · 4行/7字段"],
  ["positions_incremental.csv", "持仓增量 · 2行/7字段"],
  ["positions_schema_change.csv", "结构变化 · 新增currency"],
] as const;
const statusLabels: Record<string, string> = {
  NOT_TESTED: "待测试",
  CONNECTED: "已连接",
  READY: "已就绪",
  SCHEMA_CHANGED: "结构变化",
  RUNNING: "运行中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  QUEUED: "排队中",
  APPLIED: "草稿已创建",
};
const identityMapping = (metadata?: Metadata) =>
  Object.fromEntries((metadata?.columns ?? []).map((column) => [column.name, column.name]));

export function IngestionWorkbench({
  api,
  activeModule,
  canWrite,
  onModuleChange,
}: {
  api: Api;
  activeModule: "sources" | "sync";
  canWrite: boolean;
  onModuleChange: (module: "sources" | "sync") => void;
}) {
  const [syncView, setSyncView] = useState<"offline" | "realtime">("offline");
  const [sources, setSources] = useState<Source[]>([]),
    [tasks, setTasks] = useState<SyncTask[]>([]),
    [plans, setPlans] = useState<AgentPlan[]>([]),
    [targetRows, setTargetRows] = useState<Record<string, unknown>[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState(""),
    [selectedTaskId, setSelectedTaskId] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [sourceName, setSourceName] = useState("证券持仓演示源"),
    [sourceFile, setSourceFile] = useState("positions_baseline.csv"),
    [revisionFile, setRevisionFile] = useState("positions_schema_change.csv");
  const [taskName, setTaskName] = useState("证券持仓全量落地"),
    [taskMode, setTaskMode] = useState("FULL"),
    [taskSourceId, setTaskSourceId] = useState(""),
    [targetTable, setTargetTable] = useState("raw_positions_review");
  const [agentMessage, setAgentMessage] = useState(
      "基于证券持仓增量CSV，生成写入raw_positions的增量合并任务，position_id为主键，trade_date为水位",
    ),
    [agentPlan, setAgentPlan] = useState<AgentPlan>();

  const selectedSource = sources.find((item) => item.id === selectedSourceId),
    selectedMetadata = selectedSource?.metadataVersions.find(
      (item) => item.id === selectedSource.currentMetadataId,
    ),
    selectedTask = tasks.find((item) => item.id === selectedTaskId),
    selectedTaskSource = sources.find((item) => item.id === selectedTask?.sourceId),
    sourceForTask = sources.find((item) => item.id === taskSourceId),
    metadataForTask = sourceForTask?.metadataVersions.find(
      (item) => item.id === sourceForTask.currentMetadataId,
    ),
    successfulRuns = useMemo(
      () => tasks.flatMap((task) => task.runs).filter((run) => run.status === "SUCCEEDED"),
      [tasks],
    );

  const reload = async () => {
    const [nextSources, nextTasks, nextPlans, nextRows] = await Promise.all([
      api<Source[]>("/sources"),
      api<SyncTask[]>("/sync/tasks"),
      api<AgentPlan[]>("/sync/agent/plans"),
      api<Record<string, unknown>[]>("/sync/targets/raw_positions/rows").catch(
        () => [],
      ),
    ]);
    setSources(nextSources);
    setTasks(nextTasks);
    setPlans(nextPlans);
    setTargetRows(nextRows);
    if (!selectedSourceId && nextSources[0]) setSelectedSourceId(nextSources[0].id);
    if (!taskSourceId && nextSources[0]) setTaskSourceId(nextSources[0].id);
    if (!selectedTaskId && nextTasks[0]) setSelectedTaskId(nextTasks[0].id);
    if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);
  };
  useEffect(() => {
    reload().catch((cause) => setError(cause.message));
  }, []);
  useEffect(() => {
    if (!agentPlan || !["QUEUED", "RUNNING"].includes(agentPlan.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<AgentPlan>(
          `/sync/agent/plans/${agentPlan.id}`,
        );
        setAgentPlan(current);
        if (!["QUEUED", "RUNNING"].includes(current.status))
          setPlans(await api<AgentPlan[]>("/sync/agent/plans"));
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [agentPlan?.id, agentPlan?.status]);

  const action = async (name: string, work: () => Promise<unknown>, message: string) => {
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
      "create-source",
      async () => {
        const source = await api<Source>("/sources", {
          name: sourceName,
          sourceType: "LOCAL_CSV",
          fileName: sourceFile,
        });
        setSelectedSourceId(source.id);
      },
      "数据源版本已登记，请执行真实连接测试",
    );
  const testSource = () =>
    selectedSource &&
    action(
      "test-source",
      () => api(`/sources/${selectedSource.id}/test`, {}),
      "CSV已真实读取，连接摘要已保存",
    );
  const collectMetadata = () =>
    selectedSource &&
    action(
      "metadata",
      () => api(`/sources/${selectedSource.id}/metadata`, {}),
      "字段类型、基数和结构摘要已实际扫描",
    );
  const createRevision = () =>
    selectedSource &&
    action(
      "revision",
      () =>
        api(`/sources/${selectedSource.id}/revisions`, {
          fileName: revisionFile,
        }),
      "新源版本已建立；旧测试和元数据不会自动复用",
    );
  const createTask = () =>
    action(
      "create-task",
      async () => {
        const task = await api<SyncTask>("/sync/tasks", {
          name: taskName,
          sourceId: taskSourceId,
          targetTable,
          mode: taskMode,
          mapping: identityMapping(metadataForTask),
          keyFields: ["position_id"],
          watermarkField: metadataForTask?.columns.some(
            (column) => column.name === "trade_date",
          )
            ? "trade_date"
            : undefined,
        });
        setSelectedTaskId(task.id);
      },
      "同步任务已绑定当前源与元数据版本",
    );
  const runTask = () =>
    selectedTask &&
    action(
      "run-task",
      () => api(`/sync/tasks/${selectedTask.id}/run`, {}),
      "同步已实际执行，读写计数与目标摘要已保存",
    );
  const planWithAgent = () =>
    action(
      "agent",
      async () => {
        const plan = await api<AgentPlan>("/sync/agent/plans", {
          message: agentMessage,
        });
        setAgentPlan(plan);
      },
      "Data Agent正在读取当前元数据版本",
    );
  const applyPlan = () =>
    agentPlan &&
    action(
      "apply-plan",
      async () => {
        const task = await api<SyncTask>(
          `/sync/agent/plans/${agentPlan.id}/apply`,
          {},
        );
        setSelectedTaskId(task.id);
        setAgentPlan(
          await api<AgentPlan>(`/sync/agent/plans/${agentPlan.id}`),
        );
      },
      "受治理方案已应用为READY草稿，尚未自动运行",
    );

  return (
    <div className="ingestion-workbench">
      <section className="ingestion-hero">
        <div>
          <span className="eyebrow">{activeModule === "sync" && syncView === "realtime" ? "STREAMING CONTROL PLANE · M4B" : "INGESTION CONTROL PLANE · M4A"}</span>
          <h2>{activeModule === "sync" && syncView === "realtime" ? "从事件契约到可恢复实时处理" : "从真实连接证据到可追溯同步"}</h2>
          <p>{activeModule === "sync" && syncView === "realtime" ? "实时源版本、任务配置、运行、Checkpoint、状态与告警逐层绑定；当前只处理仓库内虚构证券事件日志。" : "源版本、元数据、字段映射、运行和落地结果逐层绑定；当前只读取仓库内虚构证券CSV。"}</p>
        </div>
        <div className="ingestion-stats">
          {activeModule === "sync" && syncView === "realtime" ? <>
            <div><strong>JSONL</strong><span>当前适配器</span></div>
            <div><strong>CP</strong><span>断点恢复</span></div>
            <div><strong>WM</strong><span>Watermark</span></div>
            <div><strong>0</strong><span>云连接</span></div>
          </> : <>
            <div><strong>{sources.length}</strong><span>数据源</span></div>
            <div><strong>{tasks.length}</strong><span>同步任务</span></div>
            <div><strong>{successfulRuns.length}</strong><span>成功运行</span></div>
            <div><strong>{targetRows.length}</strong><span>落地行</span></div>
          </>}
        </div>
      </section>
      <div className="ingestion-tabs" role="tablist" aria-label="接入与同步">
        <button
          role="tab"
          aria-selected={activeModule === "sources"}
          className={activeModule === "sources" ? "active" : ""}
          onClick={() => onModuleChange("sources")}
        >
          <Database size={16} />数据源与元数据
        </button>
        <button
          role="tab"
          aria-selected={activeModule === "sync" && syncView === "offline"}
          className={activeModule === "sync" && syncView === "offline" ? "active" : ""}
          onClick={() => {
            setSyncView("offline");
            onModuleChange("sync");
          }}
        >
          <GitBranch size={16} />离线同步
        </button>
        <button
          role="tab"
          aria-selected={activeModule === "sync" && syncView === "realtime"}
          className={activeModule === "sync" && syncView === "realtime" ? "active" : ""}
          onClick={() => {
            setSyncView("realtime");
            onModuleChange("sync");
          }}
        >
          <Radio size={16} />实时同步
        </button>
      </div>
      {(notice || error) && (
        <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>
          {error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          {error || notice}
        </div>
      )}

      {activeModule === "sources" ? (
        <>
          <div className="source-layout">
            <aside className="source-list">
              <header><div><span className="eyebrow">SOURCE REGISTRY</span><h3>数据源目录</h3></div><span>{sources.length}</span></header>
              {sources.map((source) => (
                <button className={source.id === selectedSourceId ? "active" : ""} key={source.id} onClick={() => setSelectedSourceId(source.id)}>
                  <FileSpreadsheet size={17} />
                  <div><strong>{source.name}</strong><code>{source.currentRevision.fileName}</code></div>
                  <span className={"status-pill " + source.status.toLowerCase()}>{statusLabels[source.status] ?? source.status}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
              {!sources.length && <div className="ingestion-empty"><Database size={25} /><p>登记第一个合成CSV数据源。</p></div>}
            </aside>
            <section className="source-detail">
              {selectedSource ? (
                <>
                  <header className="source-detail-head">
                    <div><span className="eyebrow">{selectedSource.sourceType} · REVISION {selectedSource.currentRevision.revisionNumber}</span><h3>{selectedSource.name}</h3><code>{selectedSource.currentRevision.fileName}</code></div>
                    <span className={"status-pill " + selectedSource.status.toLowerCase()}>{statusLabels[selectedSource.status] ?? selectedSource.status}</span>
                  </header>
                  <div className="source-actions">
                    <button className="button" onClick={testSource} disabled={!canWrite || !!busy}>{busy === "test-source" ? <LoaderCircle className="spin" size={15} /> : <Network size={15} />}真实连接测试</button>
                    <button className="button primary" onClick={collectMetadata} disabled={!canWrite || selectedSource.status === "NOT_TESTED" || !!busy}>{busy === "metadata" ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}采集元数据</button>
                  </div>
                  {selectedMetadata ? (
                    <>
                      <div className="metadata-proof">
                        <div><span>实际行数</span><strong>{selectedMetadata.rowCount}</strong></div>
                        <div><span>字段数</span><strong>{selectedMetadata.columns.length}</strong></div>
                        <div><span>内容摘要</span><code>{selectedMetadata.contentHash.slice(0, 12)}</code></div>
                        <div><span>结构摘要</span><code>{selectedMetadata.schemaHash.slice(0, 12)}</code></div>
                      </div>
                      {selectedMetadata.change.changed && (
                        <div className="schema-change"><AlertTriangle size={16} /><div><strong>检测到结构变化</strong><p>新增：{selectedMetadata.change.added.join("、") || "无"} · 删除：{selectedMetadata.change.removed.join("、") || "无"}</p></div></div>
                      )}
                      <div className="metadata-table-wrap">
                        <table><thead><tr><th>#</th><th>字段</th><th>类型</th><th>可空</th><th>基数</th></tr></thead><tbody>
                          {selectedMetadata.columns.map((column) => <tr key={column.name}><td>{column.ordinal + 1}</td><td><code>{column.name}</code></td><td>{column.type}</td><td>{column.nullable ? "是" : "否"}</td><td>{column.distinctCount}</td></tr>)}
                        </tbody></table>
                      </div>
                    </>
                  ) : <div className="ingestion-empty"><ScanSearch size={26} /><p>连接测试后采集实际字段元数据。</p></div>}
                  <div className="source-revision-bar">
                    <label>新数据源版本<select value={revisionFile} onChange={(event) => setRevisionFile(event.target.value)}>{fixtureFiles.map(([file, label]) => <option value={file} key={file}>{label}</option>)}</select></label>
                    <button className="button" onClick={createRevision} disabled={!canWrite || revisionFile === selectedSource.currentRevision.fileName || !!busy}><RefreshCw size={14} />创建新版本</button>
                    <small>{selectedSource.revisions.length}个不可变版本</small>
                  </div>
                </>
              ) : (
                <section className="source-create">
                  <header><Database size={22} /><div><span className="eyebrow">NEW SOURCE</span><h3>登记合成CSV数据源</h3></div></header>
                  <label>数据源名称<input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label>
                  <label>仓库内文件<select value={sourceFile} onChange={(event) => setSourceFile(event.target.value)}>{fixtureFiles.map(([file, label]) => <option value={file} key={file}>{label}</option>)}</select></label>
                  <button className="button primary" onClick={createSource} disabled={!canWrite || !!busy}><Database size={15} />登记数据源</button>
                  <small>不接受本机任意路径、上传文件或凭证。</small>
                </section>
              )}
            </section>
          </div>
          <details className="source-add-more">
            <summary>登记另一个合成CSV数据源</summary>
            <div><label>名称<input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label><label>文件<select value={sourceFile} onChange={(event) => setSourceFile(event.target.value)}>{fixtureFiles.map(([file, label]) => <option value={file} key={file}>{label}</option>)}</select></label><button className="button" onClick={createSource} disabled={!canWrite || !!busy}>登记</button></div>
          </details>
        </>
      ) : syncView === "realtime" ? (
        <RealtimeWorkbench api={api} canWrite={canWrite} />
      ) : (
        <>
          <section className="ingestion-agent">
            <header><div className="ingestion-agent-icon"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · METADATA GROUNDED</span><h3>从实际元数据生成同步草稿</h3><p>模型看字段和版本，不读取CSV行；后端复核后仍不会自动运行。</p></div></header>
            <div className="ingestion-agent-compose"><textarea aria-label="向Data Agent描述同步需求" rows={2} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={planWithAgent} disabled={!canWrite || !!busy || ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "")}>
              {busy === "agent" || ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "") ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}生成方案
            </button></div>
            {agentPlan && <div className="ingestion-agent-plan"><span className={"status-pill " + agentPlan.status.toLowerCase()}>{statusLabels[agentPlan.status] ?? agentPlan.status}</span><div><strong>{agentPlan.proposal?.name ?? "正在读取元数据"}</strong><p>{agentPlan.explanation ?? agentPlan.error ?? "生成中…"}</p>{agentPlan.proposal && <code>{agentPlan.proposal.mode} → {agentPlan.proposal.targetTable} · {agentPlan.proposal.configHash.slice(0, 12)}</code>}</div><button className="button" onClick={applyPlan} disabled={!canWrite || agentPlan.status !== "SUCCEEDED" || !!busy}><CheckCircle2 size={14} />确认创建草稿</button></div>}
            <small>{plans.length}条Agent方案 · 不自动运行</small>
          </section>
          <div className="sync-layout">
            <aside className="sync-task-list">
              <header><div><span className="eyebrow">OFFLINE JOBS</span><h3>同步任务</h3></div><span>{tasks.length}</span></header>
              {tasks.map((task) => <button className={task.id === selectedTaskId ? "active" : ""} key={task.id} onClick={() => setSelectedTaskId(task.id)}><GitBranch size={16} /><div><strong>{task.name}</strong><code>{task.mode} → {task.targetTable}</code></div><span className={"status-pill " + task.status.toLowerCase()}>{statusLabels[task.status] ?? task.status}</span><ChevronRight size={14} /></button>)}
            </aside>
            <section className="sync-detail">
              {selectedTask ? <>
                <header className="sync-detail-head"><div><span className="eyebrow">{selectedTask.mode} · VERSION BOUND</span><h3>{selectedTask.name}</h3><p>{selectedTaskSource?.name} → {selectedTask.targetTable}</p></div><button className="button primary" onClick={runTask} disabled={!canWrite || !!busy}>{busy === "run-task" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}实际执行</button></header>
                <div className="sync-proof"><div><span>源版本</span><code>{selectedTask.sourceRevisionId.slice(0, 8)}</code></div><div><span>元数据版本</span><code>{selectedTask.metadataVersionId.slice(0, 8)}</code></div><div><span>主键</span><strong>{selectedTask.keyFields.join(", ")}</strong></div><div><span>水位</span><strong>{selectedTask.watermarkField ?? "无"}</strong></div></div>
                <div className="sync-runs">
                  <header><h4>运行证据</h4><span>{selectedTask.runs.length}次</span></header>
                  {selectedTask.runs.map((run) => <article key={run.id}><span className={"status-pill " + run.status.toLowerCase()}>{statusLabels[run.status] ?? run.status}</span><code>{run.id.slice(0, 8)}</code><div><span>读取 {run.readCount ?? "—"}</span><span>新增 {run.inserted ?? "—"}</span><span>更新 {run.updated ?? "—"}</span><span>最终 {run.finalCount ?? "—"}</span></div><small>{run.error ?? `${run.durationMs}ms · ${run.targetHash?.slice(0, 12)}`}</small></article>)}
                </div>
              </> : <div className="ingestion-empty"><GitBranch size={26} /><p>创建或选择同步任务。</p></div>}
            </section>
          </div>
          <section className="sync-create-panel">
            <header><div><span className="eyebrow">MANUAL CONFIGURATION</span><h3>手动创建同步任务</h3></div><ArrowRight size={20} /></header>
            <div><label>任务名称<input value={taskName} onChange={(event) => setTaskName(event.target.value)} /></label><label>已采集数据源<select value={taskSourceId} onChange={(event) => setTaskSourceId(event.target.value)}>{sources.filter((source) => source.currentMetadataId).map((source) => <option value={source.id} key={source.id}>{source.name} · V{source.currentRevision.revisionNumber}</option>)}</select></label><label>同步模式<select value={taskMode} onChange={(event) => setTaskMode(event.target.value)}><option value="FULL">FULL全量</option><option value="INCREMENTAL_UPSERT">增量UPSERT</option></select></label><label>目标表<input value={targetTable} onChange={(event) => setTargetTable(event.target.value)} /></label></div>
            <footer><span>{Object.keys(identityMapping(metadataForTask)).length}个字段同名映射 · position_id主键</span><button className="button" onClick={createTask} disabled={!canWrite || !metadataForTask || !!busy}>创建版本化任务</button></footer>
          </section>
          <section className="target-preview"><header><div><Table2 size={18} /><h3>raw_positions 实际落地结果</h3></div><span>{targetRows.length}行</span></header><div><table><thead><tr><th>持仓ID</th><th>客户</th><th>证券</th><th>类别</th><th>市值</th><th>交易日</th></tr></thead><tbody>{targetRows.map((row) => <tr key={String(row.position_id)}><td><code>{String(row.position_id)}</code></td><td>{String(row.client_id)}</td><td>{String(row.security_code)}</td><td>{String(row.asset_class)}</td><td>{String(row.market_value)}</td><td>{String(row.trade_date)}</td></tr>)}</tbody></table></div></section>
        </>
      )}
      <footer className="ingestion-boundary"><FileSpreadsheet size={15} />{syncView === "realtime" && activeModule === "sync" ? "真实读取仓库内虚构JSONL并写入本机独立状态库；不是Kafka/Flink、真实CDC或公网流计算。" : "真实读取仓库内虚构CSV并写入本机独立SQLite；不是用户上传、MySQL/CDC或公网接入。"}</footer>
    </div>
  );
}
