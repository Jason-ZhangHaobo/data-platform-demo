import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Download, FileText, LoaderCircle, Package, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { agentJourney, deliveryStageText, publicationEvidenceText, verificationPresentation } from "./agent-journey";
import type { EvidenceReadState, TaskConsumption } from "./agent-journey";
import { EvidenceDownload } from "./EvidenceDownload";
import { DeliveryFilePreview } from "./DeliveryFilePreview";
import { AgentPublicationReview, publicationTargetMatches } from "./AgentPublicationReview";
import type { PublicationTarget } from "./AuthDialog";
import { applicationStatusText } from "./service-consumption-scope";
import { reviewAttestationsComplete } from "./delivery-presentation";
import { createPublicationReader, publicationPollNeeded } from "./publication-read";
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
type Delivery = { id: string; version: number; status: string; stage: string; mode?: string; packageId?: string; packageDigest?: string; verificationId?: string; sourceRevisionId?: string; sourceRunId?: string; error?: string };
type Workflow = {
  report: { taskId: string; contextId?:string; validationContractId?:string; status: string; summary: string; definition?: string; checks: { id: string; label: string; passed: boolean }[]; revisionId?: string; runId?: string; rowCount: number; engine?: string; engineVersion?: string; notice: string };
  delivery?: Delivery;
  package?: { id: string; digest: string; manifest: unknown; files: Record<string,string> };
  verification?: { id: string; status: string; engine?: string; engineVersion?: string; mainSqlExecuted?: boolean; durationMs?: number; error?: string; testSqlValidation?: { passed: boolean }; validation?: { passed: boolean; regressions?: { contextId: string; passed: boolean }[] } };
  publication: { available: boolean; scope: string; reason: string };
};
type Release = { id: string; status: string; health: string; packageId?: string; packageDigest?: string; verificationId?: string; sourceAgentTaskId?: string; sourceRevisionId?: string; runCount?: number };
type Publication = { release?: Release; runs: {id:string; status:string; sequence:number; schedulerTriggered?:boolean; durationMs?:number; triggeredAt?:string; finishedAt?:string}[]; alerts:{id:string;status:string;message:string;recoveryRunId?:string}[]; events:{id:string;type:string;observedAt:string;releaseId?:string;releaseRunId?:string;packageDigest?:string}[] };
const complete = (status?: string) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status ?? "");
const batchLabels: Record<string,string> = { SCHEDULED: "等待调度", RUNNING: "正在运行", SUCCEEDED: "独立核验通过", FAILED: "运行或核验失败", CANCELLED: "已停止" };
function download(name: string, value: unknown) {
  const blob = new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; link.hidden = true;
  try { document.body.appendChild(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
export function AgentDeliveryPanel({ api, taskId, contextId, revisionId, runId, dirty, canWrite, canPublish, publicationTarget, codeBusy, onOpenServices, handoffBlocked = false, manual = false }: { api: Api; taskId: string; contextId?:string; revisionId?: string; runId?: string; dirty: boolean; canWrite: boolean; canPublish?: boolean; publicationTarget?: PublicationTarget; codeBusy: boolean; onOpenServices?: () => void; handoffBlocked?: boolean; manual?: boolean }) {
  const [workflow, setWorkflow] = useState<Workflow>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [auto, setAuto] = useState(false);
  const [review, setReview] = useState(false), [confirmed, setConfirmed] = useState<Record<string,boolean>>({}), [release, setRelease] = useState<Release>(), [batches, setBatches] = useState<{ id: string; status: string; sequence: number; schedulerTriggered?: boolean }[]>([]);
  const [publication,setPublication]=useState<Publication>();
  const [publicationClock,setPublicationClock]=useState(Date.now);
  const [publicationRead, setPublicationRead] = useState<EvidenceReadState>("LOADING");
  const [publicationError, setPublicationError] = useState("");
  const publicationReader = useRef<ReturnType<typeof createPublicationReader<Publication>> | undefined>(undefined);
  const acceptPublication = (value: Publication) => { setPublication(value); setRelease(value.release); setBatches(value.runs); setPublicationRead("READY"); setPublicationError(""); };
  const acceptPublicationWrite = (value: Publication) => { publicationReader.current?.invalidate(); acceptPublication(value); };
  const refreshPublication = () => { if (manual) return; setPublicationRead("LOADING"); return publicationReader.current?.refresh(); };
  const [consumption,setConsumption]=useState<TaskConsumption>(),[consumptionError,setConsumptionError]=useState("");
  const [evidenceRead, setEvidenceRead] = useState<EvidenceReadState>("LOADING");
  const [evidenceError, setEvidenceError] = useState("");
  const consumptionEpoch=useRef(0),workflowEpoch=useRef(0);
  const epoch = useRef(0), alive = useRef(true), requestKey = useRef(crypto.randomUUID());
  const activeTask = useRef(taskId); activeTask.current = taskId;
  const load = async () => {
    const id = taskId, sequence=++workflowEpoch.current;
    const active = () => alive.current && activeTask.current === id && sequence === workflowEpoch.current;
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
    const id=taskId,digest=value?.package?.digest,sequence=++consumptionEpoch.current;
    if(manual || !digest || !["PRIVATE_CLOUD_TEST","LOCAL_TEST_RELEASE"].includes(value?.publication.scope??""))return;
    try{
      const result=await api<TaskConsumption>(`/data-services/task-evidence?agent_task_id=${encodeURIComponent(id)}&package_digest=${encodeURIComponent(digest)}`);
      if(alive.current&&activeTask.current===id&&sequence===consumptionEpoch.current){setConsumption(result);setConsumptionError("");}
    }catch(e){if(alive.current&&activeTask.current===id&&sequence===consumptionEpoch.current){setConsumption(undefined);setConsumptionError(`消费对照尚未确认：${(e as Error).message}。不会新增调用或凭证。`);}}
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { if (!codeBusy) void load().catch(() => {}); }, [taskId, revisionId, runId, codeBusy]);
  const report = workflow?.report, delivery = workflow?.delivery;
  const journey = agentJourney({ taskId, contextId, revisionId, runId, dirty, evidenceReadable: evidenceRead === "READY", publicationReadable: publicationRead === "READY", report, delivery, bundle: workflow?.package, verification: workflow?.verification, release, batches, alerts: publication?.alerts, events: publication?.events, consumption });
  const current = journey.current;
  const verified = journey.steps.find(step => step.id === "validation")?.state === "DONE";
  const reportView = verificationPresentation(current, verified, evidenceRead, report?.status);
  const releaseLabel = (value: Release) => publicationEvidenceText(value, journey.publicationCurrent, journey.steps.some(step => step.id === "monitoring" && step.state === "DONE"));
  const working = busy || auto || codeBusy;
  const fileVerified = journey.fileVerified;
  const cloud = workflow?.publication.scope === "PRIVATE_CLOUD_TEST";
  const targetMatches = publicationTargetMatches(publicationTarget, { taskId, packageDigest: workflow?.package?.digest, verificationId: workflow?.verification?.id }, publicationClock)
    && (!publicationTarget || delivery?.verificationId === publicationTarget.verificationId);
  const publicationWritable = Boolean(!manual && (canPublish ?? canWrite) && targetMatches);
  const cancellationWritable = publicationWritable && (!publicationTarget || Boolean(release && publicationTargetMatches(publicationTarget,
    {taskId:release.sourceAgentTaskId ?? "",packageDigest:release.packageDigest,verificationId:release.verificationId},publicationClock)));
  useEffect(() => {
    if (!publicationTarget) return;
    setPublicationClock(Date.now());
    const timer=setInterval(()=>setPublicationClock(Date.now()),1000);
    return()=>clearInterval(timer);
  },[publicationTarget?.taskId,publicationTarget?.packageDigest,publicationTarget?.verificationId,publicationTarget?.startsAt,publicationTarget?.expiresAt]);
  useEffect(() => { if (!publicationWritable) { setReview(false);setConfirmed({}); } }, [publicationWritable]);
  useEffect(() => { if (!canWrite || publicationTarget) { epoch.current++;setAuto(false); } }, [canWrite,publicationTarget?.taskId]);
  useEffect(()=>{setConsumption(undefined);setConsumptionError("");void readConsumption();return()=>{consumptionEpoch.current++;};},[taskId,workflow?.package?.digest,cloud]);
  useEffect(() => { setReview(false); setConfirmed({}); }, [workflow?.package?.digest, workflow?.verification?.id, dirty, current, publicationRead]);
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
    if (!publicationWritable || working || publicationRead !== "READY" || !workflow?.package || !delivery?.verificationId || !verified || !fileVerified || !workflow.publication.available || !reviewAttestationsComplete(confirmed, cloud)) return;
    setBusy(true); setError("");
    const bundle = workflow.package;
    try {
      if(cloud){const result=await api<Publication>(`/agent/tasks/${taskId}/publication`,{packageDigest:bundle.digest,verificationId:delivery.verificationId,attestations:confirmed},{idempotencyKey:`agent-cloud-publication-${bundle.id}`});acceptPublicationWrite(result);setReview(false);return;}
      const reviewed = await api<{ id: string }>(`/delivery/packages/${bundle.id}/review`, { packageDigest: bundle.digest, verificationId: delivery.verificationId, reviewNote: "工程师已在Agent工作台审阅代码、核验、交付文件和测试发布范围。", attestations: confirmed });
      const approved = await api<{ id: string }>(`/delivery/packages/${bundle.id}/approve`, { packageDigest: bundle.digest, reviewId: reviewed.id });
      const published = await api<Release>("/releases", { approvalId: approved.id, triggerAfterSeconds: 5, intervalSeconds: 30, runCount: 2 }, { idempotencyKey: `agent-workbench-release-${bundle.id}` });
      publicationReader.current?.invalidate(); setRelease(published); setReview(false); await refreshPublication();
    } catch(e) { setError((e as Error).message + " 发布结果需先读取原记录确认，不要重新创建任务。"); publicationReader.current?.invalidate(); await refreshPublication(); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (manual) { setPublicationRead("READY"); setPublication(undefined); setRelease(undefined); setBatches([]); return; }
    const reader = createPublicationReader<Publication>({ read: () => api<Publication>(`/agent/tasks/${taskId}/publication`), onValue: acceptPublication, onError: e => { setPublicationRead("ERROR"); setPublicationError((e as Error).message); } });
    publicationReader.current = reader; void reader.refresh();
    return () => { reader.close(); if (publicationReader.current === reader) publicationReader.current = undefined; };
  }, [taskId,manual]);
  useEffect(() => {
    if (!publication || publicationRead !== "READY" || !publicationPollNeeded(publication)) return;
    const timer = setInterval(() => { void publicationReader.current?.refresh(); }, cloud ? 10000 : 5000);
    return () => clearInterval(timer);
  }, [publication, publicationRead, cloud]);
  useEffect(() => { if (workflow?.package?.digest) void publicationReader.current?.refresh(); }, [workflow?.package?.digest]);
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
        {!manual && <div className="agent-delivery-actions"><button className="button" disabled={working || publicationRead === "LOADING"} onClick={() => void refreshPublication()}><RefreshCw size={14} />刷新发布与监控</button><small>只读取原任务，不会重新发布或运行计算。</small></div>}
        {publicationRead !== "READY" && <p role={publicationRead === "ERROR" ? "alert" : "status"}>{publicationRead === "ERROR" ? `发布与监控读取未确认：${publicationError}。已读取的历史记录保留，暂不能判断当前健康或再次发布。` : "正在恢复原任务的发布、批次与告警记录…"}</p>}
        {publicationRead === "READY" && !release && <p>{manual ? "当前人工交付支持核验、文件生成与演练；人工包的云发布接入仍待完成。" : "当前任务尚未找到发布记录；交付演练通过并完成审阅后才能发布。"}</p>}
        {workflow.publication.available && (!release || !journey.publicationCurrent) && <button className="button primary" disabled={!publicationWritable || !fileVerified || !verified || working || publicationRead !== "READY"} onClick={() => { if (publicationWritable) setReview(true); }}>审阅并发布测试任务</button>}
        {!workflow.publication.available && !release && <span className="agent-publication-gate">交付演练通过后进入“待发布”；云端上线尚待完成。</span>}
        {review && workflow.package && <AgentPublicationReview cloud={cloud} packageDigest={workflow.package.digest} revisionId={delivery?.sourceRevisionId} runId={delivery?.sourceRunId} verificationId={delivery?.verificationId} confirmed={confirmed} disabled={!publicationWritable || working || publicationRead !== "READY" || !verified || !fileVerified || !workflow.publication.available} onConfirm={(id, checked) => setConfirmed(old => ({...old, [id]:checked}))} onPublish={() => void publishLocal()} onCancel={() => { setReview(false); setConfirmed({}); }} />}
        {release && <>
          <strong>发布版本 {release.id.slice(0,8)} · {publicationRead === "READY" ? releaseLabel(release) : "上次读取的记录 · 当前状态未确认"}</strong>
          <p className="agent-publication-id">发布编号：{release.id}</p>
          <ul>{batches.map(batch => <li key={batch.id}>第{batch.sequence}批 · {batchLabels[batch.status] ?? batch.status} · {batch.schedulerTriggered ? "调度器已触发" : batch.status === "CANCELLED" ? "未再触发" : "等待计划时间"}<small>批次编号：{batch.id}</small></li>)}</ul>
          {publication?.alerts.map(alert => <p key={alert.id} role={alert.status === "OPEN" ? "alert" : undefined}>{alert.status === "OPEN" ? "未解除告警" : "已恢复"}：{alert.message}{alert.recoveryRunId ? ` · 恢复批次 ${alert.recoveryRunId.slice(0,8)}` : ""}</p>)}
          {cloud && release.status !== "CANCELLED" && batches.some(batch => !complete(batch.status)) && <button className="button" disabled={working || !cancellationWritable || publicationRead !== "READY"} onClick={async () => {
            if (!cancellationWritable) return;
            setBusy(true);
            try { acceptPublicationWrite(await api<Publication>(`/agent/tasks/${taskId}/publication/cancel`,{})); }
            catch(e) { setError((e as Error).message); publicationReader.current?.invalidate(); await refreshPublication(); }
            finally { setBusy(false); }
          }}><Square size={14}/>停止后续云端批次</button>}
          {publication && <button className="button" onClick={() => download(`publication-${release.id.slice(0,8)}.json`,{...publication, readState:publicationRead, notice:"已读取的测试范围记录，不代表实时健康或公网验收"})}><Download size={14}/>下载发布与监控记录</button>}
        </>}
      </div>
      {!manual && <div id="agent-service-handoff" className="agent-publication-card"><div className="agent-workflow-title"><Package size={16}/><h3>发布结果 → DAPI / XAPI</h3></div><p>继续同一个任务的接口开发、测试与授权。选择实际发布批次后核对返回值和调用日志；打开模块不会自动创建凭证或调用接口。</p>
        {consumptionError&&<p role="status">{consumptionError}</p>}
        {journey.steps.find(step=>step.id==="services")?.state==="DONE"&&<p role="status">组合接口的消费证据已通过。DAPI的单独授权调用记录独立展示，不影响已通过的XAPI组合查询。</p>}
        {consumption&&<><p>{consumption.notice}</p><small>对照时间：{consumption.checkedAt}；这是历史消费记录，不是实时授权保证。</small>{!current&&<p>编辑器或当前查看的批次已变化；下面证据仅供原版本参考。</p>}<ul>{consumption.services.map(s=><li key={s.serviceId}><strong>{s.serviceType} · {s.name}</strong> · 版本 {s.versionId.slice(0,8)} · {s.status==="VERIFIED"?"历史消费证据对照通过":s.status==="NEEDS_ATTENTION"?"需要处理":"待实际授权调用"}<p>{s.notice}</p>{s.call&&<small>调用 {s.call.callId.slice(0,8)} · {s.call.rowCount}行 · 摘要 {s.call.resultHash.slice(0,12)} · {applicationStatusText(s.call.applicationStatus,true)}</small>}</li>)}</ul>{consumption.truncated&&<p>证据数量超过本次上限，不能标记整个消费阶段完成。</p>}<EvidenceDownload name={`consumption-${taskId.slice(0,8)}.json`} value={consumption} request={{kind:"consumption",id:taskId,digest:consumption.packageDigest}}>下载消费对照证据</EvidenceDownload></>}
        {workflow.package&&<button className="button" disabled={working} onClick={()=>void readConsumption()}>刷新消费证据</button>}
        {onOpenServices ? <><button className="button" disabled={dirty || working || handoffBlocked} onClick={onOpenServices}>继续此任务的接口交付</button>{handoffBlocked && <small>修改需求尚未发送，请先处理输入再切换；不会丢弃你的文字。</small>}</> : <small>当前环境尚未开放服务接管；已有交付记录保留。</small>}</div>}
    </>}
  </section>;
}
