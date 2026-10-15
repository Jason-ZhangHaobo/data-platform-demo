import { useEffect, useMemo, useRef, useState } from "react";
import { EvidenceDownload } from "./EvidenceDownload";
import { compositionChoices } from "./service-composition";
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

type Api = <T>(path: string, body?: unknown, options?: {idempotencyKey?:string}) => Promise<T>;
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
  mainSqlExecuted?: boolean;
  testSqlValidation?: { passed: boolean };
  codeExecuted?: boolean;
  createdAt: string;
};
type ServiceVersion = {
  id: string;
  versionNumber: number;
  status: string;
  configHash: string;
  sourcePackageDigest?: string;
  sourceReleaseRunId?: string;
  sourceEngine?: string;
  sourceEngineVersion?: string;
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
    versionId: string;
    configHash: string;
  };
  response: {
    data: Record<string, unknown>[];
    pagination: { total: number };
  };
};
type VersionSwitchReceipt = {id:string;fromVersionId:string;toVersionId:string;targetConfigHash:string;createdAt:string};
type VersionReview = {serviceId:string;type:"DAPI"|"XAPI";versionId:string;configHash:string;expectedPublishedVersionId:string;targetNumber:number;liveNumber:number;accepted:boolean};
type RecoveryReport = {
  bootId: string; healthy: boolean; fingerprint: string; checkedAt: string;
  state: { serviceId: string; calls: unknown[]; applications: {id:string;status:string}[];
    evidence: {verified:boolean;code?:string;snapshot?:{actualRowCount:number;integrityVerified:boolean}|null}[] };
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
  privateCloud = false,
  sourceAgentTaskId,
}: {
  api: Api;
  canWrite: boolean;
  privateCloud?: boolean;
  sourceAgentTaskId?: string;
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
    [dapiSlug, setDapiSlug] = useState(sourceAgentTaskId?`customer-holdings-${sourceAgentTaskId.slice(0,8)}`:"customer-holdings"),
    [profile, setProfile] = useState<keyof typeof fieldProfiles>("holdings"),
    [sourceRunId, setSourceRunId] = useState("");
  const [xapiName,setXapiName]=useState("财富顾问客户资产组合查询"),
    [xapiSlug,setXapiSlug]=useState(sourceAgentTaskId?`advisor-assets-${sourceAgentTaskId.slice(0,8)}`:"advisor-asset-overview"),
    [holdingsVersionId,setHoldingsVersionId]=useState(""),[cashVersionId,setCashVersionId]=useState("");
  const [testReceipt, setTestReceipt] = useState<TestReceipt>(),
    [openApi, setOpenApi] = useState<Record<string, unknown>>(),
    [issuedToken, setIssuedToken] = useState("");
  const [tokenVisible,setTokenVisible]=useState(false),[issuedAppId,setIssuedAppId]=useState("");
  const [recoveryReport,setRecoveryReport]=useState<RecoveryReport>();
  const [showVersionEditor,setShowVersionEditor]=useState(false),[versionProfile,setVersionProfile]=useState<keyof typeof fieldProfiles>("full"),[versionRate,setVersionRate]=useState("60"),[versionTimeout,setVersionTimeout]=useState("1500");
  const [versionReview,setVersionReview]=useState<VersionReview>(),[switchHistory,setSwitchHistory]=useState<VersionSwitchReceipt[]>([]);
  const activeServiceRef=useRef(selectedId);activeServiceRef.current=selectedId;
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
        ((run.engine === "Apache Spark" &&
          run.mainSqlExecuted === true &&
          run.testSqlValidation?.passed === true) ||
          (run.engine === "CPython" && run.codeExecuted === true)) &&
        run.validation?.passed,
    ),
    publishedDapis = dapis.filter((item) => item.status === "PUBLISHED"),
    callsForSelected = selected
      ? calls.filter((item) => item.serviceId === selected.id)
      : calls;
  const composition=compositionChoices(dapis,{privateCloud,sourceRunId,holdingsVersionId,cashVersionId});
  const currentPublished=Boolean(selected?.currentVersion && selected.currentVersion.id===selected.publishedVersion?.id);
  const versionContext=`${selectedId}:${selected?.currentVersion?.id??""}`;
  const activeVersionRef=useRef(versionContext);activeVersionRef.current=versionContext;
  const currentTestValid=Boolean(selected?.currentVersion && testReceipt?.test.status==="PASSED" && testReceipt.test.versionId===selected.currentVersion.id && testReceipt.test.configHash===selected.currentVersion.configHash);
  const requestKeys=useRef<Record<string,{signature:string;key:string}>>({});
  const keyFor=(action:string,body:unknown)=>{const signature=JSON.stringify(body),old=requestKeys.current[action];if(old?.signature===signature)return old.key;const key=crypto.randomUUID();requestKeys.current[action]={signature,key};return key;};

  const reload = async () => {
    const [nextRuns, nextDapis, nextXapis, nextApps, nextCalls, nextPlans] =
      await Promise.all([
        api<ReleaseRun[]>(privateCloud ? "/data-services/sources" + (sourceAgentTaskId ? `?agent_task_id=${encodeURIComponent(sourceAgentTaskId)}` : "") : "/release/runs"),
        api<DataService[]>("/data-services/dapis"),
        api<DataService[]>("/data-services/xapis"),
        api<Application[]>("/data-services/applications"),
        api<ServiceCall[]>("/data-services/calls"),
        privateCloud ? Promise.resolve([] as ServiceAgentPlan[]) : api<ServiceAgentPlan[]>("/data-services/agent/plans"),
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
    setIssuedToken("");
    setTokenVisible(false);
    setRecoveryReport(undefined);
    setVersionReview(undefined);setShowVersionEditor(false);setSwitchHistory([]);
    if(selected?.currentVersion){setVersionRate(String(selected.currentVersion.rateLimitPerMinute));setVersionTimeout(String(selected.currentVersion.timeoutMs));setVersionProfile(selected.currentVersion.fields?.includes("holding_market_value") ? selected.currentVersion.fields.includes("available_cash")?"full":"holdings":"cash");}
  }, [selectedId, selected?.currentVersion?.id]);
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
      const body={
        name: dapiName,
        slug: dapiSlug,
        sourceReleaseRunId: sourceRunId,
        fields: fieldProfiles[profile],
        timeoutMs: 1500,
        rateLimitPerMinute: 60,
      };const created = await api<DataService>("/data-services/dapis",body,{idempotencyKey:keyFor("dapi",body)});
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
      const {holdings,cash}=composition;
      if(!holdings||!cash)throw new Error("请先发布同一批次的持仓DAPI与现金DAPI");
      const body={
        name: xapiName.trim(),
        slug: xapiSlug.trim(),
        steps: [
          { alias: "positions", dapiId: holdings.id, dapiVersionId:holdings.publishedVersion!.id },
          { alias: "cash", dapiId: cash.id, dapiVersionId:cash.publishedVersion!.id },
        ],
        timeoutMs: 2500,
        rateLimitPerMinute: 30,
      };const created=await api<DataService>("/data-services/xapis",body,{idempotencyKey:keyFor("xapi",body)});
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
    const context=versionContext;
    setBusy("test");
    setError("");
    try {
      const receipt = await api<TestReceipt>(
        `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/test`,
        { clientId: "CLIENT-001", page: 1, pageSize: 20 },
      );
      if(activeVersionRef.current!==context)return;
      setTestReceipt(receipt);
      setNotice("实际业务查询已通过，结果摘要已绑定当前版本");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!selected || !currentTestValid) return;
    setBusy("publish");
    setError("");
    try {
      await api(
        `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/publish`,
        {configHash:selected.currentVersion?.configHash},
      );
      await reload();
      setNotice(privateCloud ? "当前版本已发布到私有调用通道；不是公网生产接口" : "当前测试版本已发布，本机外部端点已生成");
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
      },{idempotencyKey:keyFor("app:"+selected.id,{name:"证券财富分析演示系统",serviceIds:[selected.id]})});
      setIssuedToken(issued.token ?? "");
      setIssuedAppId(issued.application.id);setTokenVisible(false);
      await reload();
      setNotice(`${privateCloud ? "私有查询" : "本机"}应用凭证已创建；令牌只显示这一次`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const loadRecovery = async () => {
    if(!selected)return;
    const serviceId=selected.id;
    setBusy("recovery");setError("");
    try {
      const report=await api<RecoveryReport>(`/data-services/${selected.serviceType.toLowerCase()}s/${serviceId}/recovery`);
      if(activeServiceRef.current!==serviceId)return;
      setRecoveryReport(report);
      setNotice("已读取当前后端实例的恢复对照；仍需重建后比较启动标识与状态摘要");
    }catch(cause){if(activeServiceRef.current===serviceId)setError((cause as Error).message);}
    finally{setBusy("");}
  };
  const createVersion = async () => {
    if(!selected?.currentVersion)return;
    const resource=selected,prior=selected.currentVersion;
    setBusy("new-version");setError("");
    try{
      const body={...(resource.serviceType==="DAPI"?{sourceReleaseRunId:prior.sourceReleaseRunId,fields:fieldProfiles[versionProfile]}:{}),rateLimitPerMinute:Number(versionRate),timeoutMs:Number(versionTimeout)};
      await api(`/data-services/${resource.serviceType.toLowerCase()}s/${resource.id}/versions`,body,{idempotencyKey:keyFor("version:"+resource.id,body)});
      await reload();setNotice("已创建不可变新草稿；原线上版本继续服务，新版本仍须实际测试与审阅发布");
    }catch(cause){setError((cause as Error).message);}finally{setBusy("");}
  };
  const loadSwitchHistory = async () => {
    if(!selected)return;const resource=selected;setBusy("history");setError("");
    try{const rows=await api<VersionSwitchReceipt[]>(`/data-services/${resource.serviceType.toLowerCase()}s/${resource.id}/history`);if(activeServiceRef.current===resource.id)setSwitchHistory(rows);}
    catch(cause){setError((cause as Error).message);}finally{setBusy("");}
  };
  const activateVersion = async () => {
    if(!versionReview?.accepted)return;const review=versionReview;
    setBusy("activate");setError("");
    try{
      const body={versionId:review.versionId,expectedPublishedVersionId:review.expectedPublishedVersionId,configHash:review.configHash};
      const result=await api<{receipt:VersionSwitchReceipt;targetStillActive:boolean}>(`/data-services/${review.type.toLowerCase()}s/${review.serviceId}/activate`,body,{idempotencyKey:keyFor("activate:"+review.serviceId,body)});
      await reload();setVersionReview(undefined);
      setNotice(result.targetStillActive?`版本切换已记录回执 ${result.receipt.id.slice(0,8)}；没有重新运行模型或Spark` : "原切换请求已处理，但线上版本后来已改变；请查看版本历史，不会重复回滚");
    }catch(cause){setError((cause as Error).message);}finally{setBusy("");}
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
      {!privateCloud && <section className="service-agent-studio">
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
      </section>}
      {privateCloud && <div className="service-feedback" role="status">复用已经审阅并运行的版本创建接口，不重新调用模型或Spark。仅提供当前虚构证券资产契约的参数化快照查询；模型服务规划后续单独接入。</div>}
      <div className="service-layout">
        <aside className="service-catalog">
          <header>
            <div>
              <span className="eyebrow">SERVICE CATALOG</span>
              <h3>服务目录</h3>
            </div>
            <button className="button" disabled={!canWrite||!!busy} onClick={()=>{setSelectedId("");const hasHoldings=dapis.some(s=>s.currentVersion?.fields?.includes("holding_market_value")&&(!privateCloud||s.currentVersion.sourceReleaseRunId===sourceRunId));setProfile(hasHoldings?"cash":"holdings");setDapiName(hasHoldings?"客户现金查询":"客户持仓查询");setDapiSlug((hasHoldings?"customer-cash":"customer-holdings")+(sourceAgentTaskId?`-${sourceAgentTaskId.slice(0,8)}`:""));}}>新建 DAPI</button>
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
                        {run.id.slice(0, 8)} · {run.engine} {run.engineVersion}
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
                  <span>{currentPublished?"线上版本":"当前草稿"}</span>
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
              {!currentPublished && selected.publishedVersion && <div className="service-contract-preview"><span>线上 V{selected.publishedVersion.versionNumber}</span><small>查询端点仍使用原发布版本；当前草稿尚未上线。</small></div>}
              <section className="service-definition">
                <header>
                  <h4>{selected.serviceType === "DAPI" ? "查询定义" : "组合编排"}</h4>
                  <span>不可变版本</span>
                </header>
                {selected.serviceType === "DAPI" ? (
                  <>
                    <pre>{`SELECT ${(selected.currentVersion?.fields ?? []).join(", ")}
FROM customer_assets
WHERE snapshot_id = :snapshot_id
  AND (:client_id IS NULL OR client_id = :client_id)
ORDER BY client_id
LIMIT :limit OFFSET :offset`}</pre>
                    <small>
                      源发布批次 {selected.currentVersion?.sourceReleaseRunId?.slice(0, 8)} · {selected.currentVersion?.sourceEngine ?? "未知引擎"} {selected.currentVersion?.sourceEngineVersion ?? ""} · 快照
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
                  disabled={!canWrite || !currentTestValid || currentPublished || !!busy}
                >
                  <Rocket size={15} />
                  {currentPublished ? "当前版本已发布" : "发布当前版本"}
                </button>
                <button className="button" onClick={loadOpenApi} disabled={!!busy}>
                  <CodeXml size={15} />
                  OpenAPI
                </button>
                {privateCloud && <button className="button" onClick={loadRecovery} disabled={!!busy}><Activity size={15}/>恢复对照</button>}
                <button
                  className="button"
                  onClick={createApplication}
                  disabled={!canWrite || selected.status !== "PUBLISHED" || !!busy}
                >
                  <KeyRound size={15} />
                  创建调用凭证
                </button>
              </div>
              <section className="service-definition" aria-label="版本治理">
                <header><h4>版本历史与受控切换</h4><button className="button" disabled={!canWrite||!!busy} onClick={()=>setShowVersionEditor(!showVersionEditor)}>新建版本</button></header>
                {showVersionEditor && <div className="service-create-panel">
                  <small>{selected.serviceType==="DAPI"?"复用当前已核验发布批次，不重新计算业务数据。":"保留原固定DAPI子版本，不跟随它们的最新版本。"}</small>
                  <div className="service-form-grid">
                    {selected.serviceType==="DAPI" && <label>返回字段模板<select value={versionProfile} onChange={e=>setVersionProfile(e.target.value as keyof typeof fieldProfiles)}><option value="holdings">持仓市值与证券数量</option><option value="cash">现金与总资产</option><option value="full">完整客户资产</option></select></label>}
                    <label>每分钟限流<input type="number" min={1} max={600} value={versionRate} onChange={e=>setVersionRate(e.target.value)}/></label>
                    <label>查询超时（毫秒）<input type="number" min={100} max={5000} value={versionTimeout} onChange={e=>setVersionTimeout(e.target.value)}/></label>
                  </div>
                  <button className="button" disabled={!canWrite||!!busy} onClick={createVersion}>保存新版本草稿</button>
                </div>}
                {selected.versions.map(v=><div key={v.id} className="service-contract-preview">
                  <span>V{v.versionNumber} {v.id===selected.publishedVersion?.id?"线上":v.status==="DRAFT"?"草稿":"历史"}</span><code>{v.configHash.slice(0,12)}</code>
                  {v.id!==selected.publishedVersion?.id && ["PUBLISHED","RETIRED"].includes(v.status) && selected.publishedVersion && <button className="button" disabled={!canWrite||!!busy} onClick={()=>setVersionReview({serviceId:selected.id,type:selected.serviceType,versionId:v.id,configHash:v.configHash,expectedPublishedVersionId:selected.publishedVersion!.id,targetNumber:v.versionNumber,liveNumber:selected.publishedVersion!.versionNumber,accepted:false})}>审阅切换到 V{v.versionNumber}</button>}
                </div>)}
                {versionReview && <div className="service-create-panel" role="group" aria-label="版本切换审阅">
                  <strong>线上 V{versionReview.liveNumber} → 目标 V{versionReview.targetNumber}</strong>
                  <code>目标摘要 {versionReview.configHash.slice(0,16)}</code>
                  <small>切换影响本服务查询端点；固定引用它的XAPI仍使用原子版本。线上版本变化后旧审阅将被拒绝。</small>
                  <label><input type="checkbox" checked={versionReview.accepted} onChange={e=>setVersionReview({...versionReview,accepted:e.target.checked})}/>我已核对线上版本、目标摘要及查询影响</label>
                  <button className="button primary" disabled={!canWrite||!versionReview.accepted||!!busy} onClick={activateVersion}>确认切换版本</button>
                  <button className="button" disabled={!!busy} onClick={()=>setVersionReview(undefined)}>取消审阅</button>
                </div>}
                <button className="button" disabled={!!busy} onClick={loadSwitchHistory}>查看切换回执</button>
                {switchHistory.map(r=><small key={r.id}>回执 {r.id.slice(0,8)} · {r.fromVersionId.slice(0,8)} → {r.toVersionId.slice(0,8)} · {new Date(r.createdAt).toLocaleString()}</small>)}
              </section>
              {recoveryReport && <section className="service-definition" aria-label="服务恢复对照">
                <header><h4>当前实例恢复对照</h4><span>{recoveryReport.healthy ? "快照及来源完整" : "数据或版本校验未通过"}</span></header>
                {recoveryReport.state.evidence.filter(e=>!e.verified).map((e,i)=><small key={i}>{e.code==="SERVICE_VERSION_CORRUPT"?"不可变版本配置与摘要不一致":e.code==="VERSION_NOT_FOUND"?"固定子版本缺失":"来源或实际数据快照缺失、漂移"}</small>)}
                <div className="service-version-grid">
                  <div><span>后端启动标识</span><code>{recoveryReport.bootId.slice(0,12)}</code></div>
                  <div><span>状态摘要</span><code>{recoveryReport.fingerprint.slice(0,12)}</code></div>
                  <div><span>持久调用</span><strong>{recoveryReport.state.calls.length}</strong></div>
                  <div><span>已撤销应用</span><strong>{recoveryReport.state.applications.filter(a=>a.status==="REVOKED").length}</strong></div>
                </div>
                <p>这是一份只读检查，不代表已经通过冷启动验收。重建后端后须确认启动标识改变、状态摘要与原记录一致；刷新浏览器或重启临时代理不能代替。</p>
                <EvidenceDownload name={`service-recovery-${recoveryReport.state.serviceId.slice(0,8)}.json`} value={recoveryReport} request={{kind:"recovery",type:selected.serviceType.toLowerCase() as "dapi"|"xapi",id:recoveryReport.state.serviceId}}>下载恢复对照</EvidenceDownload>
              </section>}
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
                    <code>{tokenVisible ? issuedToken : "已生成 · 默认隐藏"}</code>
                    <button className="button" onClick={()=>setTokenVisible(!tokenVisible)}>{tokenVisible?"隐藏令牌":"显示一次性令牌"}</button>
                    <button className="button" onClick={()=>{const blob=new Blob([issuedToken+"\n"],{type:"text/plain;charset=utf-8"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`shuduo-application-${issuedAppId.slice(0,8)}.token`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>下载本次调用凭据</button>
                    <small>只存哈希；请勿提交Git或发送到聊天。</small>
                  </div>
                </section>
              )}
              {openApi && (
                <section className="service-openapi">
                  <header>
                    <h4>OpenAPI 3.1</h4>
                    <span>{privateCloud ? "私有云测试范围" : "本机测试范围"}</span>
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
          <div className="service-composition-form">
            <label>XAPI名称<input value={xapiName} maxLength={100} disabled={!!busy} onChange={e=>setXapiName(e.target.value)}/></label>
            <label>XAPI路径标识<input value={xapiSlug} maxLength={48} disabled={!!busy} onChange={e=>setXapiSlug(e.target.value)}/></label>
            <label>持仓DAPI版本<select value={composition.holdings?.publishedVersion?.id??""} disabled={!!busy} onChange={e=>{setHoldingsVersionId(e.target.value);setCashVersionId("");}}><option value="">请选择已发布版本</option>{composition.holdingsOptions.map(s=><option key={s.id} value={s.publishedVersion!.id}>{s.name} · V{s.publishedVersion!.versionNumber} · {s.publishedVersion!.id.slice(0,8)}</option>)}</select></label>
            <label>现金DAPI版本<select value={composition.cash?.publishedVersion?.id??""} disabled={!!busy} onChange={e=>setCashVersionId(e.target.value)}><option value="">请选择已发布版本</option>{composition.cashOptions.map(s=><option key={s.id} value={s.publishedVersion!.id}>{s.name} · V{s.publishedVersion!.versionNumber} · {s.publishedVersion!.id.slice(0,8)}</option>)}</select></label>
          </div>
          <button
            className="button"
            onClick={createXapi}
            disabled={!canWrite || !composition.holdings || !composition.cash || !xapiName.trim() || !/^[a-z][a-z0-9-]{2,47}$/.test(xapiSlug.trim()) || !!busy}
          >
            <Network size={15} />
            创建持仓+现金XAPI
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
          {applications.filter(app=>!selected||app.serviceIds.includes(selected.id)).map(app=><div key={app.id}><span>{app.name} · {app.status==="ACTIVE"?"有效":"已撤销"}</span><button className="button" disabled={!canWrite||app.status!=="ACTIVE"||!!busy} onClick={async()=>{setBusy("revoke");try{await api(`/data-services/applications/${app.id}/revoke`,{});for(const id of app.serviceIds)delete requestKeys.current["app:"+id];setIssuedToken("");await reload();setNotice("凭证已撤销，旧令牌不能继续调用");}catch(e){setError((e as Error).message);}finally{setBusy("");}}}>撤销凭证</button></div>)}
        </article>
      </section>
      <footer className="service-boundary">
        <AppWindow size={15} />
        当前数据来自虚构证券发布批次；业务查询库与平台元数据库分离。{privateCloud ? "接口查询已发布结果的不可变快照，不在每次调用时重跑Spark；当前仅私有通道。" : "本机端点不是公网服务。"}
      </footer>
    </div>
  );
}
