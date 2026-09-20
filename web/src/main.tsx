import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bot,
  Boxes,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDollarSign,
  CircleHelp,
  Clock3,
  Code2,
  Database,
  FileCode2,
  FolderKanban,
  GitBranch,
  GitCompareArrows,
  History,
  Layers3,
  ListChecks,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Package,
  Play,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Table2,
  Terminal,
  Undo2,
  Workflow,
  X,
  AlertCircle,
  Radio,
  Save,
} from "lucide-react";
import "./styles.css";
import { DeliveryWorkbench } from "./DeliveryWorkbench";
import { DataServicesWorkbench } from "./DataServicesWorkbench";
import { IngestionWorkbench } from "./IngestionWorkbench";
import { AssetWorkbench } from "./AssetWorkbench";
import { QualityWorkbench } from "./QualityWorkbench";
import { SecurityWorkbench } from "./SecurityWorkbench";
import { ReportsWorkbench } from "./ReportsWorkbench";
import { OperationsWorkbench } from "./OperationsWorkbench";
import { AgentCenter } from "./AgentCenter";
import { PythonWorkbench } from "./PythonWorkbench";
import { CloudReadinessPanel } from "./CloudReadinessPanel";
import {
  AuthDialog,
  ChangePasswordPanel,
  InvitationPanel,
  type AuthSession,
} from "./AuthDialog";
const SqlEditor = lazy(() => import("./SqlEditor"));
type Column = { name: string; type: string };
type Context = {
  id: string;
  name: string;
  definition: string;
  advisorId: string;
  businessDate: string;
  referenceSql: string;
  tables: {
    name: string;
    label: string;
    columns: [string, string][];
    rows: (string | null)[][];
  }[];
};
type Capability = {
  id: string;
  name: string;
  group: string;
  stage: string;
  description: string;
  features: string[];
};
type Status = {
  validationContract?: { id: string; fixtureCount: number };
  mode: string;
  projectId: string;
  model: {
    configured: boolean;
    model: string;
    connectionVerified?: boolean;
    verifiedAt?: string | null;
  };
  spark: {
    available: boolean;
    engine: string;
    isolation: string;
    healthVerified?: boolean;
    publicWriteEnabled?: boolean;
  };
  python?: {
    available: boolean;
    isolation: string;
    memoryLimitRequired: boolean;
    cloudVerified: boolean;
    publicWriteEnabled: boolean;
  };
  metadata: { driver: string; cloudVerified: boolean };
  persistence?: {
    mode: string;
    healthy: boolean;
    dataState?: { driver: string; healthy: boolean };
  };
  artifacts?: {
    driver: string;
    durable: boolean;
    cloudVerified: boolean;
    lastVerifiedAt?: string;
  };
  ingestion?: {
    availableSourceTypes?: string[];
    serverMysql?: { configured: boolean; supportsOfflineSync: boolean; allowTableCount: number; credentialMode: string };
  };
  publicReady: boolean;
  authentication?: {
    users: number;
    pendingInvitations: number;
    activeSessions: number;
    mode: string;
    publicSessionEnforced: boolean;
  };
  budget?: {
    month: string;
    preferredTotalCny: number;
    hardLimitCny: number;
    enforced: "ALLOW" | "RESOURCE_STOP" | "HARD_STOP";
    model: {
      estimatedCostCny: number;
      limitCny: number;
      recordedCalls: number;
    };
    remoteSpark: {
      runCount: number;
      runLimit: number;
      seconds: number;
      secondsLimit: number;
    };
    account: {
      observedSpendCny?: number;
      source: string;
    };
  };
  capabilities: Capability[];
};
type Revision = {
  id: string;
  sql: string;
  hash: string;
  createdAt: string;
  contextId: string;
  source: string;
};
type Run = {
  validationContractId?: string;
  id: string;
  status: string;
  revisionId: string;
  contextId: string;
  createdAt: string;
  engine?: string;
  engineVersion?: string;
  durationMs?: number;
  rows?: Record<string, string | number | null>[];
  columns?: Column[];
  validation?: {
    contractId?: string;
    passed: boolean;
    issues: string[];
    assertions: string[];
    regressions?: { contextId: string; name: string; passed: boolean }[];
  };
  error?: string;
  log?: string;
};
type AgentTask = {
  validationContractId?: string;
  id: string;
  status: string;
  message: string;
  sql?: string;
  explanation?: string;
  error?: string;
  revisionId?: string;
  attempts: { attempt: number; status: string; runId: string }[];
};
type AgentJourney = {
  taskId: string;
  stages: {
    id: string;
    label: string;
    actor: string;
    status: "SUCCEEDED" | "WAITING" | "FAILED" | "HISTORICAL" | "UNVERIFIED";
    evidence: Record<string, string | number | boolean | undefined>;
    note: string;
  }[];
  localEvidenceComplete: boolean;
  agentIndependentE2E: boolean;
  publicDeployed: boolean;
  notice: string;
};
type AgentDeliveryTask = {
  id: string;
  sourceAgentTaskId: string;
  sourceRunId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  stage: string;
  packageId?: string;
  packageDigest?: string;
  verificationId?: string;
  actualExecution?: boolean;
  error?: string;
  notice?: string;
  fullLifecycleE2E: boolean;
  agentIndependentE2E: boolean;
  publicDeployed: boolean;
};
const journeyActors: Record<string, string> = {
  ENGINEER_AND_AGENT: "工程师明确口径 · Agent读取上下文",
  DATA_AGENT_THEN_ENGINEER: "Agent生成 · 工程师审阅",
  DATA_AGENT_AND_SPARK: "Agent修正 · Spark执行",
  ENGINEER_VIA_DELIVERY_API: "工程师或受控接口生成",
  AGENT_DELIVERY_ORCHESTRATOR: "Agent受控编排 · 工程师审阅",
  ENGINEER_AND_SPARK: "工程师确认 · Spark演练",
  AGENT_ORCHESTRATOR_AND_SPARK: "Agent编排 · Spark真实演练",
  ENGINEER_APPROVAL_THEN_SCHEDULER: "工程师审批 · 调度器执行",
  SCHEDULER_AND_ENGINEER: "调度器监控 · 工程师处置",
};
const deliveryStageLabels: Record<string, string> = {
  QUEUED: "等待串行执行",
  PACKAGE_READY: "调度与部署文件已保存",
  FILE_REHEARSAL_RUNNING: "按文件执行Spark测试",
  AWAITING_ENGINEER_REVIEW: "真实演练通过 · 等待工程师审阅",
};
const icons: Record<string, React.ComponentType<{ size?: number }>> = {
  sources: Database,
  sync: GitBranch,
  development: Code2,
  schedules: Workflow,
  assets: Layers3,
  quality: ListChecks,
  security: ShieldCheck,
  services: Braces,
  reports: Table2,
  ops: Activity,
  settings: Settings2,
};
const labels: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "执行中",
  SUCCEEDED: "验证通过",
  VALIDATION_FAILED: "结果不符",
  FAILED: "运行失败",
  CANCELLED: "已取消",
  INTERRUPTED: "已中断",
};
const isPending = (s?: string) => s === "QUEUED" || s === "RUNNING";
const time = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
async function api<T>(
  path: string,
  body?: unknown,
  requestOptions: { actorId?: string } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/v2" + path, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(15000),
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        ...(requestOptions.actorId
          ? { "X-Actor-Id": requestOptions.actorId }
          : {}),
        ...(body === undefined || !cookieValue("shuduo_csrf")
          ? {}
          : { "X-CSRF-Token": cookieValue("shuduo_csrf") }),
        ...(body === undefined
          ? {}
          : { "Idempotency-Key": crypto.randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError")
      throw new Error(
        "请求超时，操作结果尚未确认；输入内容已保留。请确认本机服务状态后再试。",
      );
    throw new Error(
      "无法连接本机服务，输入内容已保留。请确认服务正在运行后再试。",
    );
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("服务响应无法解析，操作结果尚未确认；输入内容已保留。");
  }
  if (!response.ok) throw new Error(value.message ?? "请求失败");
  return value;
}
function cookieValue(name: string) {
  return document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
const navPermission: Record<string, string> = {
  "agent-center": "AGENT",
  sources: "INGESTION",
  sync: "INGESTION",
  development: "DEVELOPMENT",
  schedules: "DELIVERY",
  assets: "ASSETS",
  quality: "QUALITY",
  security: "ADMIN",
  services: "SERVICES",
  reports: "REPORTS",
  ops: "OPS",
  settings: "ADMIN",
};
function App() {
  const [status, setStatus] = useState<Status>(),
    [contexts, setContexts] = useState<Context[]>([]),
    [contextId, setContextId] = useState("holdings-t1");
  const [nav, setNav] = useState(
      () =>
        new URLSearchParams(window.location.search).get("module") ??
        "agent-center",
    ),
    [sql, setSql] = useState(""),
    [developmentLanguage, setDevelopmentLanguage] = useState<"SQL" | "PYTHON">("SQL"),
    [original, setOriginal] = useState(""),
    [diff, setDiff] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]),
    [run, setRun] = useState<Run>(),
    [revisions, setRevisions] = useState<Revision[]>([]);
  const [agentTask, setAgentTask] = useState<AgentTask>(),
    [agentJourney, setAgentJourney] = useState<AgentJourney>(),
    [agentDelivery, setAgentDelivery] = useState<AgentDeliveryTask>(),
    [message, setMessage] = useState(""),
    [agentOpen, setAgentOpen] = useState(true);
  const [tab, setTab] = useState("结果"),
    [modal, setModal] = useState<"versions" | "search" | null>(null),
    [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState("");
  const sqlRef = useRef(sql);
  const [modelKey, setModelKey] = useState("");
  const [deliverySourceId, setDeliverySourceId] = useState("");
  const [agentHandoff, setAgentHandoff] = useState<{ destination: string; message: string }>();
  const [modelSaveError, setModelSaveError] = useState("");
  const [modelSaved, setModelSaved] = useState(false);
  const [session, setSession] = useState<AuthSession>({ authenticated: false });
  const [authOpen, setAuthOpen] = useState(false);
  sqlRef.current = sql;
  const modalRef = useRef<HTMLElement>(null);
  const context = contexts.find((c) => c.id === contextId),
    active = status?.capabilities.find((c) => c.id === nav);
  const totalRows = context?.tables.reduce((s, t) => s + t.rows.length, 0) ?? 0;
  const groupNames = [...new Set(status?.capabilities.map((c) => c.group))];
  useEffect(() => {
    if (!status) return;
    if (!status.capabilities.some((cap) => cap.id === nav)) {
      setNav("development");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("module", nav);
    window.history.replaceState(null, "", url);
  }, [nav, status]);
  const reload = async () => {
    const [s, c, r, v, a, d, authSession] = await Promise.all([
      api<Status>("/status"),
      api<Context[]>("/contexts"),
      api<Run[]>("/runs"),
      api<Revision[]>("/revisions"),
      api<AgentTask[]>("/agent/tasks"),
      api<AgentDeliveryTask[]>("/agent/deliveries"),
      api<AuthSession>("/auth/session"),
    ]);
    setStatus(s);
    setContexts(c);
    setRuns(r);
    setRevisions(v);
    if (!sqlRef.current) {
      const initial = v[0]?.sql ?? c[0].referenceSql;
      setSql(initial);
      setOriginal(initial);
      if (v[0]) setContextId(v[0].contextId);
    }
    setRun(r[0]);
    setAgentTask(a[0]);
    setAgentDelivery(d.find((item) => item.sourceAgentTaskId === a[0]?.id));
    setSession(authSession);
  };
  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!isPending(run?.status) && !isPending(agentTask?.status) && !isPending(agentDelivery?.status)) return;
    const interval = setInterval(async () => {
      try {
        if (run && isPending(run.status)) {
          const current = await api<Run>("/runs/" + run.id);
          setRun(current);
          if (!isPending(current.status)) setRuns(await api<Run[]>("/runs"));
        }
        if (agentTask && isPending(agentTask.status)) {
          const current = await api<AgentTask>("/agent/tasks/" + agentTask.id);
          setAgentTask(current);
          if (!isPending(current.status)) {
            setRevisions(await api<Revision[]>("/revisions"));
            setRuns(await api<Run[]>("/runs"));
          }
        }
        if (agentDelivery && isPending(agentDelivery.status)) {
          const current = await api<AgentDeliveryTask>(`/agent/deliveries/${agentDelivery.id}`);
          setAgentDelivery(current);
          if (!isPending(current.status) && agentTask)
            setAgentJourney(await api<AgentJourney>(`/agent/tasks/${agentTask.id}/journey`));
        }
      } catch (e) {
        setError((e as Error).message);
      }
    }, 1400);
    return () => clearInterval(interval);
  }, [run?.id, run?.status, agentTask?.id, agentTask?.status, agentDelivery?.id, agentDelivery?.status]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setModal("search");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!modal || !modalRef.current) return;
    const previous = document.activeElement,
      container = modalRef.current;
    const focusable = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,a[href],[tabindex="0"]',
        ),
      ).filter((e) => e.offsetParent !== null);
    (
      container.querySelector<HTMLInputElement>("input") ?? focusable()[0]
    )?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable(),
        first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    container.addEventListener("keydown", trap);
    return () => {
      container.removeEventListener("keydown", trap);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [modal]);
  const save = async () => {
    const saved = await api<Revision>("/revisions", { sql, contextId });
    setOriginal(saved.sql);
    setSql(saved.sql);
    setRevisions(await api<Revision[]>("/revisions"));
    return saved;
  };
  const saveClick = async () => {
    setBusy(true);
    setError("");
    try {
      await save();
      setNotice("代码版本已保存");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const execute = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await save();
      const result = await api<Run>("/runs", { revisionId: saved.id });
      setRun(result);
      setTab("结果");
      setNotice("已提交 Spark 后台执行");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const task = await api<AgentTask>("/agent/tasks", {
        message,
        sql,
        contextId,
      });
      setAgentTask(task);
      setAgentDelivery(undefined);
      setAgentJourney(undefined);
      setMessage("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    if (!run) return;
    try {
      const bundle = await api<unknown>("/runs/" + run.id + "/bundle");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "shuduo-verification-" + run.id.slice(0, 8) + ".json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const switchContext = (id: string) => {
    setContextId(id);
    setRun(undefined);
    setNotice("已切换输入数据，代码保留；重新运行以验证结果");
  };
  const dirty = sql !== original,
    canWrite = Boolean(
      status?.mode === "LOCAL_DEVELOPMENT" ||
        (session.authenticated &&
          (session.permissions?.includes("*") ||
            session.permissions?.includes(navPermission[nav]))),
    );
  const runRevision = revisions.find(
    (revision) => revision.id === run?.revisionId,
  );
  const resultIsCurrent = Boolean(
    run &&
      run.contextId === contextId &&
      runRevision?.sql === sql.trim() &&
      (!status?.validationContract ||
        run.validationContractId === status.validationContract.id),
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/v2/" aria-label="数舵工作台">
          <span className="brand-symbol">
            <Layers3 size={22} />
          </span>
          <strong>
            数舵<span>SHUDUO</span>
          </strong>
          <small>V2</small>
        </a>
        <button
          className="workspace-picker"
          onClick={() => {
            setNav("settings");
          }}
        >
          <FolderKanban size={17} />
          <span>
            证券数据实验室<small>个人工作空间</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button
          className="nav-search"
          aria-label="搜索功能与模块"
          title="搜索功能与模块"
          onClick={() => setModal("search")}
        >
          <Search size={15} />
          <span>搜索功能与模块</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          aria-label="Data Agent"
          title="Data Agent"
          className={
            "agent-entry " +
            (nav === "agent-center" ? "active" : "")
          }
          onClick={() => {
            setNav("agent-center");
            setAgentOpen(true);
          }}
        >
          <Bot size={17} />
          <span>Data Agent</span>
          <span className="ai-tag">AI</span>
        </button>
        <nav aria-label="主要功能">
          {groupNames.map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              {status?.capabilities
                .filter((c) => c.group === group)
                .map((cap) => {
                  const Icon = icons[cap.id] ?? Boxes;
                  return (
                    <button
                      title={cap.name}
                      key={cap.id}
                      className={
                        "nav-link " + (nav === cap.id ? "selected" : "")
                      }
                      onClick={() => setNav(cap.id)}
                    >
                      <Icon size={17} />
                      <span>{cap.name}</span>
                      {cap.id === "development" && <span className="nav-dot" />}
                    </button>
                  );
                })}
            </section>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="user-avatar">
            {session.user?.displayName?.slice(0, 1) ?? "数"}
          </span>
          <div>
            <strong>
              {status?.mode === "LOCAL_DEVELOPMENT"
                ? "本地开发者"
                : session.user?.displayName ?? "公开访客"}
            </strong>
            <small>
              {status?.mode === "LOCAL_DEVELOPMENT"
                ? "合成数据 · 开发验证"
                : session.authenticated
                  ? `${session.role} · 受邀项目`
                  : "合成数据 · 只读浏览"}
            </small>
          </div>
          <button aria-label="查看运行设置" onClick={() => setNav("settings")}>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>证券数据实验室</span>
            <ChevronRight size={13} />
            <strong>{active?.name ?? "数据开发"}</strong>
          </div>
          <div className="top-actions">
            <span className="env-tag">
              <span />
              {status?.mode === "LOCAL_DEVELOPMENT"
                ? "本地验证"
                : session.authenticated
                  ? "受邀会话"
                  : "公开浏览"}
            </span>
            {status?.mode !== "LOCAL_DEVELOPMENT" &&
              (session.authenticated ? (
                <button
                  className="auth-session-button-v2"
                  title="退出受邀会话"
                  onClick={async () => {
                    try {
                      await api("/auth/logout", {});
                      setSession({ authenticated: false });
                      setNotice("已退出受邀会话，切换为公开只读浏览");
                    } catch (cause) {
                      setError((cause as Error).message);
                    }
                  }}
                >
                  <LogOut size={14} />
                  {session.user?.displayName}
                </button>
              ) : (
                <button
                  className="auth-session-button-v2"
                  onClick={() => setAuthOpen(true)}
                >
                  <LogIn size={14} />受邀用户登录
                </button>
              ))}
            <button title="帮助与验收标准" onClick={() => setNav("settings")}>
              <CircleHelp size={18} />
            </button>
            <span className="top-avatar">
              {session.user?.displayName?.slice(0, 1) ?? "数"}
            </span>
          </div>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="关闭错误提示">
              <X size={15} />
            </button>
          </div>
        )}
        {nav === "agent-center" ? (
          <AgentCenter
            api={api}
            canWrite={canWrite}
            modelConfigured={Boolean(status?.model.configured)}
            contextId={contextId}
            currentSql={sql}
            onOpenDestination={(destination, handoffMessage) => {
              if (handoffMessage) setAgentHandoff({ destination, message: handoffMessage });
              setNav(destination);
              setNotice(handoffMessage ? "已带入专业Agent草稿；请在模块内审阅后再发起。" : "已进入对应专业模块；后续动作仍需模块内资源与权限校验");
            }}
          />
        ) : nav === "development" ? (
          <>
            <div className="development-language-v2" role="tablist" aria-label="数据开发语言">
              <button role="tab" aria-selected={developmentLanguage === "SQL"} className={developmentLanguage === "SQL" ? "active" : ""} onClick={() => setDevelopmentLanguage("SQL")}>Spark SQL</button>
              <button role="tab" aria-selected={developmentLanguage === "PYTHON"} className={developmentLanguage === "PYTHON" ? "active" : ""} onClick={() => setDevelopmentLanguage("PYTHON")}>Python</button>
              <span>{developmentLanguage === "SQL" ? "Apache Spark 3.5.9" : "受限CPython · 本机实际执行"}</span>
            </div>
            {developmentLanguage === "PYTHON" ? (
              <PythonWorkbench
                api={api}
                contextId={contextId}
                canWrite={canWrite}
                available={status?.python?.available === true}
              />
            ) : (
              <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span /> DATA DEVELOPMENT
                </div>
                <h1>
                  客户资产 T+1 <span className="draft-badge">开发中</span>
                </h1>
                <p>在已知数据与业务口径下，编写、执行并验证 SQL。</p>
              </div>
              <div className="heading-actions">
                <button className="button" onClick={() => setModal("versions")}>
                  <History size={15} />
                  版本 <span>{revisions.length}</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={agentOpen ? "收起 Agent" : "展开 Agent"}
                  onClick={() => setAgentOpen(!agentOpen)}
                >
                  {agentOpen ? (
                    <PanelRightClose size={18} />
                  ) : (
                    <PanelRightOpen size={18} />
                  )}
                </button>
              </div>
            </div>
            <div className="journey" aria-label="开发流程">
              <span className="done">
                <Check size={13} />
                选择上下文
              </span>
              <ChevronRight size={12} />
              <span className="current">02 编写与调试</span>
              <ChevronRight size={12} />
              <span
                className={
                  run?.status === "SUCCEEDED" && resultIsCurrent ? "done" : ""
                }
              >
                03 核验结果
              </span>
              <ChevronRight size={12} />
              <span title="M2：本机计时发布已验证；云端公网部署仍待验收">
                04 发布交付 <small>M2</small>
              </span>
              <div className="journey-end">
                <Database size={13} />
                {context?.tables.length ?? 0} 张样例表 · {totalRows} 行
              </div>
            </div>
            <div className={"work-area " + (agentOpen ? "with-agent" : "")}>
              <section className="studio">
                <div className="studio-top">
                  <div className="file-tab">
                    <FileCode2 size={15} />
                    <strong>customer_assets.sql</strong>
                    {dirty && (
                      <span className="unsaved-dot" title="编辑已修改" />
                    )}
                  </div>
                  <span>Spark SQL</span>
                </div>
                <div className="editor-toolbar">
                  <label>
                    <Database size={14} />
                    <select
                      aria-label="输入数据版本"
                      value={contextId}
                      onChange={(e) => switchContext(e.target.value)}
                    >
                      {contexts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="toolbar-actions">
                    <button
                      title="查看与参考版本的差异"
                      className={diff ? "on" : ""}
                      onClick={() => setDiff(!diff)}
                    >
                      <GitCompareArrows size={15} />
                      <span>差异</span>
                    </button>
                    <button
                      title="撤销至载入版本"
                      onClick={() => {
                        setSql(original);
                        setNotice("已恢复载入版本");
                      }}
                    >
                      <Undo2 size={15} />
                    </button>
                    <button
                      onClick={saveClick}
                      disabled={busy || !canWrite}
                      title="保存代码版本"
                    >
                      <Save size={15} />
                    </button>
                    <button
                      className="run-button"
                      onClick={execute}
                      disabled={
                        busy ||
                        isPending(run?.status) ||
                        !status?.spark.available ||
                        !canWrite
                      }
                    >
                      {isPending(run?.status) ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Play size={14} />
                      )}
                      <span>
                        {isPending(run?.status) ? "执行中" : "运行 SQL"}
                      </span>
                    </button>
                  </div>
                </div>
                <div className="editor-region">
                  <Suspense
                    fallback={
                      <textarea
                        aria-label="SQL 编辑器"
                        value={sql}
                        onChange={(e) => setSql(e.target.value)}
                      />
                    }
                  >
                    {sql && (
                      <SqlEditor
                        value={sql}
                        original={original}
                        onChange={setSql}
                        diff={diff}
                      />
                    )}
                  </Suspense>
                </div>
                <div className="editor-status">
                  <span>
                    <CheckCircle2 size={12} />
                    参考 SQL 可人工编辑
                  </span>
                  <span>UTF-8 · Spark SQL · {sql.split("\n").length} 行</span>
                </div>
                <section className="result-panel">
                  <div className="result-toolbar">
                    <div role="tablist" aria-label="运行结果视图">
                      {["结果", "验证", "日志", "运行记录"].map((label) => (
                        <button
                          role="tab"
                          aria-selected={tab === label}
                          className={tab === label ? "active" : ""}
                          key={label}
                          onClick={() => setTab(label)}
                        >
                          {label}
                          {label === "结果" && run?.rows && (
                            <small>{run.rows.length}</small>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="run-meta">
                      {run && (
                        <span
                          className={
                            "status-pill " +
                            (resultIsCurrent
                              ? run.status.toLowerCase()
                              : "stale")
                          }
                        >
                          {resultIsCurrent
                            ? (labels[run.status] ?? run.status)
                            : "历史结果"}
                        </span>
                      )}
                      {run?.durationMs && (
                        <span>{(run.durationMs / 1000).toFixed(1)}s</span>
                      )}
                      {isPending(run?.status) && (
                        <button
                          aria-label="取消运行"
                          onClick={async () => {
                            try {
                              setRun(
                                await api<Run>(
                                  "/runs/" + run?.id + "/cancel",
                                  {},
                                ),
                              );
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          <Square size={13} />
                        </button>
                      )}
                      <button
                        title="导出验证包"
                        aria-label="导出验证包"
                        disabled={run?.status !== "SUCCEEDED"}
                        onClick={download}
                      >
                        <ArrowDownToLine size={15} />
                      </button>
                    </div>
                  </div>
                  <div className="result-body">
                    {run && tab !== "运行记录" && (
                      <div
                        className={
                          "run-reference " + (resultIsCurrent ? "" : "stale")
                        }
                      >
                        <span>
                          版本{" "}
                          {runRevision?.hash.slice(0, 8) ??
                            run.revisionId.slice(0, 8)}{" "}
                          · 批次 {run.id.slice(0, 8)}
                        </span>
                        {!resultIsCurrent && (
                          <strong>
                            代码、上下文或验证范围已变更，请重新运行核验
                          </strong>
                        )}
                      </div>
                    )}
                    {tab === "结果" &&
                      (run?.rows ? (
                        <>
                          <table>
                            <thead>
                              <tr>
                                <th>#</th>
                                {run.columns?.map((c) => (
                                  <th key={c.name}>
                                    {c.name}
                                    <small>{c.type}</small>
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {run.rows.map((row, i) => (
                                <tr key={i}>
                                  <td>{i + 1}</td>
                                  {run.columns?.map((c) => (
                                    <td key={c.name}>
                                      {String(row[c.name] ?? "NULL")}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="table-foot">
                            <span>
                              <ShieldCheck size={12} />
                              仅当前上下文的合成客户
                            </span>
                            <span>
                              {run.engine} {run.engineVersion}
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="empty-result">
                          {isPending(run?.status) ? (
                            <LoaderCircle size={27} className="spin" />
                          ) : (
                            <Terminal size={27} />
                          )}
                          <strong>
                            {run?.error ??
                              (isPending(run?.status)
                                ? "Spark 正在后台执行"
                                : "运行代码，查看真实结果")}
                          </strong>
                          <p>
                            {isPending(run?.status)
                              ? "你可以继续浏览；运行状态会自动保存。"
                              : "每次执行会记录代码版本，并用独立业务断言核验结果。"}
                          </p>
                        </div>
                      ))}
                    {tab === "验证" &&
                      (run?.validation ? (
                        <div
                          className={
                            "validation-list " +
                            (run.validation.passed ? "passed" : "failed")
                          }
                        >
                          <h3>
                            {run.validation.passed
                              ? "独立业务断言通过"
                              : "结果需要修正"}
                          </h3>
                          {!run.validation.passed && (
                            <p>
                              以下为本次核验范围，并非全部通过；具体问题见下方。
                            </p>
                          )}
                          {run.validation.regressions?.map((check) => (
                            <div key={check.contextId}>
                              {check.passed ? (
                                <CheckCircle2 size={15} />
                              ) : (
                                <AlertCircle size={15} />
                              )}
                              <span>
                                {check.name} ·{" "}
                                {check.passed ? "通过" : "未通过"}
                              </span>
                            </div>
                          ))}
                          {run.validation.assertions.map((item) => (
                            <div key={item}>
                              {run.validation!.passed ? (
                                <CheckCircle2 size={15} />
                              ) : (
                                <Circle size={15} />
                              )}
                              {item}
                            </div>
                          ))}
                          {run.validation.issues.map((item) => (
                            <p className="validation-error" key={item}>
                              {item}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <div className="empty-result">
                          <ListChecks size={27} />
                          <strong>运行后生成验证报告</strong>
                          <p>核验客户范围、现金聚合、证券去重和金额精度。</p>
                        </div>
                      ))}
                    {tab === "日志" && (
                      <pre className="log-text">
                        {run?.error ??
                          run?.log ??
                          "等待运行日志。模型未配置时不会生成模拟成功日志。"}
                      </pre>
                    )}
                    {tab === "运行记录" && (
                      <div className="run-history">
                        {runs.length ? (
                          runs.map((r) => (
                            <button
                              key={r.id}
                              onClick={() => {
                                setRun(r);
                                setTab("结果");
                              }}
                            >
                              <span
                                className={
                                  "status-pill " + r.status.toLowerCase()
                                }
                              >
                                {labels[r.status]}
                              </span>
                              <span>{r.id.slice(0, 8)}</span>
                              <span>{time(r.createdAt)}</span>
                              <ArrowUpRight size={14} />
                            </button>
                          ))
                        ) : (
                          <div className="empty-result">
                            <History size={25} />
                            <strong>还没有执行记录</strong>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              </section>
              {agentOpen && (
                <aside className="agent-panel">
                  <header>
                    <span className="agent-icon">
                      <Bot size={20} />
                    </span>
                    <div>
                      <strong>Data Agent</strong>
                      <small>与当前代码和上下文协作</small>
                    </div>
                    <button
                      aria-label="收起 Agent 面板"
                      onClick={() => setAgentOpen(false)}
                    >
                      <X size={17} />
                    </button>
                  </header>
                  <div className="agent-content">
                    <div className="assistant-message">
                      <span className="mini-agent">
                        <Bot size={15} />
                      </span>
                      <div>
                        <strong>从业务目标，到可验证的代码。</strong>
                        <p>
                          我会基于你选择的表结构与口径编写
                          SQL，读取执行结果，并在限定次数内修正问题。
                        </p>
                      </div>
                    </div>
                    <div className="context-card">
                      <div>
                        <span>
                          <Layers3 size={14} />
                          已关联上下文
                        </span>
                        <small>{context?.tables.length ?? 0} 张表</small>
                      </div>
                      {context?.tables.map((t) => (
                        <button
                          key={t.name}
                          onClick={() => {
                            setExpanded(t.name);
                            setNav("assets");
                          }}
                        >
                          <Table2 size={13} />
                          <code>{t.name}</code>
                          <small>{t.columns.length} 字段</small>
                          <ChevronRight size={12} />
                        </button>
                      ))}
                      <p>
                        <ShieldCheck size={13} />
                        已定义：现金独立聚合、持仓去重
                      </p>
                    </div>
                    <p className="section-caption">你可以这样开始</p>
                    <div className="prompt-list">
                      {[
                        "检查当前 SQL 是否会重复累计现金",
                        "完善客户总资产计算，并执行验证",
                        "检查证券去重逻辑，修正后重新运行",
                      ].map((prompt) => (
                        <button key={prompt} onClick={() => setMessage(prompt)}>
                          <span>{prompt}</span>
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                    </div>
                    {agentTask && (
                      <div className="agent-task">
                        {status?.validationContract &&
                          agentTask.validationContractId !==
                            status.validationContract.id && (
                            <p className="validation-error">
                              该委托使用旧验证范围，需要重新核验。
                            </p>
                          )}
                        {isPending(agentTask.status) && (
                          <button
                            className="button"
                            onClick={async () => {
                              try {
                                setAgentTask(
                                  await api<AgentTask>(
                                    "/agent/tasks/" + agentTask.id + "/cancel",
                                    {},
                                  ),
                                );
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            停止委托
                            <Square size={13} />
                          </button>
                        )}
                        <div>
                          <strong>最近的委托</strong>
                          <span
                            className={
                              "status-pill " + agentTask.status.toLowerCase()
                            }
                          >
                            {labels[agentTask.status]}
                          </span>
                        </div>
                        <p>{agentTask.message}</p>
                        {agentTask.attempts.map((a) => (
                          <p key={a.attempt}>
                            第 {a.attempt} 次 · {labels[a.status]}
                          </p>
                        ))}
                        <button
                          className="button agent-journey-refresh-v2"
                          onClick={async () => {
                            try {
                              setAgentJourney(
                                await api<AgentJourney>(
                                  `/agent/tasks/${agentTask.id}/journey`,
                                ),
                              );
                            } catch (cause) {
                              setError((cause as Error).message);
                            }
                          }}
                        >
                          查看/刷新七阶段证据
                          <ArrowRight size={13} />
                        </button>
                        {agentJourney?.taskId === agentTask.id && (
                          <section className="agent-journey-v2" aria-label="Agent七阶段证据旅程">
                            <header>
                              <strong>从需求到监控</strong>
                              <span>{agentJourney.localEvidenceComplete ? "本机证据完整" : "仍有待完成阶段"}</span>
                            </header>
                            <ol>
                              {agentJourney.stages.map((item, index) => (
                                <li key={item.id} className={item.status.toLowerCase()}>
                                  <span>{index + 1}</span>
                                  <details>
                                    <summary>
                                      <strong>{item.label}</strong>
                                      <small>{item.status === "SUCCEEDED" ? "完成" : item.status === "HISTORICAL" ? "历史状态" : item.status === "FAILED" ? "失败" : item.status === "UNVERIFIED" ? "证据不足" : "待完成"} · {journeyActors[item.actor] ?? "责任待核对"}</small>
                                    </summary>
                                    <p>{item.note}</p>
                                    <code>{Object.entries(item.evidence)
                                      .filter(([key, value]) => /(?:Id|Hash|model)/.test(key) && typeof value === "string" && value)
                                      .slice(0, 2)
                                      .map(([key, value]) => `${key}:${String(value).slice(0, 12)}`)
                                      .join(" · ")}</code>
                                  </details>
                                </li>
                              ))}
                            </ol>
                            <footer>{agentJourney.notice}</footer>
                          </section>
                        )}
                        {agentTask.status === "SUCCEEDED" &&
                          agentTask.validationContractId === status?.validationContract?.id && (
                          <section className="agent-delivery-progress-v2" aria-label="Agent交付准备">
                            <strong>{agentDelivery?.status === "SUCCEEDED" ? "交付文件已准备" : "下一步：交付文件准备"}</strong>
                            <p>复用该委托已验证的代码版本，自动生成不可变调度/部署文件并实际按文件演练；不审批或发布。</p>
                            {(!agentDelivery || agentDelivery.sourceAgentTaskId !== agentTask.id || agentDelivery.status === "FAILED" || agentDelivery.status === "INTERRUPTED") && (
                              <button
                                className="button primary"
                                disabled={!canWrite || busy}
                                onClick={async () => {
                                  setBusy(true);
                                  setError("");
                                  try {
                                    setAgentDelivery(await api<AgentDeliveryTask>(
                                      `/agent/tasks/${agentTask.id}/prepare-delivery`,
                                      {},
                                    ));
                                  } catch (cause) {
                                    setError((cause as Error).message);
                                  } finally {
                                    setBusy(false);
                                  }
                                }}
                              >
                                <Package size={13} />Agent继续准备并演练
                              </button>
                            )}
                            {agentDelivery?.sourceAgentTaskId === agentTask.id && (
                              <div className="agent-delivery-status-v2" role="status">
                                <span className={`status-pill ${agentDelivery.status.toLowerCase()}`}>{agentDelivery.status === "SUCCEEDED" ? "准备已验证" : labels[agentDelivery.status]}</span>
                                <small>{deliveryStageLabels[agentDelivery.stage] ?? agentDelivery.stage}</small>
                                {agentDelivery.packageDigest && <code>包摘要 {agentDelivery.packageDigest.slice(0, 12)}</code>}
                                {agentDelivery.error && <p>{agentDelivery.error}</p>}
                                {agentDelivery.status === "SUCCEEDED" && agentDelivery.actualExecution && (
                                  <button className="button" onClick={() => {
                                    setDeliverySourceId(agentDelivery.sourceRunId);
                                    setNav("schedules");
                                  }}>审阅交付包再决定审批<ArrowRight size={13} /></button>
                                )}
                              </div>
                            )}
                          </section>
                        )}
                        {agentTask.explanation && (
                          <p>{agentTask.explanation}</p>
                        )}
                        {agentTask.error && (
                          <p className="validation-error">{agentTask.error}</p>
                        )}
                        {agentTask.status === "SUCCEEDED" &&
                          agentTask.validationContractId ===
                            status?.validationContract?.id && (
                            <button
                              className="button"
                              title="基于该委托已验证的代码版本，不包含未保存修改"
                              onClick={() => {
                                setDeliverySourceId(
                                  agentTask.attempts.at(-1)?.runId ?? "",
                                );
                                setNav("schedules");
                              }}
                            >
                              {agentDelivery?.sourceAgentTaskId === agentTask.id && agentDelivery.status === "SUCCEEDED"
                                ? "查看经典手动交付流程"
                                : "生成该版本交付包"}
                              <ArrowRight size={15} />
                            </button>
                          )}
                        {agentTask.sql && !isPending(agentTask.status) && (
                          <button
                            className="button"
                            onClick={async () => {
                              setOriginal(sql);
                              setSql(agentTask.sql!);
                              setDiff(true);
                              setNotice("已打开 Agent 产物差异");
                              const last = agentTask.attempts.at(-1);
                              if (last)
                                try {
                                  setRun(await api<Run>("/runs/" + last.runId));
                                  setTab("结果");
                                } catch (error) {
                                  setError((error as Error).message);
                                }
                            }}
                          >
                            审阅生成代码
                            <GitCompareArrows size={14} />
                          </button>
                        )}
                      </div>
                    )}
                    {!status?.model.configured && (
                      <div className="model-notice">
                        <CircleHelp size={16} />
                        <div>
                          <strong>模型服务待连接</strong>
                          <p>
                            参考 SQL 可直接编辑运行。连接模型后即可委托 Agent
                            自动编写与修正。
                          </p>
                          <button onClick={() => setNav("settings")}>
                            查看配置方法
                            <ArrowRight size={13} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <form
                    className="agent-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send();
                    }}
                  >
                    <textarea
                      aria-label="向 Data Agent 描述需求"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="描述你希望生成、修改或检查的代码…"
                      rows={3}
                    />
                    <div>
                      <span>
                        <span
                          className={
                            "connection-dot " +
                            (status?.model.configured ? "online" : "")
                          }
                        />
                        {status?.model.configured
                          ? status.model.model
                          : "尚未连接模型"}
                      </span>
                      <button
                        type="submit"
                        aria-label="委托 Agent"
                        disabled={
                          busy ||
                          isPending(agentTask?.status) ||
                          !canWrite ||
                          !status?.model.configured ||
                          message.trim().length < 4
                        }
                      >
                        <Send size={15} />
                      </button>
                    </div>
                  </form>
                  <small className="agent-footer">
                    生成 → 执行 → 核验 · 最多 3 次修正
                    <span className="agent-scope-note">
                      {agentDelivery?.sourceAgentTaskId === agentTask?.id && agentDelivery?.status === "SUCCEEDED"
                        ? "代码和交付文件已真实验证；审批、上线与监控仍待审阅"
                        : "当前仅代码阶段；完整 E2E 还需调度、部署、上线与监控"}
                    </span>
                  </small>
                </aside>
              )}
            </div>
              </>
            )}
          </>
        ) : (
          <section className="module-page">
            <div className="eyebrow">
              {active?.group} / {active?.stage}
            </div>
            <h1>{active?.name}</h1>
            <p className="module-subtitle">{active?.description}</p>
            {nav === "services" ? (
              <DataServicesWorkbench api={api} canWrite={Boolean(canWrite)} />
            ) : nav === "sources" || nav === "sync" ? (
              <IngestionWorkbench
                api={api}
                activeModule={nav}
                canWrite={Boolean(canWrite)}
                serverMysqlConfigured={status?.ingestion?.serverMysql?.configured === true}
                serverMysqlSyncEnabled={status?.ingestion?.serverMysql?.supportsOfflineSync === true}
                onModuleChange={setNav}
              />
            ) : nav === "schedules" ? (
              <DeliveryWorkbench
                api={api}
                runs={runs}
                contractId={status?.validationContract?.id}
                sourceRunId={deliverySourceId}
                canWrite={Boolean(canWrite)}
                onBack={() => setNav("development")}
              />
            ) : nav === "assets" ? (
              <AssetWorkbench
                api={api}
                canWrite={Boolean(canWrite)}
                initialAssetId={expanded ? `fixture:${expanded}` : undefined}
                handoffMessage={agentHandoff?.destination === "assets" ? agentHandoff.message : undefined}
              />
            ) : nav === "quality" ? (
              <QualityWorkbench api={api} canWrite={Boolean(canWrite)} />
            ) : nav === "security" ? (
              <SecurityWorkbench api={api} canWrite={Boolean(canWrite)} />
            ) : nav === "reports" ? (
              <ReportsWorkbench api={api} canWrite={Boolean(canWrite)} handoffMessage={agentHandoff?.destination === "reports" ? agentHandoff.message : undefined} />
            ) : nav === "ops" ? (
              <OperationsWorkbench api={api} canWrite={Boolean(canWrite)} />
            ) : nav === "settings" ? (
              <>
                <div className="settings-grid">
                  <article>
                    <Code2 size={23} />
                    <h3>SQL 执行引擎</h3>
                    <span
                      className={
                        "status-pill " +
                        (status?.spark.available ? "succeeded" : "failed")
                      }
                    >
                      {status?.spark.available
                        ? runs.some(
                            (r) =>
                              r.status === "SUCCEEDED" &&
                              r.engine === "Apache Spark" &&
                              r.engineVersion !== "TEST_DOUBLE",
                          )
                          ? "已有真实执行记录"
                          : "环境已安装，待运行核验"
                        : "待安装"}
                    </span>
                    <p>
                      Apache Spark · {status?.spark.isolation === "REMOTE_FUNCTION"
                        ? "远程隔离 Worker"
                        : "本地执行单元"}
                    </p>
                    <code>
                      {status?.spark.isolation === "REMOTE_FUNCTION"
                        ? status.spark.healthVerified
                          ? "远程健康检查通过"
                          : "远程端点未通过健康检查"
                        : "npm run v2:bootstrap"}
                    </code>
                  </article>
                  <article>
                    <Bot size={23} />
                    <h3>模型服务</h3>
                    <span
                      className={
                        "status-pill " +
                        (status?.model.configured ? "succeeded" : "queued")
                      }
                    >
                      {status?.model.configured
                        ? status.model.connectionVerified
                          ? "连接已验证"
                          : "已保存，连接未验证"
                        : "尚未保存密钥"}
                    </span>
                    <p>{status?.model.model}</p>
                    <code>DASHSCOPE_API_KEY</code>
                  </article>
                  <article>
                    <Database size={23} />
                    <h3>平台元数据库</h3>
                    <span
                      className={`status-pill ${status?.metadata.cloudVerified ? "succeeded" : "queued"}`}
                    >
                      {status?.metadata.cloudVerified
                        ? "云端持久化已连接"
                        : "本地 SQLite"}
                    </span>
                    <p>
                      {status?.metadata.driver === "mysql-project-snapshot-cas"
                        ? "MySQL元数据 · OSS业务状态"
                        : "独立存储版本和后台运行"}
                    </p>
                    <code>{status?.metadata.driver ?? "sqlite"}</code>
                    <small>
                      {status?.metadata.cloudVerified
                        ? status?.artifacts?.cloudVerified
                          ? "OSS不可变产物已实际核验"
                          : "OSS状态已连接，产物待首次实际核验"
                        : "云端 MySQL / OSS 尚未验收"}
                    </small>
                  </article>
                  <article>
                    <CircleDollarSign size={23} />
                    <h3>月度预算门</h3>
                    <span
                      className={`status-pill ${status?.budget?.enforced === "ALLOW" ? "succeeded" : "failed"}`}
                    >
                      {status?.budget?.enforced === "ALLOW"
                        ? "允许"
                        : status?.budget?.enforced === "HARD_STOP"
                          ? "硬停止"
                          : "资源停止"}
                    </span>
                    <p>
                      模型估算 ¥
                      {status?.budget?.model.estimatedCostCny.toFixed(3) ?? "0.000"}
                      / ¥{status?.budget?.model.limitCny ?? 50}
                    </p>
                    <code>
                      Spark {status?.budget?.remoteSpark.runCount ?? 0}/
                      {status?.budget?.remoteSpark.runLimit ?? 200} 次 · 硬上限 ¥
                      {status?.budget?.hardLimitCny ?? 200}
                    </code>
                    <small>
                      {status?.budget?.account.source === "NOT_CONNECTED"
                        ? "账号账单尚未接入，不能证明全站费用"
                        : `账号已核验 ¥${status?.budget?.account.observedSpendCny}`}
                    </small>
                  </article>
                </div>
                {status?.mode !== "LOCAL_DEVELOPMENT" &&
                  session.role === "ADMIN" && <InvitationPanel api={api} />}
                {status?.mode !== "LOCAL_DEVELOPMENT" &&
                  session.authenticated && (
                    <ChangePasswordPanel
                      api={api}
                      onChanged={(next) => {
                        setSession(next);
                        setNotice("密码已更新，此前登录会话均已撤销");
                      }}
                    />
                  )}
                <div className="definition-card">
                  <h3>连接真实模型服务</h3>
                  <p>
                    {status?.mode === "LOCAL_DEVELOPMENT"
                      ? "在百炼北京地域获取本项目专用 API Key，然后在下方粘贴。仅保存密钥，不会自动调用收费模型；不要使用公司凭证。"
                      : "公网部署的模型密钥只能由服务端秘密管理配置，浏览器与受邀用户均不能写入或读取。"}
                  </p>
                  <a
                    className="button"
                    href="https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    打开百炼 API Key 页面
                    <ArrowUpRight size={14} />
                  </a>
                  {status?.mode === "LOCAL_DEVELOPMENT" ? (
                  <form
                    className="model-key-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      setBusy(true);
                      setError("");
                      setModelSaveError("");
                      setModelSaved(false);
                      try {
                        const saved = await api<{ configured: boolean }>(
                          "/settings/model-key",
                          { apiKey: modelKey },
                        );
                        if (!saved.configured)
                          throw new Error(
                            "服务未确认保存成功，输入内容已保留。",
                          );
                        setModelKey("");
                        setStatus((previous) =>
                          previous
                            ? {
                                ...previous,
                                model: {
                                  ...previous.model,
                                  configured: true,
                                  connectionVerified: false,
                                  verifiedAt: null,
                                },
                              }
                            : previous,
                        );
                        setModelSaved(true);
                        setNotice("密钥已保存在本机；真实模型能力仍需实测");
                      } catch (e) {
                        setError((e as Error).message);
                        setModelSaveError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label htmlFor="model-key">百炼 API Key</label>
                    <div>
                      <input
                        id="model-key"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={modelKey}
                        onChange={(event) => setModelKey(event.target.value)}
                        placeholder="只在本机输入，不发送到聊天"
                        disabled={!canWrite}
                      />
                      <button
                        className="button primary"
                        type="submit"
                        disabled={busy || !canWrite}
                      >
                        {busy ? "正在保存…" : "保存到本机"}
                      </button>
                    </div>
                    {modelSaveError && (
                      <p role="alert" className="model-key-error">
                        {modelSaveError}
                      </p>
                    )}
                    {modelSaved && (
                      <p role="status" className="model-key-success">
                        已保存到本机。模型尚未调用验证，可以返回开发页试运行。
                      </p>
                    )}
                    <small>
                      保存为项目内仅本人可读写的
                      .env.local；不回显、不写入任务记录、不提交
                      Git。公网模式禁用此入口。
                    </small>
                  </form>
                  ) : (
                    <div className="public-model-boundary-v2">
                      <ShieldCheck size={17} />
                      <div>
                        <strong>网页密钥入口已关闭</strong>
                        <p>
                          部署管理员在云端秘密管理中配置；项目成员只能看到“已配置/未配置”，不能看到或替换值。
                        </p>
                      </div>
                    </div>
                  )}
                  <p>
                    本地开发运行：npm run
                    v2:dev。公网写入将在邀请认证、隔离执行与预算验收后开放。
                  </p>
                  <small>
                    计划约束：200 元/月以内 · 内地部署与域名备案 · 少量受邀用户
                  </small>
                </div>
                <CloudReadinessPanel api={api} />
              </>
            ) : (
              <>
                <div className="stage-card">
                  <span className="stage-label">
                    {active?.stage} · 已纳入新版计划
                  </span>
                  <h2>
                    {nav === "services"
                      ? "让业务数据成为可调用的服务"
                      : "让 " + active?.name + " 与 Agent 协同工作"}
                  </h2>
                  <p>
                    {nav === "services"
                      ? "DAPI 通过参数化 SQL 提供查询；XAPI 编排多个查询和接口。发布、授权、版本和监控共同建设。"
                      : "该模块将与代码工作台共用项目上下文、资源模型与运行记录。当前显示规划范围，未宣称已具备实际执行能力。"}
                  </p>
                  <div className="feature-list">
                    {active?.features.map((f) => (
                      <div key={f}>
                        <Circle size={13} />
                        {f}
                      </div>
                    ))}
                  </div>
                  <button
                    className="button primary"
                    onClick={() => setNav("development")}
                  >
                    体验已实现的代码工作台
                    <ArrowRight size={15} />
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        <footer className="statusbar">
          <span>
            <span className={"connection-dot " + (status ? "online" : "")} />
            {status ? "服务已连接" : "正在连接服务"}
          </span>
          <span>经典中台 × Data Agent</span>
          <span className="statusbar-right">
            合成证券数据 · {status?.mode === "LOCAL_DEVELOPMENT" ? "本地开发验证" : session.authenticated ? "受邀项目会话" : "公开只读演示"}
          </span>
        </footer>
      </main>
      {notice && (
        <div role="status" className="toast">
          <CheckCircle2 size={17} />
          {notice}
        </div>
      )}
      {authOpen && (
        <AuthDialog
          api={api}
          onClose={() => setAuthOpen(false)}
          onAuthenticated={(nextSession) => {
            setSession(nextSession);
            setNotice("受邀项目会话已建立");
          }}
        />
      )}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={modal === "versions" ? "代码版本" : "搜索功能"}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>{modal === "versions" ? "代码版本" : "快速前往"}</h2>
              <button aria-label="关闭对话框" onClick={() => setModal(null)}>
                <X size={18} />
              </button>
            </header>
            {modal === "search" ? (
              <>
                <input
                  autoFocus
                  aria-label="搜索功能"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索模块、DAPI、质量…"
                />
                {status?.capabilities
                  .filter((c) =>
                    (c.name + c.features.join(""))
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((c) => (
                    <button
                      className="search-result"
                      key={c.id}
                      onClick={() => {
                        setNav(c.id);
                        setModal(null);
                        setQuery("");
                      }}
                    >
                      <span>{c.name}</span>
                      <small>{c.description}</small>
                      <ArrowRight size={14} />
                    </button>
                  ))}
              </>
            ) : (
              <div className="versions">
                {revisions.length ? (
                  revisions.map((v, i) => (
                    <button
                      key={v.id}
                      onClick={() => {
                        setOriginal(sql);
                        setSql(v.sql);
                        setContextId(v.contextId);
                        setDiff(true);
                        setModal(null);
                      }}
                    >
                      <FileCode2 size={17} />
                      <div>
                        <strong>
                          版本 {revisions.length - i}{" "}
                          <small>
                            {v.source === "LIVE_MODEL"
                              ? "Agent 生成"
                              : "人工保存"}
                          </small>
                        </strong>
                        <code>{v.hash.slice(0, 12)}</code>
                      </div>
                      <time>{time(v.createdAt)}</time>
                      <GitCompareArrows size={16} />
                    </button>
                  ))
                ) : (
                  <p>点击“保存”创建第一个不可变代码版本。</p>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
