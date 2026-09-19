import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CircleDot,
  Clock3,
  Code2,
  Database,
  ExternalLink,
  FileCheck2,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Risk = "LOW" | "MEDIUM" | "HIGH";
type Destination = { id: string; label: string; action: string; risk: Risk };
type RouteStep = { destinationId: string; label: string; risk: Risk; objective: string };
type IntentRoute = {
  destinationId: string;
  destination: Destination;
  summary: string;
  rationale: string;
  confidence: number;
  steps?: RouteStep[];
  execution: "NO_EXECUTION";
  requiresHumanReview: boolean;
  notice: string;
};
type IntentTask = {
  id: string;
  status: string;
  messageHash?: string;
  messageLength?: number;
  approvalMode?: "PLAN_ONLY" | "REQUEST_APPROVAL";
  route?: IntentRoute;
  model?: string;
  usage?: { total_tokens?: number };
  error?: string;
  createdAt: string;
  finishedAt?: string;
};
type IntentTrace = {
  id: string;
  sequence: number;
  kind: "MODEL_ROUTE" | "STEP_APPROVAL" | "SPECIALIST_HANDOFF" | "INTENT_CANCELLED" | "SPECIALIST_CANCELLED";
  status: string;
  output?: { destinationId?: string; stepCount?: number; confidence?: number };
  execution: "NO_EXECUTION" | "SPECIALIST_TASK_CANCELLED";
  observedAt: string;
};
type Handoff = { id: string; destinationId: string; status: string; objective: string; specialistTaskId?: string; specialistTaskKind?: string };
type StepApproval = { id: string; destinationId: string; status: "APPROVED" | "BOUND" | "REVOKED"; risk: Risk; approvedAt: string; specialistTaskId?: string };
type IntentGraph = { intentId: string; completedCount: number; totalCount: number; completionScope: string; agentIndependentE2E: false; publicDeployed: false; steps: { destinationId: string; status: string; approvalStatus?: string; specialistTaskId?: string; specialistTaskKind?: string; specialistStatus?: string }[] };
type AgentTool = { id: string; label: string; risk: Risk; approvalRequired: boolean; createMode: string; createPath: string; detailPath: string; applyPath?: string; requiresDestination?: string };
type AgentToolCatalog = { version: string; tools: AgentTool[] };
type SpecialistActivity = {
  destinationId: string;
  id: string;
  status: string;
  getPath: string;
  result?: Record<string, unknown>;
  error?: string;
  applied?: boolean;
  linkPending?: boolean;
};

const destinations: Destination[] = [
  { id: "sources", label: "数据源与离线同步", action: "连接、采集元数据并生成同步配置", risk: "MEDIUM" },
  { id: "sync", label: "实时同步", action: "设计实时任务、Checkpoint与恢复策略", risk: "MEDIUM" },
  { id: "development", label: "数据开发", action: "生成、调试并用Spark验证SQL", risk: "MEDIUM" },
  { id: "schedules", label: "调度与发布", action: "生成交付包、调度与部署文件", risk: "HIGH" },
  { id: "assets", label: "数据资产与契约", action: "找数据、解释口径与评估影响", risk: "LOW" },
  { id: "quality", label: "数据质量", action: "设计规则、检测并关联异常", risk: "MEDIUM" },
  { id: "security", label: "安全与脱敏", action: "生成最小权限与脱敏策略草稿", risk: "HIGH" },
  { id: "services", label: "数据服务", action: "设计DAPI/XAPI并验证契约", risk: "MEDIUM" },
  { id: "reports", label: "数据报表", action: "设计数据集、指标和可视化", risk: "LOW" },
  { id: "ops", label: "运维监控", action: "诊断运行证据、告警和恢复链", risk: "HIGH" },
];
const byDestination = new Map(destinations.map((item) => [item.id, item]));
const pending = (status?: string) => ["QUEUED", "RUNNING"].includes(status ?? "");
const succeeded = (status?: string) => ["SUCCEEDED", "APPLIED"].includes(status ?? "");
const retryable = (status?: string) => ["FAILED", "CANCELLED", "INTERRUPTED"].includes(status ?? "");
const riskLabel: Record<Risk, string> = {
  LOW: "只读 / 低风险",
  MEDIUM: "变更前审阅",
  HIGH: "人工批准关口",
};
const fillToolPath = (template: string, id: string) =>
  template.replace("{id}", encodeURIComponent(id));
