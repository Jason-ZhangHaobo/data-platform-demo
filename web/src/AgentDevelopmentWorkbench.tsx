import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, ChevronDown, Code2, FileCode2, GitCompareArrows, History, LoaderCircle, Play, Plus, RefreshCw, Send, Square, Undo2 } from "lucide-react";
import { developmentRunLog } from "./run-log";
import { AgentDeliveryPanel } from "./AgentDeliveryPanel";
import { AgentRequirementExample } from "./AgentRequirementExample";
import {AgentRequirementUnderstanding} from './AgentRequirementUnderstanding';
import {AgentClarificationReply} from './AgentClarificationReply';
import {readSqlClarification,sqlClarificationBody,verifiedClarificationReceipt} from '../../src/v2/sql-clarification-client.mjs';
import {clarificationReplyReason} from '../../src/v2/sql-clarification-contract.mjs';
import { manualRunLocation, manualRunRecovery, manualSaveLocation, manualSaveRequest, acknowledgedManualDraft, mayReuseManualRevision,verifiedManualOrigin,manualSourceDisclosure,developmentContextLocked } from "./manual-run-recovery";
import {agentSubmissionRequest,agentSubmissionLocation,createAgentSubmission,agentTaskReceiptValid} from "./agent-submission";
import { fundExecutionBody, fundExecutionReceiptMatches } from "../../src/v2/fund-preparation-client.mjs";
import type { FundExecutionBinding, FundPreparationReceipt } from "../../src/v2/fund-preparation-client.mjs";
import {AgentSubmissionRecovery} from "./AgentSubmissionRecovery";
import {initialAgentTaskId,loadHistoryAfterTarget,mergeTaskHistory,checkedAgentTask,checkedAgentRun} from "./agent-history-loading";
import {agentTaskFinished,mayEditScopedTask} from "./agent-task-scope";
import {AgentRepairAction} from "./AgentRepairAction";
import {failedRunRepairAction} from './agent-repair-action';
import {comparisonRepairReceiptMatches} from '../../src/v2/repair-comparison-client.mjs';
import {readAssistedContinuation,assistedContinuationReceiptMatches} from '../../src/v2/assisted-continuation-client.mjs';
import {readManualContinuation,manualContinuationReceiptMatches} from '../../src/v2/manual-continuation-client.mjs';
import {AgentModelRecovery} from "./AgentModelRecovery";
import {AgentContextDerivation} from "./AgentContextDerivation";
import {contextDerivationFromLocation,contextDerivationLocation,clearContextDerivation,contextDerivationReference,contextDerivationAccessReason,readContextDerivationSource,contextDerivationSubmitReason,contextDerivationBody,contextDerivationReceiptMatches,contextDerivationReceiptContent} from "./agent-context-derivation";
import type {ContextDerivationDraft,VerifiedDerivationSource,DerivedFrom} from "./agent-context-derivation";
import {ValidationDetails,ValidationResultScope} from "./ValidationDetails";
import type {ValidationDetailsReport} from "./validation-details";
import type {ServiceSourceBinding} from "./service-source-binding";
import {validServiceSourceBinding,sourceBindingEnvironmentMatches,agentReturnSourceMatches,serviceSourcesPath,currentAgentTaskLocation} from "./service-source-binding";
import {agentResumeDecision,modelRecoveryNeedsAction,pauseModelRecovery,submitAgentResume} from "./agent-model-recovery";
import {clearAgentArchivePin} from "./agent-archive-location";
import {agentCallHistoryTarget} from "./agent-call-history";
import {AgentCallHistory} from "./AgentCallHistory";
import type { PublicationTarget } from "./AuthDialog";
import type {ValidationFamily} from "./validation-family";
import "./agent-development.css";
const FundAgentPreparation = lazy(() => import("./FundAgentPreparation"));
const SqlEditor = lazy(() => import("./SqlEditor"));
const ManualDeliveryWorkbench = lazy(async () => ({default:(await import("./DeliveryWorkbench")).DeliveryWorkbench}));
const RunColumnLineagePanel=lazy(()=>import('./RunColumnLineagePanel'));
const RunComparisonPanel=lazy(()=>import('./RunComparisonPanel'));
const StandaloneManualDeliveryPanel=lazy(async()=>({default:(await import('./StandaloneManualDeliveryPanel')).StandaloneManualDeliveryPanel}));
type Context = { id: string; name: string; definition: string; businessDate?:string; validationFamily?:ValidationFamily; capabilities?:{delivery?:boolean;agentDevelopment?:boolean;fundPreparation?:boolean};outputContract?:{id:string;fields:{name:string;label:string}[]}; tables: { name: string; columns: [string, string][] }[] };
type Task = { id: string; version: number; status: string; stage?: string; requirements?:unknown;clarification?:import('../../src/v2/sql-clarification-client.mjs').SqlClarification;humanClarified?:boolean;directAutonomousEligible?:boolean;clarificationOriginTaskId?:string;executionMode?: string; mode?:string;language?:string;fundPreparation?:FundExecutionBinding;sourceKind?:string;sourceAttribution?:unknown;manualContinuation?:import('../../src/v2/manual-continuation-binding.mjs').ManualContinuationBinding;assistedContinuation?:import('../../src/v2/assisted-continuation-binding.mjs').AssistedContinuationBinding;derivedFrom?:DerivedFrom; message: string; contextId: string; sql?: string; initialSql?: string; sourceRunId?: string; explanation?: string; error?: string; revisionId?: string; runId?: string; usedTokens?: number; createdAt?: string; recovery?: { modelLeaseExpiresAt?: string }; background?: {status:string;state?:string;delivery?:string;expiresAt:number;consumedEvents:number;maxEvents:number;code?:string;scopeBlocked?:boolean}; attempts: { attempt: number; status: string; revisionId?: string; runId?: string; sourceRunId?: string; model?: string; diagnostic?: {code:string;phase:string;httpStatus?:number;elapsedMs:number;requestMayHaveBeenSent:boolean} }[] };
type Run = { id: string; status: string; agentTaskId?:string; contextId?:string; createdAt?: string; validationContractId?: string; validationDetails?:ValidationDetailsReport; revisionId?: string; revisionHash?: string; engine?: string; engineVersion?: string; mainSqlExecuted?:boolean;columnLineage?:unknown;testDouble?:boolean;sourceKind?:string;sourceAttribution?:unknown; rows?: Record<string, unknown>[]; columns?: { name: string; type: string }[]; error?: string; log?: string; stage?: string; validation?: { passed: boolean; contractId?:string; issues?: string[]; regressions?: { contextId: string; name: string; passed: boolean }[] } };
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
type SavedRevision = {id:string;sql:string;hash?:string;contextId:string;source?:string;manualProvenance?:{originAgentTaskId?:string;kind:string;agentIndependentE2E:boolean}};
const terminal = (s?: string) => Boolean(s && ["SUCCEEDED", "FAILED", "CANCELLED", "VALIDATION_FAILED","INTERRUPTED"].includes(s));
const stageText: Record<string, string> = { READY_FOR_MODEL: "准备生成 / 修正", MODEL_IN_FLIGHT: "正在编写代码", MODEL_OUTCOME_UNKNOWN: "模型结果待确认", MODEL_NOT_SENT:"模型请求未发送，等待修复后重试", READY_FOR_RUN: "代码已保存，待执行", WAITING_FOR_RUN: "Spark 执行与校验中", CANCELLING: "正在停止", SUCCEEDED: "SQL 验证通过", FAILED: "需要处理", CANCELLED: "已停止", QUEUED: "等待执行", RUNNING: "执行中", INTERRUPTED: "执行中断，记录保留", VALIDATION_FAILED: "业务断言未通过", NO_SQL_CHANGE:"模型未修改代码（未重复执行）" };
Object.assign(stageText,{REQUIREMENT_CLARIFICATION_REQUIRED:'等待需求澄清（未执行）',REQUIREMENT_EVIDENCE_INVALID:'需求理解未确认（未执行）'});
stageText.CLARIFICATION_SOURCE_CHANGED='澄清依据已变化，原记录保留';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const resultFieldLabels: Record<string,string> = { client_id:"客户", holding_market_value:"持仓市值（元）", available_cash:"可用现金（元）", total_assets:"总资产（元）", security_count:"证券数量" };

type WorkbenchProps = {
  initialContextId?:string;
  api: Api; contexts: Context[]; canWrite: boolean; canPublish?: boolean; publicationTarget?: PublicationTarget; ready: boolean; readinessReason?:string; loading: boolean; privatePreview: boolean; runtimeMode?: "LOCAL_DEVELOPMENT" | "PUBLIC_INVITATION"; backgroundAvailable?:boolean; readOnly?:boolean; taskOnly?:boolean; targetTaskId?:string; onLogin: () => void; onDirtyChange: (dirty: boolean) => void; onOpenServices?: (source:ServiceSourceBinding) => void;
  expectedSourceBinding?:ServiceSourceBinding;expectedManualSource?:import("./service-source-binding").StandaloneServiceSourceBinding;expectedSourceError?:string;
};

export function AgentDevelopmentWorkbench(props: WorkbenchProps) {
  const url = new URL(location.href);
  const taskId = url.searchParams.get("task") ?? "";
  const target = agentCallHistoryTarget(url.href, taskId);
  if (target !== undefined)
    return <AgentCallHistory key={url.href} api={props.api} target={target} loading={props.loading} onLogin={props.onLogin}/>;
  return <DevelopmentWorkspace {...props}/>;
}

