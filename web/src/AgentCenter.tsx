import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type{PublishedReportBinding}from'../../src/v2/published-report-request.mjs';
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

import './agent-report-chat.css';
import {ReportClarificationReply} from './ReportClarificationReply';
import {readChatReportPlan, type SourceReportPlan} from './source-report-plan';
import {reportChatReplyKey} from '../../src/v2/report-clarification-contract.mjs';
import {readReportIntent} from '../../src/v2/report-intent-client.mjs';
import {AgentReportBatchPicker} from './AgentReportBatchPicker';
import {appliedChatReport, chatBatchLocation, chatBatchTarget, readWealthBatch, sameReportSource, type ChatTarget} from './agent-report-chat';
const CustomerAssetAnalysis=lazy(()=>import('./CustomerAssetAnalysis'));
const ChatSqlDevelopment=lazy(()=>import('./ChatSqlDevelopment'));
const ChatScopeChange=lazy(()=>import('./ChatScopeChange'));
type Api = <T>(path: string, body?: unknown, options?:{idempotencyKey?:string}) => Promise<T>;
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
  reportSource?:PublishedReportBinding;
  requestId?:string;
  reportPlanningProfile?:"MYSQL_HOLDINGS_CUSTOMER_ANALYSIS";
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
type IntentGraph = { intentId: string; completedCount: number; totalCount: number; completionScope: string; agentIndependentE2E: false; publicDeployed: false; steps: { destinationId: string; status: string; approvalStatus?: string; specialistTaskId?: string; specialistTaskKind?: string; specialistLanguage?: "SPARK_SQL" | "PYTHON"; specialistStatus?: string; invocationId?: string; invocationStatus?: string; invocationAttempt?: number; invocationRecovery?: "NONE" | "WAIT" | "RETRY_BINDING" | "RETRY_REQUIRED"; executionEvidence?: string }[] };
type AgentTool = { id: string; label: string; risk: Risk; approvalRequired: boolean; createMode: string; createPath: string; detailPath: string; applyPath?: string; requiresDestination?: string; invokePath: string };
type AgentToolCatalog = { version: "shuduo-agent-tools/v2"; contractDigest: string; tools: AgentTool[] };
type AgentToolInvocation = { specialist: { id: string; status: string; detailPath: string }; handoff: Handoff; graph: IntentGraph };
type SpecialistActivity = {
  destinationId: string;
  id: string;
  status: string;
  getPath: string;
  result?: Record<string, unknown>;
  error?: string;
  applied?: boolean;
  boundPlan?: SourceReportPlan;
  sqlGraph?: true;
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
const reportMessageHash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),n=>n.toString(16).padStart(2,'0')).join('');
const fillToolPath = (template: string, id: string) =>
  template.replace("{id}", encodeURIComponent(id));
