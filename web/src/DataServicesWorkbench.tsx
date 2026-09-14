import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AppWindow,
  Bot,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  CodeXml,
  KeyRound,
  Layers3,
  LoaderCircle,
  Network,
  Play,
  Rocket,
  Send,
  ShieldCheck,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type ReleaseRun = {
  id: string;
  releaseId: string;
  status: string;
  published: boolean;
  schedulerTriggered: boolean;
  engine?: string;
  engineVersion?: string;
  rows?: Record<string, string | number>[];
  validation?: { passed: boolean };
  createdAt: string;
};
type ServiceVersion = {
  id: string;
  versionNumber: number;
  status: string;
  configHash: string;
  sourceReleaseRunId?: string;
  snapshotHash?: string;
  fields?: string[];
  steps?: { alias: string; dapiId: string; dapiVersionId: string }[];
  timeoutMs: number;
  rateLimitPerMinute: number;
};
type DataService = {
  id: string;
  name: string;
  slug: string;
  serviceType: "DAPI" | "XAPI";
  status: string;
  endpoint?: string;
  currentVersion?: ServiceVersion;
  publishedVersion?: ServiceVersion;
  versions: ServiceVersion[];
};
type Application = {
  id: string;
  name: string;
  status: string;
  serviceIds: string[];
  tokenPrefix: string;
  scope: string;
};
type ServiceCall = {
  id: string;
  serviceId: string;
  serviceType: string;
  versionNumber: number;
  applicationId: string;
  outcome: string;
  statusCode: number;
  rowCount: number;
  durationMs: number;
  createdAt: string;
};
type TestReceipt = {
  test: {
    id: string;
    status: string;
    rowCount: number;
    resultHash: string;
    durationMs: number;
  };
  response: {
    data: Record<string, unknown>[];
    pagination: { total: number };
  };
};
type ServiceAgentPlan = {
  id: string;
  message: string;
  status: string;
  proposal?: {
    serviceType: "DAPI" | "XAPI";
    name: string;
    slug: string;
    fields?: string[];
    steps?: { alias: string; dapiId: string; dapiVersionId: string }[];
    sourceReleaseRunId?: string;
    timeoutMs: number;
    rateLimitPerMinute: number;
  };
  explanation?: string;
  error?: string;
  serviceId?: string;
};

const fieldProfiles = {
  holdings: ["client_id", "holding_market_value", "security_count"],
  cash: ["client_id", "available_cash", "total_assets"],
  full: [
    "client_id",
    "holding_market_value",
    "available_cash",
    "total_assets",
    "security_count",
  ],
};
const labels: Record<string, string> = {
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  RETIRED: "历史版本",
  SUCCEEDED: "成功",
  RATE_LIMITED: "已限流",
  TIMED_OUT: "已超时",
  FAILED: "失败",
};
const flowSteps: {
  Icon: typeof CodeXml;
  number: string;
  title: string;
  description: string;
}[] = [
  { Icon: CodeXml, number: "01", title: "开发", description: "绑定真实发布结果" },
  { Icon: Play, number: "02", title: "测试", description: "执行参数化查询" },
  { Icon: Rocket, number: "03", title: "发布", description: "锁定不可变版本" },
  { Icon: Activity, number: "04", title: "消费", description: "授权、限流与日志" },
];