function DevelopmentWorkspace({ api, contexts: availableContexts, initialContextId, canWrite:originalCanWrite, canPublish, publicationTarget, ready, readinessReason, loading, privatePreview, runtimeMode, backgroundAvailable=false, readOnly:requestedReadOnly=false, taskOnly=false, targetTaskId, expectedSourceBinding,expectedManualSource,expectedSourceError,onLogin, onDirtyChange, onOpenServices }: WorkbenchProps) {
  const contexts=availableContexts.filter(context=>context.capabilities?.agentDevelopment!==false);
  const fundContexts=availableContexts.filter(context=>context.capabilities?.fundPreparation===true);
  const [fundDirty,setFundDirty]=useState(false);
  const sourceReturnActive=Boolean(expectedSourceBinding||expectedManualSource||expectedSourceError),readOnly=requestedReadOnly||sourceReturnActive;
  const [returnSourceError,setReturnSourceError]=useState("");
  const [tasks, setTasks] = useState<Task[]>([]), [task, setTask] = useState<Task>(), [contextId, setContextId] = useState(initialContextId ?? "holdings-t1");
  const [message, setMessage] = useState(""), [draft, setDraft] = useState(""), [baseline, setBaseline] = useState("");
  const [run, setRunValue] = useState<Run>(), [tab, setTab] = useState("结果"), [diff, setDiff] = useState(false);
  const [runRead,setRunRead]=useState<{state:"IDLE"|"LOADING"|"ERROR";message?:string}>({state:"IDLE"});
  function setRun(value:Run|undefined){setRunValue(value);setRunRead({state:"IDLE"});}
  const [baselineRevisionId, setBaselineRevisionId] = useState<string>();
  const [automatic, setAutomatic] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [retryConsent, setRetryConsent] = useState(false);
  const initialDerivation=typeof window==="undefined"?{status:"ABSENT" as const}:contextDerivationFromLocation(window.location.href);
  const [derivationActive,setDerivationActive]=useState(initialDerivation.status!=="ABSENT");
  const [derivationDraft,setDerivationDraft]=useState<ContextDerivationDraft|undefined>(()=>initialDerivation.status==="VALID"?initialDerivation.draft:undefined);
  const [derivationSource,setDerivationSource]=useState<VerifiedDerivationSource>();
  const [derivationState,setDerivationState]=useState<"LOADING"|"READY"|"ERROR">(initialDerivation.status==="INVALID"?"ERROR":"LOADING");
  const [derivationError,setDerivationError]=useState(initialDerivation.status==="INVALID"?initialDerivation.error:"");
  const derivationRef=useRef(derivationDraft),derivationSourceRef=useRef(derivationSource),derivationActiveRef=useRef(derivationActive);
  derivationRef.current=derivationDraft;derivationSourceRef.current=derivationSource;derivationActiveRef.current=derivationActive;
  const derivationAutomaticMessage=useRef<string|undefined>(undefined),messageRef=useRef(message);messageRef.current=message;
  const initialManual=typeof window==="undefined"?undefined:manualRunRecovery(window.location.href);
  const [manualUnconfirmed, setManualUnconfirmed] = useState(()=>Boolean(initialManual?.requestKey)), [originTaskId, setOriginTaskId] = useState<string>();
  const [manualDeliveryOpen, setManualDeliveryOpen] = useState(false);
  const [pendingSaveKey, setPendingSaveKey] = useState<string|undefined>(()=>typeof window==="undefined"?undefined:manualSaveRequest(window.location.href));
  const revisionRequest = useRef<{key:string;sql:string;contextId:string;originAgentTaskId?:string} | undefined>(undefined);
  const confirmedManualRevision = useRef<SavedRevision | undefined>(undefined);
  const [backgroundConsent,setBackgroundConsent]=useState(true);
  const [historyState,setHistoryState]=useState<"loading"|"loaded"|"deferred"|"error">("loading"),[historyError,setHistoryError]=useState("");
  const historyFlight=useRef<Promise<void>|undefined>(undefined),startupStarted=useRef(false);
  const restoredManual=useRef<string|undefined>(undefined),draftRef=useRef(draft);draftRef.current=draft;
  const epoch = useRef(0), selectedId = useRef<string | undefined>(undefined);
  const alive = useRef(true), manualRequest = useRef<{ revisionId: string; key: string } | undefined>(initialManual?.revisionId&&initialManual.requestKey?{revisionId:initialManual.revisionId,key:initialManual.requestKey}:undefined);
  const [pendingAgentKey,setPendingAgentKey]=useState<string|undefined>(()=>typeof window==="undefined"?undefined:agentSubmissionRequest(window.location.href));
  const scopeEditable=mayEditScopedTask(taskOnly,targetTaskId,task?.id,originTaskId);
  const canWrite=originalCanWrite&&!readOnly&&!publicationTarget&&!pendingAgentKey&&scopeEditable;
  const submission=useRef<ReturnType<typeof createAgentSubmission<Task>>|undefined>(undefined);
  function submissionController(){
    if(!submission.current||submission.current.snapshot().closed)submission.current=createAgentSubmission<Task>({api,initialKey:agentSubmissionRequest(location.href),onPending:key=>{
      setPendingAgentKey(key);if(key)history.replaceState(null,"",derivationActiveRef.current&&derivationRef.current?contextDerivationLocation(location.href,derivationRef.current,key):agentSubmissionLocation(location.href,key));
    }});
    return submission.current;
  }
  const fundTask = Boolean(task?.fundPreparation);
  const context = (fundTask ? fundContexts : contexts).find(c => c.id === contextId), dirty = draft !== baseline;
  const scopedLabels=context?.outputContract?context.validationFamily?.metricLabels:context?.validationFamily?.id==="securities-stock-cash-five-fixtures-v1"?context.validationFamily.metricLabels:undefined;
  const resultLabel=(field:string)=>context?.outputContract?context.outputContract.fields.find(f=>f.name===field)?.label??field:scopedLabels?.[field]
    ? scopedLabels[field]+(["holding_market_value","available_cash","total_assets"].includes(field)?"（元）":"")
    :resultFieldLabels[field]??field;
  const localManualDelivery = runtimeMode === "LOCAL_DEVELOPMENT" && !privatePreview;
  const runPending = Boolean(run && !terminal(run.status));
  const working = automatic || busy, durable = task?.executionMode === "DURABLE_SQL_AGENT_V1";
  const contextLocked=developmentContextLocked({readOnly,publicationOnly:Boolean(publicationTarget),taskOnly,working,hasTask:Boolean(task)||sourceReturnActive,hasSavedRevision:Boolean(baselineRevisionId||initialManual?.revisionId),pendingSubmission:Boolean(pendingAgentKey||pendingSaveKey||manualUnconfirmed),runPending});
  const submissionAccess=useRef({canWrite,ready,taskOnly});submissionAccess.current={canWrite,ready,taskOnly};
  const unknown = task?.stage === "MODEL_OUTCOME_UNKNOWN";
  const modelNotSent = task?.stage === "MODEL_NOT_SENT";
  const clarificationReason=task?.stage==='REQUIREMENT_CLARIFICATION_REQUIRED'?clarificationReplyReason(task):undefined;
  const resumeInput = task ? {task,canWrite,working,dirty,
    pendingResult:manualUnconfirmed||Boolean(pendingSaveKey)||Boolean(pendingAgentKey),retryConsent} : undefined;
  const resumeReason = resumeInput ? agentResumeDecision(resumeInput).reason : undefined;
  const repairInput = {taskOnly,taskStatus:task?.status,ready,canWrite,working,dirty,
    pendingResult:manualUnconfirmed||Boolean(pendingSaveKey)||Boolean(pendingAgentKey)||runPending,
    hasContext:Boolean(context),baselineRevisionId,run};
  const derivationAccess={canWrite:originalCanWrite,readOnly,taskOnly,sourceLocked:sourceReturnActive,publicationOnly:Boolean(publicationTarget),working,
    pending:manualUnconfirmed||Boolean(pendingSaveKey)||Boolean(pendingAgentKey)||runPending,dirty};
  const derivationReference=fundTask?undefined:contextDerivationReference(task,run,baselineRevisionId);
  const derivationStartReason=contextDerivationAccessReason({...derivationAccess,unsentMessage:Boolean(message.trim())})||(!derivationReference?"请选择当前已成功核验的原生SQL Agent版本，人工版本与历史失败批次不适用。":"");
  const derivationSubmitReason=derivationState!=="READY"?derivationError||"原冻结来源尚未核验，请等待或重新读取。":contextDerivationSubmitReason(derivationDraft,derivationSource,derivationAccess,ready,draft);
  function accept(current: Task) {
    setTask(current); setTasks(old => [current, ...old.filter(t => t.id !== current.id)]);
  }
  async function restoreDerivation(selection:ContextDerivationDraft){
    const token=++epoch.current,key=JSON.stringify(selection);setAutomatic(false);setBusy(true);setError("");
    setDerivationActive(true);derivationActiveRef.current=true;setDerivationDraft(selection);derivationRef.current=selection;
    setDerivationSource(undefined);derivationSourceRef.current=undefined;setDerivationState("LOADING");setDerivationError("");
    selectedId.current=undefined;setTask(undefined);setRun(undefined);setDraft("");setBaseline("");setBaselineRevisionId(undefined);setDiff(false);setContextId(selection.targetContextId);
    const current=()=>alive.current&&epoch.current===token&&JSON.stringify(derivationRef.current)===key;
    try{
      if(sourceReturnActive||taskOnly||publicationTarget)throw Error("当前只读返程或限定窗口不允许新口径草稿；请返回原任务查看，未创建任务。");
      const source=await readContextDerivationSource(selection,<T,>(path:string)=>api<T>(path));
      if(!current())return false;
      setDerivationSource(source);derivationSourceRef.current=source;setDerivationState("READY");
      setDraft(source.sql);setBaseline(source.sql);setBaselineRevisionId(source.source.revisionId);
      const suggested="请基于原已验证SQL，按选定的新口径改写并重新验证。";
      if(!messageRef.current)derivationAutomaticMessage.current=suggested;
      setMessage(previous=>previous||suggested);
      setNotice("已只读恢复原SQL与成功证据；新需求文字不写入链接。选择不同口径并确认后，才会创建新任务。");return true;
    }catch(cause){if(current()){setDerivationState("ERROR");setDerivationError((cause as Error).message);}return false;}
    finally{if(current())setBusy(false);}
  }
  async function beginDerivation(){
    if(derivationStartReason||!derivationReference||!task){setNotice(derivationStartReason);return;}
    const selection={source:derivationReference,targetContextId:task.contextId};
    history.replaceState(null,"",contextDerivationLocation(location.href,selection));
    await restoreDerivation(selection);
  }
  function chooseDerivationTarget(targetContextId:string){
    if(!derivationDraft||derivationState!=="READY"||contextDerivationAccessReason(derivationAccess)||!contexts.some(context=>context.id===targetContextId))return;
    const selection={...derivationDraft,targetContextId};setDerivationDraft(selection);derivationRef.current=selection;setContextId(targetContextId);
    history.replaceState(null,"",contextDerivationLocation(location.href,selection));
  }
  async function exitDerivation(){
    if(working||pendingAgentKey||manualUnconfirmed||pendingSaveKey){setNotice("原请求尚未确认，请先按原编号查询；不会丢弃待确认的提交。");return;}
    if(message.trim()&&!confirm("退出口径变更草稿？本页新需求文字不会保存；原成功任务不受影响。"))return;
    const sourceTask=derivationDraft?.source.taskId;
    epoch.current++;rememberSelection();setTask(undefined);setRun(undefined);setDraft("");setBaseline("");setBaselineRevisionId(undefined);setMessage("");
    if(sourceTask)await selectTask(sourceTask,false);
  }
  function loadHistory() {
    if(historyFlight.current)return historyFlight.current;
    const pending=loadHistoryOnce().catch(e=>{if(alive.current){setHistoryError((e as Error).message);setHistoryState("error");}}).finally(()=>{if(historyFlight.current===pending)historyFlight.current=undefined;});
    historyFlight.current=pending;return pending;
  }
  async function loadHistoryOnce() {
    setHistoryError("");setHistoryState("loading");
    if(sourceReturnActive&&!expectedManualSource){
      if(expectedSourceError||!expectedSourceBinding||!validServiceSourceBinding(expectedSourceBinding)||expectedSourceBinding.sourceKind!=="AGENT"||
        !sourceBindingEnvironmentMatches(expectedSourceBinding,runtimeMode==="PUBLIC_INVITATION",runtimeMode)){
        setReturnSourceError(expectedSourceError??"返程来源或运行环境未确认，未采用当前任务的其他版本。");setHistoryState("deferred");return;
      }
      const linkedId=initialAgentTaskId(location.href);
      if(linkedId&&linkedId!==expectedSourceBinding.taskId){setReturnSourceError("返程任务编号与发布来源不一致，未采用其他任务。");setHistoryState("deferred");return;}
      await selectTask(expectedSourceBinding.taskId,false);if(alive.current)setHistoryState("deferred");return;
    }
    const deriving=contextDerivationFromLocation(location.href);
    if(deriving.status!=="ABSENT"){
      if(deriving.status==="INVALID"){setDerivationActive(true);setDerivationState("ERROR");setDerivationError(deriving.error);setHistoryState("deferred");return;}
      if(await restoreDerivation(deriving.draft))if(agentSubmissionRequest(location.href))await recoverAgentSubmission();
      if(alive.current)setHistoryState("deferred");return;
    }
    if(agentSubmissionRequest(location.href)){await recoverAgentSubmission();if(alive.current)setHistoryState("deferred");return;}
    const saveKey=manualSaveRequest(location.href);
    if (saveKey) { setPendingSaveKey(saveKey); await recoverSavedRevision(saveKey); if(alive.current)setHistoryState("deferred"); return; }
    const { revisionId, runId, requestKey, originTaskId: origin } = manualRunRecovery(location.href);
    if(expectedManualSource&&(!validServiceSourceBinding(expectedManualSource)||!sourceBindingEnvironmentMatches(expectedManualSource,runtimeMode==='PUBLIC_INVITATION',runtimeMode)||revisionId!==expectedManualSource.revisionId||runId!==expectedManualSource.runId||origin!==undefined||initialAgentTaskId(location.href))){setReturnSourceError('独立手工返程的原代码、运行或环境未确认，未采用其他版本。');setHistoryState('deferred');return;}
    const manualTarget=!selectedId.current&&revisionId&&/^[a-f0-9-]{36}$/.test(revisionId),manualKey=JSON.stringify([revisionId,runId,requestKey]);
    if (manualTarget && restoredManual.current!==manualKey && !dirty) {
      const recoveryEpoch=epoch.current,draftAtStart=draftRef.current;
      const saved = await api<SavedRevision>(`/revisions/${revisionId}`);
      const persistedOrigin=verifiedManualOrigin(saved,origin);
      const actual = runId ? await api<Run>(`/runs/${runId}`) : requestKey ? undefined : (await api<Run[]>("/runs")).find(r => r.revisionId === saved.id);
      if(expectedManualSource&&(saved.source!=='MANUAL'||saved.hash!==expectedManualSource.revisionHash||actual?.revisionHash!==expectedManualSource.revisionHash||actual.revisionId!==expectedManualSource.revisionId))throw Error('独立手工返程的保存字节与运行不一致，未采用其他版本');
      if (actual && actual.revisionId !== saved.id) throw new Error("运行与代码版本不匹配，请重新选择任务。");
      if (!alive.current || epoch.current!==recoveryEpoch || selectedId.current) return;
      if(draftRef.current!==draftAtStart){setHistoryState("deferred");setNotice("读取期间的编辑已保留；没有用已保存版本覆盖当前代码。");return;}
      setTask(undefined); setContextId(saved.contextId); setDraft(saved.sql); setBaseline(saved.sql); setBaselineRevisionId(saved.id); setRun(actual);
      confirmedManualRevision.current = saved;
      manualRequest.current = requestKey ? {revisionId:saved.id, key:requestKey} : undefined;
      setManualUnconfirmed(Boolean(requestKey)); setOriginTaskId(persistedOrigin);
      rememberManual(saved.id, actual?.id, requestKey, persistedOrigin);
      setNotice(requestKey ? "原提交结果未确认，恢复编号已保留；不会自动重跑，也不会用其他批次替代原请求。" : actual ? "已恢复手工保存的代码版本及其运行，没有重新提交。" : "已恢复保存的代码，尚未确认对应运行；没有自动重新提交。");
      setHistoryState("deferred");
      return;
    }
    const id=manualTarget?undefined:initialAgentTaskId(location.href);
    await loadHistoryAfterTarget<Task>({
      restoreTarget:id&&(!selectedId.current||(!task&&selectedId.current===id))?()=>selectTask(id,false):undefined,
      readHistory:()=>api<Task[]>("/agent/tasks"),isCurrent:()=>alive.current,
      acceptHistory:list=>{setTasks(old=>mergeTaskHistory(list,old.find(item=>item.id===selectedId.current)));setHistoryState("loaded");},
      onHistoryError:e=>{setHistoryError((e as Error).message);setHistoryState("error");},
    });
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; submission.current?.close(); }; }, []);
  useEffect(() => {
    if (initialContextId && contextId === initialContextId && contexts.length && !contexts.some(item => item.id === contextId))
      setContextId(contexts[0].id);
  }, [initialContextId, contextId, availableContexts]);
  useEffect(() => { if (readOnly || !originalCanWrite || publicationTarget) { epoch.current++; setAutomatic(false); setBusy(false); } }, [readOnly, originalCanWrite, publicationTarget?.taskId]);
  // The parent mounts this view only after identity/capabilities are confirmed.
  // Initialize its read/write epoch above before starting the first task read.
  // Context or worker readiness updates must not refetch the same task/history.
  useEffect(() => { if(startupStarted.current)return;startupStarted.current=true;void loadHistory(); }, []);
  useEffect(() => { onDirtyChange(dirty || Boolean(message.trim()) || manualUnconfirmed || Boolean(pendingSaveKey) || Boolean(pendingAgentKey) || fundDirty); }, [fundDirty, dirty, message, manualUnconfirmed, pendingSaveKey, pendingAgentKey, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 9000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (fundDirty || dirty || message.trim() || manualUnconfirmed || pendingSaveKey || pendingAgentKey) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [fundDirty, dirty, message, manualUnconfirmed, pendingSaveKey,pendingAgentKey]);
  useEffect(() => { setManualDeliveryOpen(false); }, [run?.id, baselineRevisionId]);
  useEffect(() => { setRetryConsent(false); }, [task?.id, task?.stage]);
  useEffect(() => {
    if (!run || terminal(run.status) || automatic) return;
    let active = true, polling = false;
    const id = run.id, timer = setInterval(async () => {
      if (polling) return; polling = true;
      try { const next = await api<Run>(`/runs/${id}`); if (active) setRun(next); }
      catch (e) { if (active) setError((e as Error).message); }
      finally { polling = false; }
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [run?.id, run?.status, automatic]);
  const rememberSelection = (id?: string) => {
    selectedId.current = id;
    const url = clearContextDerivation(location.href);
    if (url.searchParams.get("task") !== id) clearAgentArchivePin(url);
    if (id) url.searchParams.set("task", id); else url.searchParams.delete("task");
    setDerivationActive(false);derivationActiveRef.current=false;setDerivationDraft(undefined);derivationRef.current=undefined;
    setDerivationSource(undefined);derivationSourceRef.current=undefined;setDerivationError("");
    url.searchParams.delete("revision"); url.searchParams.delete("run");
    url.searchParams.delete("run_request"); url.searchParams.delete("origin_task");
    url.searchParams.delete("save_request"); setPendingSaveKey(undefined); revisionRequest.current=undefined;
    url.searchParams.delete("agent_request");setPendingAgentKey(undefined);
    manualRequest.current = undefined; setManualUnconfirmed(false); setOriginTaskId(undefined);
    setManualDeliveryOpen(false);
    history.replaceState(null, "", url);
  };
  const rememberManual = (revisionId: string, runId?: string, requestKey?: string, origin = originTaskId) => {
    selectedId.current = undefined;
    restoredManual.current=JSON.stringify([revisionId,runId,requestKey]);
    const url = manualRunLocation(location.href, {revisionId, runId, requestKey, originTaskId:expectedManualSource?undefined:origin});
    history.replaceState(null, "", url);
  };
  async function selectTask(id: string, protectDraft = true) {
    if(derivationActiveRef.current){setNotice("请先退出口径变更草稿；不会丢弃新需求或切换到其他来源。");return;}
    if(sourceReturnActive&&(expectedSourceError||!expectedSourceBinding||id!==expectedSourceBinding.taskId)){setReturnSourceError("此页只定位原发布来源；未切换到其他任务或最新代码。");return;}
    if (manualUnconfirmed || pendingSaveKey || pendingAgentKey) { setNotice("请先确认原提交、保存或运行请求，再切换任务；不会丢弃未确认请求。"); return; }
    const keepDraft = selectedId.current === id && dirty;
    if (protectDraft && dirty && !keepDraft && !confirm("当前代码有未保存修改，是否放弃修改并切换任务？")) return;
    const selectionEpoch = ++epoch.current; setAutomatic(false); setBusy(true); setError(""); setRetryConsent(false);
    rememberSelection(id);
    let readingRun=false;
    try {
      const current = checkedAgentTask<Task>(await api<unknown>(`/agent/tasks/${id}`),id);
      if (!alive.current || selectedId.current !== id || epoch.current !== selectionEpoch) return;
      if(expectedSourceBinding){
        if(!expectedSourceBinding.revisionId||!expectedSourceBinding.runId)throw Error("返程链接缺少原代码版本或运行编号，未采用最新版本。");
        const [saved,actual,sources]=await Promise.all([api<SavedRevision>(`/revisions/${expectedSourceBinding.revisionId}`),api<Run>(`/runs/${expectedSourceBinding.runId}`),api<unknown>(serviceSourcesPath(expectedSourceBinding))]);
        if(!alive.current||selectedId.current!==id||epoch.current!==selectionEpoch)return;
        if(!agentReturnSourceMatches(expectedSourceBinding,current,actual,saved,sources))throw Error("原任务的代码、运行或发布来源已变化，无法恢复此冻结版本；未展示最新版本冒充原证据。");
        accept(current);setContextId(current.contextId);setDraft(saved.sql);setBaseline(saved.sql);setBaselineRevisionId(saved.id);setDiff(false);setRun(actual);setReturnSourceError("");
        setNotice("已核对原生 Agent、代码、运行和确切发布来源；当前返程只读，不创建人工版本或启动计算。");return;
      }
      accept(current); setContextId(current.contextId);
      if (!keepDraft) { setDraft(current.sql ?? current.initialSql ?? ""); setBaseline(current.sql ?? current.initialSql ?? ""); setBaselineRevisionId(current.revisionId); setDiff(false); }
      setRun(undefined);readingRun=Boolean(current.runId);
      if(readingRun)setRunRead({state:"LOADING"});
      const actual = current.runId ? checkedAgentRun<Run>(await api<unknown>(`/runs/${current.runId}`),current) : undefined;
      if (!alive.current || selectedId.current !== id || epoch.current !== selectionEpoch) return;
      setRun(actual);
      setNotice(keepDraft ? "服务端状态已刷新，未保存的编辑已保留；运行结果仍对应原代码版本。" : "已恢复服务端任务；读取历史不会重新调用模型。点击继续才会推进。");
    } catch (e) { if (alive.current && epoch.current === selectionEpoch){if(sourceReturnActive){setReturnSourceError((e as Error).message);setTask(undefined);setRun(undefined);setDraft("");setBaseline("");setBaselineRevisionId(undefined);}else {if(readingRun)setRunRead({state:"ERROR",message:(e as Error).message});setError((e as Error).message);}} } finally { if (alive.current && epoch.current === selectionEpoch) setBusy(false); }
  }
  async function readAttemptRun(runId:string,revisionId:string|undefined,label:string,source=false,view="日志") {
    if(!task||working)return;
    const token=epoch.current,taskId=task.id,context=task.contextId;
    const active=()=>alive.current&&epoch.current===token&&selectedId.current===taskId;
    setBusy(true);setError("");
    try {
      const actual=checkedAgentRun<Run>(await api<unknown>(`/runs/${runId}`),{...(source?{}:{id:taskId}),contextId:context,runId,revisionId});
      if(!active())return;
      setRun(actual);setTab(view);setNotice(label+" 编辑器保留当前代码；结果以原批次所绑定版本为准，没有新增计算。");
    } catch(cause) {if(active())setError((cause as Error).message+" 已展示的原批次保持不变。");}
    finally {if(active())setBusy(false);}
  }
  function newTask() {
    if (readOnly || !originalCanWrite || publicationTarget || taskOnly || derivationActive) return;
    if (manualUnconfirmed || pendingSaveKey || pendingAgentKey) { setNotice("请先确认原提交、保存或运行请求，再新建任务。"); return; }
    if (dirty && !confirm("当前代码有未保存修改，是否放弃并新建任务？")) return;
    epoch.current++; setAutomatic(false); rememberSelection(); setTask(undefined); setRun(undefined);
    if (fundTask) setContextId(contexts[0]?.id ?? "holdings-t1");
    setDraft(""); setBaseline(""); setBaselineRevisionId(undefined); setMessage(""); setError(""); setNotice(""); setDiff(false);
  }
  async function drive(start: Task, confirmRetry = false, manualTakeover = false) {
    if (readOnly || !originalCanWrite) return;
    if (publicationTarget || !mayEditScopedTask(taskOnly,targetTaskId,start.id,undefined)) return;
    const token = ++epoch.current; setAutomatic(true); setError("");
    let current = start, started = Date.now();
    let explicitNotSentRetry = manualTakeover && start.stage === "MODEL_NOT_SENT";
    try {
      for (let step = 0; step < 40 && token === epoch.current; step++) {
        if (Date.now() - started > 5 * 60 * 1000) { setNotice("本次自动推进已达5分钟上限；任务记录保留，可稍后继续。"); break; }
        if (agentTaskFinished(current.status)) break;
        if(current.background && !["ACTIVE","COMPLETED"].includes(current.background.status) && !manualTakeover){setNotice("云后台已暂停，检查点保留；请核对原因后明确选择人工继续。");break;}
        if (pauseModelRecovery(current.stage,{explicitNotSentRetry,confirmModelRetry:confirmRetry})) break;
        if (current.executionMode === "DURABLE_SQL_AGENT_V1") {
          if(current.background?.status==="ACTIVE"){
            if(current.background.delivery==="UNCONFIRMED"){setNotice("后台唤醒投递未确认；请刷新原任务后重试同一投递，不重新提交需求。");break;}
            if(Date.now()>=current.background.expiresAt){setNotice("后台授权窗口已到期，任务检查点保留；停止后台后可人工接管。");break;}
            await pause(5000);if(token!==epoch.current)break;
            current=await api<Task>(`/agent/tasks/${current.id}`);
          }else if (current.stage === "MODEL_IN_FLIGHT" && Date.parse(current.recovery?.modelLeaseExpiresAt ?? "") > Date.now()) {
            await pause(5000); if (token !== epoch.current) break;
            current = await api<Task>(`/agent/tasks/${current.id}`);
          } else {
            explicitNotSentRetry = false;
            current = await api<Task>(`/agent/tasks/${current.id}/advance`, { expectedVersion: current.version, ...(confirmRetry ? { confirmModelRetry: true } : {}) });
            confirmRetry = false;
          }
        } else { await pause(2000); if (token !== epoch.current) break; current = await api<Task>(`/agent/tasks/${current.id}`); }
        if (token !== epoch.current) break;
        accept(current);
        if (current.sql) { setDraft(current.sql); setBaseline(current.sql); setBaselineRevisionId(current.revisionId); }
        if (current.runId) {
          const actual = await api<Run>(`/runs/${current.runId}`);
          if (token !== epoch.current) break;
          setRun(actual);
        }
        if (agentTaskFinished(current.status) || modelRecoveryNeedsAction(current.stage)) break;
        await pause(current.stage === "WAITING_FOR_RUN" ? 5000 : 800);
      }
    } catch (e) {
      if (token === epoch.current) { setError((e as Error).message + " 请先刷新任务确认状态，不要重复新建。"); }
    } finally { if (token === epoch.current) { setAutomatic(false); setRetryConsent(false); } }
  }
  async function acceptSubmissionReceipt(current:Task,key:string,token:number,continueOriginal:boolean){
    if(!alive.current||epoch.current!==token||agentSubmissionRequest(location.href)!==key)return;
    if(!agentTaskReceiptValid(current))throw Error("任务回执不完整或语言不匹配，保留原提交编号");
    if(!manualContinuationReceiptMatches(current,submissionController().expectedBody()))throw Error("手工续改回执与原保存版本、意图或来源不一致，原编号保留。");
    if(!assistedContinuationReceiptMatches(current,submissionController().expectedBody()))throw Error('续改回执与原父版本或人工辅助来源不一致，保留原请求编号。');
    if(!fundExecutionReceiptMatches(current,submissionController().expectedBody(),key))throw Error("基金开发回执与原准备不一致，保留原请求编号。");
    if(!comparisonRepairReceiptMatches(current,submissionController().expectedBody()))throw Error('对照修正回执未绑定原来源、证据或人工辅助归因，保留原提交编号。');
    if(!await verifiedClarificationReceipt(current,submissionController().expectedBody()))throw Error('澄清回执未绑定原问题、答复或输入，保留原请求编号。');
    if(!alive.current||epoch.current!==token||agentSubmissionRequest(location.href)!==key)return;
    if(derivationActiveRef.current&&(!derivationRef.current||!derivationSourceRef.current||!contextDerivationReceiptMatches(current,derivationRef.current,derivationSourceRef.current)))
      throw Error("新任务回执未绑定原成功版本与目标口径，保留提交编号；不会改用其他任务。");
    const derivedReceipt=derivationActiveRef.current,automaticMessage=derivationAutomaticMessage.current;
    // Parse before acknowledging: malformed child SQL must keep the original
    // request and derivation URL, never throw later inside a React updater.
    const derivedContent=derivedReceipt?contextDerivationReceiptContent(current,"",automaticMessage):undefined;
    submissionController().acknowledge(key);rememberSelection(current.id);accept(current);setContextId(current.contextId);setRun(undefined);setBaselineRevisionId(current.revisionId);
    const saved=current.sql??current.initialSql;
    if(saved!==undefined){setDraft(previous=>derivedContent?derivedContent.sql:!continueOriginal&&previous!==baseline?previous:saved);setBaseline(saved);}
    setMessage(previous=>previous.trim()===current.message.trim()||derivedReceipt&&automaticMessage!==undefined&&previous===automaticMessage?"":previous);
    derivationAutomaticMessage.current=undefined;
    if(continueOriginal&&!agentTaskFinished(current.status)){
      setBusy(false);
      setNotice(current.background?.status==="ACTIVE"?"需求已保存并委托云端事件后台；发布仍须审阅。":"需求已保存，将按已确认口径生成代码并执行独立校验。");
      void drive(current);return;
    }
    if(current.runId){
      const actual=await api<Run>(`/runs/${current.runId}`);
      if(!alive.current||epoch.current!==token||selectedId.current!==current.id)return;
      setRun(actual);
    }
    setNotice(current.status==="INTERRUPTED"?"原任务与已有版本已找回，执行中断记录保留；不会自动重跑模型。":"已找回原任务及已有执行结果，未保存的编辑保留；查询没有重新发起模型或计算。需要推进时请审阅后点击继续任务。");
  }
  async function recoverAgentSubmission(retry=false){
    if(retry&&!originalCanWrite)return;
    const key=agentSubmissionRequest(location.href)??pendingAgentKey;if(!key)return;
    const token=++epoch.current;setAutomatic(false);setPendingAgentKey(key);setBusy(true);setError("");
    try{
      const controller=submissionController();
      const current=await (retry?controller.retry():controller.recover());
      await acceptSubmissionReceipt(current,key,token,false);
    }catch(cause){if(alive.current&&epoch.current===token)setError((cause as Error).message+(agentSubmissionRequest(location.href)?" 原提交编号保留，请用原账号继续查询；不会自动新建任务。":" 原任务已找回，执行结果读取尚未确认，请刷新原任务。"));}
    finally{if(alive.current&&epoch.current===token)setBusy(false);}
  }
  const fundExecutionBlocked = !ready || !canWrite || working || dirty || runPending || Boolean(message.trim()) ||
    manualUnconfirmed || Boolean(pendingSaveKey) || derivationActive;
  async function startFundExecution(receipt: FundPreparationReceipt) {
    if (fundExecutionBlocked) return;
    const token = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const created = await submissionController().submit(fundExecutionBody(receipt), receipt.requestId);
      if (created.fundPreparation?.inputDigest !== receipt.execution.inputDigest ||
          created.fundPreparation?.schemaDigest !== receipt.execution.schemaDigest ||
          created.fundPreparation?.assertionDigest !== receipt.execution.assertionDigest)
        throw Error("基金开发回执与已核对的输入或独立断言不一致。");
      await acceptSubmissionReceipt(created, receipt.requestId, token, true);
    } catch (cause) {
      if (alive.current && epoch.current === token) setError((cause as Error).message + " 请先查询原请求，不另建任务。");
    } finally {
      if (alive.current && epoch.current === token) setBusy(false);
    }
  }
  async function send(overrideMessage?: string, expectedRepairSourceId?: string, repairComparison?: import('../../src/v2/repair-comparison-client.mjs').RepairComparisonBasis) {
    if (fundTask) return;
    const requestMessage = (overrideMessage ?? message).trim();
    if(derivationActive){
      if(derivationSubmitReason||!derivationDraft||!derivationSource||expectedRepairSourceId){setNotice(derivationSubmitReason||"口径变更不能混用失败修正来源。");return;}
      const token=++epoch.current;setBusy(true);setError("");
      try{
        const body={...contextDerivationBody(derivationDraft,derivationSource,requestMessage),...(backgroundAvailable?{background:backgroundConsent}:{})};
        const controller=submissionController(),created=await controller.submit(body),key=controller.snapshot().key;
        if(key)await acceptSubmissionReceipt(created,key,token,true);
      }catch(e){if(alive.current&&epoch.current===token)setError((e as Error).message+" 原来源与提交编号保留，不自动另建任务。");}
      finally{if(alive.current&&epoch.current===token)setBusy(false);}return;
    }
    if (taskOnly || !ready || !canWrite || working || manualUnconfirmed || pendingSaveKey || pendingAgentKey || runPending || requestMessage.length < 4 || !context) return;
    if(assistedChatReason){setNotice(assistedChatReason);return;}
    const repairSource = run && ["FAILED", "VALIDATION_FAILED"].includes(run.status) && !dirty && run.revisionId === baselineRevisionId ? run.id : undefined;
    if (expectedRepairSourceId && repairSource !== expectedRepairSourceId) { setNotice("失败批次或代码版本已变化，请重新确认当前核验记录；未新建任务。"); return; }
    if(repairComparison&&(repairComparison.sourceRunId!==repairSource||repairComparison.contextId!==contextId||repairComparison.binding.currentRevisionHash!==run?.revisionHash||dirty)){
      setNotice('对照来源或代码已变化，请重读原运行；未新建任务。');return;
    }
    const manualParent=!task&&confirmedManualRevision.current?.source==='MANUAL'&&!repairSource?confirmedManualRevision.current:undefined;
    if(manualParent&&(dirty||!run||run.status!=='SUCCEEDED'||run.revisionId!==manualParent.id||run.revisionId!==baselineRevisionId||!run.revisionHash)){setNotice('请先保存并完整核验当前手工版本；原代码和修改意图保留。');return;}
    const continuationParent=task?.sourceKind==='MANUAL'&&task.status==='SUCCEEDED'&&!repairSource?task:undefined;
    if(continuationParent&&(dirty||!run||run.id!==continuationParent.runId||run.revisionId!==continuationParent.revisionId||baselineRevisionId!==continuationParent.revisionId||!run.revisionHash||run.status!=='SUCCEEDED')){
      setNotice('续改须基于当前成功代码与运行；请先保存核验或恢复当前版本，原需求与草稿保留。');return;
    }
    const token=++epoch.current,submittedSql=draft,submittedContext=contextId,submittedParent=continuationParent?.id,submittedManual=manualParent?.id;
    setBusy(true); setError("");
    const body = { message: requestMessage, sql: repairComparison||continuationParent||manualParent?draft:draft.trim() || "SELECT 1 AS pending", contextId, ...(backgroundAvailable?{background:backgroundConsent}:{}), ...(repairSource ? { sourceRunId: repairSource } : {}),...(repairComparison?{repairComparison:repairComparison.binding}:{}) };
    try {
      let continuation,manual;
      if(manualParent){
        const proof=await readManualContinuation({request:p=>api<unknown>(p)},{sourceRunId:run!.id,revisionId:manualParent.id,revisionHash:run!.revisionHash,contextId:submittedContext});
        if(!alive.current||epoch.current!==token||selectedId.current!==undefined||confirmedManualRevision.current?.id!==submittedManual||draftRef.current!==submittedSql||messageRef.current.trim()!==requestMessage||!submissionAccess.current.canWrite||!submissionAccess.current.ready||submissionAccess.current.taskOnly){if(alive.current&&epoch.current===token)setNotice("手工版本、意图或权限已变化，本次未提交；请按当前版本重新确认。");return;}
        manual=proof.binding;
      }
      if(continuationParent){
        const proof=await readAssistedContinuation({request:p=>api<unknown>(p)},{taskId:continuationParent.id,revisionId:baselineRevisionId,runId:run!.id,revisionHash:run!.revisionHash,contextId:submittedContext});
        if(!alive.current||epoch.current!==token||selectedId.current!==submittedParent||draftRef.current!==submittedSql||messageRef.current.trim()!==requestMessage||!submissionAccess.current.canWrite||!submissionAccess.current.ready||submissionAccess.current.taskOnly){
          if(alive.current&&epoch.current===token)setNotice('原输入、代码或权限已变化，本次未提交；请按当前版本重新确认。');return;
        }
        continuation=proof.binding;
      }
      const controller=submissionController(),created=await controller.submit({...body,...(continuation?{assistedContinuation:continuation}:{}),...(manual?{manualContinuation:manual}:{})}),key=controller.snapshot().key;
      if(key)await acceptSubmissionReceipt(created,key,token,true);
    } catch (e) { if(alive.current&&epoch.current===token)setError((e as Error).message + " 输入仍在本页，原编号已保留在恢复链接中，请先查询原任务。"); }
    finally { if(alive.current&&epoch.current===token)setBusy(false); }
  }
  async function answerClarification(){
    const parent=task,answer=message.trim(),question=(parent?.requirements as {interpretation?:{question?:string}}|undefined)?.interpretation?.question;
    if(!parent||parent.stage!=='REQUIREMENT_CLARIFICATION_REQUIRED'||clarificationReason||!question||taskOnly||readOnly||publicationTarget||derivationActive||!ready||!canWrite||working||dirty||runPending||!answer||answer.length>1000)return;
    const sourceSql=parent.sql??parent.initialSql;if(!sourceSql){setError('原任务未保存代码输入，请保留历史并新建完整需求；不会猜造原代码。');return;}
    const token=++epoch.current;setBusy(true);setError('');
    try{
      const source=await readSqlClarification({request:p=>api<unknown>(p)},{taskId:parent.id,contextId:parent.contextId,question,sql:sourceSql});
      if(!alive.current||epoch.current!==token||selectedId.current!==parent.id||messageRef.current.trim()!==answer||!submissionAccess.current.canWrite||!submissionAccess.current.ready||submissionAccess.current.taskOnly)return;
      const body={...sqlClarificationBody(source,answer),...(backgroundAvailable?{background:backgroundConsent}:{})};
      const controller=submissionController(),created=await controller.submit(body),key=controller.snapshot().key;
      if(key)await acceptSubmissionReceipt(created,key,token,true);
    }catch(cause){if(alive.current&&epoch.current===token)setError((cause as Error).message+' 原需求与回答保留，先按原编号查询，不自动重提。');}
    finally{if(alive.current&&epoch.current===token)setBusy(false);}
  }
  async function stop() {
    epoch.current++; setAutomatic(false); setBusy(true); setError(""); setNotice("停止请求已发送；当前调用返回前不会继续发起下一步骤。");
    try { if (task) {
      const stopped = await api<Task>(`/agent/tasks/${task.id}/cancel`, {}); accept(stopped);
      if (stopped.sql && !dirty) { setDraft(stopped.sql); setBaseline(stopped.sql); setBaselineRevisionId(stopped.revisionId); }
      setNotice(stopped.status === "CANCELLED" ? "委托已停止，代码和历史批次保留。" : "任务已结束，停止请求没有撤销已完成的结果。");
    } }
    catch (e) { setError((e as Error).message + " 停止结果未确认，请刷新任务。"); }
    finally { setBusy(false); }
  }
  async function runDraft() {
    if (derivationActive || !draft.trim() || !canWrite || working || runPending || manualUnconfirmed || pendingSaveKey || pendingAgentKey || fundTask) return;
    const submittedSql = draft, saveEpoch = epoch.current;
    setBusy(true); setError("");
    try {
      let revision: SavedRevision;
      if (!task && !dirty && mayReuseManualRevision(confirmedManualRevision.current, {id:baselineRevisionId,sql:baseline,contextId,originAgentTaskId:originTaskId})) revision=confirmedManualRevision.current!;
      else {
        const key=crypto.randomUUID(), origin=task?.id ?? originTaskId;
        revisionRequest.current={key,sql:draft,contextId,originAgentTaskId:origin};
        setPendingSaveKey(key);
        history.replaceState(null,"",manualSaveLocation(location.href,key,origin));
        revision=await api<SavedRevision>("/revisions",{sql:draft,contextId,...(origin ? {originAgentTaskId:origin} : {})},{idempotencyKey:key});
        setPendingSaveKey(undefined); revisionRequest.current=undefined;
      }
      if (!alive.current || epoch.current !== saveEpoch) return;
      acknowledgedManualDraft(submittedSql, submittedSql, revision.sql);
      setDraft(current => acknowledgedManualDraft(current, submittedSql, revision.sql));
      confirmedManualRevision.current = revision;
      const origin = task?.id ?? originTaskId;
      setOriginTaskId(origin); setBaseline(revision.sql); setBaselineRevisionId(revision.id); setTask(undefined); setRun(undefined);
      if (manualRequest.current?.revisionId !== revision.id) manualRequest.current = { revisionId: revision.id, key: crypto.randomUUID() };
      rememberManual(revision.id, undefined, manualRequest.current.key, origin); setManualUnconfirmed(true);
      const actual = await api<Run>("/runs", { revisionId: revision.id }, { idempotencyKey: manualRequest.current.key });
      if (!alive.current) return;
      if (actual.revisionId !== revision.id) throw new Error("返回批次与保存版本不一致，保留原提交编号");
      manualRequest.current = undefined; setManualUnconfirmed(false); rememberManual(revision.id, actual.id, undefined, origin);
      setRun(actual); setTab("结果"); setNotice("人工修改已另存版本并提交Spark；不会改写原Agent任务的验证结论。");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function resumeManualRun() {
    const pending = manualRequest.current;
    if (!pending || !canWrite || working) return;
    setBusy(true); setError("");
    try {
      const actual = await api<Run>("/runs", {revisionId:pending.revisionId}, {idempotencyKey:pending.key});
      if (!alive.current) return;
      if (actual.revisionId !== pending.revisionId) throw new Error("返回批次与原版本不一致，保留恢复编号");
      setRun(actual); setManualUnconfirmed(false); manualRequest.current=undefined;
      rememberManual(pending.revisionId, actual.id);
      setNotice("已按原提交编号确认批次；未保存的编辑保持不变，结果只属于原代码版本。");
    } catch(e) { setError((e as Error).message + " 原提交编号保留，不会生成新的重试编号。"); }
    finally { setBusy(false); }
  }
  async function recoverSavedRevision(key = pendingSaveKey) {
    if (!key) return;
    setBusy(true); setError("");
    try {
      const result=await api<{status:string;revision?:SavedRevision}>(`/revisions/requests/${key}`);
      if (!alive.current || manualSaveRequest(location.href) !== key) return;
      if (result.status !== "SAVED" || !result.revision) { setNotice("尚未查到原保存记录，保留编号与输入；可稍后再次查询。不会自动创建版本或执行。"); return; }
      const saved=result.revision, pending=revisionRequest.current;
      const origin=verifiedManualOrigin(saved,pending?.originAgentTaskId??manualRunRecovery(location.href).originTaskId);
      confirmedManualRevision.current = saved;
      setDraft(current => !current || current === pending?.sql ? saved.sql : current);
      setBaseline(saved.sql);setBaselineRevisionId(saved.id);setContextId(saved.contextId);setTask(undefined);setRun(undefined);
      setOriginTaskId(origin);rememberManual(saved.id,undefined,undefined,origin);
      setPendingSaveKey(undefined);revisionRequest.current=undefined;
      setNotice("原代码版本已找回，未保存修改仍保留。尚未提交运行；审阅后再点击保存并运行。");
    } catch(e) { if (alive.current) setError((e as Error).message + " 原保存编号保留，请重试查询，不必重复新建。"); }
    finally { if (alive.current) setBusy(false); }
  }
  async function retrySavedRevision() {
    const pending=revisionRequest.current ?? (pendingSaveKey && draft.trim() ? {key:pendingSaveKey,sql:draft,contextId,originAgentTaskId:manualRunRecovery(location.href).originTaskId} : undefined);
    if (!pending || !canWrite || working) return;
    revisionRequest.current=pending;
    setBusy(true);setError("");
    try {
      await api<SavedRevision>("/revisions",{sql:pending.sql,contextId:pending.contextId,...(pending.originAgentTaskId ? {originAgentTaskId:pending.originAgentTaskId} : {})},{idempotencyKey:pending.key});
      await recoverSavedRevision(pending.key);
    } catch(e) { setError((e as Error).message + " 原内容与编号保留。不会用当前修改覆盖原请求。"); }
    finally { setBusy(false); }
  }
  const codeOriginal = dirty ? baseline : task?.initialSql ?? baseline;
  const manualDisclosure=manualSourceDisclosure(confirmedManualRevision.current,originTaskId);
  const manualSuccessReady=!task&&confirmedManualRevision.current?.source==='MANUAL'&&run?.status==='SUCCEEDED'&&run.revisionId===baselineRevisionId&&run.revisionId===confirmedManualRevision.current.id&&!dirty;
  const assistedChatReason=(task?.sourceKind==='MANUAL'||!task&&confirmedManualRevision.current?.source==='MANUAL')&&!derivationActive&&task?.status!=='SUCCEEDED'&&!manualSuccessReady&&
    !(run&&['FAILED','VALIDATION_FAILED'].includes(run.status)&&run.revisionId===baselineRevisionId&&!dirty)?'当前尚无可续改的成功辅助任务或可引用的失败批次；请先继续原任务，或在编辑器保存核验。新的修改意图保留，不会改作无来源的新任务。':'';
  const resultFields = run?.rows?.[0] ? Object.keys(run.rows[0]) : [];
  return <section className="agent-dev" aria-label="Agent 数据开发工作台">
    <header className="agent-dev-heading">
      <div>
        <div className="eyebrow"><Bot size={14} /> AGENT DEVELOPMENT</div>
        <h1>把需求交给 Agent，<span>把结果握在手里。</span></h1>
        <p>{scopedLabels?context?.validationFamily?.name:"客户资产 T+1"} · 需求、代码与真实执行，在一个工作台完成。</p>
      </div>
      <div className="agent-dev-heading-controls">
        {!derivationActive && <label className="agent-dev-context-picker">
          <span>业务口径与验证数据</span>
          <select aria-label="Agent 验证数据" disabled={contextLocked} value={contextId} onChange={event => {
            if (contextLocked) return;
            setContextId(event.target.value);
            setRun(undefined);
            setBaselineRevisionId(undefined);
          }}>
            {contexts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {baselineRevisionId && <small>当前口径绑定已保存版本；新建任务后可另选口径。</small>}
        </label>}
        <div className="agent-dev-header-actions">
          {(task || baselineRevisionId) && <a className="button" href="#agent-delivery">核验与交付</a>}
          {task?.status === "SUCCEEDED" && <button className="button" title={derivationStartReason||"以当前成功版本创建新口径草稿，尚不执行"} disabled={Boolean(derivationStartReason)||derivationActive} onClick={()=>void beginDerivation()}>基于此版本变更口径</button>}
          <button className="button" disabled={derivationActive||taskOnly||!canWrite||working||Boolean(pendingAgentKey)} onClick={newTask}><Plus size={15} />新建任务</button>
        </div>
      </div>
    </header>
    {sourceReturnActive&&<div className="agent-dev-notice" role={returnSourceError||expectedSourceError?"alert":"status"}><div><strong>{expectedManualSource?"精确发布返程 · 独立手工版本只读定位":"精确发布返程 · 原生 Agent 只读定位"}</strong><p>{returnSourceError||expectedSourceError||(task?"原任务、代码、运行和确切发布来源已核对，当前只读展示冻结来源。":"正在核对原任务、代码版本、运行与确切发布来源；未核对前不展示其他版本。")}</p><small>离开版本定位可查看当前任务；打开链接不会自动调用模型或计算。</small>{expectedSourceBinding?.taskId&&validServiceSourceBinding(expectedSourceBinding)&&<a className="button" href={currentAgentTaskLocation(typeof location==="undefined"?"http://localhost/v2/":location.href,expectedSourceBinding.taskId).href}>打开当前任务继续处理</a>}</div></div>}
    <div className="agent-dev-boundary"><span className="agent-dev-dot" />{publicationTarget||readOnly&&canPublish ? "受邀发布试点 · 开发只读" : readOnly ? "只读验收" : privatePreview ? "私有试用" : runtimeMode === "PUBLIC_INVITATION" ? "受邀云端验证" : runtimeMode === "LOCAL_DEVELOPMENT" ? "本机开发验证" : "环境待确认"} · 仅虚构证券数据与 Spark SQL。{publicationTarget||readOnly&&canPublish ? "本页仅查看原代码与核验记录；只有指定交付包可以在下方审阅后进入两个冻结样例批次，不新建任务或修改代码。" : readOnly ? "仅查看历史任务与已保存结果；本页不会推进任务或提交计算。" : taskOnly ? "先查看指定任务并审阅原检查点，再明确选择继续或恢复后台；打开页面与刷新不会启动计算。" : backgroundAvailable?"可委托云端事件后台；浏览器只展示进度，不负责触发计算。每个委托有时限、事件与模型预算，发布仍须人工审阅。":"本页打开时自动推进；离开后检查点保留，已提交计算可继续，返回后可恢复。不是永久云调度。"}</div>
    {taskOnly&&<div className="agent-dev-alert" role="status"><div><strong>仅续接指定任务</strong><p>保留原任务编号、业务口径、尝试次数与费用预留。不新建或派生任务，其他历史只读；人工编辑单独标记，不计为 Agent 自主完成。查看任务不会启动计算。</p></div>{targetTaskId&&<button className="button" disabled={working||Boolean(pendingAgentKey)} onClick={()=>void selectTask(targetTaskId)}>查看指定任务</button>}</div>}
    {loading ? <div className="agent-dev-notice" role="status"><LoaderCircle size={14} className="spin" />正在连接服务并读取项目上下文…</div> : !ready && !publicationTarget && <div className="agent-dev-alert">{readinessReason??"模型或执行环境尚未就绪；历史任务仍可查询。"}</div>}
    {!loading && ready && !originalCanWrite && !readOnly && <div className="agent-dev-alert">需要有数据开发权限的账号才能提交任务。<button className="button" onClick={onLogin}>登录 / 查看账号</button></div>}
    {error && <div className="agent-dev-alert error" role="alert">{error}<button onClick={() => setError("")} aria-label="关闭错误提示">×</button></div>}
    {notice && <div className="agent-dev-notice" role="status">{notice}</div>}
    {derivationActive&&<AgentContextDerivation draft={derivationDraft} source={derivationSource} state={derivationState} error={derivationError} reason={derivationSubmitReason} contexts={contexts}
      busy={working} pending={Boolean(pendingAgentKey)} locked={Boolean(contextDerivationAccessReason({...derivationAccess,working:false,pending:false,dirty:false}))}
      onTarget={chooseDerivationTarget} onRead={()=>{if(derivationDraft)void restoreDerivation(derivationDraft);}} onExit={()=>void exitDerivation()}/>}
    {pendingAgentKey&&<AgentSubmissionRecovery requestKey={pendingAgentKey} recoveryHref={(derivationActive&&derivationDraft?contextDerivationLocation(location.href,derivationDraft,pendingAgentKey):agentSubmissionLocation(location.href,pendingAgentKey)).href} canRetry={!taskOnly&&originalCanWrite&&Boolean(submission.current?.snapshot().canRetry)} busy={working} onRead={()=>void recoverAgentSubmission()} onRetry={()=>void recoverAgentSubmission(true)}/>}
    {pendingSaveKey && <div className="agent-dev-alert" role="alert"><div><strong>代码保存结果待确认</strong><p>只查询当前账号的原保存编号，不运行模型或 Spark。恢复链接不含代码；若服务端未收到保存且本页已关闭，需重新填写代码。同编号不同内容会被拒绝，不覆盖原记录。</p></div><div><button className="button" disabled={working} onClick={() => void recoverSavedRevision()}>查询原保存记录</button><button className="button" disabled={!canWrite || working || (!revisionRequest.current && !draft.trim())} onClick={() => void retrySavedRevision()}>{revisionRequest.current ? "按原编号重试保存" : "按原编号保存填写内容"}</button></div></div>}
    {manualUnconfirmed && <div className="agent-dev-alert" role="alert"><div><strong>手工运行结果待确认</strong><p>原提交编号已保留在恢复链接中。按原编号重试，不创建新的重试编号；未保存代码不会被覆盖。</p></div><button className="button" disabled={!canWrite || working} onClick={() => void resumeManualRun()}>按原编号重试提交</button></div>}
    {localManualDelivery && !readOnly && !taskOnly && !publicationTarget && fundContexts.length > 0 &&
      <Suspense fallback={<p role="status">正在加载基金准备…</p>}>
        <FundAgentPreparation api={api} contexts={fundContexts} canWrite={originalCanWrite} onDirty={setFundDirty}
          onExecute={receipt=>void startFundExecution(receipt)} executionDisabled={fundExecutionBlocked}
          executionNotice={!ready?readinessReason:dirty||message.trim()?"请先处理未保存的代码或需求。":undefined}
          executionRequestId={task?.fundPreparation?.requestId} />
      </Suspense>}
    <div className="agent-dev-grid">
      <aside className="agent-dev-history"><header><span><History size={15} />任务历史</span><button className="icon-button" aria-label="刷新任务历史" onClick={() => loadHistory().catch(e => setError(e.message))}><RefreshCw size={14} /></button></header>
        {historyState==="loading"&&<p className="agent-dev-empty" role="status">正在读取任务历史；当前任务会优先显示。</p>}
        {historyState==="error"&&<p className="agent-dev-error-text" role="alert">任务历史暂未加载：{historyError} 已读取的任务与编辑内容保留，可点击刷新重试。</p>}
        {historyState==="deferred"&&!tasks.length&&<p className="agent-dev-empty">已优先恢复原请求或代码；需要历史时可点击刷新。</p>}
        {historyState==="loaded"&&!tasks.length&&<p className="agent-dev-empty">还没有委托。<br />从一个明确的证券业务需求开始。</p>}
        {derivationActive&&<p className="agent-dev-empty">正在准备新口径草稿；退出后可切换任务历史。</p>}{tasks.map(t => <button disabled={derivationActive||working||Boolean(pendingAgentKey)} className={t.id === task?.id ? "selected" : ""} key={t.id} onClick={() => void selectTask(t.id)}><strong>{t.message}</strong><span>{stageText[t.stage ?? t.status] ?? t.status}</span><small>{t.id.slice(0,8)}</small></button>)}
      </aside>
      <section id="agent-requirement" className="agent-dev-dialogue"><header><Bot size={17} /><strong>开发助手</strong><span>需求与执行</span></header>
        <div className="agent-dev-conversation">
          <details className="agent-dev-context" open={!task}><summary>本次数据与业务口径 <ChevronDown size={14} /></summary>
            {derivationActive && <p>目标口径在上方变更草稿中选择；下方展示其已登记定义与数据结构。</p>}
            {context?.validationFamily&&<small>已登记口径 · {context.validationFamily.name} · V{context.validationFamily.definitionVersion}</small>}
            <p>{context?.definition ?? "正在加载数据上下文…"}</p><div className="agent-dev-tables">{context?.tables.map(t => <details key={t.name}><summary>{t.name} · {t.columns.length}字段</summary><dl>{t.columns.map(([name,type]) => <div key={name}><dt>{name}</dt><dd>{type}</dd></div>)}</dl></details>)}</div>
            <small>输出：{scopedLabels?(context?.outputContract?.fields.map(f=>f.name)??["client_id","holding_market_value","available_cash","total_assets","security_count"]).map(resultLabel).join("、"):"客户、持仓市值、可用现金、总资产、证券数量"}。其他指标请先补充并审阅口径，不默认纳入。</small>
          </details>
          {!task && <div className="agent-dev-intro"><h3>{derivationActive?"说明这次口径变化。":manualSuccessReady?"继续完善这份手工 SQL。":"先说清楚你想得到什么。"}</h3><p>{derivationActive?"确认前只保留本页草稿；新任务会从冻结SQL出发，按目标口径重新生成与验证。":manualSuccessReady?"当前手工版本和成功运行已保存。描述修改意图，Agent会创建独立版本、保留手工来源并重新核验；原代码与运行不变。":"我会引用当前表结构编写 SQL，交给 Spark 执行，并依据独立断言修正错误。代码和失败记录始终可见。"}</p>{!manualSuccessReady&&<AgentRequirementExample readOnly={readOnly||Boolean(publicationTarget)} disabled={taskOnly||derivationActive&&derivationState!=="READY"} scoped={Boolean(scopedLabels)} example={scopedLabels?`请按已选择的“${context?.name}”口径编写Spark SQL。${context?.definition}`:"请计算T+1客户资产，确保现金不重复累计、持仓按position_id去重，并包含只有现金的客户。"} onFill={setMessage}/>}</div>}
          {task && <><div className="agent-dev-message user"><small>你的需求 · {task.id.slice(0,8)}</small><p>{task.message}</p></div>
            <AgentRequirementUnderstanding task={task} dirty={dirty}/>
            {task.sourceKind==='MANUAL'&&<div className="agent-dev-notice agent-dev-assisted" role="status"><strong>人工辅助修正 · 独立开发结果</strong><p>工程师引用了历史开发依据。代码、运行与核验保留人工辅助来源，不计 Agent 自主完成。交付文件与演练使用下方人工辅助流程，须重新审阅确切版本。</p></div>}
            {task.manualContinuation&&<div className="agent-dev-notice agent-dev-assisted" role="status"><strong>基于手工成功版本修改</strong><p>手工版本 {task.manualContinuation.revisionId.slice(0,8)}、运行 {task.manualContinuation.runId.slice(0,8)}。原代码和结果保留；本次由Agent生成独立版本，继续记录人工来源并重新核验交付。</p></div>}
            {task.assistedContinuation&&<div className="agent-dev-notice agent-dev-assisted" role="status"><strong>基于成功版本续改 · 第{task.assistedContinuation.depth}次</strong><p>父任务 {task.assistedContinuation.taskId.slice(0,8)}，父版本 {task.assistedContinuation.revisionId.slice(0,8)}。原文件与批准保留，本任务需重新核验和交付；人工参考归因继续保留。</p><button className="button" disabled={working} onClick={()=>void selectTask(task.assistedContinuation!.taskId)}>查看父任务</button></div>}
            {task.derivedFrom&&<div className="agent-dev-notice" role="status"><strong>已登记口径变更 · 独立新任务</strong><p>来自任务 {task.derivedFrom.taskId.slice(0,8)}、版本 {task.derivedFrom.revisionId.slice(0,8)}。原口径：{contexts.find(item=>item.id===task.derivedFrom?.contextId)?.name??task.derivedFrom.contextId}；原任务及批准不变，新任务需重新核验、交付和审阅。</p></div>}
            <div className="agent-dev-message assistant"><strong>{automatic ? <LoaderCircle size={15} className="spin" /> : <Bot size={15} />}{automatic && task.stage === "READY_FOR_MODEL" ? "正在请求模型生成或修正…" : stageText[task.stage ?? task.status] ?? task.status}</strong><p>{task.explanation || "需求已记录，将使用上方已确认的上下文和口径。"}</p>
              {task.error && <p className="agent-dev-error-text">{task.error}</p>}
              {task.attempts.filter(a=>a.diagnostic).map(a=><p key={`diagnostic-${a.attempt}`} className="agent-dev-error-text">第{a.attempt}次安全诊断：{a.diagnostic!.code} · 阶段 {a.diagnostic!.phase}{a.diagnostic!.httpStatus?` · HTTP ${a.diagnostic!.httpStatus}`:""} · {a.diagnostic!.elapsedMs}ms。{a.diagnostic!.requestMayHaveBeenSent?"请求可能已发送，不能据此确认是否计费。":"失败发生在请求发送前；原预算预留仍保留。"}</p>)}
              {task.sourceRunId && <button className="button" disabled={working} onClick={()=>void readAttemptRun(task.sourceRunId!,undefined,"这里是本次修正引用的原始失败批次。",true)}>查看修正依据 · {task.sourceRunId.slice(0,8)}</button>}
              <ol className="agent-dev-attempts">{task.attempts.map(a => <li key={a.attempt}><span>第{a.attempt}次</span><strong>{a.status === "FAILED" ? "执行失败（记录保留）" : a.status === "GENERATED" ? "代码已生成" : stageText[a.status] ?? a.status}</strong>{a.model && <small>{task.mode==="SYNTHETIC_MODEL"?"模型替身":`模型：${a.model}`}</small>}{a.status === "NO_SQL_CHANGE" ? a.sourceRunId && <button disabled={working} onClick={()=>void readAttemptRun(a.sourceRunId!,undefined,"本次模型未修改代码，正在查看原失败批次。",true,"校验")}>查看原失败批次 · {a.sourceRunId.slice(0,8)}</button> : a.runId && <button disabled={working} onClick={()=>void readAttemptRun(a.runId!,a.revisionId,"正在查看这次尝试的执行记录。")}>查看第{a.attempt}次执行 · {a.runId.slice(0,8)}</button>}</li>)}</ol>
              <small>版本 {task.version} · {task.mode==="SYNTHETIC_MODEL"?"测试用量":"预算占用"} {task.usedTokens ?? 0} Token{task.mode==="SYNTHETIC_MODEL"?"":"（含未发送或未知结果的保留额度）"} · 结论仅对应当前代码版本</small>
              {task.background&&<p role="status">云后台：{task.background.status} · 已处理{task.background.consumedEvents}/{task.background.maxEvents}个事件 · 截止{new Date(task.background.expiresAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai"})}。请求未发送或模型结果未知时暂停，不自动重试或上线。{task.background.code&&` ${task.background.code}`}</p>}
            </div>
            <AgentModelRecovery stage={task.stage} consent={retryConsent} disabled={!canWrite||working} onConsent={setRetryConsent} />
            <div className="agent-dev-task-actions"><button className="button" disabled={busy} onClick={() => void selectTask(task.id, false)}><RefreshCw size={14} />刷新 / 恢复</button>
              {task.background?.status==="ACTIVE"&&<button className="button" disabled={!canWrite||busy} onClick={async()=>{epoch.current++;setAutomatic(false);setBusy(true);try{await api(`/agent/tasks/${task.id}/background/cancel`,{});setNotice("已停止后续后台推进；已提交步骤不会重复运行，待当前步骤确认后可人工接管。");await selectTask(task.id,false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><Square size={13}/>停止后台自动推进</button>}
              {task.background&&(["NEEDS_CONFIRMATION","EXPIRED","PAUSED","CANCELLED"].includes(task.background.status)||task.background.scopeBlocked||Date.now()>=task.background.expiresAt)&&!agentTaskFinished(task.status)&&<button className="button primary" title={resumeReason} disabled={Boolean(resumeReason)} onClick={()=>resumeInput&&submitAgentResume(resumeInput,{explain:setNotice,submit:async confirmModelRetry=>{setBusy(true);try{await api(`/agent/tasks/${task.id}/background/resume`,{expectedVersion:task.version,confirmModelRetry});setRetryConsent(false);setNotice("已审阅并在当前窗口内恢复原任务云后台，最多15分钟；原次数与预算不清零，不自动发布。");await selectTask(task.id,false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}})}>{modelNotSent?"修复后恢复后台":"审阅并恢复云后台"}</button>}
              {!agentTaskFinished(task.status) && <button className="button primary" title={resumeReason} disabled={Boolean(resumeReason)} onClick={()=>resumeInput&&submitAgentResume(resumeInput,{explain:setNotice,submit:confirmModelRetry=>drive(task,confirmModelRetry,true)})}><Play size={14} />{modelNotSent ? "修复后重试原任务" : unknown ? "确认重试" : task.background?.status==="ACTIVE"?"查看后台进度":"继续任务"}</button>}
              {!agentTaskFinished(task.status) && <button className="button" disabled={!canWrite || busy} onClick={() => void stop()}><Square size={13} />停止</button>}
            </div>
            {!agentTaskFinished(task.status)&&resumeReason&&<p className="agent-dev-notice" role="status">{resumeReason}</p>}
            {task.status === "SUCCEEDED" && <p className="agent-dev-success"><CheckCircle2 size={16} />{fundTask?'本机 Spark 已通过登记基金口径的独立校验。':context?.capabilities?.delivery===false?'代码已通过当前分布口径核验；可查看五场景结果。调度交付尚未开放。':task.sourceKind==='MANUAL'?'代码已通过当前开发核验。人工辅助归因保留，交付仍需独立审阅。':'代码已通过执行校验。继续查看下方核验报告，并准备调度与部署交付。'}</p>}
          </>}
        </div>
        {fundTask ? <p className="agent-dev-notice">基金开发基于已保存的口径。需要调整业务需求时，请新建基金准备。</p> : task?.stage==='REQUIREMENT_CLARIFICATION_REQUIRED' ? <AgentClarificationReply answer={message} onChange={setMessage} onReply={()=>void answerClarification()} disabled={Boolean(clarificationReason)||taskOnly||readOnly||Boolean(publicationTarget)||!ready||!canWrite||working||dirty||runPending} reason={clarificationReason??(dirty?'请先处理当前代码编辑，回答不会替换未保存代码。':readinessReason)} background={backgroundAvailable&&!taskOnly&&!readOnly&&!publicationTarget?{checked:backgroundConsent,onChange:setBackgroundConsent}:undefined}/> : (
        <form className="agent-dev-compose" onSubmit={e => { e.preventDefault(); void send(); }}><label htmlFor="agent-dev-message">{taskOnly ? "本窗口不创建新的需求任务" : derivationActive?"确认新口径任务的需求":task ? "基于当前代码提出下一次修改" : manualSuccessReady?"描述对手工版本的修改":"描述开发需求"}</label><textarea id="agent-dev-message" value={message} onChange={e => setMessage(e.target.value)} maxLength={2000} placeholder="例如：计算客户总资产，检查现金是否被重复累计…" disabled={taskOnly||readOnly||Boolean(publicationTarget)||working} />{backgroundAvailable&&!taskOnly&&!readOnly&&!publicationTarget&&<label className="agent-dev-consent"><input type="checkbox" checked={backgroundConsent} disabled={working} onChange={e=>setBackgroundConsent(e.target.checked)}/>委托云后台推进本次开发（15分钟、最多20个事件；沿用模型与执行预算，不自动发布）</label>}<div><small>{taskOnly ? "使用上方原任务的继续／恢复操作，不会清零历史" : readOnly || publicationTarget ? "当前不会调用模型或开发计算" : derivationActive?"确认后才新建任务并调用模型与 Spark，原批准不继承":"本次将真实调用模型与隔离 Spark"}</small><button className="button primary" type="submit" disabled={taskOnly || !ready || !canWrite || working || runPending || Boolean(assistedChatReason) || message.trim().length < 4 || derivationActive&&Boolean(derivationSubmitReason)}><Send size={14} />{derivationActive?"确认新建口径任务并验证":manualSuccessReady?"基于手工版本修改并验证":"按此口径生成并验证"}</button></div>{assistedChatReason&&<p role="status">{assistedChatReason}</p>}</form>
        )}
      </section>
      <section id="agent-code" className="agent-dev-artifacts"><header><div><FileCode2 size={16} /><strong>main.sql</strong><span>{dirty ? "修改待验证" : baselineRevisionId ? `版本 ${baselineRevisionId.slice(0,8)}` : "等待生成"}</span></div><div><button className="icon-button" aria-label="查看代码差异" disabled={!dirty && !task?.initialSql} title={!dirty && !task?.initialSql ? "没有原始草稿，不能重建历史差异" : "对照原始或未修改版本"} aria-pressed={diff} onClick={() => setDiff(!diff)}><GitCompareArrows size={16} /></button><button className="icon-button" disabled={working || !dirty} aria-label="撤销未保存修改" onClick={() => setDraft(baseline)}><Undo2 size={15} /></button></div></header>
        <div className="agent-dev-editor"><Suspense fallback={<div className="agent-dev-empty">正在加载代码编辑器…</div>}><SqlEditor value={draft} original={codeOriginal} diff={diff} onChange={setDraft} readOnly={derivationActive||readOnly||!scopeEditable||Boolean(publicationTarget)||working||fundTask} /></Suspense></div>
        <div className="agent-dev-code-actions"><small><Code2 size={14} />{fundTask?"此处展示与准备回执绑定的生成代码":derivationActive?"源SQL已冻结；新任务确认后才按目标口径生成新版本":readOnly ? "代码只读；编辑与执行尚未开放" : !scopeEditable ? "其他任务只读；请查看指定任务续接" : automatic ? "Agent 处理中，可随时停止后接管" : "可直接编辑；修改后需重新验证"}</small>{runPending && !automatic && <button className="button" disabled={!canWrite || busy} onClick={async () => { if (!run) return; setBusy(true); try { setRun(await api<Run>(`/runs/${run.id}/cancel`, {})); setNotice("取消标记已保存；迟到结果不会覆盖已取消状态。"); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}><Square size={13} />停止运行</button>}{!fundTask&&<button className="button" disabled={derivationActive||!canWrite || working || runPending || manualUnconfirmed || Boolean(pendingSaveKey) || Boolean(pendingAgentKey) || !draft.trim()} onClick={() => void runDraft()}><Play size={14} />保存并运行我的代码</button>}</div>
        <div className="agent-dev-result-tabs" role="tablist" aria-label="开发执行反馈">{["结果","字段来源","运行对照","校验","日志"].map(name => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}<span>{runRead.state==="LOADING"?"正在读取原运行记录":runRead.state==="ERROR"?"运行结果未确认":run ? `${stageText[run.status] ?? run.status} · ${run.id.slice(0,8)}` : "尚未执行"}</span></div>
        <div className={`agent-dev-results ${tab==='运行对照'?'agent-dev-results-compare':''}`}>{!run ? runRead.state!=="IDLE"?<div className="agent-dev-empty" role={runRead.state==="ERROR"?"alert":"status"}>{runRead.state==="LOADING"?"正在核对原任务的运行记录；不重新执行计算。":<>{runRead.message}<p>已读代码与草稿保留，不显示其他任务的结果。</p><button className="button" disabled={working||!task} onClick={()=>task&&void selectTask(task.id,false)}>重新读取原任务与运行</button></>}</div>:<div className="agent-dev-empty">执行后的真实结果、校验与日志会显示在这里。<br />不会预先填入报表结果。</div> : <>
          {run.error && <p className="agent-dev-error-text" role="alert">{run.error}</p>}
          {tab!=='运行对照'&&<AgentRepairAction input={repairInput} onSubmit={request=>send(request.message,request.sourceRunId)} onExplain={setNotice} />}
          {tab === "结果" && (resultFields.length ? <><ValidationResultScope contextId={run.contextId} contextName={availableContexts.find(item=>item.id===run.contextId)?.name} runId={run.id} revisionId={run.revisionId} dirty={dirty} /><div className="agent-dev-table-scroll"><table><thead><tr>{resultFields.map(k => <th key={k} title={k}>{resultLabel(k)}</th>)}</tr></thead><tbody>{run.rows?.map((row,i) => <tr key={i}>{resultFields.map(k => <td key={k}>{String(row[k] ?? "—")}</td>)}</tr>)}</tbody></table></div><p>{run.engine} {run.engineVersion} · {run.rows?.length} 行 · 结果绑定版本 {run.revisionId?.slice(0,8)}</p></> : <p className="agent-dev-empty">{terminal(run.status) ? "本次未产生可展示的数据行。请查看校验和日志。" : "Spark 正在执行，结果完成后显示。"}</p>)}
          {tab === "字段来源" && <Suspense fallback={<p role="status">正在加载字段来源视图…</p>}><RunColumnLineagePanel key={run.id} run={run} revisionId={baselineRevisionId} sql={baseline} context={context} dirty={dirty}/></Suspense>}
          {tab === "运行对照" && <Suspense fallback={<p role="status">正在加载已保存运行对照…</p>}><RunComparisonPanel key={run.id} api={api} runId={run.id} revisionHash={run.revisionHash} contextId={run.contextId??contextId} runStatus={run.status} dirty={dirty} repairReason={failedRunRepairAction(repairInput).request?undefined:failedRunRepairAction(repairInput).reason} onRepair={basis=>send('参考所选成功基线的已核验差异，修正当前失败 SQL；以实际运行与独立断言验证，不继承发布批准。',basis.sourceRunId,basis)}/></Suspense>}
          {tab === "校验" && <><h4>{run.validation?.passed ? "独立业务断言通过" : "校验尚未通过"}</h4>{run.validation?.issues?.map((x,i) => <p key={i}>{x}</p>)}{run.validation?.regressions?.map(r => <div className="agent-dev-check" key={r.contextId}><span>{r.name ?? r.contextId}</span><strong>{r.passed ? "通过" : "未通过"}</strong></div>)}{!context?.outputContract&&<ValidationDetails details={run.validationDetails} expectedSource={{runId:run.id,revisionId:baselineRevisionId,contextId,revisionHash:run.revisionHash,contractId:run.validationContractId}} dirty={dirty} />}{context?.outputContract&&<p className="agent-dev-notice">{fundTask?"按组合、交易日、资产类别核对敞口金额与六位占比，查看每次运行可复核原结果。":"分布按客户/交易日/分类复合键与六位占比独立核验；具体失败见各场景摘要，不套用旧客户级差异表。"}</p>}</>}
          {tab === "日志" && <pre>{developmentRunLog(run)}</pre>}
        </>}</div>
      </section>
    </div>
    {task?.sourceKind==='MANUAL'&&(task.executionMode==='DURABLE_SQL_AGENT_V1'&&task.status==='SUCCEEDED'&&run?.id===task.runId&&run?.agentTaskId===task.id&&baselineRevisionId===task.revisionId&&run?.revisionId===baselineRevisionId?
      <AgentDeliveryPanel key={`assisted-${task.id}-${run.id}`} manual assisted api={api} taskId={task.id} contextId={task.contextId} revisionId={baselineRevisionId} runId={run.id} dirty={dirty} canWrite={canWrite&&!pendingAgentKey} canPublish={canPublish&&!sourceReturnActive} publicationTarget={publicationTarget} expectedSourceBinding={expectedSourceBinding} codeBusy={working||Boolean(pendingAgentKey)} onOpenServices={onOpenServices} handoffBlocked={Boolean(message.trim())||Boolean(pendingAgentKey)} />:
      <section id="agent-delivery" className="agent-dev-context" aria-label="人工辅助开发交付边界"><h3>人工辅助开发结果</h3><p>先完成持久修正任务并查看其当前已核验代码和运行。交付将独立记录人工辅助来源，不继承历史基线的批准。</p><button className="button" disabled={!run||working} onClick={()=>setTab('校验')}>查看当前独立核验</button></section>)}
    {(task||run) && context?.capabilities?.delivery===false&&<section id="agent-delivery" className="agent-dev-notice" role="status"><strong>分布代码阶段</strong><p>可查看需求、代码、结果与五场景核验。调度交付、发布和云端执行尚未适配；当前不计完整E2E。{task?.sourceKind==='MANUAL'?" 本次引用了原失败批次，人工参考归因保留。":""}</p><a className="button" href="#agent-code" onClick={()=>setTab("校验")}>查看本次五场景核验</a></section>}
    {task && context?.capabilities?.delivery!==false && task.sourceKind!=='MANUAL' && <AgentDeliveryPanel key={task.id} fundPreparation={task.fundPreparation} api={api} taskId={task.id} contextId={task.contextId} revisionId={baselineRevisionId} runId={run?.id} dirty={dirty} canWrite={canWrite&&!pendingAgentKey} canPublish={canPublish&&!sourceReturnActive} publicationTarget={publicationTarget} expectedSourceBinding={expectedSourceBinding} codeBusy={working||Boolean(pendingAgentKey)} onOpenServices={onOpenServices} handoffBlocked={Boolean(message.trim())||Boolean(pendingAgentKey)} />}
    {!task && !derivationActive && baselineRevisionId && context?.capabilities?.delivery!==false && <section id="agent-delivery" className="agent-delivery-panel" aria-label={manualDisclosure.region}><h3>{manualDisclosure.title}</h3><p>{manualDisclosure.description}</p><small>代码版本：{baselineRevisionId}{run ? ` · 运行批次：${run.id}` : " · 运行尚未确认"}</small>
      {originTaskId && <button className="button" disabled={working || manualUnconfirmed || Boolean(message.trim())} onClick={() => void selectTask(originTaskId)}>返回原 Agent 任务</button>}
      {!localManualDelivery ? originTaskId && !expectedManualSource && run?.id ? <AgentDeliveryPanel key={`manual-${baselineRevisionId}-${run.id}`} manual api={api} taskId={originTaskId} contextId={contextId} revisionId={baselineRevisionId} runId={run.id} dirty={dirty} canWrite={canWrite&&!manualUnconfirmed&&!pendingSaveKey} canPublish={canPublish} publicationTarget={publicationTarget} codeBusy={working||runPending} onOpenServices={onOpenServices} handoffBlocked={Boolean(message.trim())} /> : run?.status==='SUCCEEDED'&&run.revisionId===baselineRevisionId?<Suspense fallback={<p role="status">正在读取手工交付流程…</p>}><StandaloneManualDeliveryPanel key={`standalone-${run.id}`} api={api} sourceRunId={run.id} revisionId={baselineRevisionId} revisionHash={run.revisionHash} dirty={dirty} expectedSource={expectedManualSource} onOpenServices={onOpenServices} canPublish={canPublish} canWrite={canWrite&&!manualUnconfirmed&&!pendingSaveKey&&!pendingAgentKey}/></Suspense>:<p>先保存并完整核验当前手工版本；成功后可直接准备文件与演练，模型不是必经步骤。</p> : <><button className="button" disabled={working || dirty || manualUnconfirmed || Boolean(message.trim()) || run?.status !== "SUCCEEDED" || run.revisionId !== baselineRevisionId || !run.validationContractId} onClick={() => setManualDeliveryOpen(true)}>打开本机人工交付流程</button><small>在本页继续生成包、文件演练和审阅；服务端仍核验实际执行与来源。不是自动批准或云端上线。</small>
      {manualDeliveryOpen && run?.validationContractId && run.revisionId === baselineRevisionId && <Suspense fallback={<p role="status">正在加载人工交付流程…</p>}><ManualDeliveryWorkbench key={run.id} api={api} runs={[{id:run.id,status:run.status,revisionId:baselineRevisionId,contextId,createdAt:run.createdAt ?? "",validationContractId:run.validationContractId}]} sourceRunId={run.id} contractId={run.validationContractId} lockSource canWrite={canWrite && !working && !dirty && !manualUnconfirmed && !message.trim()} onBack={() => setManualDeliveryOpen(false)} /></Suspense>}</>}
    </section>}
  </section>;
}
