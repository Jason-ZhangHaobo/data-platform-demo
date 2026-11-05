import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Download, FileText, LoaderCircle, Package, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { agentJourney, deliveryStageText, publicationEvidenceText, verificationPresentation,manualConsumptionEntryMatches } from "./agent-journey";
import type { EvidenceReadState, TaskConsumption } from "./agent-journey";
import { EvidenceDownload } from "./EvidenceDownload";
import { DeliveryFilePreview } from "./DeliveryFilePreview";
import { AgentPublicationReview, publicationTargetMatches } from "./AgentPublicationReview";
import type { PublicationTarget } from "./AuthDialog";
import { applicationStatusText } from "./service-consumption-scope";
import { reviewAttestationsComplete } from "./delivery-presentation";
import { createPublicationReader, publicationPollNeeded } from "./publication-read";
import {ValidationDetails} from "./ValidationDetails";
import type {ValidationDetailsReport} from "./validation-details";
import {publicationSelector,publicationSelectionKey,publicationReadPath,publicationReleaseMatches,checkedPublication,publicationWriteAllowed,publicationCancellationAllowed,cloudPublicationRequest,createPublicationAttempt} from "./publication-selection";
import type {PublicationSelector} from "./publication-selection";
import {validServiceSourceBinding,serviceSourceKey,serviceSourceScope,serviceEvidencePath,returnedPublicationMatches,localAgentPublicationPath} from "./service-source-binding";
import type {ServiceSourceBinding} from "./service-source-binding";
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
type Delivery = { id: string; version: number; status: string; stage: string; mode?: string; sourceKind?:string; packageId?: string; packageDigest?: string; verificationId?: string; sourceRevisionId?: string; sourceRunId?: string; error?: string };
type Workflow = {
  report: { taskId: string; sourceKind?:string; agentIndependentE2E?:boolean; contextId?:string; validationContractId?:string; validationDetails?:ValidationDetailsReport; status: string; summary: string; definition?: string; checks: { id: string; label: string; passed: boolean }[]; revisionId?: string; revisionHash?:string; runId?: string; rowCount: number; engine?: string; engineVersion?: string; notice: string };
  delivery?: Delivery;
  package?: { id: string; digest: string; manifest: unknown; files: Record<string,string> };
  verification?: { id: string; status: string; engine?: string; engineVersion?: string; mainSqlExecuted?: boolean; durationMs?: number; error?: string; testSqlValidation?: { passed: boolean }; validation?: { passed: boolean; regressions?: { contextId: string; passed: boolean }[] } };
  publication: { available: boolean; scope: string; reason: string };
};
type Release = { id: string; status: string; health: string; sourceKind?:string; sourceRunId?:string; agentIndependentE2E?:boolean; packageId?: string; packageDigest?: string; verificationId?: string; sourceAgentTaskId?: string; sourceRevisionId?: string; runCount?: number };
type Publication = { release?: Release; runs: {id:string; status:string; sequence:number; schedulerTriggered?:boolean; durationMs?:number; triggeredAt?:string; finishedAt?:string}[]; alerts:{id:string;status:string;message:string;recoveryRunId?:string}[]; events:{id:string;type:string;observedAt:string;releaseId?:string;releaseRunId?:string;packageDigest?:string}[] };
const complete = (status?: string) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status ?? "");
const batchLabels: Record<string,string> = { SCHEDULED: "等待调度", RUNNING: "正在运行", SUCCEEDED: "独立核验通过", FAILED: "运行或核验失败", CANCELLED: "已停止" };
function download(name: string, value: unknown) {
  const blob = new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; link.hidden = true;
  try { document.body.appendChild(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
export function AgentDeliveryPanel({ api, taskId, contextId, revisionId, runId, dirty, canWrite, canPublish, publicationTarget, expectedSourceBinding,codeBusy, onOpenServices, handoffBlocked = false, manual = false }: { api: Api; taskId: string; contextId?:string; revisionId?: string; runId?: string; dirty: boolean; canWrite: boolean; canPublish?: boolean; publicationTarget?: PublicationTarget; expectedSourceBinding?:ServiceSourceBinding; codeBusy: boolean; onOpenServices?: (source:ServiceSourceBinding) => void; handoffBlocked?: boolean; manual?: boolean }) {
  const [workflow, setWorkflow] = useState<Workflow>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [auto, setAuto] = useState(false);
  const [review, setReview] = useState(false), [confirmed, setConfirmed] = useState<Record<string,boolean>>({}), [release, setRelease] = useState<Release>(), [batches, setBatches] = useState<{ id: string; status: string; sequence: number; schedulerTriggered?: boolean }[]>([]);
  const [publication,setPublication]=useState<Publication>();
  const [publicationClock,setPublicationClock]=useState(Date.now);
  const [publicationRead, setPublicationRead] = useState<EvidenceReadState>("LOADING");
  const [publicationReadKey,setPublicationReadKey]=useState("");
  const [publicationError, setPublicationError] = useState("");
  const publicationReader = useRef<ReturnType<typeof createPublicationReader<Publication>> | undefined>(undefined);
  const activePublicationKey=useRef(""),publicationReaderKey=useRef(""),pinnedReleases=useRef(new Map<string,string>());
  const publicationAttempts=useRef(new Map<string,ReturnType<typeof createPublicationAttempt>>());
  const acceptPublication = (value: Publication,key=activePublicationKey.current) => { setPublication(value); setRelease(value.release); setBatches(value.runs); setPublicationReadKey(key);setPublicationRead("READY"); setPublicationError(""); };
  const acceptPublicationWrite = (value: Publication,key=activePublicationKey.current,selector?:PublicationSelector) => {
    if(!alive.current||activePublicationKey.current!==key)return;
    if(selector)checkedPublication(value,taskId,selector,pinnedReleases.current.get(key));
    if(value.release)pinnedReleases.current.set(key,value.release.id);
    publicationAttempts.current.get(key)?.readback(Boolean(value.release));
    publicationReader.current?.invalidate(); acceptPublication(value,key);
  };
  const refreshPublication = () => { if (!publicationReader.current||publicationReaderKey.current!==activePublicationKey.current) return Promise.resolve(); setPublicationRead("LOADING"); return publicationReader.current.refresh(); };
  const [consumption,setConsumption]=useState<TaskConsumption>(),[consumptionError,setConsumptionError]=useState("");
  const [evidenceRead, setEvidenceRead] = useState<EvidenceReadState>("LOADING");
  const [evidenceError, setEvidenceError] = useState("");
  const consumptionEpoch=useRef(0),workflowEpoch=useRef(0);
  const activeConsumptionSource=useRef("");
  const epoch = useRef(0), alive = useRef(true), requestKey = useRef(crypto.randomUUID());
  const activeTask = useRef(taskId); activeTask.current = taskId;
  const workflowSourceKey=JSON.stringify([taskId,manual,runId,revisionId,contextId]),activeWorkflowSource=useRef(workflowSourceKey);activeWorkflowSource.current=workflowSourceKey;
  const load = async () => {
    const id = taskId, sequence=++workflowEpoch.current;
    const active = () => alive.current && activeTask.current === id && activeWorkflowSource.current===workflowSourceKey && sequence === workflowEpoch.current;
    setEvidenceRead("LOADING"); setEvidenceError("");
    try {
      const value = await api<Workflow>(manual ? `/runs/${runId}/workflow` : `/agent/tasks/${id}/workflow`);
      if (active()) { setWorkflow(value); setEvidenceRead("READY"); }
      return value;
    } catch (e) {
      if (active()) { setEvidenceRead("ERROR"); setEvidenceError((e as Error).message); }
      throw e;
    }
  };
  const readConsumption=async(value=workflow)=>{
    const id=taskId,digest=value?.package?.digest,sequence=++consumptionEpoch.current,binding=serviceHandoff,key=serviceSourceKey(binding);
    if(!binding||digest!==binding.packageDigest||!["PRIVATE_CLOUD_TEST","LOCAL_TEST_RELEASE"].includes(value?.publication.scope??""))return;
    try{
      const result=await api<TaskConsumption>(serviceEvidencePath(binding));
      if(result.taskId!==binding.taskId||result.packageDigest!==binding.packageDigest||result.releaseId!==binding.releaseId||result.scope!==serviceSourceScope(binding)||(result.sourceKind??"AGENT")!==binding.sourceKind||manual&&result.agentIndependentE2E!==false)throw Error("消费证据不是当前确切发布来源与环境，未采用其他包或发布记录");
      if(manual&&(!Array.isArray(result.services)||result.services.some(entry=>entry.status==="VERIFIED"&&!manualConsumptionEntryMatches(entry,binding.releaseId,batches,binding.runId))))throw Error("人工消费证据未绑定当前成功调度的发布批次；不采用开发运行或混合来源。");
      if(alive.current&&activeTask.current===id&&activeConsumptionSource.current===key&&sequence===consumptionEpoch.current){setConsumption(result);setConsumptionError("");}
    }catch(e){if(alive.current&&activeTask.current===id&&activeConsumptionSource.current===key&&sequence===consumptionEpoch.current){setConsumption(undefined);setConsumptionError(`消费对照尚未确认：${(e as Error).message}。不会新增调用或凭证。`);}}
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { if (!codeBusy) void load().catch(() => {}); }, [taskId, revisionId, runId, codeBusy]);
  const report = workflow?.report, delivery = workflow?.delivery;
  const cloud = workflow?.publication.scope === "PRIVATE_CLOUD_TEST";
  // A retained, successfully read workflow may still select read-only history
  // while refreshing; write gates continue to require fresh READY evidence.
  const selector=cloud?publicationSelector({taskId,manual,runId,revisionId,contextId},workflow,Boolean(workflow)):undefined;
  const publicationKey=selector?publicationSelectionKey(taskId,selector)+(expectedSourceBinding?`:${expectedSourceBinding.releaseId}`:""):!manual&&workflow&&!cloud?`local:${workflowSourceKey}:${expectedSourceBinding?.releaseId??""}`:"";
  activePublicationKey.current=publicationKey;
  const publicationReady=Boolean(publicationKey)&&publicationReadKey===publicationKey&&publicationRead==="READY";
  const journey = agentJourney({ taskId, contextId, revisionId, runId, dirty, evidenceReadable: evidenceRead === "READY", publicationReadable: publicationReady, report, delivery, bundle: workflow?.package, verification: workflow?.verification, release, batches, alerts: publication?.alerts, events: publication?.events, consumption });
  const current = journey.current;
  const verified = journey.steps.find(step => step.id === "validation")?.state === "DONE";
  const reportView = verificationPresentation(current, verified, evidenceRead, report?.status);
  const releaseLabel = (value: Release) => publicationEvidenceText(value, journey.publicationCurrent, journey.steps.some(step => step.id === "monitoring" && step.state === "DONE"));
  const working = busy || auto || codeBusy;
  const fileVerified = journey.fileVerified;
  const targetMatches = publicationTargetMatches(publicationTarget, { taskId, packageDigest: workflow?.package?.digest, verificationId: workflow?.verification?.id }, publicationClock)
    && (!publicationTarget || delivery?.verificationId === publicationTarget.verificationId);
  const publicationWritable = publicationWriteAllowed({manual,canPublish,canWrite,cloud,hasSelector:Boolean(selector),targetMatches});
  const publicationUnknown=publicationAttempts.current.get(publicationKey)?.snapshot().status==="UNKNOWN";
  const cancellationInput={taskId,selector,release,publicationKey,confirmedReadKey:publicationReadKey,pinnedReleaseId:pinnedReleases.current.get(publicationKey),dirty,working,
    canPublish:publicationWritable&&(!publicationTarget||Boolean(release&&publicationTargetMatches(publicationTarget,
      {taskId:release.sourceAgentTaskId??"",packageDigest:release.packageDigest,verificationId:release.verificationId},publicationClock)))};
  const cancellationWritable=publicationCancellationAllowed(cancellationInput);
  const handoffCandidate:ServiceSourceBinding|undefined=publicationReady&&journey.publicationCurrent&&release&&workflow?.package&&["PRIVATE_CLOUD_TEST","LOCAL_TEST_RELEASE"].includes(workflow.publication.scope)&&
    (!cloud||selector&&publicationReleaseMatches(release,taskId,selector))?{taskId,packageDigest:workflow.package.digest,releaseId:release.id,sourceKind:manual?"MANUAL":"AGENT",scope:cloud?"PRIVATE_CLOUD_TEST":"LOCAL_TEST_ONLY",revisionId,runId}:undefined;
  const serviceHandoff=validServiceSourceBinding(handoffCandidate)?handoffCandidate:undefined,serviceHandoffKey=serviceSourceKey(serviceHandoff);
  activeConsumptionSource.current=serviceHandoffKey;
  useEffect(() => {
    if (!publicationTarget) return;
    setPublicationClock(Date.now());
    const timer=setInterval(()=>setPublicationClock(Date.now()),1000);
    return()=>clearInterval(timer);
  },[publicationTarget?.taskId,publicationTarget?.packageDigest,publicationTarget?.verificationId,publicationTarget?.startsAt,publicationTarget?.expiresAt]);
  useEffect(() => { if (!publicationWritable) { setReview(false);setConfirmed({}); } }, [publicationWritable]);
  useEffect(() => { if (!canWrite || publicationTarget) { epoch.current++;setAuto(false); } }, [canWrite,publicationTarget?.taskId]);
  useEffect(()=>{setConsumption(undefined);setConsumptionError("");void readConsumption();return()=>{consumptionEpoch.current++;};},[serviceHandoffKey,cloud]);
  useEffect(() => { setReview(false); setConfirmed({}); }, [publicationKey,workflow?.package?.digest, workflow?.verification?.id, dirty, current, publicationRead]);
  useEffect(() => { requestKey.current = crypto.randomUUID(); }, [taskId, revisionId, runId]);
  async function drive(start: Delivery) {
    if (!canWrite || publicationTarget) return;
    const token = ++epoch.current; setAuto(true); setError(""); let item = start;
    try {
      for (let i = 0; i < 40 && token === epoch.current && !complete(item.status); i++) {
        item = item.mode === "DURABLE_AGENT_DELIVERY_V1" ? await api<Delivery>(`/agent/deliveries/${item.id}/advance`, { expectedVersion: item.version }) : await api<Delivery>(`/agent/deliveries/${item.id}`);
        if (token !== epoch.current) break;
        await load();
        if (!complete(item.status)) await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) { if (token === epoch.current) setError((e as Error).message + " 记录已保留，请刷新核对后继续同一交付。"); }
    finally { if (token === epoch.current) setAuto(false); }
  }
  async function prepare() {
    if (!verified || !canWrite || publicationTarget || working) return; setBusy(true); setError("");
    try { const started = await api<Delivery>(manual ? `/runs/${runId}/prepare-delivery` : `/agent/tasks/${taskId}/prepare-delivery`, {}, { idempotencyKey: requestKey.current }); await load(); void drive(started); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function stop() {
    if (!delivery || !canWrite || publicationTarget) return; epoch.current++; setAuto(false); setBusy(true);
    try { await api(`/agent/deliveries/${delivery.id}/cancel`, {}); await load(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publishLocal() {
    if (!publicationWritable || working || !publicationReady || !workflow?.package || !delivery?.verificationId || !verified || !fileVerified || !workflow.publication.available || !reviewAttestationsComplete(confirmed, cloud)) return;
    setBusy(true); setError("");
    const bundle = workflow.package,writeKey=publicationKey;
    try {
      if(cloud){
        if(!selector)throw Error("请先确认当前交付包、人工来源及文件演练，不能发布其他历史版本。");
        const key=publicationKey,request=cloudPublicationRequest(selector,bundle.id,confirmed);
        let attempt=publicationAttempts.current.get(key);
        if(!attempt){attempt=createPublicationAttempt(request);publicationAttempts.current.set(key,attempt);}
        const result=await attempt.submit(async frozen=>checkedPublication(await api<Publication>(`/agent/tasks/${taskId}/publication`,frozen.body,{idempotencyKey:frozen.idempotencyKey}),taskId,selector,pinnedReleases.current.get(key),true),true);
        acceptPublicationWrite(result,key,selector);if(activePublicationKey.current===key)setReview(false);return;
      }
      const reviewed = await api<{ id: string }>(`/delivery/packages/${bundle.id}/review`, { packageDigest: bundle.digest, verificationId: delivery.verificationId, reviewNote: "工程师已在Agent工作台审阅代码、核验、交付文件和测试发布范围。", attestations: confirmed });
      const approved = await api<{ id: string }>(`/delivery/packages/${bundle.id}/approve`, { packageDigest: bundle.digest, reviewId: reviewed.id });
      const published = await api<Release>("/releases", { approvalId: approved.id, triggerAfterSeconds: 5, intervalSeconds: 30, runCount: 2 }, { idempotencyKey: `agent-workbench-release-${bundle.id}` });
      publicationReader.current?.invalidate(); setRelease(published); setReview(false); await refreshPublication();
    } catch(e) { if(alive.current&&activePublicationKey.current===writeKey){setReview(false);setConfirmed({});setError((e as Error).message + " 只查询当前包的原发布记录；不会自动重发。明确重试仍复用原请求编号和审阅内容，不重新创建批准。"); publicationReader.current?.invalidate(); await refreshPublication();} } finally { if(alive.current)setBusy(false); }
  }
  useEffect(() => {
    const key=publicationKey;
    setPublication(undefined);setRelease(undefined);setBatches([]);setPublicationError("");
    if(!key){setPublicationReadKey("");setPublicationRead("READY");return;}
    setPublicationRead("LOADING");
    const reader = createPublicationReader<Publication>({
      read: async () => {
        const pinned=pinnedReleases.current.get(key)??expectedSourceBinding?.releaseId;
        const value=await api<Publication>(selector?publicationReadPath(taskId,selector,pinned):expectedSourceBinding?.scope==="LOCAL_TEST_ONLY"?localAgentPublicationPath(expectedSourceBinding):`/agent/tasks/${taskId}/publication`);
        if(expectedSourceBinding&&!returnedPublicationMatches(expectedSourceBinding,value))throw Error("发布回执不是返程绑定的原版本；未采用同任务的最新发布。可打开当前任务另行查看。");
        return selector?checkedPublication(value,taskId,selector,pinned):value;
      },
      onValue:value=>{
        if(!alive.current||activePublicationKey.current!==key)return;
        if(value.release)pinnedReleases.current.set(key,value.release.id);
        publicationAttempts.current.get(key)?.readback(Boolean(value.release));
        acceptPublication(value,key);
      },onError:e=>{if(alive.current&&activePublicationKey.current===key){setPublicationRead("ERROR");setPublicationError((e as Error).message);}}
    });
    publicationReader.current = reader;publicationReaderKey.current=key; void reader.refresh();
    return () => { reader.close(); if (publicationReader.current === reader){publicationReader.current = undefined;publicationReaderKey.current="";} };
  }, [publicationKey]);
  useEffect(() => {
    if (!publication || !publicationReady || !publicationPollNeeded(publication)) return;
    const timer = setInterval(() => { void publicationReader.current?.refresh(); }, cloud ? 10000 : 5000);
    return () => clearInterval(timer);
  }, [publication, publicationReady, cloud]);
  return <section id="agent-delivery" className="agent-delivery-panel" aria-label="核验与发布交付">
    <header><div><ShieldCheck size={17} /><strong>从开发到交付</strong></div><button className="icon-button" aria-label="刷新核验与交付" disabled={working || evidenceRead === "LOADING"} onClick={async()=>{try{await readConsumption(await load());}catch{/* load preserves the read error without losing evidence */}}}><RefreshCw size={14} /></button></header>
    {manual && <p className="agent-dev-notice" role="status">工程师接管交付 · 当前报告、交付包及演练均绑定此人工版本。原 Agent 的失败和尝试记录保留，不计作自主完成；发布需要独立审阅。</p>}
    {evidenceRead !== "READY" && <div className="agent-dev-notice" role={evidenceRead === "ERROR" ? "alert" : "status"}><div><strong>{reportView.title}</strong><p>{reportView.detail}</p>{evidenceError && <small>{evidenceError}</small>}</div>{evidenceRead === "ERROR" && <button className="button" disabled={working} onClick={() => void load().catch(() => {})}>重新读取核验记录</button>}</div>}
    <div className="agent-journey-summary"><div><span className="eyebrow">TASK JOURNEY · {taskId.slice(0,8)}</span><h3>{evidenceRead !== "READY" ? "先确认核验记录" : journey.next.id === "evidence" ? "本任务测试范围内的证据已齐" : `下一步：${journey.next.label}`}</h3><p>{evidenceRead !== "READY" ? "保留原任务与交付文件；不因读取失败重新计算或创建任务。" : journey.next.detail}</p></div>{evidenceRead === "READY" && <a className="button" href={`#${journey.next.target}`}>{journey.next.id === "evidence" ? "查看消费证据" : "查看下一步"}</a>}</div>
    <ol className="agent-workflow-steps agent-journey-steps" aria-label="完整任务链路">{journey.steps.map((step,index) => <li key={step.id} className={step.state.toLowerCase()}><a href={`#${step.target}`}>{step.state === "DONE" ? <CheckCircle2 size={15} /> : <Circle size={15} />}<span>{index+1}. {step.label}</span><strong>{({DONE:"证据通过",PENDING:"待完成",ATTENTION:"需要处理",STALE:"修改后待核验"})[step.state]}</strong></a><small>{step.detail}</small></li>)}</ol>
    <small>这是当前任务的证据导航，不是自主E2E评分；私有测试发布不等于公网或生产上线。</small>
    {error && <p className="agent-dev-alert error" role="alert">{error}</p>}
    {!workflow ? <p className="agent-dev-empty">{evidenceRead === "ERROR" ? "核验记录未读取成功；无需重新创建任务。" : "正在读取版本、核验和交付记录…"}</p> : <>
      <div id="agent-verification" className="agent-verification-card"><div className="agent-workflow-title"><FileText size={16} /><h3>结果核验报告</h3><span className={verified ? "passed" : ""}>{reportView.title}</span></div>
        <p>{reportView.detail}</p>{current && <p>{report?.summary}</p>}
        <ul>{report?.checks.map(check => <li key={check.id}>{reportView.currentChecks && check.passed ? <CheckCircle2 size={14} /> : <Circle size={14} />}<span>{check.label}</span><strong>{!reportView.currentChecks ? "历史记录" : check.passed ? "通过" : "待核验"}</strong></li>)}</ul>
        <small>{report?.rowCount}位客户 · {report?.engine} {report?.engineVersion} · {report?.notice}</small>
        <ValidationDetails details={evidenceRead==="READY"?report?.validationDetails:{schema:"shuduo-validation-details/v1",status:"UNVERIFIED"}} expectedSource={{runId:report?.runId,revisionId:report?.revisionId,contextId:report?.contextId,revisionHash:report?.revisionHash,contractId:report?.validationContractId}} dirty={dirty} historical={!current} />
        <button className="button" onClick={() => download("verification-report.json", report)}><Download size={14} />下载核验报告</button>
      </div>
      <div id="agent-files" className="agent-delivery-card"><div className="agent-workflow-title"><Package size={16} /><h3>调度与部署交付</h3></div><p>把当前通过核验的代码、测试、调度依赖、交易日历和部署清单固定到同一版本，再用 Spark 按文件执行一次演练。</p>
        {!delivery && <button className="button primary" disabled={!canWrite || !verified || working} onClick={() => void prepare()}><Play size={14} />生成交付并演练</button>}
        {delivery && <><strong className="agent-delivery-stage">{auto && <LoaderCircle size={14} className="spin" />}{deliveryStageText(delivery.stage, journey.publicationCurrent, release?.status, journey.current)}</strong>{delivery.error && <p role="alert">{delivery.error}</p>}<div className="agent-delivery-actions">{!complete(delivery.status) && <><button className="button primary" disabled={!canWrite || !verified || working} onClick={() => void drive(delivery)}>继续交付准备</button><button className="button" disabled={!canWrite || busy} onClick={() => void stop()}><Square size={13} />停止</button></>}{["FAILED","CANCELLED"].includes(delivery.status) && <button className="button" disabled={!canWrite || !verified || working} onClick={() => { requestKey.current=crypto.randomUUID(); void prepare(); }}>重新准备并演练</button>}{workflow.package && <button className="button" onClick={() => download("shuduo-delivery-package.json", workflow.package)}><Download size={14} />下载版本化交付包</button>}</div></>}
        {workflow.package && <DeliveryFilePreview key={workflow.package.digest} bundle={workflow.package} current={current} onDownload={download} />}
        {workflow.verification && <><p className={fileVerified ? "passed" : ""}>文件演练：{fileVerified ? "主SQL、测试SQL与五场景回归全部通过" : workflow.verification.status} · {workflow.verification.engine} {workflow.verification.engineVersion}</p>
          <dl className="delivery-review-source" aria-label="交付演练来源"><dt>文件演练编号</dt><dd>{workflow.verification.id}</dd><dt>源代码版本</dt><dd>{delivery?.sourceRevisionId ?? "未确认"}</dd><dt>源运行批次</dt><dd>{delivery?.sourceRunId ?? "未确认"}</dd></dl>
          <small>以上编号属于当前读取的交付演练，不代表已经批准或发布；未开放发布时仍可核对来源。</small>
          <button className="button" onClick={() => download(`delivery-evidence-${workflow.package?.id.slice(0,8) ?? taskId.slice(0,8)}.json`, { schema: "shuduo-delivery-evidence/v1", report: workflow.report, delivery: workflow.delivery, package: workflow.package ? { id: workflow.package.id, digest: workflow.package.digest, manifest: workflow.package.manifest } : undefined, verification: workflow.verification, publication: workflow.publication, exportedAt: new Date().toISOString() })}><Download size={14} />下载演练证据</button></>}
      </div>
      <div id="agent-publication" className="agent-publication-card"><div className="agent-workflow-title"><ShieldCheck size={16} /><h3>审阅发布与运行监控</h3></div><p>{!workflow.publication.available && release ? "发布记录已保留；临时调度入口已关闭，不会继续启动批次。新发布需按预算和权限重新启用。" : workflow.publication.reason}</p>{release && !journey.publicationCurrent && <p role="status">这是保留的发布记录，尚未核对为当前编辑版本的上线证据。</p>}
        {publicationTarget && <p role="status">{publicationWritable ? "本任务、包摘要和演练编号与受邀发布范围一致。请逐项审阅，不会自动批准。" : "当前任务或版本不在有效发布范围内，或窗口已关闭；只保留查看，不发布或停止其他任务。"} 同一冻结业务日期的两个样例批次，不是两个交易日或生产调度；不修改原代码或重新演练文件。</p>}
        <div className="agent-delivery-actions"><button className="button" disabled={!publicationKey || working || publicationRead === "LOADING"} onClick={() => void refreshPublication()}><RefreshCw size={14} />刷新发布与监控</button><small>{publicationKey?"只读取当前来源、交付包和演练绑定的发布，不重新发布或运行计算。":"先确认当前交付包及文件演练，才能读取此版本的发布记录。"}</small></div>
        {manual&&<p role="status">发布来源：工程师接管（MANUAL／ENGINEER_ASSISTED）· 原 Agent 失败记录保留，此包和发布不计作 Agent 自主完成。</p>}
        {publicationUnknown&&<p role="status">原发布请求结果尚未确认。先刷新读取同一包的记录；如仍未找到，重新审阅后可按原请求编号重试，不会自动生成新的批准。</p>}
        {publicationKey && !publicationReady && <p role={publicationRead === "ERROR" ? "alert" : "status"}>{publicationRead === "ERROR" ? `发布与监控读取未确认：${publicationError}。已读取的历史记录保留，暂不能判断当前健康或再次发布。` : "正在恢复当前来源与确切交付包的发布、批次与告警记录…"}</p>}
        {publicationReady && !release && <p>当前来源、交付包与演练尚未找到发布记录；需逐项审阅确切版本，发布后仍等待受控调度器执行。</p>}
        {workflow.publication.available && (!release || !journey.publicationCurrent) && <button className="button primary" disabled={!publicationWritable || !fileVerified || !verified || working || !publicationReady} onClick={() => { if (publicationWritable&&!working&&verified&&fileVerified&&publicationReady) setReview(true); }}>{publicationUnknown?"重新审阅并重试原发布请求":"审阅并发布测试任务"}</button>}
        {!workflow.publication.available && !release && <span className="agent-publication-gate">交付演练通过后进入“待发布”；云端上线尚待完成。</span>}
        {review && workflow.package && <AgentPublicationReview cloud={cloud} sourceKind={manual?"MANUAL":"AGENT"} originTaskId={taskId} packageDigest={workflow.package.digest} revisionId={delivery?.sourceRevisionId} runId={delivery?.sourceRunId} verificationId={delivery?.verificationId} confirmed={confirmed} disabled={!publicationWritable || working || !publicationReady || !verified || !fileVerified || !workflow.publication.available} onConfirm={(id, checked) => setConfirmed(old => ({...old, [id]:checked}))} onPublish={() => void publishLocal()} onCancel={() => { setReview(false); setConfirmed({}); }} />}
        {release && <>
          <strong>发布版本 {release.id.slice(0,8)} · {publicationReady ? releaseLabel(release) : "上次读取的记录 · 当前状态未确认"}</strong>
          <p className="agent-publication-id">发布编号：{release.id}</p>
          <ul>{batches.map(batch => <li key={batch.id}>第{batch.sequence}批 · {batchLabels[batch.status] ?? batch.status} · {batch.schedulerTriggered ? "调度器已触发" : batch.status === "CANCELLED" ? "未再触发" : "等待计划时间"}<small>批次编号：{batch.id}</small></li>)}</ul>
          {publication?.alerts.map(alert => <p key={alert.id} role={alert.status === "OPEN" ? "alert" : undefined}>{alert.status === "OPEN" ? "未解除告警" : "已恢复"}：{alert.message}{alert.recoveryRunId ? ` · 恢复批次 ${alert.recoveryRunId.slice(0,8)}` : ""}</p>)}
          {cloud&&cancellationWritable&&!publicationReady&&<p role="status">监控读取尚未确认；原发布来源和编号已核对，仍可停止这个已确认版本的后续批次。</p>}
          {cloud && release.status !== "CANCELLED" && batches.some(batch => !complete(batch.status)) && <button className="button" disabled={!cancellationWritable} onClick={async () => {
            if (!publicationCancellationAllowed(cancellationInput)||!selector) return;
            const key=publicationKey,selectedReleaseId=release.id;
            setBusy(true);
            try { const value=checkedPublication(await api<Publication>(`/agent/tasks/${taskId}/publication/cancel`,{...selector,releaseId:selectedReleaseId}),taskId,selector,selectedReleaseId);acceptPublicationWrite(value,key,selector); }
            catch(e) { if(alive.current&&activePublicationKey.current===key){setError((e as Error).message); publicationReader.current?.invalidate(); await refreshPublication();} }
            finally { if(alive.current)setBusy(false); }
          }}><Square size={14}/>停止后续云端批次</button>}
          {publication && <button className="button" onClick={() => download(`publication-${release.id.slice(0,8)}.json`,{...publication, readState:publicationRead, notice:"已读取的测试范围记录，不代表实时健康或公网验收"})}><Download size={14}/>下载发布与监控记录</button>}
        </>}
      </div>
      <div id="agent-service-handoff" className="agent-publication-card"><div className="agent-workflow-title"><Package size={16}/><h3>发布结果 → DAPI / XAPI</h3></div><p>继续同一个任务、交付包和发布版本的接口开发、测试与授权。选择实际成功发布批次后核对返回值和调用日志；打开模块不会自动创建凭证或调用接口。</p>
        {manual&&<p role="status">人工发布结果消费 · 保留原 Agent 失败及工程师接管归因，不计为 Agent 自主完成。</p>}
        {!serviceHandoff&&<p role="status">请先核对当前包的确切发布记录；未确认来源时不跳转到全项目或原 Agent 的其他结果。</p>}
        {consumptionError&&<p role="status">{consumptionError}</p>}
        {journey.steps.find(step=>step.id==="services")?.state==="DONE"&&<p role="status">组合接口的消费证据已通过。DAPI的单独授权调用记录独立展示，不影响已通过的XAPI组合查询。</p>}
        {consumption&&<><p>{consumption.notice}</p><small>对照时间：{consumption.checkedAt}；这是历史消费记录，不是实时授权保证。</small>{!current&&<p>编辑器或当前查看的批次已变化；下面证据仅供原版本参考。</p>}<ul>{consumption.services.map(s=><li key={s.serviceId}><strong>{s.serviceType} · {s.name}</strong> · 版本 {s.versionId.slice(0,8)} · {s.status==="VERIFIED"?"历史消费证据对照通过":s.status==="NEEDS_ATTENTION"?"需要处理":"待实际授权调用"}<p>{s.notice}</p>{s.call&&<small>调用 {s.call.callId.slice(0,8)} · {s.call.rowCount}行 · 摘要 {s.call.resultHash.slice(0,12)} · {applicationStatusText(s.call.applicationStatus,true)}</small>}</li>)}</ul>{consumption.truncated&&<p>证据数量超过本次上限，不能标记整个消费阶段完成。</p>}<EvidenceDownload name={`consumption-${taskId.slice(0,8)}.json`} value={consumption} request={{kind:"consumption",id:taskId,digest:consumption.packageDigest,releaseId:consumption.releaseId}}>下载当前发布的消费对照证据</EvidenceDownload></>}
        {workflow.package&&<button className="button" disabled={working||!serviceHandoff} onClick={()=>void readConsumption()}>刷新消费证据</button>}
        {onOpenServices ? <><button className="button" disabled={!serviceHandoff || dirty || working || handoffBlocked} onClick={()=>{if(serviceHandoff&&!dirty&&!working&&!handoffBlocked)onOpenServices(serviceHandoff);}}>继续此任务的接口交付</button>{handoffBlocked && <small>修改需求尚未发送，请先处理输入再切换；不会丢弃你的文字。</small>}</> : <small>当前环境尚未开放服务接管；已有交付记录保留。</small>}</div>
    </>}
  </section>;
}
