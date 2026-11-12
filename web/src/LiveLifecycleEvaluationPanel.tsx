import {Fragment, useEffect, useRef, useState} from "react";
import {RefreshCw} from "lucide-react";

type Execution = {
  state: "RECORDED" | "UNCONFIRMED";
  evidence?: "TEST_HARNESS" | "STORED_METADATA";
  model?: {state:string; usage:string; attempts:number; unconfirmedAttempts:number;
    ledgerTokens:number|null; reportedTokens:number|null; reservedTokens:number|null; unattributedTokens:number|null};
  spark?: {state:string; revisionId?:string; runId?:string; pinned?:boolean; resultStatus?:string};
};
type EvaluationCase = {
  caseId: string;
  context: string;
  kind: "FRESH" | "DERIVED";
  sourceCaseId?: string;
  sourceStatus?: string;
  expectation?: {
    scope: "REGISTERED_FIXTURE";
    businessDate: string;
    definition: string;
    rows: {clientId:string; holdingMarketValue:string; availableCash:string; totalAssets:string; securityCount:number}[];
  };
  status: string;
  phase: string;
  taskUrl?: string;
  servicesUrl?: string;
  execution?: Execution;
};
type Overview = {
  runs: {id:string; startedAt:string; caseLimit:number}[];
  selectedId: string | null;
  legacyCount: number;
  unreadableCount: number;
  measurementStatus: "NOT_RUN" | "TEST_HARNESS" | "RECORDED_EVIDENCE_ONLY";
  verifiedCaseCount: number;
  attemptedCaseCount: number;
  caseCount: number;
  autonomousCompletionRate: null;
  cases: EvaluationCase[];
};
type Api = <T>(path: string) => Promise<T>;

const statuses: Record<string, string> = {
  NOT_RUN:"未执行", OUTSIDE_RUN:"未纳入本轮", RUNNING:"已进入执行",
  AWAITING_SOURCE:"等待来源案例", BLOCKED_SOURCE:"来源未通过",
  AWAITING_ENGINEER_REVIEW:"待审阅发布", AWAITING_MONITORING:"待监控",
  AWAITING_CONSUMPTION:"待消费", SUBMISSION_UNKNOWN:"提交待确认", DELIVERY_SUBMISSION_UNKNOWN:"交付回执待确认",
  PAUSED:"已暂停", FAILED:"未通过", UNCONFIRMED:"证据未确认",
  RECORDED_PASS:"记录核验通过", TEST_HARNESS:"测试记录",
};
const phases: Record<string, string> = {
  REQUIREMENT:"需求", SOURCE_CONTEXT:"来源口径", CODE_AND_DEBUG:"代码与调试",
  DELIVERY_PREPARATION:"调度部署文件", ENGINEER_REVIEW_AND_PUBLICATION:"审阅与发布",
  POST_RELEASE_MONITORING:"发布后监控", CONSUMPTION:"接口消费", COMPLETE:"完成",
};
const measurement = {
  NOT_RUN:"未实测", TEST_HARNESS:"测试记录", RECORDED_EVIDENCE_ONLY:"本机记录",
};

function workbenchLink(href: string | undefined, module: string) {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    if (url.origin === window.location.origin && url.pathname === "/v2/" &&
        url.searchParams.get("module") === module)
      return url.pathname + url.search;
  } catch {
    return undefined;
  }
}

function caseNavigation(row: EvaluationCase) {
  const task = workbenchLink(row.taskUrl, "agent-center");
  const services = workbenchLink(row.servicesUrl, "services");
  const section = row.status === "AWAITING_ENGINEER_REVIEW" ? "#agent-delivery"
    : row.status === "AWAITING_MONITORING" ? "#agent-publication" : "";
  return <div className="ops-live-links-v2">
    {task && <a href={task + section}>原任务</a>}
    {services && <a href={services}>同源接口</a>}
    {row.taskUrl && !task && <span>需打开原评测入口</span>}
  </div>;
}