export function DataServicesWorkbench({
  api,
  canWrite,
}: {
  api: Api;
  canWrite: boolean;
}) {
  const [releaseRuns, setReleaseRuns] = useState<ReleaseRun[]>([]),
    [dapis, setDapis] = useState<DataService[]>([]),
    [xapis, setXapis] = useState<DataService[]>([]),
    [applications, setApplications] = useState<Application[]>([]),
    [calls, setCalls] = useState<ServiceCall[]>([]),
    [agentPlans, setAgentPlans] = useState<ServiceAgentPlan[]>([]);
  const [selectedId, setSelectedId] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [dapiName, setDapiName] = useState("客户持仓查询"),
    [dapiSlug, setDapiSlug] = useState("customer-holdings"),
    [profile, setProfile] = useState<keyof typeof fieldProfiles>("holdings"),
    [sourceRunId, setSourceRunId] = useState("");
  const [testReceipt, setTestReceipt] = useState<TestReceipt>(),
    [openApi, setOpenApi] = useState<Record<string, unknown>>(),
    [issuedToken, setIssuedToken] = useState("");
  const [agentMessage, setAgentMessage] = useState(
      "基于已发布的持仓与现金DAPI，规划一个财富顾问客户资产组合XAPI",
    ),
    [agentPlan, setAgentPlan] = useState<ServiceAgentPlan>();
  const services = useMemo(() => [...dapis, ...xapis], [dapis, xapis]),
    selected = services.find((item) => item.id === selectedId),
    eligibleRuns = releaseRuns.filter(
      (run) =>
        run.status === "SUCCEEDED" &&
        run.published &&
        run.schedulerTriggered &&
        run.engine === "Apache Spark" &&
        run.validation?.passed,
    ),
    publishedDapis = dapis.filter((item) => item.status === "PUBLISHED"),
    callsForSelected = selected
      ? calls.filter((item) => item.serviceId === selected.id)
      : calls;

  const reload = async () => {
    const [nextRuns, nextDapis, nextXapis, nextApps, nextCalls, nextPlans] =
      await Promise.all([
        api<ReleaseRun[]>("/release/runs"),
        api<DataService[]>("/data-services/dapis"),
        api<DataService[]>("/data-services/xapis"),
        api<Application[]>("/data-services/applications"),
        api<ServiceCall[]>("/data-services/calls"),
        api<ServiceAgentPlan[]>("/data-services/agent/plans"),
      ]);
    setReleaseRuns(nextRuns);
    setDapis(nextDapis);
    setXapis(nextXapis);
    setApplications(nextApps);
    setCalls(nextCalls);
    setAgentPlans(nextPlans);
    if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);
    if (!sourceRunId && nextRuns.find((run) => run.status === "SUCCEEDED"))
      setSourceRunId(nextRuns.find((run) => run.status === "SUCCEEDED")!.id);
    if (!selectedId && [...nextDapis, ...nextXapis][0])
      setSelectedId([...nextDapis, ...nextXapis][0].id);
  };
  useEffect(() => {
    reload().catch((cause) => setError(cause.message));
  }, []);
  useEffect(() => {
    setTestReceipt(undefined);
    setOpenApi(undefined);
  }, [selectedId]);
  useEffect(() => {
    if (!agentPlan || !["QUEUED", "RUNNING"].includes(agentPlan.status)) return;
    const timer = setInterval(async () => {
      try {
        const latest = await api<ServiceAgentPlan>(
          `/data-services/agent/plans/${agentPlan.id}`,
        );
        setAgentPlan(latest);
        if (!["QUEUED", "RUNNING"].includes(latest.status))
          setAgentPlans(await api<ServiceAgentPlan[]>("/data-services/agent/plans"));
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [agentPlan?.id, agentPlan?.status]);

  const planWithAgent = async () => {
    setBusy("agent");
    setError("");
    try {
      const plan = await api<ServiceAgentPlan>("/data-services/agent/plans", {
        message: agentMessage,
      });
      setAgentPlan(plan);
      setNotice("Data Agent已开始读取当前发布批次与DAPI版本");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const applyAgentPlan = async () => {
    if (!agentPlan) return;
    setBusy("agent-apply");
    setError("");
    try {
      const service = await api<DataService>(
        `/data-services/agent/plans/${agentPlan.id}/apply`,
        {},
      );
      await reload();
      setSelectedId(service.id);
      setAgentPlan(
        await api<ServiceAgentPlan>(
          `/data-services/agent/plans/${agentPlan.id}`,
        ),
      );
      setNotice("已按经过后端校验的Agent方案创建草稿，尚未测试或发布");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  const createDapi = async () => {
    setBusy("create-dapi");
    setError("");
    try {
      const created = await api<DataService>("/data-services/dapis", {
        name: dapiName,
        slug: dapiSlug,
        sourceReleaseRunId: sourceRunId,
        fields: fieldProfiles[profile],
        timeoutMs: 1500,
        rateLimitPerMinute: 60,
      });
      await reload();
      setSelectedId(created.id);
      setNotice("DAPI草稿已绑定真实发布批次，请先执行查询测试");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const createXapi = async () => {
    setBusy("create-xapi");
    setError("");
    try {
      const created = await api<DataService>("/data-services/xapis", {
        name: "财富顾问客户资产组合查询",
        slug: "advisor-asset-overview",
        steps: [
          { alias: "positions", dapiId: publishedDapis[0].id },
          { alias: "cash", dapiId: publishedDapis[1].id },
        ],
        timeoutMs: 2500,
        rateLimitPerMinute: 30,
      });
      await reload();
      setSelectedId(created.id);
      setNotice("XAPI已锁定两个DAPI的已发布版本");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const testService = async () => {
    if (!selected) return;
    setBusy("test");
    setError("");
    try {
      const receipt = await api<TestReceipt>(
        `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/test`,
        { clientId: "CLIENT-001", page: 1, pageSize: 20 },
      );
      setTestReceipt(receipt);
      setNotice("实际业务查询已通过，结果摘要已绑定当前版本");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!selected) return;
    setBusy("publish");
    setError("");
    try {
      await api(
        `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/publish`,
        {},
      );
      await reload();
      setNotice("当前测试版本已发布，本机外部端点已生成");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const loadOpenApi = async () => {
    if (!selected) return;
    setBusy("openapi");
    setError("");
    try {
      setOpenApi(
        await api<Record<string, unknown>>(
          `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/openapi`,
        ),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const createApplication = async () => {
    if (!selected) return;
    setBusy("application");
    setError("");
    setIssuedToken("");
    try {
      const issued = await api<{
        application: Application;
        token: string | null;
        tokenShownOnce: boolean;
      }>("/data-services/applications", {
        name: "证券财富分析演示系统",
        serviceIds: [selected.id],
      });
      setIssuedToken(issued.token ?? "");
      await reload();
      setNotice("本机应用凭证已创建；令牌只显示这一次");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="service-workbench">
      <section className="service-hero">
        <div>
          <span className="eyebrow">DATA SERVICE STUDIO · M3</span>
          <h2>把已验证数据发布成可治理接口</h2>
          <p>
            DAPI查询真实发布批次，XAPI固定编排已发布版本；测试、授权、限流、版本和调用证据共享一个工作区。
          </p>
        </div>
        <div className="service-stats">
          <div>
            <strong>{dapis.length}</strong>
            <span>DAPI</span>
          </div>
          <div>
            <strong>{xapis.length}</strong>
            <span>XAPI</span>
          </div>
          <div>
            <strong>{calls.length}</strong>
            <span>调用</span>
          </div>
        </div>
      </section>
      <div className="service-flow" aria-label="数据服务生命周期">
        {flowSteps.map(({ Icon: FlowIcon, number, title, description }) => {
          return (
            <div key={String(number)}>
              <FlowIcon size={17} />
              <span>{number}</span>
              <strong>{title}</strong>
              <small>{description}</small>
            </div>
          );
        })}
      </div>
      {(error || notice) && (
        <div
          className={error ? "service-feedback error" : "service-feedback"}
          role={error ? "alert" : "status"}
        >
          {error ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
          {error || notice}
        </div>
      )}
      <section className="service-agent-studio">
        <header>
          <div className="service-agent-icon">
            <Bot size={20} />
          </div>
          <div>
            <span className="eyebrow">DATA AGENT · GOVERNED DESIGN</span>
            <h3>用自然语言规划数据服务</h3>
            <p>模型只能选择页面中的发布批次和DAPI版本；后端校验通过后仍只创建草稿。</p>
          </div>
        </header>
        <div className="service-agent-compose">
          <textarea
            aria-label="向Data Agent描述数据服务需求"
            value={agentMessage}
            rows={2}
            maxLength={2000}
            onChange={(event) => setAgentMessage(event.target.value)}
          />
          <button
            className="button primary"
            onClick={planWithAgent}
            disabled={
              !canWrite ||
              !!busy ||
              agentMessage.trim().length < 4 ||
              ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "")
            }
          >
            {busy === "agent" || ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "") ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Send size={15} />
            )}
            生成受治理方案
          </button>
        </div>
        {agentPlan && (
          <div className="service-agent-plan">
            <span className={"status-pill " + agentPlan.status.toLowerCase()}>
              {agentPlan.status}
            </span>
            <div>
              <strong>
                {agentPlan.proposal
                  ? `${agentPlan.proposal.serviceType} · ${agentPlan.proposal.name}`
                  : "正在生成方案"}
              </strong>
              <p>{agentPlan.explanation ?? agentPlan.error ?? "读取资源与约束中…"}</p>
              {agentPlan.proposal && (
                <code>
                  /{agentPlan.proposal.slug} · {agentPlan.proposal.timeoutMs}ms · {agentPlan.proposal.rateLimitPerMinute}/min
                </code>
              )}
            </div>
            <button
              className="button"
              onClick={applyAgentPlan}
              disabled={!canWrite || agentPlan.status !== "SUCCEEDED" || !!busy}
            >
              <CheckCircle2 size={15} />
              {agentPlan.status === "APPLIED" ? "草稿已创建" : "确认创建草稿"}
            </button>
          </div>
        )}
        <small>{agentPlans.length}条方案记录 · 不自动发布、不创建调用凭证</small>
      </section>
      <div className="service-layout">
        <aside className="service-catalog">
          <header>
            <div>
              <span className="eyebrow">SERVICE CATALOG</span>
              <h3>服务目录</h3>
            </div>
            <span>{services.length}</span>
          </header>
          {services.length ? (
            services.map((service) => (
              <button
                className={service.id === selectedId ? "active" : ""}
                key={service.id}
                onClick={() => setSelectedId(service.id)}
              >
                {service.serviceType === "DAPI" ? (
                  <Braces size={17} />
                ) : (
                  <Network size={17} />
                )}
                <div>
                  <strong>{service.name}</strong>
                  <code>/{service.slug}</code>
                </div>
                <span className={"status-pill " + service.status.toLowerCase()}>
                  {labels[service.status] ?? service.status}
                </span>
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <div className="service-empty">
              <Layers3 size={25} />
              <p>从真实发布批次创建第一个DAPI。</p>
            </div>
          )}
        </aside>
        <section className="service-editor">
          {!selected ? (
            <section className="service-create-panel">
              <header>
                <div>
                  <span className="eyebrow">NEW DAPI</span>
                  <h3>创建参数化查询服务</h3>
                </div>
                <Braces size={22} />
              </header>
              <div className="service-form-grid">
                <label>
                  服务名称
                  <input
                    value={dapiName}
                    maxLength={80}
                    onChange={(event) => setDapiName(event.target.value)}
                  />
                </label>
                <label>
                  服务路径
                  <input
                    value={dapiSlug}
                    maxLength={48}
                    onChange={(event) => setDapiSlug(event.target.value)}
                  />
                </label>
                <label>
                  已验证发布批次
                  <select
                    value={sourceRunId}
                    onChange={(event) => setSourceRunId(event.target.value)}
                  >
                    {!eligibleRuns.length && <option>暂无可用批次</option>}
                    {eligibleRuns.map((run) => (
                      <option value={run.id} key={run.id}>
                        {run.id.slice(0, 8)} · Spark {run.engineVersion}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  返回字段模板
                  <select
                    value={profile}
                    onChange={(event) =>
                      setProfile(event.target.value as keyof typeof fieldProfiles)
                    }
                  >
                    <option value="holdings">持仓市值与证券数量</option>
                    <option value="cash">现金与总资产</option>
                    <option value="full">完整客户资产</option>
                  </select>
                </label>
              </div>
              <div className="service-contract-preview">
                <span>GET</span>
                <code>/api/v2/open/dapis/{dapiSlug}</code>
                <small>client_id · page · page_size</small>
              </div>
              <button
                className="button primary"
                disabled={!canWrite || !eligibleRuns.length || !!busy}
                onClick={createDapi}
              >
                {busy === "create-dapi" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Braces size={15} />
                )}
                创建DAPI草稿
              </button>
            </section>
          ) : (
            <>
              <section className="service-detail-head">
                <div>
                  <span className="eyebrow">{selected.serviceType} · VERSIONED</span>
                  <h3>{selected.name}</h3>
                  <code>{selected.endpoint ?? `/api/v2/open/${selected.serviceType.toLowerCase()}s/${selected.slug}`}</code>
                </div>
                <span className={"status-pill " + selected.status.toLowerCase()}>
                  {labels[selected.status] ?? selected.status}
                </span>
              </section>
              <div className="service-version-grid">
                <div>
                  <span>当前版本</span>
                  <strong>V{selected.currentVersion?.versionNumber}</strong>
                </div>
                <div>
                  <span>超时</span>
                  <strong>{selected.currentVersion?.timeoutMs}ms</strong>
                </div>
                <div>
                  <span>限流</span>
                  <strong>{selected.currentVersion?.rateLimitPerMinute}/min</strong>
                </div>
                <div>
                  <span>版本摘要</span>
                  <code>{selected.currentVersion?.configHash.slice(0, 12)}</code>
                </div>
              </div>
              <section className="service-definition">
                <header>
                  <h4>{selected.serviceType === "DAPI" ? "查询定义" : "组合编排"}</h4>
                  <span>不可变版本</span>
                </header>
                {selected.serviceType === "DAPI" ? (
                  <>
                    <pre>
                      SELECT {(selected.currentVersion?.fields ?? []).join(", ")}\n
                      FROM customer_assets\nWHERE snapshot_id = :snapshot_id\n
                      AND (:client_id IS NULL OR client_id = :client_id)
                    </pre>
                    <small>
                      源发布批次 {selected.currentVersion?.sourceReleaseRunId?.slice(0, 8)} · 快照
                      {selected.currentVersion?.snapshotHash?.slice(0, 12)}
                    </small>
                  </>
                ) : (
                  <div className="xapi-steps">
                    {selected.currentVersion?.steps?.map((step, index) => (
                      <div key={step.alias}>
                        <span>{index + 1}</span>
                        <Network size={15} />
                        <strong>{step.alias}</strong>
                        <code>DAPI {step.dapiVersionId.slice(0, 8)}</code>
                      </div>
                    ))}
                    <small>按 client_id 合并结果；发布后继续固定子版本。</small>
                  </div>
                )}
              </section>
              <div className="service-actions">
                <button className="button" onClick={testService} disabled={!canWrite || !!busy}>
                  {busy === "test" ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                  实际查询测试
                </button>
                <button
                  className="button primary"
                  onClick={publish}
                  disabled={!canWrite || !testReceipt || selected.status === "PUBLISHED" || !!busy}
                >
                  <Rocket size={15} />
                  {selected.status === "PUBLISHED" ? "当前版本已发布" : "发布当前版本"}
                </button>
                <button className="button" onClick={loadOpenApi} disabled={!!busy}>
                  <CodeXml size={15} />
                  OpenAPI
                </button>
                <button
                  className="button"
                  onClick={createApplication}
                  disabled={!canWrite || selected.status !== "PUBLISHED" || !!busy}
                >
                  <KeyRound size={15} />
                  创建调用凭证
                </button>
              </div>
              {testReceipt && (
                <section className="service-test-result">
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>真实查询通过 · {testReceipt.test.rowCount}行</strong>
                    <code>结果摘要 {testReceipt.test.resultHash.slice(0, 16)}</code>
                  </div>
                  <pre>{JSON.stringify(testReceipt.response.data, null, 2)}</pre>
                </section>
              )}
              {issuedToken && (
                <section className="service-token" role="status">
                  <ShieldCheck size={18} />
                  <div>
                    <strong>令牌仅显示一次</strong>
                    <code>{issuedToken}</code>
                    <small>只存哈希；请勿提交Git或发送到聊天。</small>
                  </div>
                </section>
              )}
              {openApi && (
                <section className="service-openapi">
                  <header>
                    <h4>OpenAPI 3.1</h4>
                    <span>本机测试范围</span>
                  </header>
                  <pre>{JSON.stringify(openApi, null, 2)}</pre>
                </section>
              )}
            </>
          )}
        </section>
      </div>
      <section className="service-bottom-grid">
        <article className="service-create-more">
          <header>
            <Network size={19} />
            <div>
              <h3>XAPI组合编排</h3>
              <p>把两个已发布DAPI按客户编号组合，固定其版本。</p>
            </div>
          </header>
          <button
            className="button"
            onClick={createXapi}
            disabled={!canWrite || publishedDapis.length < 2 || !!xapis.length || !!busy}
          >
            <Network size={15} />
            {xapis.length ? "组合服务已创建" : "创建持仓+现金XAPI"}
          </button>
          <small>需要至少两个已发布DAPI；首版采用声明式编排。</small>
        </article>
        <article className="service-observability">
          <header>
            <Activity size={19} />
            <div>
              <h3>调用与授权</h3>
              <p>{applications.length}个应用 · {callsForSelected.length}条当前服务调用</p>
            </div>
          </header>
          {callsForSelected.slice(0, 5).map((call) => (
            <div key={call.id}>
              <span className={"status-pill " + call.outcome.toLowerCase()}>
                {labels[call.outcome] ?? call.outcome}
              </span>
              <code>V{call.versionNumber} · {call.id.slice(0, 8)}</code>
              <span>{call.rowCount}行</span>
              <span>{call.durationMs}ms</span>
            </div>
          ))}
          {!callsForSelected.length && (
            <div className="service-no-calls">
              <Clock3 size={16} />
              发布并授权后，外部调用证据显示在这里。
            </div>
          )}
        </article>
      </section>
      <footer className="service-boundary">
        <AppWindow size={15} />
        当前数据来自虚构证券发布批次；业务查询库与平台元数据库分离。本机端点不是公网服务。
      </footer>
    </div>
  );
}
