import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, ChevronDown, Code2, FileCode2, GitCompareArrows, History, LoaderCircle, Play, Plus, RefreshCw, Send, Square, Undo2 } from "lucide-react";
import { developmentRunLog } from "./run-log";
import { AgentDeliveryPanel } from "./AgentDeliveryPanel";
import { manualRunLocation, manualRunRecovery, manualSaveLocation, manualSaveRequest } from "./manual-run-recovery";
import {agentSubmissionRequest,agentSubmissionLocation,createAgentSubmission,agentTaskReceiptValid} from "./agent-submission";
import {AgentSubmissionRecovery} from "./AgentSubmissionRecovery";
import "./agent-development.css";
const SqlEditor = lazy(() => import("./SqlEditor"));
const ManualDeliveryWorkbench = lazy(async () => ({default:(await import("./DeliveryWorkbench")).DeliveryWorkbench}));
type Context = { id: string; name: string; definition: string; tables: { name: string; columns: [string, string][] }[] };
type Task = { id: string; version: number; status: string; stage?: string; executionMode?: string; message: string; contextId: string; sql?: string; initialSql?: string; sourceRunId?: string; explanation?: string; error?: string; revisionId?: string; runId?: string; usedTokens?: number; createdAt?: string; recovery?: { modelLeaseExpiresAt?: string }; background?: {status:string;state?:string;delivery?:string;expiresAt:number;consumedEvents:number;maxEvents:number;code?:string}; attempts: { attempt: number; status: string; revisionId?: string; runId?: string; model?: string; diagnostic?: {code:string;phase:string;httpStatus?:number;elapsedMs:number;requestMayHaveBeenSent:boolean} }[] };
type Run = { id: string; status: string; createdAt?: string; validationContractId?: string; revisionId?: string; revisionHash?: string; engine?: string; engineVersion?: string; rows?: Record<string, unknown>[]; columns?: { name: string; type: string }[]; error?: string; log?: string; stage?: string; validation?: { passed: boolean; issues?: string[]; regressions?: { contextId: string; name: string; passed: boolean }[] } };
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
type SavedRevision = {id:string;sql:string;contextId:string;manualProvenance?:{originAgentTaskId?:string;kind:string;agentIndependentE2E:boolean}};
const terminal = (s?: string) => Boolean(s && ["SUCCEEDED", "FAILED", "CANCELLED", "VALIDATION_FAILED","INTERRUPTED"].includes(s));
const stageText: Record<string, string> = { READY_FOR_MODEL: "准备生成 / 修正", MODEL_IN_FLIGHT: "正在编写代码", MODEL_OUTCOME_UNKNOWN: "模型结果待确认", READY_FOR_RUN: "代码已保存，待执行", WAITING_FOR_RUN: "Spark 执行与校验中", CANCELLING: "正在停止", SUCCEEDED: "SQL 验证通过", FAILED: "需要处理", CANCELLED: "已停止", QUEUED: "等待执行", RUNNING: "执行中", INTERRUPTED: "执行中断，记录保留", VALIDATION_FAILED: "业务断言未通过" };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const resultFieldLabels: Record<string,string> = { client_id:"客户", holding_market_value:"持仓市值（元）", available_cash:"可用现金（元）", total_assets:"总资产（元）", security_count:"证券数量" };

