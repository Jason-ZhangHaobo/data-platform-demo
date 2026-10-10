import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Download, FileText, LoaderCircle, Package, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
type Delivery = { id: string; version: number; status: string; stage: string; mode?: string; packageId?: string; verificationId?: string; error?: string };
type Workflow = {
  report: { status: string; summary: string; definition?: string; checks: { id: string; label: string; passed: boolean }[]; revisionId?: string; runId?: string; rowCount: number; engine?: string; engineVersion?: string; notice: string };
  delivery?: Delivery;
  package?: { id: string; digest: string; manifest: unknown; files: Record<string,string> };
  verification?: { id: string; status: string; engine?: string; engineVersion?: string; durationMs?: number; error?: string; testSqlValidation?: { passed: boolean }; validation?: { passed: boolean } };
  publication: { available: boolean; scope: string; reason: string };
};
type Release = { id: string; status: string; health: string };
const complete = (status?: string) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status ?? "");
const labels: Record<string,string> = { PACKAGE_READY: "调度与部署文件已生成", FILE_REHEARSAL_SUBMITTING: "正在提交文件演练", FILE_REHEARSAL_RUNNING: "Spark 正在按交付文件演练", AWAITING_ENGINEER_REVIEW: "演练通过，待审阅交付", FILE_REHEARSAL_FAILED: "文件演练需要处理", CANCELLED: "交付准备已停止" };
function download(name: string, value: unknown) {
  const blob = new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function AgentDeliveryPanel({ api, taskId, revisionId, runId, dirty, canWrite, codeBusy }: { api: Api; taskId: string; revisionId?: string; runId?: string; dirty: boolean; canWrite: boolean; codeBusy: boolean }) {
  const [workflow, setWorkflow] = useState<Workflow>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [file, setFile] = useState("schedule.json"), [auto, setAuto] = useState(false);
  const [review, setReview] = useState(false), [confirmed, setConfirmed] = useState<Record<string,boolean>>({}), [release, setRelease] = useState<Release>(), [batches, setBatches] = useState<{ id: string; status: string; sequence: number; schedulerTriggered?: boolean }[]>([]);
  const epoch = useRef(0), alive = useRef(true), requestKey = useRef(crypto.randomUUID());
  const activeTask = useRef(taskId); activeTask.current = taskId;
  const load = async () => {
    const id = taskId, value = await api<Workflow>(`/agent/tasks/${id}/workflow`);
    if (alive.current && activeTask.current === id) setWorkflow(value); return value;
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { if (!codeBusy) load().catch(e => setError(e.message)); }, [taskId, revisionId, runId, codeBusy]);
  const report = workflow?.report, delivery = workflow?.delivery;
  const current = !dirty && report?.revisionId === revisionId && report?.runId === runId;
  const verified = report?.status === "PASSED" && current;
  const working = busy || auto || codeBusy;
  const fileVerified = workflow?.verification?.status === "SUCCEEDED" && delivery?.status === "SUCCEEDED";
  useEffect(() => { if (!workflow?.package?.digest || dirty || !current) { setReview(false); setConfirmed({}); } }, [workflow?.package?.digest, dirty, current]);
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
      const reviewed = await api<{ id: string }>(`/delivery/packages/${bundle.id}/review`, { packageDigest: bundle.digest, verificationId: delivery.verificationId, reviewNote: "工程师已在Agent工作台审阅代码、核验、交付文件和测试发布范围。", attestations: confirmed });
      const approved = await api<{ id: string }>(`/delivery/packages/${bundle.id}/approve`, { packageDigest: bundle.digest, reviewId: reviewed.id });
      const published = await api<Release>("/releases", { approvalId: approved.id, triggerAfterSeconds: 5, intervalSeconds: 30, runCount: 2 }, { idempotencyKey: `agent-workbench-release-${bundle.id}` });
      setRelease(published); setReview(false);
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!release?.id) return; let active = true;
    const read = async () => { const [next, runs] = await Promise.all([api<Release>(`/releases/${release.id}`), api<{ id: string; status: string; sequence: number; releaseId: string; schedulerTriggered?: boolean }[]>("/release/runs")]); if (active) { setRelease(next); setBatches(runs.filter(r => r.releaseId === release.id)); } };
    read().catch(e => setError(e.message)); const timer = setInterval(() => read().catch(e => setError(e.message)), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [release?.id]);
  const milestones = [{ name: "编写代码", done: Boolean(revisionId) }, { name: "核验结果", done: verified }, { name: "交付文件", done: Boolean(workflow?.package) && current }, { name: "文件演练", done: fileVerified && current }, { name: "审阅发布", done: Boolean(release) && current }, { name: "运行监控", done: release?.health === "HEALTHY" && current }];
  return <section id="agent-delivery" className="agent-delivery-panel" aria-label="核验与发布交付">
    <header><div><ShieldCheck size={17} /><strong>从开发到交付</strong></div><button className="icon-button" aria-label="刷新核验与交付" disabled={working} onClick={() => load().catch(e => setError(e.message))}><RefreshCw size={14} /></button></header>
    <ol className="agent-workflow-steps">{milestones.map((step,index) => <li key={step.name} className={step.done ? "done" : ""}>{step.done ? <CheckCircle2 size={15} /> : <Circle size={15} />}<span>{index+1}. {step.name}</span></li>)}</ol>
    {error && <p className="agent-dev-alert error" role="alert">{error}</p>}
    {!workflow ? <p className="agent-dev-empty">正在读取版本、核验和交付记录…</p> : <>
      <div className="agent-verification-card"><div className="agent-workflow-title"><FileText size={16} /><h3>结果核验报告</h3><span className={verified ? "passed" : ""}>{verified ? "核验通过" : !current ? "当前修改待验证" : "需要处理"}</span></div>
        <p>{current ? report?.summary : "编辑器或正在查看的批次与报告版本不同，请先运行当前代码。原版本的报告仍保留。"}</p>
        <ul>{report?.checks.map(check => <li key={check.id}>{check.passed ? <CheckCircle2 size={14} /> : <Circle size={14} />}<span>{check.label}</span><strong>{check.passed ? "通过" : "待核验"}</strong></li>)}</ul>
        <small>{report?.rowCount}位客户 · {report?.engine} {report?.engineVersion} · {report?.notice}</small>
        <button className="button" onClick={() => download("verification-report.json", report)}><Download size={14} />下载核验报告</button>
      </div>
      <div className="agent-delivery-card"><div className="agent-workflow-title"><Package size={16} /><h3>调度与部署交付</h3></div><p>把当前通过核验的代码、测试、调度依赖、交易日历和部署清单固定到同一版本，再用 Spark 按文件执行一次演练。</p>
        {!delivery && <button className="button primary" disabled={!canWrite || !verified || working} onClick={() => void prepare()}><Play size={14} />生成交付并演练</button>}
        {delivery && <><strong className="agent-delivery-stage">{auto && <LoaderCircle size={14} className="spin" />}{labels[delivery.stage] ?? delivery.stage}</strong>{delivery.error && <p role="alert">{delivery.error}</p>}<div className="agent-delivery-actions">{!complete(delivery.status) && <><button className="button primary" disabled={!canWrite || !verified || working} onClick={() => void drive(delivery)}>继续交付准备</button><button className="button" disabled={!canWrite || busy} onClick={() => void stop()}><Square size={13} />停止</button></>}{["FAILED","CANCELLED"].includes(delivery.status) && <button className="button" disabled={!canWrite || !verified || working} onClick={() => { requestKey.current=crypto.randomUUID(); void prepare(); }}>重新准备并演练</button>}{workflow.package && <button className="button" onClick={() => download("shuduo-delivery-package.json", workflow.package)}><Download size={14} />下载版本化交付包</button>}</div></>}
        {workflow.package && <><div className="agent-delivery-files" role="tablist" aria-label="交付文件">{Object.keys(workflow.package.files).map(name => <button key={name} role="tab" aria-selected={file === name} onClick={() => setFile(name)}>{name}</button>)}</div><pre className="agent-delivery-file">{workflow.package.files[file]}</pre><small>包摘要：{workflow.package.digest.slice(0,16)} · 修改代码后必须重新核验与生成交付。</small></>}
        {workflow.verification && <p className={fileVerified ? "passed" : ""}>文件演练：{fileVerified ? "主SQL、测试SQL与五场景回归全部通过" : workflow.verification.status} · {workflow.verification.engine} {workflow.verification.engineVersion}</p>}
      </div>
      <div className="agent-publication-card"><div className="agent-workflow-title"><ShieldCheck size={16} /><h3>审阅发布与运行监控</h3></div><p>{workflow.publication.reason}</p>
        {workflow.publication.available && !release && <button className="button primary" disabled={!canWrite || !fileVerified || !verified || working} onClick={() => setReview(true)}>审阅并发布测试任务</button>}
        {!workflow.publication.available && <span className="agent-publication-gate">交付演练通过后进入“待发布”；云端上线尚待完成。</span>}
        {review && <div className="agent-review-form">{[{id:"code",label:"已审阅当前SQL版本"},{id:"assertions",label:"已查看独立核验与文件演练"},{id:"deliveryFiles",label:"已审阅调度、部署和日历文件"},{id:"localScope",label:"仅发布本机测试任务：5秒后触发，共两批次"}].map(item => <label key={item.id}><input type="checkbox" checked={Boolean(confirmed[item.id])} onChange={e => setConfirmed(old => ({...old,[item.id]:e.target.checked}))} />{item.label}</label>)}<button className="button primary" disabled={working || Object.keys(confirmed).length !== 4 || !Object.values(confirmed).every(Boolean)} onClick={() => void publishLocal()}>确认并发布此版本</button></div>}
        {release && <><strong>发布版本 {release.id.slice(0,8)} · {release.health === "HEALTHY" ? "运行健康" : "观察运行中"}</strong><ul>{batches.map(batch => <li key={batch.id}>第{batch.sequence}批 · {batch.status} · {batch.schedulerTriggered ? "调度器已触发" : "等待计划时间"}</li>)}</ul></>}
      </div>
    </>}
  </section>;
}