function reportPhase(activity?:SpecialistActivity) {
  switch(activity?.status) {
    case 'NEEDS_CLARIFICATION': return '等待回答';
    case 'SUCCEEDED': return '方案待审阅';
    case 'APPLYING': return '报表生成中';
    case 'APPLIED': return '报表回执待核对';
    case 'UNCONFIRMED': return '原方案待核对';
    case 'FAILED': return '规划失败';
    case 'CANCELLED': return '规划已取消';
    case 'INTERRUPTED': return '规划已中断';
    default: return '规划报表';
  }
}
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
  local=false,
  modelConfigured,
  contextId,
  currentSql,
  currentPythonCode,
  developmentLanguage,
  onDevelopmentLanguageChange,
  onOpenDestination,
}: {
  api: Api;
  canWrite: boolean;
  local?: boolean;
  modelConfigured: boolean;
  contextId: string;
  currentSql: string;
  currentPythonCode: string;
  developmentLanguage: "SQL" | "PYTHON";
  onDevelopmentLanguageChange: (language: "SQL" | "PYTHON") => void;
  onOpenDestination: (id: string, handoffMessage?: string, editorHref?: string) => void;
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

  const initialTarget=useMemo(()=>typeof window==='undefined'?undefined:chatBatchTarget(window.location.href),[]);
  const [target,setTarget]=useState<ChatTarget|null|undefined>(initialTarget);
  const selectionEpoch=useRef(0),readOrder=useRef(0),actionLock=useRef(false);
  const originalSubmission=useRef<{requestId:string;source:PublishedReportBinding;message:string;approvalMode:"PLAN_ONLY"|"REQUEST_APPROVAL"}|undefined>(undefined);
  const [notFound,setNotFound]=useState(false);
  const [actionBusy,setActionBusy]=useState(false),[batchRetry,setBatchRetry]=useState(0);
  const [batchRead,setBatchRead]=useState<{key:string;value?:Awaited<ReturnType<typeof readWealthBatch>>;error?:string}>();
  const wealthSource=target?.source??(task?.reportPlanningProfile==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS'?task.reportSource:undefined);
  const sourceKey=JSON.stringify(wealthSource??null);
  useEffect(()=>{
    let active=true;setBatchRead(undefined);
    if(local && sourceKey!=='null'){
      readWealthBatch(api,JSON.parse(sourceKey)).then(value=>{
        if(active)setBatchRead({key:sourceKey,value});
      },cause=>{if(active)setBatchRead({key:sourceKey,error:(cause as Error).message});});
    }
    return()=>{active=false;};
  },[api,local,sourceKey,batchRetry]);
  useEffect(()=>()=>{selectionEpoch.current++;readOrder.current++;},[]);
  const verifiedBatch=batchRead?.key===sourceKey?batchRead.value:undefined;
  const boundReady=target!==null && (!target || local && !!verifiedBatch && !target.requestId);
  const sendAllowed=canWrite&&modelConfigured&&!busy&&!actionBusy&&boundReady&&message.trim().length>=4;
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
    const ticket=++readOrder.current,selectedEpoch=selectionEpoch.current;
    const current=()=>ticket===readOrder.current && selectedEpoch===selectionEpoch.current;
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
    if(!current())return;
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
            if(item.destinationId==='development'&&item.specialistLanguage==='SPARK_SQL'){
              if(nextGraph.intentId!==selected.id||item.executionEvidence!=='SPECIALIST_TASK_LINKED'||item.specialistTaskKind!=='agent')
                throw Error('对话与原开发任务的关联尚待核对。');
              restored.development={destinationId:'development',id:item.specialistTaskId!,
                status:item.specialistStatus??'UNKNOWN',getPath:`/agent/intents/${selected.id}/graph`,sqlGraph:true};
              return;
            }
            const result = await api<Record<string, unknown>>(getPath);
            if(item.destinationId==='reports'&&selected.reportSource&&selected.reportPlanningProfile==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS'){
              if(nextGraph.intentId!==selected.id||item.executionEvidence!=='SPECIALIST_TASK_LINKED'||result.id!==item.specialistTaskId)
                throw Error('任务图与原报表方案不匹配');
              const plan=await readChatReportPlan({request:path=>api(path)},{root:result,source:selected.reportSource});
              restored.reports={
                destinationId:'reports',id:plan.id,status:plan.status,
                getPath:fillToolPath(requireTool('reports',catalog).detailPath,plan.id),
                result:{...plan},boundPlan:plan,applied:plan.status==='APPLIED',
              };
              return;
            }
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
              status: item.destinationId==='reports'&&selected.reportPlanningProfile==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS' ? "UNCONFIRMED" : "FAILED",
              getPath,
              error: (cause as Error).message,
            };
          }
        }),
    );
    if(current())setActivities(restored);
  };
  const refresh = async (
    preferredId?: string,
    catalog = toolCatalog,
  ) => {
    const selectedEpoch=selectionEpoch.current;
    const next = await api<IntentTask[]>("/agent/intents");
    if(selectedEpoch!==selectionEpoch.current)return;
    setTasks(next);
    const id=preferredId??task?.id;
    const selected = id ? next.find(item=>item.id===id) : next[0];
    await loadTask(selected, catalog);
  };
  async function restore(original:ChatTarget, catalog=toolCatalog) {
    if(!original.requestId||!local)return;
    const ticket=selectionEpoch.current;
    setNotFound(false);
    let saved:IntentTask;
    try{saved=await readReportIntent({request:path=>api(path)},{requestId:original.requestId,source:original.source}) as IntentTask;}
    catch(cause){
      if(ticket===selectionEpoch.current && (cause as {code?:string}).code==='AGENT_REPORT_INTENT_NOT_FOUND')setNotFound(true);
      throw cause;
    }
    if(ticket!==selectionEpoch.current)return;
    if(saved.requestId!==original.requestId||!sameReportSource(saved.reportSource,original.source))
      throw Error('原会话与所选发布批次不一致。');
    if(originalSubmission.current && saved.messageHash!==await reportMessageHash(originalSubmission.current.message))
      throw Error('原请求与当前输入无法核对。');
    if(ticket!==selectionEpoch.current)return;
    originalSubmission.current=undefined;
    setError('');setTasks(items=>[saved,...items.filter(item=>item.id!==saved.id)]);
    await loadTask(saved,catalog);
  }
  useEffect(() => {
    const ticket=selectionEpoch.current;
    void (async () => {
      try {
        const catalog = await api<AgentToolCatalog>("/agent/tools");
        if (
          catalog.version !== "shuduo-agent-tools/v2" ||
          !/^[a-f0-9]{64}$/.test(catalog.contractDigest)
        )
          throw new Error("专业Agent工具目录版本不兼容，请刷新或升级工作台");
        if(selectionEpoch.current!==ticket)return;
        setToolCatalog(catalog);
        if(initialTarget!==undefined){
          const list=await api<IntentTask[]>('/agent/intents');
          if(selectionEpoch.current!==ticket)return;
          setTasks(list);
          if(initialTarget?.requestId)await restore(initialTarget,catalog);
        } else {
          const intentId=new URLSearchParams(location.search).get('chat_intent')??undefined;
          await refresh(intentId,catalog);
        }
      } catch (cause) {
        if(ticket===selectionEpoch.current)setError((cause as Error).message);
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
    const pendingActivities=Object.values(activities).filter(item=>pending(item.status)&&item.getPath);
    if(!pendingActivities.length)return;
    const ticket=selectionEpoch.current;
    let disposed=false,reading=false;
    const currentSelection=()=>!disposed&&selectionEpoch.current===ticket;
    const poll=async()=>{
      if(reading||!currentSelection())return;
      reading=true;
      try{
        for(const item of pendingActivities){
          try{
            if(item.sqlGraph&&task){
              const next=await api<IntentGraph>(item.getPath);
              if(!currentSelection())return;
              const step=next.steps.find(s=>s.destinationId==='development');
              if(next.intentId!==task.id||step?.specialistTaskId!==item.id||step.specialistLanguage!=='SPARK_SQL'||
                step.executionEvidence!=='SPECIALIST_TASK_LINKED'||step.specialistTaskKind!=='agent')throw Error('原开发任务的关联尚待核对。');
              const status=step.specialistStatus??'UNKNOWN';
              if(status!==item.status){
                setGraph(next);
                setActivities(all=>({...all,development:{...item,status}}));
              }
              continue;
            }
            const result=await api<Record<string,unknown>>(item.getPath);
            if(!currentSelection())return;
            const status=String(result.status??item.status);
            if(item.boundPlan&&task){
              // Re-read the linked lineage when the specialist settles. Only
              // its current job needs polling while the model is still busy.
              if(!pending(status))await loadTask(task);
              continue;
            }
            setActivities(all=>({...all,[item.destinationId]:{...item,status,result}}));
            if(!pending(status)&&task){
              const next=await api<IntentGraph>(`/agent/intents/${task.id}/graph`);
              if(selectionEpoch.current===ticket)setGraph(next);
            }
          }catch(cause){
            if(!currentSelection())return;
            setActivities(all=>({...all,[item.destinationId]:{
              ...item,status:item.boundPlan||item.sqlGraph?'UNCONFIRMED':'FAILED',error:(cause as Error).message,
            }}));
          }
        }
      }finally{reading=false;}
    };
    const timer=setInterval(()=>void poll(),1200);
    return()=>{disposed=true;clearInterval(timer);};
  }, [activities,task?.id]);

  const resetTask = () => {
    selectionEpoch.current++;readOrder.current++;originalSubmission.current=undefined;setNotFound(false);setTarget(undefined);setBatchRead(undefined);
    history.replaceState(null,'',location.pathname+'?module=agent-center#agent-chat');
    setTask(undefined);
    setMessage("");
    setTrace([]);
    setGraph(undefined);
    setApprovals([]);
    setHandoffs([]);
    setActivities({});
    setError("");
  };
  const chooseBatch=(source:PublishedReportBinding)=>{
    const draft=message;
    resetTask();setTarget({source});setMessage(draft);
    history.replaceState(null,'',chatBatchLocation(location.href,source));
  };
  const selectHistory=async(item:IntentTask)=>{
    resetTask();
    if(item.reportPlanningProfile==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS'&&item.reportSource?.kind==='AGENT'&&item.requestId){
      setTarget({source:item.reportSource,requestId:item.requestId});
      history.replaceState(null,'',chatBatchLocation(location.href,item.reportSource,item.requestId));
    } else {
      history.replaceState(null,'',location.pathname+'?module=agent-center&chat_intent='+encodeURIComponent(item.id)+'#agent-chat');
    }
    await loadTask(item);
  };
  const submit = async (retryOriginal=false) => {
    const prior=retryOriginal?originalSubmission.current:undefined;
    if(actionLock.current || (!retryOriginal && !sendAllowed) ||
        (retryOriginal && (!prior || !notFound || !canWrite || !modelConfigured || !verifiedBatch ||
          target?.requestId!==prior.requestId || !sameReportSource(target.source,prior.source) ||
          message.trim()!==prior.message || approvalMode!==prior.approvalMode)))return;
    const ticket=++selectionEpoch.current;readOrder.current++;
    actionLock.current=true;setBusy(true);setError("");
    try {
      const requestId=prior?.requestId??crypto.randomUUID(),text=message.trim(),source=target?.source;
      setNotFound(false);
      if(source){
        originalSubmission.current={requestId,source,message:text,approvalMode};
        // Save the opaque recovery locator before the single model-backed submission.
        history.replaceState(null,'',chatBatchLocation(location.href,source,requestId));
        setTarget({source,requestId});
      }
      const created=await api<IntentTask>('/agent/intents',{message:text,approvalMode,...(source?{reportSource:source}:{})},{idempotencyKey:requestId});
      if(ticket!==selectionEpoch.current)return;
      if(source&&(created.requestId!==requestId||!sameReportSource(created.reportSource,source)||created.messageHash!==await reportMessageHash(text)))throw Error('会话没有确认所选批次，请查询原规划请求。');
      originalSubmission.current=undefined;
      if(!source)history.replaceState(null,'',location.pathname+'?module=agent-center&chat_intent='+encodeURIComponent(created.id)+'#agent-chat');
      setSubmittedMessages(current=>({...current,[created.id]:text}));
      setTasks(current=>[created,...current.filter(item=>item.id!==created.id)]);
      setTask(created);setTrace([]);setGraph(undefined);setApprovals([]);setHandoffs([]);setActivities({});setMessage("");
    }catch(cause){if(ticket===selectionEpoch.current)setError((cause as Error).message);}
    finally{actionLock.current=false;setBusy(false);}
  };

  const prepareStep = async (step: RouteStep) => {
    if (!task || actionLock.current) return;
    const ticket=selectionEpoch.current;actionLock.current=true;setActionBusy(true);
    setError("");
    setActivities((all) => ({
      ...all,
      [step.destinationId]: { destinationId: step.destinationId, id: "preparing", status: "QUEUED", getPath: "" },
    }));
    try {
      const tool = requireTool(step.destinationId),
        requiredActivity = tool.requiresDestination
          ? activities[tool.requiresDestination]
          : undefined;
      if (
        tool.requiresDestination &&
        (!requiredActivity || requiredActivity.status !== "SUCCEEDED")
      )
        throw new Error("请先完成当前步骤要求的前置专业任务，再继续执行。");
      const toolInput = tool.createMode === "CODE_DEVELOPMENT"
          ? {
              message: step.objective,
              contextId,
              language:
                developmentLanguage === "PYTHON" ? "PYTHON" : "SPARK_SQL",
              code:
                developmentLanguage === "PYTHON"
                  ? currentPythonCode
                  : currentSql || "SELECT 1",
            }
          : tool.createMode === "DELIVERY_FROM_DEVELOPMENT"
            ? { sourceTaskId: requiredActivity!.id }
            : { message: step.objective,...(step.destinationId==='reports'&&task?.reportSource?{source:task.reportSource}:{}) };
      if (!toolCatalog) throw new Error("专业Agent工具目录尚未加载");
      await api(`/agent/tools/${encodeURIComponent(tool.id)}/validate`, {
        catalogVersion: toolCatalog.version,
        contractDigest: toolCatalog.contractDigest,
        input: toolInput,
      });
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
      if (!approval) throw new Error("当前审批模式不能调用专业Agent工具");
      const invocation = await api<AgentToolInvocation>(
          tool.invokePath
            .replace("{intentId}", encodeURIComponent(task.id))
            .replace("{destinationId}", encodeURIComponent(step.destinationId)),
          {
            catalogVersion: toolCatalog.version,
            contractDigest: toolCatalog.contractDigest,
            approvalId: approval.id,
            input: toolInput,
          },
        ),
        id = invocation.specialist.id,
        getPath = invocation.specialist.detailPath,
        created = invocation.specialist;
      if(ticket!==selectionEpoch.current)return;
      if(step.destinationId==='development'&&invocation.graph.steps.some(s=>s.destinationId==='development'&&s.specialistLanguage==='SPARK_SQL')){
        await loadTask(task);
        return;
      }
      setActivities((all) => ({
        ...all,
        [step.destinationId]: {
          destinationId: step.destinationId,
          id,
          status: String(created.status ?? "QUEUED"),
          getPath,
          result: created,
        },
      }));
      setTrace(await api<IntentTrace[]>(`/agent/intents/${task.id}/trace`));
      setGraph(invocation.graph);
      setApprovals(await api<StepApproval[]>(`/agent/intents/${task.id}/approvals`));
      setHandoffs(await api<Handoff[]>(`/agent/intents/${task.id}/handoffs`));
      if(ticket===selectionEpoch.current&&step.destinationId==='reports'&&task.reportPlanningProfile==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS')
        await loadTask(task);
    } catch (cause) {
      if(ticket!==selectionEpoch.current)return;
      setActivities((all) => ({
        ...all,
        [step.destinationId]: {
          ...(all[step.destinationId] ?? { destinationId: step.destinationId, id: "failed", getPath: "" }),
          status: "FAILED",
          error: (cause as Error).message,
        },
      }));
    } finally {actionLock.current=false;setActionBusy(false);}
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
      const child=activities[step.destinationId]?.boundPlan;
      if(child?.originPlanId){
        await api(`/reports/agent/plans/${child.id}/cancel`,{});
        await loadTask(task);
        return;
      }
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
    if (!activity || !applyPath || actionLock.current) return;
    if(task?.reportPlanningProfile==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS' && step.destinationId==='reports' && (!verifiedBatch||!activity.boundPlan||
      activity.boundPlan.requestBasisState!=='VERIFIED'||activity.boundPlan.proposal?.kind!=='PUBLISHED_REPORT'||
      !sameReportSource(activity.boundPlan.sourceBinding,task.reportSource)))return;
    const ticket=selectionEpoch.current;actionLock.current=true;setActionBusy(true);
    try {
      const response=await api<unknown>(applyPath, activity.result?.planMode==='PUBLISHED_SOURCE_REPORT_V1'?{proposalHash:activity.result.proposalHash}:{});
      const result = await api<Record<string, unknown>>(activity.getPath);
      if(ticket!==selectionEpoch.current)return;
      if(activity.result?.planMode==='PUBLISHED_SOURCE_REPORT_V1' && result.status==='APPLIED'){
        const receipt=appliedChatReport(result,task?.reportSource);
        if(!receipt||typeof response!=='object'||!response||!('requestId' in response)||response.requestId!==receipt.requestId)
          throw Error('原报表生成回执尚待核对，请查询当前方案。');
      }
      if(activity.boundPlan&&task){
        await loadTask(task);
        return;
      }
      setActivities((all) => ({
        ...all,
        [step.destinationId]: {
          ...activity,
          status: String(result.status ?? "APPLIED"),
          result,
          applied: result.status==='APPLIED',
        },
      }));
      if (task?.id)
        setGraph(await api<IntentGraph>(`/agent/intents/${task.id}/graph`));
    } catch (cause) {
      if(ticket!==selectionEpoch.current)return;
      setActivities((all) => ({
        ...all,
        [step.destinationId]: { ...activity, error: (cause as Error).message },
      }));
    }finally{actionLock.current=false;setActionBusy(false);}
  };

  const sqlStep=task&&graph?.intentId===task.id
    ? graph.steps.find(s=>s.destinationId==='development'&&s.specialistLanguage==='SPARK_SQL') : undefined;
  const readableSqlId=sqlStep?.executionEvidence==='SPECIALIST_TASK_LINKED'&&sqlStep.specialistTaskKind==='agent'&&
    ['SUCCEEDED','FAILED','VALIDATION_FAILED','CANCELLED','INTERRUPTED'].includes(sqlStep.specialistStatus??'')
    ? sqlStep.specialistTaskId : undefined;
  const renderedSelection=selectionEpoch.current;
  const scopeChat=Boolean(readableSqlId&&sqlStep?.specialistStatus==='SUCCEEDED'&&!wealthSource);
  const reportActivity=activities.reports;
  const chatPlan=wealthSource&&task?.reportSource&&sameReportSource(wealthSource,task.reportSource)&&
    sameReportSource(reportActivity?.boundPlan?.sourceBinding,wealthSource)?reportActivity.boundPlan:undefined;
  const chatQuestion=chatPlan?.status==='NEEDS_CLARIFICATION'&&chatPlan.proposal?.kind==='CLARIFICATION_REQUIRED'?chatPlan.proposal.question:undefined;
  const appliedReport=appliedChatReport(activities.reports?.result,task?.reportSource);
  const fullAnalysis=(activities.reports?.result?.proposal as {customerAnalysis?:{kind?:string}}|undefined)?.customerAnalysis?.kind==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS';
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
    <div className="agent-os-v2" data-wealth-chat={Boolean(wealthSource)||undefined} data-sql-chat={Boolean(readableSqlId)||undefined}>
      <aside className="agent-os-history-v2">
        <header><div><Sparkles size={17} /><strong>数舵 Data Agent</strong></div><button aria-label="新建Agent任务" disabled={busy||actionBusy} onClick={resetTask}><Plus size={16} /></button></header>
        <button className="agent-os-new-v2" disabled={busy||actionBusy} onClick={resetTask}><MessageSquare size={15} />新任务</button>
        <span className="agent-os-section-label-v2">任务历史</span>
        <div className="agent-os-task-list-v2">
          {tasks.length ? tasks.map((item) => (
            <button key={item.id} className={item.id === task?.id ? "selected" : ""} disabled={busy||actionBusy} onClick={() => selectHistory(item).catch((cause) => setError((cause as Error).message))}>
              <span>{pending(item.status) ? <LoaderCircle className="spin" size={13} /> : <MessageSquare size={13} />}</span>
              <div><strong>{taskTitle(item)}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></div>
            </button>
          )) : <p>还没有任务。直接描述目标，不必先找模块。</p>}
        </div>
        <div className="agent-os-history-foot-v2"><ShieldCheck size={14} /><span>继承项目身份、权限、预算与审计</span></div>
      </aside>

      <section className="agent-os-chat-v2">
        <header className="agent-os-chat-head-v2"><div><span className="eyebrow">INDEPENDENT AGENT WORKSPACE</span><h2>{task ? taskTitle(task) : "你想完成什么数据工作？"}</h2></div><div className="agent-os-head-meta-v2"><span>证券数据实验室</span><span>{modelConfigured ? "模型已连接" : "模型待连接"}</span></div></header>
        {local&&<div className="agent-chat-batch-context">
          {target===null?<p role="alert">批次链接不完整。请新建会话并重新选择报表批次。</p>:
            wealthSource?<><strong>{verifiedBatch?`第 ${verifiedBatch.sequence} 批 · MySQL 持仓归档`:'报表批次待核对'}</strong>
              <span>{verifiedBatch?.businessDate} · 批次 {wealthSource.batchId.slice(0,8)}</span>
              {batchRead?.key===sourceKey&&batchRead.error&&<p role="alert">{batchRead.error} <button className="button" onClick={()=>setBatchRetry(n=>n+1)}>重新核对批次</button></p>}
              {target?.requestId&&!task&&!busy&&<button className="button" onClick={()=>void restore(target).catch(cause=>setError((cause as Error).message))}>查询原规划请求</button>}
              {notFound&&target?.requestId&&!task&&originalSubmission.current&&<button className="button" disabled={busy||!verifiedBatch||!canWrite||!modelConfigured||message.trim()!==originalSubmission.current.message||approvalMode!==originalSubmission.current.approvalMode}
                onClick={()=>void submit(true)}>按原编号和需求重试</button>}
              {verifiedBatch&&!task&&!target?.requestId&&<button className="button" onClick={()=>setMessage(`用第 ${verifiedBatch.sequence} 批持仓生成财富顾问五指标资产报表，包含总资产、持仓市值、证券数量、资产类别分布和行业分布。`)}>使用五指标报表需求</button>}
            </>:null}
          {!task&&target!==null&&!target?.requestId&&<AgentReportBatchPicker api={api} disabled={busy||actionBusy} onSelect={chooseBatch}/>}
        </div>}
        {error && <div className="agent-os-error-v2" role="alert">{error}</div>}
        <div className="agent-os-thread-v2">
          {!task && target===undefined && <section className="agent-os-empty-v2">
            <div className="agent-os-orbit-v2"><Bot size={30} /></div><h1>从目标出发，不从模块出发。</h1>
            <p>告诉我你要得到的业务结果。数舵会理解需求、规划步骤、调用数据中台能力，并把代码、任务、报表与运行证据留在同一个会话中。</p>
            <div className="agent-os-prompts-v2">{["接入虚构持仓数据，开发T+1客户资产任务并发布DAPI", "找到客户持仓口径，生成质量规则和资产分析报表", "诊断昨日失败批次，分析影响并准备恢复方案"].map((prompt) => <button key={prompt} onClick={() => setMessage(prompt)}>{prompt}<ArrowRight size={13} /></button>)}</div>
          </section>}
          {task && <>
            <article className="agent-os-message-v2 user"><div>{selectedMessage ?? "任务原文已按隐私策略不持久化；以下展示Agent生成的安全摘要。"}</div></article>
            <article className="agent-os-message-v2 assistant"><span className="agent-os-avatar-v2"><Bot size={16} /></span><div>
              {pending(task.status) ? <div className="agent-os-thinking-v2"><LoaderCircle className="spin" size={15} />正在理解目标、匹配上下文并规划跨域步骤…</div> : route ? <>
                <p>{route.summary}</p><small>{route.rationale}</small>
                <div className="agent-os-plan-v2"><header><div><FileCheck2 size={15} /><strong>执行计划</strong></div><span>{wealthSource?(appliedReport?'报表已生成':reportPhase(reportActivity)):`${completedCount}/${graph?.totalCount ?? steps.length} 已完成 · ${graph ? "持久任务图" : "加载中"}`}</span></header><ol>{steps.map((step, index) => {
                  const activity = activities[step.destinationId], reportReceipt=appliedChatReport(activity?.result,task.reportSource), proposal=activity?.result?.proposal as {name?:string;metricIds?:string[];customerAnalysis?:{kind?:string}}|undefined, approval = approvals.find((item) => item.destinationId === step.destinationId), prepared = handoffs.some((item) => item.destinationId === step.destinationId), graphStep = graph?.steps.find((item) => item.destinationId === step.destinationId), linked = graphStep?.executionEvidence === "SPECIALIST_TASK_LINKED", canApply = ["SUCCEEDED","APPLYING"].includes(activity?.status??"") && linked && Boolean(toolById.get(step.destinationId)?.applyPath), artifactRows = activityArtifactRows(activity), complete = succeeded(activity?.status) && (!graph || linked), recoveryText = graphStep?.invocationRecovery === "RETRY_BINDING" ? "专业任务已创建，等待恢复任务图绑定" : graphStep?.invocationRecovery === "RETRY_REQUIRED" ? "工具调用已中断或失败，可重新批准恢复" : graphStep?.invocationRecovery === "WAIT" ? "工具调用已持久化，正在创建专业任务" : "";
                  return <li key={step.destinationId} className={complete ? "complete" : retryable(activity?.status) ? "failed" : ""}><span>{complete ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span><div><div className="agent-os-step-title-v2"><strong>{step.label}</strong><small>{riskLabel[step.risk]}</small></div>
                    {step.destinationId==='reports'&&chatPlan?.clarification
                      ? <p className="agent-chat-confirmed-scope"><strong>已确认口径</strong> {chatPlan.message}</p>
                      : <p>{step.objective}</p>}
                    {activity && <div className="agent-os-activity-v2"><CircleDot size={12} /><span>{activity.boundPlan||activity.status==='UNCONFIRMED' ? reportReceipt?'报表已生成':reportPhase(activity) : complete ? activity.result?.planMode==='PUBLISHED_SOURCE_REPORT_V1' ? reportReceipt?'报表已生成':activity.status==='SUCCEEDED'?'方案待审阅':'报表回执待核对' : activity.applied ? '专业草稿已写入' : '专业Agent已完成' : activity.status === "FAILED" ? activity.error : activity.status === "CANCELLED" ? "专业Agent已取消" : activity.status === "INTERRUPTED" ? "服务重启后专业任务已中断" : "专业Agent执行中"}</span>{activity.id !== "preparing" && activity.id !== "failed" && <code>{activity.id.slice(0, 8)}</code>}</div>}
                    {recoveryText && <div className="agent-os-activity-v2"><Clock3 size={12} /><span>{recoveryText}</span>{graphStep?.invocationAttempt && <code>尝试 {graphStep.invocationAttempt}</code>}</div>}
                    {approval && <div className="agent-os-activity-v2"><ShieldCheck size={12} /><span>{approval.status === "BOUND" ? "本次批准已绑定专业任务" : "步骤已批准，等待绑定任务"}</span><code>{approval.id.slice(0, 8)}</code></div>}
                    {proposal?.customerAnalysis?.kind==='MYSQL_HOLDINGS_CUSTOMER_ANALYSIS'&&<div className="agent-report-plan"><strong>{proposal.name}</strong><p>按客户与交易日核对总资产、持仓市值和证券数量。资产类别与行业分布按原冻结明细计算，占比分母为该客户的持仓市值。</p></div>}
                    {artifactRows.length > 0 && <details className="agent-os-artifact-v2"><summary>查看专业Agent产物</summary><div>{artifactRows.map((row) => <section key={row.label}><span>{row.label}</span>{Array.isArray(row.value) ? <div className="agent-os-artifact-tags-v2">{row.value.map((item) => <code key={item}>{item}</code>)}</div> : <p>{row.value}</p>}</section>)}</div></details>}
                    <div className="agent-os-step-actions-v2">{task.status !== "CANCELLED" && task.approvalMode !== "PLAN_ONLY" && (!activity || retryable(activity.status)&&!activity.boundPlan) && <button onClick={() => prepareStep(step)} disabled={!canWrite || !modelConfigured || actionBusy || Boolean(wealthSource&&!verifiedBatch)}><Wrench size={13} />{retryable(activity?.status) ? "重新批准并重试" : "批准并执行此步骤"}</button>}{activity && pending(activity.status) && <button className="secondary" onClick={() => cancelSpecialist(step)} disabled={!canWrite || childCancelBusy === step.destinationId}><Clock3 size={12} />{childCancelBusy === step.destinationId ? "正在取消…" : "取消专业子任务"}</button>}{canApply && !activity.applied && !(activity?.error&&activity.result?.planMode==='PUBLISHED_SOURCE_REPORT_V1') && <button disabled={!canWrite||actionBusy||Boolean(wealthSource&&(!verifiedBatch||activity.result?.requestBasisState!=='VERIFIED'||!sameReportSource(activity.result?.sourceBinding,wealthSource)))} onClick={() => applyDraft(step)}><Check size={13} />{activity?.result?.planMode==='PUBLISHED_SOURCE_REPORT_V1'?'按审阅方案生成报表':'应用为草稿'}</button>}{activity?.applied && (activity.result?.planMode!=='PUBLISHED_SOURCE_REPORT_V1'||reportReceipt) && <span className="agent-os-applied-v2"><Check size={12} />{activity?.result?.planMode==='PUBLISHED_SOURCE_REPORT_V1'?'报表已实际生成':'草稿已写入'}</span>}{!(step.destinationId==='development'&&sqlStep)&&<button className="secondary" disabled={graph?.intentId!==task.id} onClick={() => openProfessionalWorkspace(step)}><ExternalLink size={12} />记录接管并打开工作台</button>}</div>
                    {activity?.error&&activity.status!=='FAILED'&&<div role="alert">{activity.error}
                      <button className="button" disabled={busy||actionBusy} onClick={()=>void loadTask(task).catch(cause=>setError((cause as Error).message))}>查询原方案结果</button>
                    </div>}
                    {prepared && !activity && <small className="agent-os-prepared-v2">已准备专业Agent输入，尚未执行工具。</small>}
                  </div></li>;
                })}</ol></div>
                <div className="agent-os-step-actions-v2">{task.status === "CANCELLED" ? <span className="agent-os-applied-v2"><Check size={12} />已停止后续编排</span> : <button className="secondary" onClick={cancelIntent} disabled={!canWrite || cancelBusy}><Clock3 size={12} />{cancelBusy ? "正在停止…" : "停止后续编排"}</button>}</div>
                {trace.length > 0 && <details className="agent-os-trace-v2"><summary>查看执行轨迹与证据</summary>{trace.map((item) => <div key={item.id}><span>{item.sequence}</span><strong>{item.kind === "MODEL_ROUTE" ? "需求理解与规划" : item.kind === "STEP_APPROVAL" ? "人工批准专业步骤" : item.kind === "INTENT_CANCELLED" ? "停止后续编排" : item.kind === "SPECIALIST_CANCELLED" ? "取消专业子任务" : "专业Agent任务绑定"}</strong><small>{item.output?.destinationId ?? "—"} · {item.execution} · {new Date(item.observedAt).toLocaleTimeString("zh-CN")}</small></div>)}</details>}
              </> : <p>{task.status === "INTERRUPTED" ? "服务重启时任务尚未完成；原始需求未持久化，请新建任务并重新描述目标。" : task.status === "CANCELLED" ? "后续编排已停止，历史证据仍保留。" : task.error ?? "Agent未能形成可执行计划。"}</p>}
            </div></article>
            {task&&readableSqlId&&<Suspense fallback={<p role="status">正在加载 SQL 查看器…</p>}>
              <ChatSqlDevelopment key={task.id+':'+readableSqlId+':'+sqlStep?.specialistStatus} api={api}
                intentId={task.id} taskId={readableSqlId} canEdit={canWrite} isCurrent={()=>selectionEpoch.current===renderedSelection} onOpen={href=>{
                  if(!task.reportSource)
                    history.replaceState(null,'',location.pathname+'?module=agent-center&chat_intent='+encodeURIComponent(task.id)+'#agent-chat');
                  onOpenDestination('development',undefined,href);
                }}/>
            </Suspense>}
            {scopeChat&&task&&readableSqlId&&<Suspense fallback={<p role="status">正在打开口径变更记录…</p>}>
              <ChatScopeChange key={task.id+':'+readableSqlId} api={api} intentId={task.id} taskId={readableSqlId} isCurrent={()=>selectionEpoch.current===renderedSelection}
                canSubmit={canWrite&&modelConfigured&&!actionBusy&&task.status!=='CANCELLED'&&task.approvalMode==='REQUEST_APPROVAL'}/>
            </Suspense>}
            {chatPlan?.clarification&&<details className="agent-chat-clarification-history">
              <summary>本次方案的口径确认 · {chatPlan.clarification.depth} 轮</summary>
              <p>原需求：{chatPlan.clarification.originalRequest}</p>
              <dl>{chatPlan.clarification.turns.map(turn=><div key={turn.planId}><dt>{turn.question}</dt><dd>{turn.answer}</dd></div>)}</dl>
            </details>}
            {task&&chatPlan&&chatQuestion&&<article className="agent-chat-question" aria-label="确认报表口径">
              <small>{chatPlan.clarification?.depth===3?'口径确认已达三轮':`Data Agent · 第 ${(chatPlan.clarification?.depth??0)+1} 次口径确认`}</small>
              <h3>{chatQuestion}</h3>
              <ReportClarificationReply key={chatPlan.id} api={api} plan={chatPlan}
                canWrite={canWrite&&local&&Boolean(verifiedBatch)&&!actionBusy&&task.status!=='CANCELLED'&&task.approvalMode==='REQUEST_APPROVAL'&&
                  chatPlan.requestBasisState==='VERIFIED'&&!reportActivity.error}
                available={modelConfigured} chatRequestId={reportChatReplyKey(chatPlan.id)}
                onContinue={()=>{void loadTask(task).catch(e=>setError((e as Error).message));}}/>
            </article>}
            {appliedReport&&fullAnalysis&&<details className="agent-chat-report-result"><summary>查看本次生成的客户资产报表</summary>
              <Suspense fallback={<p role="status">正在加载原报表…</p>}><CustomerAssetAnalysis key={appliedReport.requestId} api={api} title={appliedReport.name} selection={{
                requestId:appliedReport.requestId,source:appliedReport.source,reportId:appliedReport.reportId!,reportRunId:appliedReport.reportRunId!,
                versionId:appliedReport.reportVersionId!,resultHash:appliedReport.resultHash!,reportSnapshotId:appliedReport.snapshotId
              }}/></Suspense>
            </details>}
            {appliedReport&&!fullAnalysis&&<a className="button" href={'?module=agent-center&report_request='+appliedReport.requestId}>查看原报表运行</a>}
          </>}
        </div>
        {readableSqlId&&!scopeChat&&!message.trim()&&<footer className="chat-sql-footer">
          <button className="button" onClick={resetTask} disabled={busy||actionBusy}>发起新需求</button>
        </footer>}
        {scopeChat?<footer className="chat-change-footer"><button className="button" onClick={resetTask} disabled={busy||actionBusy}>发起新需求</button></footer>:task&&wealthSource?<footer className="chat-report-footer"><button className="button" onClick={()=>chooseBatch(wealthSource)} disabled={busy||actionBusy||!verifiedBatch}>用此批次提新需求</button></footer>:<footer className="agent-os-composer-v2">
          <textarea aria-label="向数舵 Data Agent 描述目标" placeholder={wealthSource?"描述这次资产报表的需求…":"描述你希望完成的目标，例如：接入持仓数据，生成T+1资产任务并发布服务…"} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && sendAllowed) { event.preventDefault(); submit(); } }} maxLength={2000} />
          <div>{!wealthSource&&<div className="agent-os-context-v2"><span>@ 证券数据实验室</span><span><Code2 size={11} />{contextId}</span><span>{developmentLanguage === "PYTHON" ? "受限Python" : "Spark SQL"}</span><span>{approvalMode === "PLAN_ONLY" ? "只规划" : "请求批准"}</span></div>}<div className="agent-os-send-v2">{!wealthSource&&<select aria-label="数据开发语言" value={developmentLanguage} onChange={(event) => onDevelopmentLanguageChange(event.target.value as "SQL" | "PYTHON")}><option value="SQL">Spark SQL</option><option value="PYTHON">受限Python</option></select>}<select aria-label="Agent审批模式" value={approvalMode} onChange={(event) => setApprovalMode(event.target.value as typeof approvalMode)}><option value="REQUEST_APPROVAL">请求批准</option><option value="PLAN_ONLY">仅规划</option></select><button aria-label="发送给Data Agent" onClick={()=>void submit()} disabled={!sendAllowed}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div></div>
          <small>Agent可以调用所有经典中台能力；读操作、草稿、发布和权限变更按风险分级，生产上线仍需独立批准。</small>
        </footer>}
      </section>

      <aside className="agent-os-inspector-v2">
        <header><strong>能力与上下文</strong><span>{toolCatalog?.tools.length ?? 10}个专业域</span></header>
        <section><span className="agent-os-section-label-v2">当前上下文</span><div className="agent-os-context-card-v2"><Database size={16} /><div><strong>证券数据实验室</strong><small>虚构数据 · 项目权限继承</small></div></div><div className="agent-os-context-card-v2"><Code2 size={16} /><div><strong>{contextId}</strong><small>{developmentLanguage === "PYTHON" ? "受限Python" : "Spark SQL"} · 当前编辑版本</small></div></div></section>
        <section><span className="agent-os-section-label-v2">专业能力</span>{capabilityGroups.map((group) => { const Icon = group.icon; return <div className="agent-os-capability-v2" key={group.label}><div><Icon size={14} /><strong>{group.label}</strong></div>{group.ids.map((id) => <span key={id}>{byDestination.get(id)?.label}</span>)}</div>; })}</section>
        <section className="agent-os-governance-v2"><span className="agent-os-section-label-v2">治理边界</span><p><ShieldCheck size={14} />继承用户权限，不向模型发送凭证或业务明细。</p><p><Clock3 size={14} />长任务后台运行，状态与证据可恢复。</p><p><FileCheck2 size={14} />发布、授权和高成本操作必须确认。</p></section>
        <footer><Activity size={13} />GUI / API / CLI / MCP 同源 · {toolCatalog?.version ?? "工具目录加载中"}</footer>
      </aside>
    </div>
  );
}