export function AgentDevelopmentWorkbench({ api, contexts, canWrite:originalCanWrite, ready, readinessReason, loading, privatePreview, runtimeMode, backgroundAvailable=false, onLogin, onDirtyChange, onOpenServices }: {
  api: Api; contexts: Context[]; canWrite: boolean; ready: boolean; readinessReason?:string; loading: boolean; privatePreview: boolean; runtimeMode?: "LOCAL_DEVELOPMENT" | "PUBLIC_INVITATION"; backgroundAvailable?:boolean; onLogin: () => void; onDirtyChange: (dirty: boolean) => void; onOpenServices?: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]), [task, setTask] = useState<Task>(), [contextId, setContextId] = useState("holdings-t1");
  const [message, setMessage] = useState(""), [draft, setDraft] = useState(""), [baseline, setBaseline] = useState("");
  const [run, setRun] = useState<Run>(), [tab, setTab] = useState("结果"), [diff, setDiff] = useState(false);
  const [baselineRevisionId, setBaselineRevisionId] = useState<string>();
  const [automatic, setAutomatic] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [retryConsent, setRetryConsent] = useState(false);
  const [manualUnconfirmed, setManualUnconfirmed] = useState(false), [originTaskId, setOriginTaskId] = useState<string>();
  const [manualDeliveryOpen, setManualDeliveryOpen] = useState(false);
  const [pendingSaveKey, setPendingSaveKey] = useState<string>();
  const revisionRequest = useRef<{key:string;sql:string;contextId:string;originAgentTaskId?:string} | undefined>(undefined);
  const [backgroundConsent,setBackgroundConsent]=useState(true);
  const epoch = useRef(0), selectedId = useRef<string | undefined>(undefined);
  const alive = useRef(true), manualRequest = useRef<{ revisionId: string; key: string } | undefined>(undefined);
  const [pendingAgentKey,setPendingAgentKey]=useState<string|undefined>(()=>typeof window==="undefined"?undefined:agentSubmissionRequest(window.location.href));
  const canWrite=originalCanWrite&&!pendingAgentKey;
  const submission=useRef<ReturnType<typeof createAgentSubmission<Task>>|undefined>(undefined);
  function submissionController(){
    if(!submission.current||submission.current.snapshot().closed)submission.current=createAgentSubmission<Task>({api,initialKey:agentSubmissionRequest(location.href),onPending:key=>{
      setPendingAgentKey(key);if(key)history.replaceState(null,"",agentSubmissionLocation(location.href,key));
    }});
    return submission.current;
  }
  const context = contexts.find(c => c.id === contextId), dirty = draft !== baseline;
  const localManualDelivery = runtimeMode === "LOCAL_DEVELOPMENT" && !privatePreview;
  const runPending = Boolean(run && !terminal(run.status));
  const working = automatic || busy, durable = task?.executionMode === "DURABLE_SQL_AGENT_V1";
  const unknown = task?.stage === "MODEL_OUTCOME_UNKNOWN";
  function accept(current: Task) {
    setTask(current); setTasks(old => [current, ...old.filter(t => t.id !== current.id)]);
  }
  async function loadHistory() {
    if(agentSubmissionRequest(location.href)){await recoverAgentSubmission();return;}
    const saveKey=manualSaveRequest(location.href);
    if (saveKey) { setPendingSaveKey(saveKey); await recoverSavedRevision(saveKey); return; }
    const list = await api<Task[]>("/agent/tasks"); if (!alive.current) return; setTasks(list);
    const params = new URLSearchParams(location.search), id = params.get("task"), { revisionId, runId, requestKey, originTaskId: origin } = manualRunRecovery(location.href);
    if (!selectedId.current && revisionId && /^[a-f0-9-]{36}$/.test(revisionId)) {
      const saved = await api<SavedRevision>(`/revisions/${revisionId}`);
      const actual = runId ? await api<Run>(`/runs/${runId}`) : requestKey ? undefined : (await api<Run[]>("/runs")).find(r => r.revisionId === saved.id);
      if (actual && actual.revisionId !== saved.id) throw new Error("运行与代码版本不匹配，请重新选择任务。");
      if (!alive.current) return;
      setTask(undefined); setContextId(saved.contextId); setDraft(saved.sql); setBaseline(saved.sql); setBaselineRevisionId(saved.id); setRun(actual);
      manualRequest.current = requestKey ? {revisionId:saved.id, key:requestKey} : undefined;
      const persistedOrigin = saved.manualProvenance?.originAgentTaskId ?? origin;
      setManualUnconfirmed(Boolean(requestKey)); setOriginTaskId(persistedOrigin);
      rememberManual(saved.id, actual?.id, requestKey, persistedOrigin);
      setNotice(requestKey ? "原提交结果未确认，恢复编号已保留；不会自动重跑，也不会用其他批次替代原请求。" : actual ? "已恢复手工保存的代码版本及其运行，没有重新提交。" : "已恢复保存的代码，尚未确认对应运行；没有自动重新提交。");
      return;
    }
    if (id && !selectedId.current && list.some(t => t.id === id)) await selectTask(id, false);
  }
  useEffect(() => { loadHistory().catch(e => setError(e.message)); }, [ready, originalCanWrite]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; submission.current?.close(); }; }, []);
  useEffect(() => { onDirtyChange(dirty || Boolean(message.trim()) || manualUnconfirmed || Boolean(pendingSaveKey) || Boolean(pendingAgentKey)); }, [dirty, message, manualUnconfirmed, pendingSaveKey, pendingAgentKey, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 9000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || message.trim() || manualUnconfirmed || pendingSaveKey || pendingAgentKey) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, message, manualUnconfirmed, pendingSaveKey,pendingAgentKey]);
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
    const url = new URL(location.href); if (id) url.searchParams.set("task", id); else url.searchParams.delete("task");
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
    const url = manualRunLocation(location.href, {revisionId, runId, requestKey, originTaskId:origin});
    history.replaceState(null, "", url);
  };
  async function selectTask(id: string, protectDraft = true) {
    if (manualUnconfirmed || pendingSaveKey || pendingAgentKey) { setNotice("请先确认原提交、保存或运行请求，再切换任务；不会丢弃未确认请求。"); return; }
    const keepDraft = selectedId.current === id && dirty;
    if (protectDraft && dirty && !keepDraft && !confirm("当前代码有未保存修改，是否放弃修改并切换任务？")) return;
    const selectionEpoch = ++epoch.current; setAutomatic(false); setBusy(true); setError("");
    rememberSelection(id);
    try {
      const current = await api<Task>(`/agent/tasks/${id}`);
      if (!alive.current || selectedId.current !== id || epoch.current !== selectionEpoch) return;
      accept(current); setContextId(current.contextId);
      if (!keepDraft) { setDraft(current.sql ?? ""); setBaseline(current.sql ?? ""); setBaselineRevisionId(current.revisionId); setDiff(false); }
      const actual = current.runId ? await api<Run>(`/runs/${current.runId}`) : undefined;
      if (!alive.current || selectedId.current !== id || epoch.current !== selectionEpoch) return;
      setRun(actual);
      setNotice(keepDraft ? "服务端状态已刷新，未保存的编辑已保留；运行结果仍对应原代码版本。" : "已恢复服务端任务；读取历史不会重新调用模型。点击继续才会推进。");
    } catch (e) { if (alive.current && epoch.current === selectionEpoch) setError((e as Error).message); } finally { if (alive.current && epoch.current === selectionEpoch) setBusy(false); }
  }
  function newTask() {
    if (manualUnconfirmed || pendingSaveKey || pendingAgentKey) { setNotice("请先确认原提交、保存或运行请求，再新建任务。"); return; }
    if (dirty && !confirm("当前代码有未保存修改，是否放弃并新建任务？")) return;
    epoch.current++; setAutomatic(false); rememberSelection(); setTask(undefined); setRun(undefined);
    setDraft(""); setBaseline(""); setBaselineRevisionId(undefined); setMessage(""); setError(""); setNotice(""); setDiff(false);
  }
  async function drive(start: Task, confirmRetry = false, manualTakeover = false) {
    const token = ++epoch.current; setAutomatic(true); setError("");
    let current = start, started = Date.now();
    try {
      for (let step = 0; step < 40 && token === epoch.current; step++) {
        if (Date.now() - started > 5 * 60 * 1000) { setNotice("本次自动推进已达5分钟上限；任务记录保留，可稍后继续。"); break; }
        if (terminal(current.status)) break;
        if(current.background && !["ACTIVE","COMPLETED"].includes(current.background.status) && !manualTakeover){setNotice("云后台已暂停，检查点保留；请核对原因后明确选择人工继续。");break;}
        if (current.stage === "MODEL_OUTCOME_UNKNOWN" && !confirmRetry) break;
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
        if (terminal(current.status) || current.stage === "MODEL_OUTCOME_UNKNOWN") break;
        await pause(current.stage === "WAITING_FOR_RUN" ? 5000 : 800);
      }
    } catch (e) {
      if (token === epoch.current) { setError((e as Error).message + " 请先刷新任务确认状态，不要重复新建。"); }
    } finally { if (token === epoch.current) { setAutomatic(false); setRetryConsent(false); } }
  }
  async function acceptSubmissionReceipt(current:Task,key:string,token:number,continueOriginal:boolean){
    if(!alive.current||epoch.current!==token||agentSubmissionRequest(location.href)!==key)return;
    if(!agentTaskReceiptValid(current))throw Error("任务回执不完整或语言不匹配，保留原提交编号");
    submissionController().acknowledge(key);rememberSelection(current.id);accept(current);setContextId(current.contextId);setRun(undefined);setBaselineRevisionId(current.revisionId);
    const saved=current.sql??current.initialSql;
    if(saved!==undefined){setDraft(previous=>!continueOriginal&&previous!==baseline?previous:saved);setBaseline(saved);}
    setMessage(previous=>previous.trim()===current.message.trim()?"":previous);
    if(continueOriginal){
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
  async function send(overrideMessage?: string) {
    const requestMessage = (overrideMessage ?? message).trim();
    if (!ready || !canWrite || working || manualUnconfirmed || pendingSaveKey || pendingAgentKey || runPending || requestMessage.length < 4 || !context) return;
    const token=++epoch.current;
    setBusy(true); setError("");
    const repairSource = run && ["FAILED", "VALIDATION_FAILED"].includes(run.status) && !dirty && run.revisionId === baselineRevisionId ? run.id : undefined;
    const body = { message: requestMessage, sql: draft.trim() || "SELECT 1 AS pending", contextId, ...(backgroundAvailable?{background:backgroundConsent}:{}), ...(repairSource ? { sourceRunId: repairSource } : {}) };
    try {
      const controller=submissionController(),created=await controller.submit(body),key=controller.snapshot().key;
      if(key)await acceptSubmissionReceipt(created,key,token,true);
    } catch (e) { if(alive.current&&epoch.current===token)setError((e as Error).message + " 输入仍在本页，原编号已保留在恢复链接中，请先查询原任务。"); }
    finally { if(alive.current&&epoch.current===token)setBusy(false); }
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
    if (!draft.trim() || !canWrite || working || runPending || manualUnconfirmed || pendingSaveKey || pendingAgentKey) return;
    setBusy(true); setError("");
    try {
      let revision: {id:string;sql:string};
      if (!dirty && baselineRevisionId) revision={id:baselineRevisionId,sql:baseline};
      else {
        const key=crypto.randomUUID(), origin=task?.id ?? originTaskId;
        revisionRequest.current={key,sql:draft,contextId,originAgentTaskId:origin};
        setPendingSaveKey(key);
        history.replaceState(null,"",manualSaveLocation(location.href,key,origin));
        revision=await api<SavedRevision>("/revisions",{sql:draft,contextId,...(origin ? {originAgentTaskId:origin} : {})},{idempotencyKey:key});
        setPendingSaveKey(undefined); revisionRequest.current=undefined;
      }
      if (!alive.current) return;
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
      setDraft(current => !current || current === pending?.sql ? saved.sql : current);
      setBaseline(saved.sql);setBaselineRevisionId(saved.id);setContextId(saved.contextId);setTask(undefined);setRun(undefined);
      const origin=saved.manualProvenance?.originAgentTaskId;
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
  const resultFields = run?.rows?.[0] ? Object.keys(run.rows[0]) : [];
  return <section className="agent-dev" aria-label="Agent 数据开发工作台">
    <header className="agent-dev-heading"><div><div className="eyebrow"><Bot size={14} /> AGENT DEVELOPMENT</div><h1>把需求交给 Agent，<span>把结果握在手里。</span></h1><p>客户资产 T+1 · 需求、代码与真实执行，在一个工作台完成。</p></div><div className="agent-dev-header-actions">{task && <a className="button" href="#agent-delivery">核验与交付</a>}<button className="button" disabled={working||Boolean(pendingAgentKey)} onClick={newTask}><Plus size={15} />新建任务</button></div></header>
    <div className="agent-dev-boundary"><span className="agent-dev-dot" />{privatePreview ? "私有试用" : runtimeMode === "PUBLIC_INVITATION" ? "受邀云端验证" : runtimeMode === "LOCAL_DEVELOPMENT" ? "本机开发验证" : "环境待确认"} · 仅虚构证券数据与 Spark SQL。{backgroundAvailable?"可委托云端事件后台；浏览器只展示进度，不负责触发计算。每个委托有时限、事件与模型预算，发布仍须人工审阅。":"本页打开时自动推进；离开后检查点保留，已提交计算可继续，返回后可恢复。不是永久云调度。"}</div>
    {loading ? <div className="agent-dev-notice" role="status"><LoaderCircle size={14} className="spin" />正在连接服务并读取项目上下文…</div> : !ready && <div className="agent-dev-alert">{readinessReason??"模型或执行环境尚未就绪；历史任务仍可查询。"}</div>}
    {!loading && !originalCanWrite && <div className="agent-dev-alert">需要有数据开发权限的账号才能提交任务。<button className="button" onClick={onLogin}>登录 / 查看账号</button></div>}
    {error && <div className="agent-dev-alert error" role="alert">{error}<button onClick={() => setError("")} aria-label="关闭错误提示">×</button></div>}
    {notice && <div className="agent-dev-notice" role="status">{notice}</div>}
    {pendingAgentKey&&<AgentSubmissionRecovery requestKey={pendingAgentKey} recoveryHref={agentSubmissionLocation(location.href,pendingAgentKey).href} canRetry={originalCanWrite&&Boolean(submission.current?.snapshot().canRetry)} busy={working} onRead={()=>void recoverAgentSubmission()} onRetry={()=>void recoverAgentSubmission(true)}/>}
    {pendingSaveKey && <div className="agent-dev-alert" role="alert"><div><strong>代码保存结果待确认</strong><p>只查询当前账号的原保存编号，不运行模型或 Spark。恢复链接不含代码；若服务端未收到保存且本页已关闭，需重新填写代码。同编号不同内容会被拒绝，不覆盖原记录。</p></div><div><button className="button" disabled={working} onClick={() => void recoverSavedRevision()}>查询原保存记录</button><button className="button" disabled={!canWrite || working || (!revisionRequest.current && !draft.trim())} onClick={() => void retrySavedRevision()}>{revisionRequest.current ? "按原编号重试保存" : "按原编号保存填写内容"}</button></div></div>}
    {manualUnconfirmed && <div className="agent-dev-alert" role="alert"><div><strong>手工运行结果待确认</strong><p>原提交编号已保留在恢复链接中。按原编号重试，不创建新的重试编号；未保存代码不会被覆盖。</p></div><button className="button" disabled={!canWrite || working} onClick={() => void resumeManualRun()}>按原编号重试提交</button></div>}
    <div className="agent-dev-grid">
      <aside className="agent-dev-history"><header><span><History size={15} />任务历史</span><button className="icon-button" aria-label="刷新任务历史" onClick={() => loadHistory().catch(e => setError(e.message))}><RefreshCw size={14} /></button></header>
        {!tasks.length && <p className="agent-dev-empty">还没有委托。<br />从一个明确的证券业务需求开始。</p>}
        {tasks.map(t => <button disabled={working||Boolean(pendingAgentKey)} className={t.id === task?.id ? "selected" : ""} key={t.id} onClick={() => void selectTask(t.id)}><strong>{t.message}</strong><span>{stageText[t.stage ?? t.status] ?? t.status}</span><small>{t.id.slice(0,8)}</small></button>)}
      </aside>
      <section id="agent-requirement" className="agent-dev-dialogue"><header><Bot size={17} /><strong>开发助手</strong><span>需求与执行</span></header>
        <div className="agent-dev-conversation">
          <details className="agent-dev-context" open={!task}><summary>本次数据与业务口径 <ChevronDown size={14} /></summary>
            <label>验证数据<select aria-label="Agent 验证数据" disabled={working || Boolean(task) || Boolean(pendingAgentKey) || Boolean(run && !terminal(run.status))} value={contextId} onChange={e => { setContextId(e.target.value); setRun(undefined); setBaselineRevisionId(undefined); }}>{contexts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <p>{context?.definition ?? "正在加载数据上下文…"}</p><div className="agent-dev-tables">{context?.tables.map(t => <details key={t.name}><summary>{t.name} · {t.columns.length}字段</summary><dl>{t.columns.map(([name,type]) => <div key={name}><dt>{name}</dt><dd>{type}</dd></div>)}</dl></details>)}</div>
            <small>输出：客户、持仓市值、可用现金、总资产、证券数量。其他指标请先补充并审阅口径，不默认纳入。</small>
          </details>
          {!task && <div className="agent-dev-intro"><h3>先说清楚你想得到什么。</h3><p>我会引用当前表结构编写 SQL，交给 Spark 执行，并依据独立断言修正错误。代码和失败记录始终可见。</p><button onClick={() => setMessage("请计算T+1客户资产，确保现金不重复累计、持仓按position_id去重，并包含只有现金的客户。")}>试试：生成客户资产加工 SQL <Send size={13} /></button></div>}
          {task && <><div className="agent-dev-message user"><small>你的需求 · {task.id.slice(0,8)}</small><p>{task.message}</p></div>
            <div className="agent-dev-message assistant"><strong>{automatic ? <LoaderCircle size={15} className="spin" /> : <Bot size={15} />}{automatic && task.stage === "READY_FOR_MODEL" ? "正在请求模型生成或修正…" : stageText[task.stage ?? task.status] ?? task.status}</strong><p>{task.explanation || "需求已记录，将使用上方已确认的上下文和口径。"}</p>
              {task.error && <p className="agent-dev-error-text">{task.error}</p>}
              {task.attempts.filter(a=>a.diagnostic).map(a=><p key={`diagnostic-${a.attempt}`} className="agent-dev-error-text">第{a.attempt}次安全诊断：{a.diagnostic!.code} · 阶段 {a.diagnostic!.phase}{a.diagnostic!.httpStatus?` · HTTP ${a.diagnostic!.httpStatus}`:""} · {a.diagnostic!.elapsedMs}ms。{a.diagnostic!.requestMayHaveBeenSent?"请求可能已发送，不能据此确认是否计费。":"失败发生在请求发送前；原预算预留仍保留。"}</p>)}
              {task.sourceRunId && <button className="button" disabled={working} onClick={async () => { try { setRun(await api<Run>(`/runs/${task.sourceRunId}`)); setTab("日志"); setNotice("这里是本次修正引用的原始失败批次；编辑器仍保留当前代码。"); } catch(e) { setError((e as Error).message); } }}>查看修正依据 · {task.sourceRunId.slice(0,8)}</button>}
              <ol className="agent-dev-attempts">{task.attempts.map(a => <li key={a.attempt}><span>第{a.attempt}次</span><strong>{a.status === "FAILED" ? "执行失败（记录保留）" : a.status === "GENERATED" ? "代码已生成" : stageText[a.status] ?? a.status}</strong>{a.model && <small>模型：{a.model}</small>}{a.runId && <button disabled={working} onClick={async () => { try { setRun(await api<Run>(`/runs/${a.runId}`)); setTab("日志"); setNotice("正在查看这次尝试的执行记录；编辑器保留最新代码，结果以批次所绑定版本为准。"); } catch(e) { setError((e as Error).message); } }}>查看第{a.attempt}次执行 · {a.runId.slice(0,8)}</button>}</li>)}</ol>
              <small>版本 {task.version} · 预算占用 {task.usedTokens ?? 0} Token（未知结果含预留）· 结论仅对应当前代码版本</small>
              {task.background&&<p role="status">云后台：{task.background.status} · 已处理{task.background.consumedEvents}/{task.background.maxEvents}个事件 · 截止{new Date(task.background.expiresAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai"})}。未知模型结果暂停，不自动上线。{task.background.code&&` ${task.background.code}`}</p>}
            </div>
            {unknown && <label className="agent-dev-consent"><input type="checkbox" checked={retryConsent} onChange={e => setRetryConsent(e.target.checked)} />上次模型结果未知，可能已产生费用。我确认在剩余预算内再次调用。</label>}
            <div className="agent-dev-task-actions"><button className="button" disabled={busy} onClick={() => void selectTask(task.id, false)}><RefreshCw size={14} />刷新 / 恢复</button>
              {task.background?.status==="ACTIVE"&&<button className="button" disabled={!canWrite||busy} onClick={async()=>{epoch.current++;setAutomatic(false);setBusy(true);try{await api(`/agent/tasks/${task.id}/background/cancel`,{});setNotice("已停止后续后台推进；已提交步骤不会重复运行，待当前步骤确认后可人工接管。");await selectTask(task.id,false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><Square size={13}/>停止后台自动推进</button>}
              {task.background&&["NEEDS_CONFIRMATION","EXPIRED","PAUSED","CANCELLED"].includes(task.background.status)&&!terminal(task.status)&&<button className="button primary" disabled={!canWrite||working||dirty||(unknown&&!retryConsent)} onClick={async()=>{setBusy(true);try{await api(`/agent/tasks/${task.id}/background/resume`,{expectedVersion:task.version,confirmModelRetry:retryConsent});setRetryConsent(false);setNotice("已审阅并恢复原任务云后台15分钟；原次数与预算不清零，不自动发布。");await selectTask(task.id,false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>审阅并恢复云后台</button>}
              {!terminal(task.status) && <button className="button primary" title={dirty ? "请先保存并运行修改，或撤销未保存修改" : undefined} disabled={!canWrite || working || dirty || (unknown && !retryConsent)} onClick={() => void drive(task, retryConsent,true)}><Play size={14} />{unknown ? "确认重试" : task.background?.status==="ACTIVE"?"查看后台进度":"继续任务"}</button>}
              {!terminal(task.status) && <button className="button" disabled={!canWrite || busy} onClick={() => void stop()}><Square size={13} />停止</button>}
            </div>
            {task.status === "SUCCEEDED" && <p className="agent-dev-success"><CheckCircle2 size={16} />代码已通过执行校验。继续查看下方核验报告，并准备调度与部署交付。</p>}
          </>}
        </div>
        <form className="agent-dev-compose" onSubmit={e => { e.preventDefault(); void send(); }}><label htmlFor="agent-dev-message">{task ? "基于当前代码提出下一次修改" : "描述开发需求"}</label><textarea id="agent-dev-message" value={message} onChange={e => setMessage(e.target.value)} maxLength={2000} placeholder="例如：计算客户总资产，检查现金是否被重复累计…" disabled={working} />{backgroundAvailable&&<label className="agent-dev-consent"><input type="checkbox" checked={backgroundConsent} disabled={working} onChange={e=>setBackgroundConsent(e.target.checked)}/>委托云后台推进本次开发（15分钟、最多20个事件；沿用模型与执行预算，不自动发布）</label>}<div><small>本次将真实调用模型与隔离 Spark</small><button className="button primary" type="submit" disabled={!ready || !canWrite || working || runPending || message.trim().length < 4}><Send size={14} />按此口径生成并验证</button></div></form>
      </section>
      <section id="agent-code" className="agent-dev-artifacts"><header><div><FileCode2 size={16} /><strong>main.sql</strong><span>{dirty ? "修改待验证" : baselineRevisionId ? `版本 ${baselineRevisionId.slice(0,8)}` : "等待生成"}</span></div><div><button className="icon-button" aria-label="查看代码差异" disabled={!dirty && !task?.initialSql} title={!dirty && !task?.initialSql ? "没有原始草稿，不能重建历史差异" : "对照原始或未修改版本"} aria-pressed={diff} onClick={() => setDiff(!diff)}><GitCompareArrows size={16} /></button><button className="icon-button" disabled={working || !dirty} aria-label="撤销未保存修改" onClick={() => setDraft(baseline)}><Undo2 size={15} /></button></div></header>
        <div className="agent-dev-editor"><Suspense fallback={<div className="agent-dev-empty">正在加载代码编辑器…</div>}><SqlEditor value={draft} original={codeOriginal} diff={diff} onChange={setDraft} readOnly={working} /></Suspense></div>
        <div className="agent-dev-code-actions"><small><Code2 size={14} />{automatic ? "Agent 处理中，可随时停止后接管" : "可直接编辑；修改后需重新验证"}</small>{runPending && !automatic && <button className="button" disabled={!canWrite || busy} onClick={async () => { if (!run) return; setBusy(true); try { setRun(await api<Run>(`/runs/${run.id}/cancel`, {})); setNotice("取消标记已保存；迟到结果不会覆盖已取消状态。"); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}><Square size={13} />停止运行</button>}<button className="button" disabled={!canWrite || working || runPending || !draft.trim()} onClick={() => void runDraft()}><Play size={14} />保存并运行我的代码</button></div>
        <div className="agent-dev-result-tabs" role="tablist" aria-label="开发执行反馈">{["结果","校验","日志"].map(name => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}<span>{run ? `${stageText[run.status] ?? run.status} · ${run.id.slice(0,8)}` : "尚未执行"}</span></div>
        <div className="agent-dev-results">{!run ? <div className="agent-dev-empty">执行后的真实结果、校验与日志会显示在这里。<br />不会预先填入报表结果。</div> : <>
          {run.error && <p className="agent-dev-error-text" role="alert">{run.error}</p>}
          {["FAILED", "VALIDATION_FAILED"].includes(run.status) && <button className="button" disabled={!ready || !canWrite || working || dirty || run.revisionId !== baselineRevisionId} title="仅修正与当前已保存代码一致的失败批次" onClick={() => void send("请依据这次失败运行的真实错误信息修正当前SQL，并重新执行独立业务校验。")}>让 Agent 修正并验证</button>}
          {tab === "结果" && (resultFields.length ? <><div className="agent-dev-table-scroll"><table><thead><tr>{resultFields.map(k => <th key={k} title={k}>{resultFieldLabels[k] ?? k}</th>)}</tr></thead><tbody>{run.rows?.map((row,i) => <tr key={i}>{resultFields.map(k => <td key={k}>{String(row[k] ?? "—")}</td>)}</tr>)}</tbody></table></div><p>{run.engine} {run.engineVersion} · {run.rows?.length} 行 · 结果绑定版本 {run.revisionId?.slice(0,8)}</p></> : <p className="agent-dev-empty">{terminal(run.status) ? "本次未产生可展示的数据行。请查看校验和日志。" : "Spark 正在执行，结果完成后显示。"}</p>)}
          {tab === "校验" && <><h4>{run.validation?.passed ? "独立业务断言通过" : "校验尚未通过"}</h4>{run.validation?.issues?.map((x,i) => <p key={i}>{x}</p>)}{run.validation?.regressions?.map(r => <div className="agent-dev-check" key={r.contextId}><span>{r.name ?? r.contextId}</span><strong>{r.passed ? "通过" : "未通过"}</strong></div>)}</>}
          {tab === "日志" && <pre>{developmentRunLog(run)}</pre>}
        </>}</div>
      </section>
    </div>
    {task && <AgentDeliveryPanel key={task.id} api={api} taskId={task.id} revisionId={baselineRevisionId} runId={run?.id} dirty={dirty} canWrite={canWrite&&!pendingAgentKey} codeBusy={working||Boolean(pendingAgentKey)} onOpenServices={onOpenServices} handoffBlocked={Boolean(message.trim())||Boolean(pendingAgentKey)} />}
    {!task && baselineRevisionId && <section className="agent-delivery-panel" aria-label="人工接管与交付"><h3>人工接管记录</h3><p>当前代码由工程师保存；原 Agent 的失败和验证结论不改写，也不计作 Agent 自主完成。</p><small>代码版本：{baselineRevisionId}{run ? ` · 运行批次：${run.id}` : " · 运行尚未确认"}</small>
      {originTaskId && <button className="button" disabled={working || manualUnconfirmed || Boolean(message.trim())} onClick={() => void selectTask(originTaskId)}>返回原 Agent 任务</button>}
      {!localManualDelivery ? <p>当前环境尚未接入人工版本的云交付；不会回退本机交付，也不会借用原 Agent 的批准或发布。代码与批次保留，可继续人工检查。</p> : <><button className="button" disabled={working || dirty || manualUnconfirmed || Boolean(message.trim()) || run?.status !== "SUCCEEDED" || run.revisionId !== baselineRevisionId || !run.validationContractId} onClick={() => setManualDeliveryOpen(true)}>打开本机人工交付流程</button><small>在本页继续生成包、文件演练和审阅；服务端仍核验实际执行与来源。不是自动批准或云端上线。</small>
      {manualDeliveryOpen && run?.validationContractId && run.revisionId === baselineRevisionId && <Suspense fallback={<p role="status">正在加载人工交付流程…</p>}><ManualDeliveryWorkbench key={run.id} api={api} runs={[{id:run.id,status:run.status,revisionId:baselineRevisionId,contextId,createdAt:run.createdAt ?? "",validationContractId:run.validationContractId}]} sourceRunId={run.id} contractId={run.validationContractId} lockSource canWrite={canWrite && !working && !dirty && !manualUnconfirmed && !message.trim()} onBack={() => setManualDeliveryOpen(false)} /></Suspense>}</>}
    </section>}
  </section>;
}