const activityArtifactRows = (activity?: SpecialistActivity) => {
  if (!activity?.result) return [] as { label: string; value: string | string[] }[];
  const source = activity.result,
    rows: { label: string; value: string | string[] }[] = [],
    add = (label: string, value: unknown) => {
      if (typeof value === "string" && value.trim()) rows.push({ label, value });
      else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
        rows.push({ label, value });
      else if (value && typeof value === "object")
        rows.push({ label, value: JSON.stringify(value, null, 2).slice(0, 2400) });
    };
  const insight = source.insight as Record<string, unknown> | undefined,
    plan = source.plan as Record<string, unknown> | undefined,
    diagnosis = source.diagnosis as Record<string, unknown> | undefined;
  if (insight) {
    add("Agent回答", insight.answer);
    add("引用资产", insight.assetIds);
    add("证据边界", insight.caveats);
  }
  if (plan) add("方案", plan);
  if (diagnosis) add("诊断", diagnosis);
  add("说明", source.explanation);
  add("代码版本", source.revisionId);
  add("运行批次", source.runId);
  add("交付包", source.packageId);
  add("完成范围", source.completionScope);
  add("模型", source.model);
  return rows;
};

export function AgentCenter({
  api,
  canWrite,
  modelConfigured,
  contextId,
  currentSql,
  onOpenDestination,
}: {
  api: Api;
  canWrite: boolean;
  modelConfigured: boolean;
  contextId: string;
  currentSql: string;
  onOpenDestination: (id: string, handoffMessage?: string) => void;
}) {
  const [message, setMessage] = useState(""),
    [approvalMode, setApprovalMode] = useState<"PLAN_ONLY" | "REQUEST_APPROVAL">("REQUEST_APPROVAL"),
    [tasks, setTasks] = useState<IntentTask[]>([]),
    [task, setTask] = useState<IntentTask>(),
    [trace, setTrace] = useState<IntentTrace[]>([]),
    [graph, setGraph] = useState<IntentGraph>(),
    [toolCatalog, setToolCatalog] = useState<AgentToolCatalog>(),
    [approvals, setApprovals] = useState<StepApproval[]>([]),
    [handoffs, setHandoffs] = useState<Handoff[]>([]),
    [activities, setActivities] = useState<Record<string, SpecialistActivity>>({}),
    [submittedMessages, setSubmittedMessages] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [cancelBusy, setCancelBusy] = useState(false),
    [childCancelBusy, setChildCancelBusy] = useState(""),
    [error, setError] = useState("");

  const toolById = useMemo(
    () => new Map((toolCatalog?.tools ?? []).map((tool) => [tool.id, tool])),
    [toolCatalog],
  );
  const requireTool = (
    destinationId: string,
    catalog = toolCatalog,
  ) => {
    const tool = catalog?.tools.find((item) => item.id === destinationId);
    if (!tool) throw new Error("专业Agent工具目录缺失或版本不匹配");
    return tool;
  };

  const loadTask = async (
    selected?: IntentTask,
    catalog = toolCatalog,
  ) => {
    if (!selected) {
      setTask(undefined);
      setTrace([]);
      setGraph(undefined);
      setApprovals([]);
      setHandoffs([]);
      setActivities({});
      return;
    }
    setTask(selected);
    const [nextTrace, nextGraph, nextApprovals, nextHandoffs] = await Promise.all([
      api<IntentTrace[]>(`/agent/intents/${selected.id}/trace`),
      api<IntentGraph>(`/agent/intents/${selected.id}/graph`),
      api<StepApproval[]>(`/agent/intents/${selected.id}/approvals`),
      api<Handoff[]>(`/agent/intents/${selected.id}/handoffs`),
    ]);
    setTrace(nextTrace);
    setGraph(nextGraph);
    setApprovals(nextApprovals);
    setHandoffs(nextHandoffs);
    const restored: Record<string, SpecialistActivity> = {};
    await Promise.all(
      nextGraph.steps
        .filter((item) => item.specialistTaskId)
        .map(async (item) => {
          const getPath = fillToolPath(
            requireTool(item.destinationId, catalog).detailPath,
            item.specialistTaskId!,
          );
          try {
            const result = await api<Record<string, unknown>>(getPath);
            restored[item.destinationId] = {
              destinationId: item.destinationId,
              id: item.specialistTaskId!,
              status: String(result.status ?? "UNKNOWN"),
              getPath,
              result,
              applied: result.status === "APPLIED",
            };
          } catch (cause) {
            restored[item.destinationId] = {
              destinationId: item.destinationId,
              id: item.specialistTaskId!,
              status: "FAILED",
              getPath,
              error: (cause as Error).message,
            };
          }
        }),
    );
    setActivities(restored);
  };
  const refresh = async (
    preferredId?: string,
    catalog = toolCatalog,
  ) => {
    const next = await api<IntentTask[]>("/agent/intents");
    setTasks(next);
    const selected = next.find((item) => item.id === (preferredId ?? task?.id)) ?? next[0];
    await loadTask(selected, catalog);
  };
  useEffect(() => {
    void (async () => {
      try {
        const catalog = await api<AgentToolCatalog>("/agent/tools");
        setToolCatalog(catalog);
        await refresh(undefined, catalog);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);
  useEffect(() => {
    if (!pending(task?.status)) return;
    const timer = setInterval(() => {
      refresh(task?.id).catch((cause) => setError((cause as Error).message));
    }, 1200);
    return () => clearInterval(timer);
  }, [task?.id, task?.status, toolCatalog?.version]);
  useEffect(() => {
    const pendingActivities = Object.values(activities).filter((item) => pending(item.status));
    if (!pendingActivities.length) return;
    const timer = setInterval(async () => {
      for (const item of pendingActivities) {
        try {
          const current = await api<Record<string, unknown>>(item.getPath);
          setActivities((all) => ({
            ...all,
            [item.destinationId]: {
              ...item,
              status: String(current.status ?? item.status),
              result: current,
            },
          }));
          if (!pending(String(current.status ?? item.status)) && task?.id)
            setGraph(await api<IntentGraph>(`/agent/intents/${task.id}/graph`));
        } catch (cause) {
          setActivities((all) => ({
            ...all,
            [item.destinationId]: { ...item, status: "FAILED", error: (cause as Error).message },
          }));
        }
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [activities]);

  const resetTask = () => {
    setTask(undefined);
    setMessage("");
    setTrace([]);
    setGraph(undefined);
    setApprovals([]);
    setHandoffs([]);
    setActivities({});
    setError("");
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await api<IntentTask>("/agent/intents", { message, approvalMode });
      setSubmittedMessages((current) => ({ ...current, [created.id]: message.trim() }));
      setTasks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setTask(created);
      setTrace([]);
      setGraph(undefined);
      setApprovals([]);
      setHandoffs([]);
      setActivities({});
      setMessage("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prepareStep = async (step: RouteStep) => {
    if (!task) return;
    setError("");
    setActivities((all) => ({
      ...all,
      [step.destinationId]: { destinationId: step.destinationId, id: "preparing", status: "QUEUED", getPath: "" },
    }));
    try {
      const approval = task.approvalMode === "REQUEST_APPROVAL"
        ? await api<StepApproval>(`/agent/intents/${task.id}/approvals`, {
            destinationId: step.destinationId,
          })
        : undefined;
      if (approval)
        setApprovals((items) => [
          approval,
          ...items.filter((item) => item.id !== approval.id),
        ]);
      const tool = requireTool(step.destinationId),
        requiredActivity = tool.requiresDestination
          ? activities[tool.requiresDestination]
          : undefined;
      if (
        tool.requiresDestination &&
        (!requiredActivity || requiredActivity.status !== "SUCCEEDED")
      )
        throw new Error("请先完成当前步骤要求的前置专业任务，再继续执行。");
      let created: Record<string, unknown>;
      const pendingLink = activities[step.destinationId]?.linkPending
        ? activities[step.destinationId]
        : undefined;
      if (pendingLink?.result) {
        created = pendingLink.result;
      } else if (tool.createMode === "SQL_DEVELOPMENT") {
        created = await api<Record<string, unknown>>(tool.createPath, {
          message: step.objective,
          contextId,
          sql: currentSql || "SELECT 1",
        });
      } else if (tool.createMode === "DELIVERY_FROM_DEVELOPMENT") {
        const source = activities[tool.requiresDestination!];
        created = await api<Record<string, unknown>>(
          tool.createPath.replace("{sourceTaskId}", encodeURIComponent(source.id)),
          {},
        );
      } else {
        created = await api<Record<string, unknown>>(tool.createPath, {
          message: step.objective,
        });
      }
      const id = String(created.id),
        getPath = fillToolPath(tool.detailPath, id);
      setActivities((all) => ({
        ...all,
        [step.destinationId]: {
          destinationId: step.destinationId,
          id,
          status: String(created.status ?? "QUEUED"),
          getPath,
          result: created,
          linkPending: true,
        },
      }));
      await api(`/agent/intents/${task.id}/handoffs`, {
        destinationId: step.destinationId,
        specialistTaskId: id,
        ...(approval ? { approvalId: approval.id } : {}),
      });
      setActivities((all) => ({
        ...all,
        [step.destinationId]: {
          destinationId: step.destinationId,
          id,
          status: String(created.status ?? "QUEUED"),
          getPath,
          result: created,
          linkPending: false,
        },
      }));
      setTrace(await api<IntentTrace[]>(`/agent/intents/${task.id}/trace`));
      setGraph(await api<IntentGraph>(`/agent/intents/${task.id}/graph`));
      setApprovals(await api<StepApproval[]>(`/agent/intents/${task.id}/approvals`));
      setHandoffs(await api<Handoff[]>(`/agent/intents/${task.id}/handoffs`));
    } catch (cause) {
      setActivities((all) => ({
        ...all,
        [step.destinationId]: {
          ...(all[step.destinationId] ?? { destinationId: step.destinationId, id: "failed", getPath: "" }),
          status: "FAILED",
          linkPending: all[step.destinationId]?.linkPending,
          error: (cause as Error).message,
        },
      }));
    }
  };

  const cancelIntent = async () => {
    if (!task) return;
    setCancelBusy(true);
    setError("");
    try {
      const cancelled = await api<IntentTask>(`/agent/intents/${task.id}/cancel`, {});
      setTask(cancelled);
      await loadTask(cancelled);
      setTasks((items) =>
        items.map((item) => (item.id === cancelled.id ? cancelled : item)),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setCancelBusy(false);
    }
  };

  const openProfessionalWorkspace = async (step: RouteStep) => {
    if (!task) return;
    setError("");
    try {
      await api(`/agent/intents/${task.id}/handoffs`, {
        destinationId: step.destinationId,
      });
      setTrace(await api<IntentTrace[]>(`/agent/intents/${task.id}/trace`));
      setHandoffs(await api<Handoff[]>(`/agent/intents/${task.id}/handoffs`));
      setGraph(await api<IntentGraph>(`/agent/intents/${task.id}/graph`));
      onOpenDestination(step.destinationId, step.objective);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const cancelSpecialist = async (step: RouteStep) => {
    if (!task) return;
    setChildCancelBusy(step.destinationId);
    setError("");
    try {
      const result = await api<{ child: { id: string; status: string }; graph: IntentGraph }>(
        `/agent/intents/${task.id}/children/${step.destinationId}/cancel`,
        {},
      );
      setActivities((items) => ({
        ...items,
        [step.destinationId]: {
          ...items[step.destinationId],
          status: result.child.status,
        },
      }));
      setGraph(result.graph);
      setTrace(await api<IntentTrace[]>(`/agent/intents/${task.id}/trace`));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setChildCancelBusy("");
    }
  };

  const applyDraft = async (step: RouteStep) => {
    const activity = activities[step.destinationId],
      applyTemplate = toolById.get(step.destinationId)?.applyPath,
      applyPath = activity && applyTemplate
        ? fillToolPath(applyTemplate, activity.id)
        : undefined;
    if (!activity || !applyPath) return;
    try {
      await api(applyPath, {});
      const result = await api<Record<string, unknown>>(activity.getPath);
      setActivities((all) => ({
        ...all,
        [step.destinationId]: {
          ...activity,
          status: String(result.status ?? "APPLIED"),
          result,
          applied: true,
        },
      }));
      if (task?.id)
        setGraph(await api<IntentGraph>(`/agent/intents/${task.id}/graph`));
    } catch (cause) {
      setActivities((all) => ({
        ...all,
        [step.destinationId]: { ...activity, error: (cause as Error).message },
      }));
    }
  };

  const route = task?.route,
    steps = route?.steps ?? (route ? [{ destinationId: route.destinationId, label: route.destination.label, risk: route.destination.risk, objective: route.summary }] : []),
    selectedMessage = task ? submittedMessages[task.id] : undefined,
    completedCount = graph?.completedCount ?? steps.filter((step) => succeeded(activities[step.destinationId]?.status)).length,
    taskTitle = (item: IntentTask) => item.route?.summary ?? (pending(item.status) ? "正在理解新任务" : item.status === "INTERRUPTED" ? "服务重启后中断的Agent任务" : item.status === "CANCELLED" ? "已停止的Agent任务" : "未完成的Agent任务"),
    capabilityGroups = useMemo(
      () => [
        { label: "接入与计算", icon: Database, ids: ["sources", "sync", "development"] },
        { label: "交付与治理", icon: Layers3, ids: ["schedules", "assets", "quality", "security"] },
        { label: "服务与运营", icon: Activity, ids: ["services", "reports", "ops"] },
      ],
      [],
    );

  return (
    <div className="agent-os-v2">
      <aside className="agent-os-history-v2">
        <header><div><Sparkles size={17} /><strong>数舵 Data Agent</strong></div><button aria-label="新建Agent任务" onClick={resetTask}><Plus size={16} /></button></header>
        <button className="agent-os-new-v2" onClick={resetTask}><MessageSquare size={15} />新任务</button>
        <span className="agent-os-section-label-v2">任务历史</span>
        <div className="agent-os-task-list-v2">
          {tasks.length ? tasks.map((item) => (
            <button key={item.id} className={item.id === task?.id ? "selected" : ""} onClick={() => loadTask(item).catch((cause) => setError((cause as Error).message))}>
              <span>{pending(item.status) ? <LoaderCircle className="spin" size={13} /> : <MessageSquare size={13} />}</span>
              <div><strong>{taskTitle(item)}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></div>
            </button>
          )) : <p>还没有任务。直接描述目标，不必先找模块。</p>}
        </div>
        <div className="agent-os-history-foot-v2"><ShieldCheck size={14} /><span>继承项目身份、权限、预算与审计</span></div>
      </aside>

      <section className="agent-os-chat-v2">
        <header className="agent-os-chat-head-v2"><div><span className="eyebrow">INDEPENDENT AGENT WORKSPACE</span><h2>{task ? taskTitle(task) : "你想完成什么数据工作？"}</h2></div><div className="agent-os-head-meta-v2"><span>证券数据实验室</span><span>{modelConfigured ? "模型已连接" : "模型待连接"}</span></div></header>
        {error && <div className="agent-os-error-v2" role="alert">{error}</div>}
        <div className="agent-os-thread-v2">
          {!task && <section className="agent-os-empty-v2">
            <div className="agent-os-orbit-v2"><Bot size={30} /></div><h1>从目标出发，不从模块出发。</h1>
            <p>告诉我你要得到的业务结果。数舵会理解需求、规划步骤、调用数据中台能力，并把代码、任务、报表与运行证据留在同一个会话中。</p>
            <div className="agent-os-prompts-v2">{["接入虚构持仓数据，开发T+1客户资产任务并发布DAPI", "找到客户持仓口径，生成质量规则和资产分析报表", "诊断昨日失败批次，分析影响并准备恢复方案"].map((prompt) => <button key={prompt} onClick={() => setMessage(prompt)}>{prompt}<ArrowRight size={13} /></button>)}</div>
          </section>}
          {task && <>
            <article className="agent-os-message-v2 user"><div>{selectedMessage ?? "任务原文已按隐私策略不持久化；以下展示Agent生成的安全摘要。"}</div></article>
            <article className="agent-os-message-v2 assistant"><span className="agent-os-avatar-v2"><Bot size={16} /></span><div>
              {pending(task.status) ? <div className="agent-os-thinking-v2"><LoaderCircle className="spin" size={15} />正在理解目标、匹配上下文并规划跨域步骤…</div> : route ? <>
                <p>{route.summary}</p><small>{route.rationale}</small>
                <div className="agent-os-plan-v2"><header><div><FileCheck2 size={15} /><strong>执行计划</strong></div><span>{completedCount}/{graph?.totalCount ?? steps.length} 已完成 · {graph ? "持久任务图" : "加载中"}</span></header><ol>{steps.map((step, index) => {
                  const activity = activities[step.destinationId], approval = approvals.find((item) => item.destinationId === step.destinationId), prepared = handoffs.some((item) => item.destinationId === step.destinationId), canApply = activity?.status === "SUCCEEDED" && Boolean(toolById.get(step.destinationId)?.applyPath), artifactRows = activityArtifactRows(activity), complete = succeeded(activity?.status);
                  return <li key={step.destinationId} className={complete ? "complete" : retryable(activity?.status) ? "failed" : ""}><span>{complete ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span><div><div className="agent-os-step-title-v2"><strong>{step.label}</strong><small>{riskLabel[step.risk]}</small></div><p>{step.objective}</p>
                    {activity && <div className="agent-os-activity-v2"><CircleDot size={12} /><span>{complete ? activity.applied ? "专业草稿已写入" : "专业Agent已完成" : activity.status === "FAILED" ? activity.error : activity.status === "CANCELLED" ? "专业Agent已取消" : activity.status === "INTERRUPTED" ? "服务重启后专业任务已中断" : "专业Agent执行中"}</span>{activity.id !== "preparing" && activity.id !== "failed" && <code>{activity.id.slice(0, 8)}</code>}</div>}
                    {approval && <div className="agent-os-activity-v2"><ShieldCheck size={12} /><span>{approval.status === "BOUND" ? "本次批准已绑定专业任务" : "步骤已批准，等待绑定任务"}</span><code>{approval.id.slice(0, 8)}</code></div>}
                    {artifactRows.length > 0 && <details className="agent-os-artifact-v2"><summary>查看专业Agent产物</summary><div>{artifactRows.map((row) => <section key={row.label}><span>{row.label}</span>{Array.isArray(row.value) ? <div className="agent-os-artifact-tags-v2">{row.value.map((item) => <code key={item}>{item}</code>)}</div> : <p>{row.value}</p>}</section>)}</div></details>}
                    <div className="agent-os-step-actions-v2">{task.status !== "CANCELLED" && task.approvalMode !== "PLAN_ONLY" && (!activity || retryable(activity.status)) && <button onClick={() => prepareStep(step)} disabled={!canWrite || !modelConfigured}><Wrench size={13} />{retryable(activity?.status) ? "重新批准并重试" : "批准并执行此步骤"}</button>}{activity && pending(activity.status) && <button className="secondary" onClick={() => cancelSpecialist(step)} disabled={!canWrite || childCancelBusy === step.destinationId}><Clock3 size={12} />{childCancelBusy === step.destinationId ? "正在取消…" : "取消专业子任务"}</button>}{canApply && !activity.applied && <button onClick={() => applyDraft(step)}><Check size={13} />应用为草稿</button>}{activity?.applied && <span className="agent-os-applied-v2"><Check size={12} />草稿已写入</span>}<button className="secondary" onClick={() => openProfessionalWorkspace(step)}><ExternalLink size={12} />记录接管并打开工作台</button></div>
                    {prepared && !activity && <small className="agent-os-prepared-v2">已准备专业Agent输入，尚未执行工具。</small>}
                  </div></li>;
                })}</ol></div>
                <div className="agent-os-step-actions-v2">{task.status === "CANCELLED" ? <span className="agent-os-applied-v2"><Check size={12} />已停止后续编排</span> : <button className="secondary" onClick={cancelIntent} disabled={!canWrite || cancelBusy}><Clock3 size={12} />{cancelBusy ? "正在停止…" : "停止后续编排"}</button>}</div>
                {trace.length > 0 && <details className="agent-os-trace-v2"><summary>查看执行轨迹与证据</summary>{trace.map((item) => <div key={item.id}><span>{item.sequence}</span><strong>{item.kind === "MODEL_ROUTE" ? "需求理解与规划" : item.kind === "STEP_APPROVAL" ? "人工批准专业步骤" : item.kind === "INTENT_CANCELLED" ? "停止后续编排" : item.kind === "SPECIALIST_CANCELLED" ? "取消专业子任务" : "专业Agent任务绑定"}</strong><small>{item.output?.destinationId ?? "—"} · {item.execution} · {new Date(item.observedAt).toLocaleTimeString("zh-CN")}</small></div>)}</details>}
              </> : <p>{task.status === "INTERRUPTED" ? "服务重启时任务尚未完成；原始需求未持久化，请新建任务并重新描述目标。" : task.status === "CANCELLED" ? "后续编排已停止，历史证据仍保留。" : task.error ?? "Agent未能形成可执行计划。"}</p>}
            </div></article>
          </>}
        </div>
        <footer className="agent-os-composer-v2">
          <textarea aria-label="向数舵 Data Agent 描述目标" placeholder="描述你希望完成的目标，例如：接入持仓数据，生成T+1资产任务并发布服务…" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && canWrite && modelConfigured && !busy && message.trim().length >= 4) { event.preventDefault(); submit(); } }} maxLength={2000} />
          <div><div className="agent-os-context-v2"><span>@ 证券数据实验室</span><span><Code2 size={11} />{contextId}</span><span>{approvalMode === "PLAN_ONLY" ? "只规划" : "请求批准"}</span></div><div className="agent-os-send-v2"><select aria-label="Agent审批模式" value={approvalMode} onChange={(event) => setApprovalMode(event.target.value as typeof approvalMode)}><option value="REQUEST_APPROVAL">请求批准</option><option value="PLAN_ONLY">仅规划</option></select><button aria-label="发送给Data Agent" onClick={submit} disabled={!canWrite || !modelConfigured || busy || message.trim().length < 4}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div></div>
          <small>Agent可以调用所有经典中台能力；读操作、草稿、发布和权限变更按风险分级，生产上线仍需独立批准。</small>
        </footer>
      </section>

      <aside className="agent-os-inspector-v2">
        <header><strong>能力与上下文</strong><span>{toolCatalog?.tools.length ?? 10}个专业域</span></header>
        <section><span className="agent-os-section-label-v2">当前上下文</span><div className="agent-os-context-card-v2"><Database size={16} /><div><strong>证券数据实验室</strong><small>虚构数据 · 项目权限继承</small></div></div><div className="agent-os-context-card-v2"><Code2 size={16} /><div><strong>{contextId}</strong><small>Spark SQL · 当前编辑版本</small></div></div></section>
        <section><span className="agent-os-section-label-v2">专业能力</span>{capabilityGroups.map((group) => { const Icon = group.icon; return <div className="agent-os-capability-v2" key={group.label}><div><Icon size={14} /><strong>{group.label}</strong></div>{group.ids.map((id) => <span key={id}>{byDestination.get(id)?.label}</span>)}</div>; })}</section>
        <section className="agent-os-governance-v2"><span className="agent-os-section-label-v2">治理边界</span><p><ShieldCheck size={14} />继承用户权限，不向模型发送凭证或业务明细。</p><p><Clock3 size={14} />长任务后台运行，状态与证据可恢复。</p><p><FileCheck2 size={14} />发布、授权和高成本操作必须确认。</p></section>
        <footer><Activity size={13} />GUI / API / CLI / MCP 同源 · {toolCatalog?.version ?? "工具目录加载中"}</footer>
      </aside>
    </div>
  );
}
