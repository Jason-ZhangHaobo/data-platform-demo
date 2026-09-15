import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  Compass,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Destination = {
  id: string;
  label: string;
  action: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
};
type IntentRoute = {
  destinationId: string;
  destination: Destination;
  summary: string;
  rationale: string;
  confidence: number;
  steps?: { destinationId: string; label: string; risk: "LOW" | "MEDIUM" | "HIGH"; objective: string }[];
  execution: "NO_EXECUTION";
  requiresHumanReview: boolean;
  notice: string;
};
type IntentTask = {
  id: string;
  status: string;
  message: string;
  route?: IntentRoute;
  model?: string;
  usage?: { total_tokens?: number };
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

const destinations: Destination[] = [
  { id: "development", label: "数据开发", action: "生成或修正 Spark SQL，并进入真实运行与断言", risk: "MEDIUM" },
  { id: "sources", label: "数据源与离线同步", action: "设计连接、元数据采集或离线同步草稿", risk: "MEDIUM" },
  { id: "sync", label: "实时同步", action: "设计受限实时任务草稿，不启动消费", risk: "MEDIUM" },
  { id: "assets", label: "数据资产与契约", action: "找数据、解释口径或评估版本影响", risk: "LOW" },
  { id: "quality", label: "数据质量", action: "设计规则草稿并说明实际检测范围", risk: "MEDIUM" },
  { id: "security", label: "安全与脱敏", action: "设计最小权限策略；不查询、不审批", risk: "HIGH" },
  { id: "services", label: "数据服务", action: "设计 DAPI/XAPI 草稿；不发布、不发令牌", risk: "MEDIUM" },
  { id: "reports", label: "数据报表", action: "设计受治理数据集或报表草稿", risk: "LOW" },
  { id: "schedules", label: "调度与发布", action: "查看交付包、审阅与调度证据；不自动审批或发布", risk: "HIGH" },
  { id: "ops", label: "运维监控", action: "基于事故摘要提出不可执行诊断建议", risk: "HIGH" },
];

const pending = (status?: string) => ["QUEUED", "RUNNING"].includes(status ?? "");
const riskLabel: Record<string, string> = { LOW: "低风险", MEDIUM: "需审阅", HIGH: "高风险 · 人工关口" };

export function AgentCenter({
  api,
  canWrite,
  modelConfigured,
  onOpenDestination,
}: {
  api: Api;
  canWrite: boolean;
  modelConfigured: boolean;
  onOpenDestination: (id: string, handoffMessage?: string) => void;
}) {
  const [message, setMessage] = useState(
      "财富顾问需要理解客户持仓字段，生成资产分析报表，并说明数据口径。",
    ),
    [tasks, setTasks] = useState<IntentTask[]>([]),
    [task, setTask] = useState<IntentTask>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refresh = async () => {
    const next = await api<IntentTask[]>("/agent/intents");
    setTasks(next);
    setTask(next[0]);
  };
  useEffect(() => {
    refresh().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (!pending(task?.status)) return;
    const timer = setInterval(() => {
      refresh().catch((cause) => setError((cause as Error).message));
    }, 1200);
    return () => clearInterval(timer);
  }, [task?.status]);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await api<IntentTask>("/agent/intents", { message });
      setTask(created);
      setTasks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const route = task?.route;
  return (
    <div className="agent-center-v2">
      <section className="agent-center-hero-v2">
        <div>
          <span className="eyebrow">UNIFIED DATA AGENT · GOVERNED ROUTING</span>
          <h2>一个入口，理解任务；多个模块，各自受治理。</h2>
          <p>
            Agent 只在白名单模块中理解你的意图并推荐下一步。真正的数据读写、运行、审批、发布与权限操作仍由对应模块的 API、身份和证据链控制。
          </p>
        </div>
        <div className="agent-center-hero-proof-v2">
          <ShieldCheck size={21} />
          <strong>默认不执行</strong>
          <small>不传业务行、凭证或内部地址</small>
        </div>
      </section>
      {error && <div className="agent-center-error-v2" role="alert">{error}</div>}
      <section className="agent-center-compose-v2">
        <header><Bot size={20} /><div><h3>描述你的数据任务</h3><p>例如：开发 SQL、配置同步、查找资产、设计质量规则、发布数据服务或诊断事故。</p></div></header>
        <textarea aria-label="跨模块 Data Agent 需求" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} />
        <div className="agent-center-compose-actions-v2">
          <small>{modelConfigured ? "会调用已配置模型，只生成路由建议；费用受月度预算门约束。" : "尚未连接模型：可浏览模块，但不能提交任务理解。"}</small>
          <button className="button primary" onClick={submit} disabled={!canWrite || !modelConfigured || busy || message.trim().length < 4}>
            {busy || pending(task?.status) ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
            理解并推荐下一步
          </button>
        </div>
      </section>
      {task && <section className="agent-center-result-v2">
        <header><div><span className="eyebrow">LATEST INTENT</span><h3>{pending(task.status) ? "正在理解任务…" : task.status === "SUCCEEDED" ? "推荐结果" : "未能形成推荐"}</h3></div><span className={`status-pill ${task.status.toLowerCase()}`}>{pending(task.status) ? <Clock3 size={13} /> : <CheckCircle2 size={13} />}{task.status}</span></header>
        {route ? <><div className="agent-route-v2"><div><span>推荐起点</span><strong>{route.destination.label}</strong><small>{riskLabel[route.destination.risk]}</small></div><div><span>任务摘要</span><p>{route.summary}</p></div><div><span>为什么</span><p>{route.rationale}</p></div><div className="agent-route-action-v2"><small>置信度 {(route.confidence * 100).toFixed(0)}% · 不自动执行</small><button className="button" onClick={() => onOpenDestination(route.destinationId, (route.steps ?? [{ objective: route.summary }])[0].objective)}><Compass size={15} />进入{route.destination.label}<ArrowRight size={14} /></button></div></div><ol className="agent-route-steps-v2">{(route.steps ?? [{ destinationId: route.destinationId, label: route.destination.label, risk: route.destination.risk, objective: route.summary }]).map((step, index, steps) => <li key={step.destinationId}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step.label}</strong><small>{riskLabel[step.risk]}</small><p>{step.objective}</p><button aria-label={`带入${step.label}专业Agent`} onClick={() => onOpenDestination(step.destinationId, step.objective)}>带入专业Agent <ArrowRight size={12} /></button></div>{index + 1 < steps.length && <ArrowRight size={15} />}</li>)}</ol></> : <p>{task.error ?? "等待模型返回受治理路由。"}</p>}
      </section>}
      <section className="agent-center-catalog-v2"><header><span className="eyebrow">SPECIALIST AGENTS</span><h3>可协同的专业模块</h3><p>路由不替代专业 Agent；进入模块后仍要基于实际资源、权限和运行证据生成草稿。</p></header><div>{destinations.map((item) => <article key={item.id}><div><strong>{item.label}</strong><span>{riskLabel[item.risk]}</span></div><p>{item.action}</p><button onClick={() => onOpenDestination(item.id)}>查看模块 <ArrowRight size={13} /></button></article>)}</div></section>
      <footer><ShieldCheck size={14} />不自动执行同步、查询、审批、发布、发令牌或权限变更；高风险动作必须进入对应模块并通过人工关口。</footer>
    </div>
  );
}