function caseExpectation(row: EvaluationCase, parent?: EvaluationCase) {
  const expected = row.expectation;
  if (!expected || expected.scope !== "REGISTERED_FIXTURE") return <p role="status">冻结样例预期暂不可用。</p>;
  return <>
    <div className="ops-live-case-heading-v2">
      <strong>冻结样例预期</strong>
      <span>交易日 {expected.businessDate} · {expected.rows.length} 位虚构客户</span>
    </div>
    <p>{expected.definition}</p>
    {row.sourceCaseId && <p>
      父案例 <strong>{parent?.context ?? row.sourceCaseId}</strong> · {statuses[row.sourceStatus ?? ""] ?? "状态未确认"}
      <small>{row.sourceStatus === "RECORDED_PASS" ? "提交派生前会复核父案例的原任务。" : "派生依赖同一评测中已完成并核验的父案例。"}</small>
    </p>}
    <div className="ops-live-expected-table-v2">
      <table aria-label="冻结样例的独立结果预期">
        <thead><tr><th scope="col">客户</th><th scope="col">持仓市值（元）</th><th scope="col">可用现金（元）</th><th scope="col">合计（元）</th><th scope="col">证券数</th></tr></thead>
        <tbody>{expected.rows.map(item => <tr key={item.clientId}>
          <th scope="row">{item.clientId}</th>
          <td>{item.holdingMarketValue}</td><td>{item.availableCash}</td><td>{item.totalAssets}</td><td>{item.securityCount}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

const modelState: Record<string,string> = {
  READY:"待调用", IN_FLIGHT:"调用中", OUTCOME_UNKNOWN:"结果待确认", NOT_SENT:"发送前停止", OUTPUT_RECORDED:"输出已记录",
};
const sparkState: Record<string,string> = {
  NOT_LINKED:"尚无关联批次", REVISION_RECORDED:"代码版本已记录", QUEUED:"已排队", RUNNING:"运行中",
  WAITING_FOR_RESULT:"等待结果", SUBMISSION_UNCONFIRMED:"提交待确认", RESULT_UNCONFIRMED:"结果待确认", RESULT_RECORDED:"结果已记录",
};
const runStatus: Record<string,string> = {
  SUCCEEDED:"成功", VALIDATION_FAILED:"校验失败", FAILED:"失败", CANCELLED:"已取消", INTERRUPTED:"已中断",
};
const tokenAmount = (amount: number|null) => amount === null ? "未确认" : amount.toLocaleString("zh-CN");
function executionDetails(execution: Execution) {
  const {model,spark} = execution;
  if (execution.state !== "RECORDED" || !model || !spark) return <small>原任务执行记录待核对</small>;
  return <details className="ops-live-execution-v2">
    <summary>模型 {modelState[model.state] ?? "状态待确认"} · Spark {sparkState[spark.state] ?? "关联待确认"}</summary>
    <div>
      <small>{execution.evidence === "TEST_HARNESS" ? "测试记录" : "已保存记录"}</small>
      <small>模型 {model.attempts} 次 · {model.unconfirmedAttempts} 次用量待确认</small>
      <small>已报告 {tokenAmount(model.reportedTokens)} Token · 预留 {tokenAmount(model.reservedTokens)} Token</small>
      <small>账本 {tokenAmount(model.ledgerTokens)} Token · 未分配 {tokenAmount(model.unattributedTokens)} Token
        {model.usage === "UNCONFIRMED" && " · 账本待核对"}</small>
      {spark.revisionId && <small title={spark.revisionId}>{spark.pinned ? "冻结版本" : "代码版本"} {spark.revisionId.slice(0,8)}</small>}
      {spark.runId && <small title={spark.runId}>运行 {spark.runId.slice(0,8)}{spark.resultStatus && " · " + runStatus[spark.resultStatus]}</small>}
    </div>
  </details>;
}

export function LiveLifecycleEvaluationPanel({api}:{api:Api}) {
  const [selection, setSelection] = useState("");
  const [revision, setRevision] = useState(0);
  const [casesOpen, setCasesOpen] = useState(false);
  const [reviewCase, setReviewCase] = useState<string>();
  const [response, setResponse] = useState<{key:string; overview?:Overview; error?:string}>();
  const request = useRef(api);
  request.current = api;
  const key = selection + ":" + revision;
  const current = response?.key === key ? response : undefined;
  const overview = current?.overview;
  useEffect(() => {
    let active = true;
    const query = selection ? "?" + new URLSearchParams({run_id:selection}) : "";
    request.current<Overview>("/evaluations/live-lifecycle/overview" + query).then(
      value => { if (active) setResponse({key, overview:value}); },
      (error:Error) => { if (active) setResponse({key, error:error.message || "读取失败"}); },
    );
    return () => { active = false; };
  }, [key, selection]);
  useEffect(() => {
    if (overview && casesOpen && reviewCase)
      document.getElementById("case-expectation-" + reviewCase)?.scrollIntoView({block:"nearest"});
  }, [overview, casesOpen, reviewCase]);

  return <section className="ops-live-evaluation-v2" aria-labelledby="ops-live-evaluation-title">
    <header>
      <div><h3 id="ops-live-evaluation-title">新任务端到端验收 · v3</h3>
        <p>固定 20 例，覆盖新任务和口径变更，追踪至授权接口消费。</p></div>
      <button className="button" disabled={!current} onClick={() => setRevision(value => value + 1)}>
        <RefreshCw size={14}/>读取评测记录
      </button>
    </header>
    {!current && <p role="status">正在读取评测记录…</p>}
    {current?.error && <p role="alert">评测记录读取失败。{current.error}
      {selection && <button className="button" onClick={() => setSelection("")}>查看最新记录</button>}</p>}
    {overview && <>
      <div className="ops-live-summary-v2">
        <div><span>记录核验通过</span><strong>{overview.verifiedCaseCount} / {overview.caseCount}</strong></div>
        <div><span>有提交记录</span><strong>{overview.attemptedCaseCount}</strong></div>
        <div><span>自主完成率</span><strong>未测</strong></div>
        <div><span>证据范围</span><strong>{measurement[overview.measurementStatus]}</strong></div>
      </div>
      {overview.runs.length > 0 && <label className="ops-live-run-v2">评测运行
        <select value={selection} onChange={event => setSelection(event.target.value)}>
          <option value="">最新记录</option>
          {overview.runs.map(run => <option key={run.id} value={run.id}>
            {new Date(run.startedAt).toLocaleString("zh-CN")} · {run.caseLimit} 例 · {run.id.slice(0,8)}
          </option>)}
        </select>
        {overview.selectedId && <code>{overview.selectedId.slice(0,8)}</code>}
      </label>}
      {overview.legacyCount > 0 && <p>另有 {overview.legacyCount} 份旧版记录，按原评测口径保留。</p>}
      {overview.unreadableCount > 0 && <p role="status">{overview.unreadableCount} 份记录待核对。</p>}
      <details open={casesOpen} onToggle={event => setCasesOpen(event.currentTarget.open)}>
        <summary>查看 {overview.caseCount} 例的阶段与原任务</summary>
        <div className="ops-live-table-v2">
          <table aria-label="v3 逐例验收">
            <thead><tr><th scope="col">案例与口径</th><th scope="col">记录状态</th><th scope="col">查看</th></tr></thead>
            <tbody>{overview.cases.map(row => {
              const parent = overview.cases.find(item => item.caseId === row.sourceCaseId);
              const expanded = reviewCase === row.caseId;
              const panelId = "case-expectation-" + row.caseId;
              return <Fragment key={row.caseId}>
                <tr>
                  <th scope="row"><span>{row.context}</span><small>{row.kind === "FRESH" ? "新任务" : "口径变更"}
                    {parent && " · 来源 " + parent.context}</small></th>
                  <td><strong>{statuses[row.status] ?? "证据未确认"}</strong>
                    {!["NOT_RUN","OUTSIDE_RUN"].includes(row.status) && <small>{phases[row.phase] ?? "阶段未确认"}</small>}
                    {row.execution && executionDetails(row.execution)}</td>
                  <td><button className="button ops-live-case-review-v2" type="button" aria-expanded={expanded}
                    aria-controls={expanded ? panelId : undefined}
                    aria-label={row.context + (row.kind === "FRESH" ? " 新任务" : " 口径变更") + (expanded ? " 收起预期" : " 核对预期")}
                    onClick={() => setReviewCase(expanded ? undefined : row.caseId)}>{expanded ? "收起预期" : "核对预期"}</button>
                    {caseNavigation(row)}</td>
                </tr>
                {expanded && <tr><td colSpan={3} className="ops-live-case-expectation-v2" id={panelId}>
                  {caseExpectation(row, parent)}
                </td></tr>}
              </Fragment>;
            })}</tbody>
          </table>
        </div>
      </details>
    </>}
  </section>;
}
