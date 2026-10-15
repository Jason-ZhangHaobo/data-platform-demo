import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Download, FileText, LoaderCircle, Package, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { agentJourney, deliveryStageText } from "./agent-journey";
import type { TaskConsumption } from "./agent-journey";
import { EvidenceDownload } from "./EvidenceDownload";
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
type Delivery = { id: string; version: number; status: string; stage: string; mode?: string; packageId?: string; packageDigest?: string; verificationId?: string; sourceRevisionId?: string; sourceRunId?: string; error?: string };
type Workflow = {
  report: { taskId: string; status: string; summary: string; definition?: string; checks: { id: string; label: string; passed: boolean }[]; revisionId?: string; runId?: string; rowCount: number; engine?: string; engineVersion?: string; notice: string };
  delivery?: Delivery;
  package?: { id: string; digest: string; manifest: unknown; files: Record<string,string> };
  verification?: { id: string; status: string; engine?: string; engineVersion?: string; mainSqlExecuted?: boolean; durationMs?: number; error?: string; testSqlValidation?: { passed: boolean }; validation?: { passed: boolean; regressions?: { contextId: string; passed: boolean }[] } };
  publication: { available: boolean; scope: string; reason: string };
};
type Release = { id: string; status: string; health: string; packageId?: string; packageDigest?: string; sourceRevisionId?: string; runCount?: number };
type Publication = { release?: Release; runs: {id:string; status:string; sequence:number; schedulerTriggered?:boolean; durationMs?:number; triggeredAt?:string; finishedAt?:string}[]; alerts:{id:string;status:string;message:string;recoveryRunId?:string}[]; events:{id:string;type:string;observedAt:string;releaseId?:string;releaseRunId?:string;packageDigest?:string}[] };
const complete = (status?: string) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status ?? "");
const batchLabels: Record<string,string> = { SCHEDULED: "等待调度", RUNNING: "正在运行", SUCCEEDED: "独立核验通过", FAILED: "运行或核验失败", CANCELLED: "已停止" };
function releaseLabel(release: Release) {
  if (release.status === "CANCELLED") return "已停止";
  if (release.status === "WAITING_SCHEDULER") return "已审阅，等待调度器";
  if (release.health === "HEALTHY") return "两个测试批次通过，运行健康";
  if (release.health === "CRITICAL") return "存在未解除运行告警";
  if (release.health === "RECOVERED_WITH_FAILURE") return "后续批次已恢复，历史失败保留";
  return "观察运行中";
}
function download(name: string, value: unknown) {
  const blob = new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function AgentDeliveryPanel({ api, taskId, revisionId, runId, dirty, canWrite, codeBusy, onOpenServices, handoffBlocked = false }: { api: Api; taskId: string; revisionId?: string; runId?: string; dirty: boolean; canWrite: boolean; codeBusy: boolean; onOpenServices?: () => void; handoffBlocked?: boolean }) {
  const [workflow, setWorkflow] = useState<Workflow>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [file, setFile] = useState("schedule.json"), [auto, setAuto] = useState(false);
  const [review, setReview] = useState(false), [confirmed, setConfirmed] = useState<Record<string,boolean>>({}), [release, setRelease] = useState<Release>(), [batches, setBatches] = useState<{ id: string; status: string; sequence: number; schedulerTriggered?: boolean }[]>([]);
  const [publication,setPublication]=useState<Publication>();
  const [consumption,setConsumption]=useState<TaskConsumption>(),[consumptionError,setConsumptionError]=useState("");
  const consumptionEpoch=useRef(0),workflowEpoch=useRef(0);
  const epoch = useRef(0), alive = useRef(true), requestKey = useRef(crypto.randomUUID());
  const activeTask = useRef(taskId); activeTask.current = taskId;
  const load = async () => {
    const id = taskId, sequence=++workflowEpoch.current, value = await api<Workflow>(`/agent/tasks/${id}/workflow`);
    if (alive.current && activeTask.current === id && sequence===workflowEpoch.current) setWorkflow(value); return value;
  };
  const readConsumption=async(value=workflow)=>{
    const id=taskId,digest=value?.package?.digest,sequence=++consumptionEpoch.current;
    if(!digest || value?.publication.scope!=="PRIVATE_CLOUD_TEST")return;
    try{
      const result=await api<TaskConsumption>(`/data-services/task-evidence?agent_task_id=${encodeURIComponent(id)}&package_digest=${encodeURIComponent(digest)}`);
      if(alive.current&&activeTask.current===id&&sequence===consumptionEpoch.current){setConsumption(result);setConsumptionError("");}
    }catch(e){if(alive.current&&activeTask.current===id&&sequence===consumptionEpoch.current){setConsumption(undefined);setConsumptionError(`消费对照尚未确认：${(e as Error).message}。不会新增调用或凭证。`);}}
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { if (!codeBusy) load().catch(e => setError(e.message)); }, [taskId, revisionId, runId, codeBusy]);
  const report = workflow?.report, delivery = workflow?.delivery;
  const journey = agentJourney({ taskId, revisionId, runId, dirty, report, delivery, bundle: workflow?.package, verification: workflow?.verification, release, batches, alerts: publication?.alerts, events: publication?.events, consumption });
  const current = journey.current;
  const verified = journey.steps.find(step => step.id === "validation")?.state === "DONE";
  const working = busy || auto || codeBusy;
  const fileVerified = journey.fileVerified;
  const cloud = workflow?.publication.scope === "PRIVATE_CLOUD_TEST";
  useEffect(()=>{setConsumption(undefined);setConsumptionError("");void readConsumption();return()=>{consumptionEpoch.current++;};},[taskId,workflow?.package?.digest,cloud]);
  useEffect(() => { setReview(false); setConfirmed({}); }, [workflow?.package?.digest, workflow?.verification?.id, dirty, current]);
  async function drive(start: Delivery) {
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
    if (!verified || !canWrite) return; setBusy(true); setError("");
    try { const started = await api<Delivery>(`/agent/tasks/${taskId}/prepare-delivery`, {}, { idempotencyKey: requestKey.current }); await load(); void drive(started); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function stop() {
    if (!delivery) return; epoch.current++; setAuto(false); setBusy(true);
    try { await api(`/agent/deliveries/${delivery.id}/cancel`, {}); await load(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publishLocal() {
    if (!workflow?.package || !delivery?.verificationId || !verified || !fileVerified || !workflow.publication.available || !Object.values(confirmed).every(Boolean) || Object.keys(confirmed).length !== 4) return;
    setBusy(true); setError("");
    const bundle = workflow.package;
    try {
      if(cloud){const result=await api<Publication>(`/agent/tasks/${taskId}/publication`,{packageDigest:bundle.digest,verificationId:delivery.verificationId,attestations:confirmed},{idempotencyKey:`agent-cloud-publication-${bundle.id}`});setPublication(result);setRelease(result.release);setBatches(result.runs);setReview(false);return;}
      const reviewed = await api<{ id: string }>(`/delivery/packages/${bundle.id}/review`, { packageDigest: bundle.digest, verificationId: delivery.verificationId, reviewNote: "工程师已在Agent工作台审阅代码、核验、交付文件和测试发布范围。", attestations: confirmed });
      const approved = await api<{ id: string }>(`/delivery/packages/${bundle.id}/approve`, { packageDigest: bundle.digest, reviewId: reviewed.id });
      const published = await api<Release>("/releases", { approvalId: approved.id, triggerAfterSeconds: 5, intervalSeconds: 30, runCount: 2 }, { idempotencyKey: `agent-workbench-release-${bundle.id}` });
      setRelease(published); setReview(false);
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => {
    if(cloud){let active=true;const read=async()=>{const value=await api<Publication>(`/agent/tasks/${taskId}/publication`);if(active){setPublication(value);setRelease(value.release);setBatches(value.runs);}};read().catch(e=>setError(e.message));const pending=publication?.runs.some(r=>!complete(r.status));const timer=release?.id&&pending?setInterval(()=>read().catch(e=>setError(e.message)),10000):undefined;return()=>{active=false;if(timer)clearInterval(timer);};}
    if (!release?.id) return; let active = true;
    const read = async () => { const [next, runs] = await Promise.all([api<Release>(`/releases/${release.id}`), api<{ id: string; status: string; sequence: number; releaseId: string; schedulerTriggered?: boolean }[]>("/release/runs")]); if (active) { setRelease(next); setBatches(runs.filter(r => r.releaseId === release.id)); } };
    read().catch(e => setError(e.message)); const timer = setInterval(() => read().catch(e => setError(e.message)), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [release?.id,cloud,taskId,publication?.runs.map(r=>r.status).join(",")]);
  return <section id="agent-delivery" className="agent-delivery-panel" aria-label="核验与发布交付">
    <header><div><ShieldCheck size={17} /><strong>从开发到交付</strong></div><button className="icon-button" aria-label="刷新核验与交付" disabled={working} onClick={async()=>{try{await readConsumption(await load());}catch(e){setError((e as Error).message);}}}><RefreshCw size={14} /></button></header>
    <div className="agent-journey-summary"><div><span className="eyebrow">TASK JOURNEY · {taskId.slice(0,8)}</span><h3>{journey.next.id === "evidence" ? "本任务测试范围内的证据已齐" : `下一步：${journey.next.label}`}</h3><p>{journey.next.detail}</p></div><a className="button" href={`#${journey.next.target}`}>{journey.next.id === "evidence" ? "查看消费证据" : "查看下一步"}</a></div>
    <ol className="agent-workflow-steps agent-journey-steps" aria-label="完整任务链路">{journey.steps.map((step,index) => <li key={step.id} className={step.state.toLowerCase()}><a href={`#${step.target}`}>{step.state === "DONE" ? <CheckCircle2 size={15} /> : <Circle size={15} />}<span>{index+1}. {step.label}</span><strong>{({DONE:"证据通过",PENDING:"待完成",ATTENTION:"需要处理",STALE:"修改后待核验"})[step.state]}</strong></a><small>{step.detail}</small></li>)}</ol>
    <small>这是当前任务的证据导航，不是自主E2E评分；私有测试发布不等于公网或生产上线。</small>
    {error && <p className="agent-dev-alert error" role="alert">{error}</p>}
    {!workflow ? <p className="agent-dev-empty">正在读取版本、核验和交付记录…</p> : <>
      <div id="agent-verification" className="agent-verification-card"><div className="agent-workflow-title"><FileText size={16} /><h3>结果核验报告</h3><span className={verified ? "passed" : ""}>{verified ? "核验通过" : !current ? "当前修改待验证" : "需要处理"}</span></div>
        <p>{current ? report?.summary : "编辑器或正在查看的批次与报告版本不同，请先运行当前代码。原版本的报告仍保留。"}</p>
        <ul>{report?.checks.map(check => <li key={check.id}>{check.passed ? <CheckCircle2 size={14} /> : <Circle size={14} />}<span>{check.label}</span><strong>{check.passed ? "通过" : "待核验"}</strong></li>)}</ul>
        <small>{report?.rowCount}位客户 · {report?.engine} {report?.engineVersion} · {report?.notice}</small>
        <button className="button" onClick={() => download("verification-report.json", report)}><Download size={14} />下载核验报告</button>
      </div>
      <div id="agent-files" className="agent-delivery-card"><div className="agent-workflow-title"><Package size={16} /><h3>调度与部署交付</h3></div><p>把当前通过核验的代码、测试、调度依赖、交易日历和部署清单固定到同一版本，再用 Spark 按文件执行一次演练。</p>
        {!delivery && <button className="button primary" disabled={!canWrite || !verified || working} onClick={() => void prepare()}><Play size={14} />生成交付并演练</button>}
        {delivery && <><strong className="agent-delivery-stage">{auto && <LoaderCircle size={14} className="spin" />}{deliveryStageText(delivery.stage, journey.publicationCurrent, release?.status)}</strong>{delivery.error && <p role="alert">{delivery.error}</p>}<div className="agent-delivery-actions">{!complete(delivery.status) && <><button className="button primary" disabled={!canWrite || !verified || working} onClick={() => void drive(delivery)}>继续交付准备</button><button className="button" disabled={!canWrite || busy} onClick={() => void stop()}><Square size={13} />停止</button></>}{["FAILED","CANCELLED"].includes(delivery.status) && <button className="button" disabled={!canWrite || !verified || working} onClick={() => { requestKey.current=crypto.randomUUID(); void prepare(); }}>重新准备并演练</button>}{workflow.package && <button className="button" onClick={() => download("shuduo-delivery-package.json", workflow.package)}><Download size={14} />下载版本化交付包</button>}</div></>}
        {workflow.package && <><div className="agent-delivery-files" role="tablist" aria-label="交付文件">{Object.keys(workflow.package.files).map(name => <button key={name} role="tab" aria-selected={file === name} onClick={() => setFile(name)}>{name}</button>)}</div><pre className="agent-delivery-file">{workflow.package.files[file]}</pre><small>包摘要：{workflow.package.digest.slice(0,16)} · 修改代码后必须重新核验与生成交付。</small></>}
        {workflow.verification && <><p className={fileVerified ? "passed" : ""}>文件演练：{fileVerified ? "主SQL、测试SQL与五场景回归全部通过" : workflow.verification.status} · {workflow.verification.engine} {workflow.verification.engineVersion}</p><button className="button" onClick={() => download(`delivery-evidence-${workflow.package?.id.slice(0,8) ?? taskId.slice(0,8)}.json`, { schema: "shuduo-delivery-evidence/v1", report: workflow.report, delivery: workflow.delivery, package: workflow.package ? { id: workflow.package.id, digest: workflow.package.digest, manifest: workflow.package.manifest } : undefined, verification: workflow.verification, publication: workflow.publication, exportedAt: new Date().toISOString() })}><Download size={14} />下载演练证据</button></>}
      </div>
      <div id="agent-publication" className="agent-publication-card"><div className="agent-workflow-title"><ShieldCheck size={16} /><h3>审阅发布与运行监控</h3></div><p>{!workflow.publication.available && release ? "发布记录已保留；临时调度入口已关闭，不会继续启动批次。新发布需按预算和权限重新启用。" : workflow.publication.reason}</p>{release && !journey.publicationCurrent && <p role="status">这是保留的发布记录，尚未核对为当前编辑版本的上线证据。</p>}
        {workflow.publication.available && !release && <button className="button primary" disabled={!canWrite || !fileVerified || !verified || working} onClick={() => setReview(true)}>审阅并发布测试任务</button>}
        {!workflow.publication.available && !release && <span className="agent-publication-gate">交付演练通过后进入“待发布”；云端上线尚待完成。</span>}
        {review && <div className="agent-review-form">{[{id:"code",label:"已审阅当前SQL版本"},{id:"assertions",label:"已查看独立核验与文件演练"},{id:"deliveryFiles",label:"已审阅调度、部署和日历文件"},{id:cloud?"cloudScope":"localScope",label:cloud?"仅发布冻结样例的两个云端测试批次，由受控定时器触发":"仅发布本机测试任务：5秒后触发，共两批次"}].map(item => <label key={item.id}><input type="checkbox" checked={Boolean(confirmed[item.id])} onChange={e => setConfirmed(old => ({...old,[item.id]:e.target.checked}))} />{item.label}</label>)}<button className="button primary" disabled={working || Object.keys(confirmed).length !== 4 || !Object.values(confirmed).every(Boolean)} onClick={() => void publishLocal()}>确认并发布此版本</button></div>}
        {release && <><strong>发布版本 {release.id.slice(0,8)} · {releaseLabel(release)}</strong><p className="agent-publication-id">发布编号：{release.id}</p><ul>{batches.map(batch => <li key={batch.id}>第{batch.sequence}批 · {batchLabels[batch.status] ?? batch.status} · {batch.schedulerTriggered ? "调度器已触发" : batch.status === "CANCELLED" ? "未再触发" : "等待计划时间"}</li>)}</ul>{publication?.alerts.map(alert=><p key={alert.id} role={alert.status==="OPEN"?"alert":undefined}>{alert.status==="OPEN"?"未解除告警":"已恢复"}：{alert.message}{alert.recoveryRunId?` · 恢复批次 ${alert.recoveryRunId.slice(0,8)}`:""}</p>)}{cloud&&release.status!=="CANCELLED"&&batches.some(batch=>!complete(batch.status))&&<button className="button" disabled={working||!canWrite} onClick={async()=>{setBusy(true);try{const next=await api<Publication>(`/agent/tasks/${taskId}/publication/cancel`,{});setPublication(next);setRelease(next.release);setBatches(next.runs);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><Square size={14}/>停止后续云端批次</button>}{cloud&&<button className="button" onClick={()=>download(`publication-${release.id.slice(0,8)}.json`,publication)}><Download size={14}/>下载发布与监控记录</button>}</>}
      </div>
      <div id="agent-service-handoff" className="agent-publication-card"><div className="agent-workflow-title"><Package size={16}/><h3>发布结果 → DAPI / XAPI</h3></div><p>继续同一个任务的接口开发、测试与授权。选择实际发布批次后核对返回值和调用日志；打开模块不会自动创建凭证或调用接口。</p>
        {consumptionError&&<p role="status">{consumptionError}</p>}
        {journey.steps.find(step=>step.id==="services")?.state==="DONE"&&<p role="status">组合接口的消费证据已通过。DAPI的单独授权调用记录独立展示，不影响已通过的XAPI组合查询。</p>}
        {consumption&&<><p>{consumption.notice}</p><small>对照时间：{consumption.checkedAt}；这是历史消费记录，不是实时授权保证。</small>{!current&&<p>编辑器或当前查看的批次已变化；下面证据仅供原版本参考。</p>}<ul>{consumption.services.map(s=><li key={s.serviceId}><strong>{s.serviceType} · {s.name}</strong> · 版本 {s.versionId.slice(0,8)} · {s.status==="VERIFIED"?"历史消费证据对照通过":s.status==="NEEDS_ATTENTION"?"需要处理":"待实际授权调用"}<p>{s.notice}</p>{s.call&&<small>调用 {s.call.callId.slice(0,8)} · {s.call.rowCount}行 · 摘要 {s.call.resultHash.slice(0,12)} · {s.call.applicationStatus==="REVOKED"?"应用已撤销，历史记录保留":"对照时应用有效"}</small>}</li>)}</ul>{consumption.truncated&&<p>证据数量超过本次上限，不能标记整个消费阶段完成。</p>}<EvidenceDownload name={`consumption-${taskId.slice(0,8)}.json`} value={consumption} request={{kind:"consumption",id:taskId,digest:consumption.packageDigest}}>下载消费对照证据</EvidenceDownload></>}
        {cloud&&workflow.package&&<button className="button" disabled={working} onClick={()=>void readConsumption()}>刷新消费证据</button>}
        {onOpenServices ? <><button className="button" disabled={dirty || working || handoffBlocked} onClick={onOpenServices}>继续此任务的接口交付</button>{handoffBlocked && <small>修改需求尚未发送，请先处理输入再切换；不会丢弃你的文字。</small>}</> : <small>当前环境尚未开放服务接管；已有交付记录保留。</small>}</div>
    </>}
  </section>;
}
