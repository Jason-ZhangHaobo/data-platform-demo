import { createHash } from "node:crypto";
import { validateDeliveryPackage, resolveDeliverySchedule } from "./delivery.mjs";
import { deliveryArtifactValue } from "./artifact-store.mjs";
import { contextIds } from "./context.mjs";

export const cloudPublicationMode = "DURABLE_PRIVATE_RELEASE_V1";
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = item => { const { remoteSubmission, submittedBy, rows, log, stdout, stderr, ...result } = item; return result; };

// Bounded cloud test releases. The driver is external and must be authenticated;
// reads reconcile existing receipts but never submit a new Spark job.
export function createCloudPublication({ store, project, runner, artifactStore, persist, enabled = false,
  assertBudget = () => {}, now = Date.now, reservationSeconds = 30 }) {
  if (!Number.isFinite(reservationSeconds) || reservationSeconds < 1 || reservationSeconds > 300) throw new Error("发布计算预留无效");
  const get = (kind, id) => { const item = store.get(kind, id, project); if (!item) throw fail(404, "未找到当前项目发布记录"); return item; };
  const stamp = () => new Date(now()).toISOString();
  const patch = (kind, item, values) => store.update(kind, item.id, project, values, { expectedVersion: item.version });
  const ensure = async item => { await artifactStore.verify(item.artifact, "delivery-package", item.digest, deliveryArtifactValue(item)); return validateDeliveryPackage(item, item.digest); };
  const passes = (receipt, item, plan) => receipt?.status === "SUCCEEDED" && receipt.engine === "Apache Spark" && receipt.engineVersion === plan.deployment.runtime.version && receipt.mainSqlExecuted === true && receipt.testDouble !== true && receipt.testSqlValidation?.passed === true && receipt.testSqlValidation.sqlHash === hash(item.files["tests.sql"]) && receipt.validation?.passed === true && contextIds.every(id => receipt.validation.regressions?.some(c => c.contextId === id && c.passed));
  async function publish({ agent, packageDigest, verificationId, attestations, actorId, idempotencyKey }) {
    if (!enabled) throw fail(503, "云端发布驱动尚未配置");
    const required = ["code", "assertions", "deliveryFiles", "cloudScope"];
    if (!attestations || Object.keys(attestations).length !== required.length || !required.every(key => attestations[key] === true) || !actorId || !idempotencyKey)
      throw fail(422, "请逐项审阅代码、核验、交付文件和云端测试范围");
    const delivery = store.list("agent_delivery_task", project).find(t => t.sourceAgentTaskId === agent.id && t.verificationId === verificationId && t.status === "SUCCEEDED" && t.actualExecution === true);
    if (!delivery || agent.status !== "SUCCEEDED" || agent.executionMode !== "DURABLE_SQL_AGENT_V1" || agent.mode !== "LIVE_MODEL") throw fail(409, "源任务或文件演练尚未通过");
    const item = get("delivery_package", delivery.packageId), verification = get("delivery_verification", verificationId), plan = await ensure(item), last = agent.attempts?.at(-1);
    if (last?.status!=="SUCCEEDED" || !last?.model || /TEST_DOUBLE|unconfirmed/.test(last.model) || item.digest !== packageDigest || item.digest !== delivery.packageDigest || item.manifest.source.revisionId !== last?.revisionId || item.sourceRunId !== last?.runId || verification.packageId !== item.id || verification.packageDigest !== item.digest || !passes(verification, item, plan))
      throw fail(409, "审阅必须绑定当前代码、包摘要和真实演练");
    const existing = store.list("release", project).find(r => r.mode === cloudPublicationMode && r.sourceAgentTaskId === agent.id && r.packageDigest === item.digest && !["CANCELLED", "ROLLED_BACK"].includes(r.status));
    if (existing) return detail(agent.id);
    const index = plan.calendar.tradingDays.indexOf(plan.fixtures.context.businessDate), nextDay = plan.calendar.tradingDays[index + 1];
    if (!nextDay) throw fail(422, "日历缺少下一交易日");
    const businessScheduledFor = `${nextDay}T${plan.schedule.at}+08:00`, occurrence = resolveDeliverySchedule(plan, businessScheduledFor);
    if (!occurrence.eligible || occurrence.businessDate !== plan.fixtures.context.businessDate) throw fail(422, "调度文件与冻结数据日期不一致");
    const confirmed = Object.fromEntries(required.map(key => [key,true]));
    const signature = hash(JSON.stringify({ agentId: agent.id, packageDigest, verificationId, actorId, attestations: confirmed }));
    const created = store.deduplicate(`${project}:cloud-publication:${actorId}:${idempotencyKey}`, signature, () => {
      const review = store.create("delivery_review", project, { packageId: item.id, packageDigest, verificationId, status: "REVIEWED", scope: "PRIVATE_CLOUD_TEST", submittedBy: actorId, attestations: confirmed, reviewedAt: stamp() });
      const approval = store.create("release_approval", project, { packageId: item.id, packageDigest, rehearsalId: verificationId, reviewId: review.id, sourceRevisionId: plan.source.revisionId, sourceCodeHash: plan.source.sqlHash, status: "APPROVED", scope: "PRIVATE_CLOUD_TEST", submittedBy: actorId, approvedAt: stamp() });
      const release = store.create("release", project, { mode: cloudPublicationMode, sourceAgentTaskId: agent.id, submittedBy: actorId, reviewId: review.id, approvalId: approval.id, packageId: item.id, packageDigest, sourceRevisionId: plan.source.revisionId, sourceCodeHash: plan.source.sqlHash, businessScheduledFor, status: "WAITING_SCHEDULER", health: "PENDING", scope: "PRIVATE_CLOUD_TEST", runCount: 2, publicDeployed: false, fullLifecycleE2E: false });
      for (let sequence = 1; sequence <= 2; sequence++) store.create("release_run", project, { mode: cloudPublicationMode, releaseId: release.id, packageId: item.id, packageDigest, sequence, businessScheduledFor, status: "SCHEDULED", schedulerTriggered: false, scheduledTriggerAt: new Date(now() + (sequence - 1) * 60000).toISOString(), published: false, publicDeployed: false });
      return release;
    });
    await persist(); return detail(get("release", created.id).sourceAgentTaskId);
  }
  async function finish(run, receipt) {
    const current = get("release_run", run.id), release = get("release", run.releaseId);
    if (terminal.has(current.status) || release.status === "CANCELLED") return;
    const item = get("delivery_package", run.packageId), plan = await ensure(item), passed = passes(receipt, item, plan);
    const latest = get("release_run", run.id);
    if (terminal.has(latest.status) || get("release", run.releaseId).status === "CANCELLED") return;
    const values = Object.fromEntries(["engine", "engineVersion", "mainSqlExecuted", "testSqlValidation", "validation", "durationMs", "rows", "columns", "log"].filter(k => receipt[k] !== undefined).map(k => [k, receipt[k]]));
    const saved = patch("release_run", latest, { ...values, status: passed ? "SUCCEEDED" : "FAILED", stage: "COMPLETED", finishedAt: stamp(), ...(passed ? {} : { error: "云端发布批次执行或独立校验未通过" }) });
    store.create("monitor_event", project, { releaseId: release.id, releaseRunId: run.id, type: passed ? "BATCH_SUCCEEDED" : "BATCH_FAILED", status: saved.status, observedAt: stamp(), packageDigest: item.digest });
    if (!passed) store.create("monitor_alert", project, { releaseId: release.id, releaseRunId: run.id, status: "OPEN", severity: "ERROR", code: "CLOUD_RELEASE_BATCH_FAILED", message: saved.error, openedAt: stamp() });
    else for (const alert of store.list("monitor_alert", project)) if (alert.releaseId === release.id && alert.status === "OPEN" && Date.parse(alert.openedAt) <= now()) store.update("monitor_alert", alert.id, project, { status: "RESOLVED", resolvedAt: stamp(), recoveryRunId: run.id });
    const runs = store.list("release_run", project).filter(r => r.releaseId === release.id), successCount = runs.filter(r => r.status === "SUCCEEDED").length, openAlerts = store.list("monitor_alert", project).filter(a => a.releaseId === release.id && a.status === "OPEN").length;
    const allFinished=runs.every(r=>terminal.has(r.status));
    patch("release", get("release", release.id), { status: allFinished ? "COMPLETED_CLOUD_TEST" : "ACTIVE_CLOUD_TEST", health: openAlerts ? "CRITICAL" : successCount >= 2 ? "HEALTHY" : allFinished ? "RECOVERED_WITH_FAILURE" : "OBSERVING", successfulRunCount: successCount, openAlertCount: openAlerts, lastRunId: run.id, lastObservedAt: stamp() });
    await persist();
  }
  async function reconcile(run) {
    if (terminal.has(run.status) || !run.remoteSubmission) return;
    let receipt;
    try { receipt = await runner.read(run.remoteSubmission.prepared); }
    catch (error) { if (error.code !== "REMOTE_SPARK_TIMEOUT") throw error; receipt = { status: "FAILED" }; }
    if (receipt) await finish(run, receipt);
  }
  async function tick({ releaseId, requestId, triggerName, triggerTime }) {
    if (!enabled) throw fail(503, "云端发布驱动未启用");
    let release = get("release", releaseId);
    if (release.mode !== cloudPublicationMode || !["WAITING_SCHEDULER", "RUNNING_CLOUD_TEST", "ACTIVE_CLOUD_TEST", "COMPLETED_CLOUD_TEST"].includes(release.status)) throw fail(409, "发布版本已失效");
    if (typeof requestId !== "string" || !/^[a-f0-9]{64}$/.test(requestId) || typeof triggerName !== "string" || !triggerName || !Number.isFinite(Date.parse(triggerTime))) throw fail(422, "调度事件标识不合法");
    const old = store.list("cloud_release_tick", project).find(t => t.requestId === requestId);
    if (old && old.releaseId !== release.id) throw fail(409, "同一事件不能调用另一发布版本");
    if (old?.status === "COMPLETED") return { replayed: true, ...old.summary };
    const event = old ?? store.create("cloud_release_tick", project, { requestId, releaseId, triggerName, triggerTime, status: "RUNNING" });
    if (event.releaseId !== release.id) throw fail(409, "同一事件不能调用另一发布版本");
    await persist();
    for (const run of store.list("release_run", project).filter(r => r.releaseId === release.id && r.status === "RUNNING")) await reconcile(run);
    release = get("release", release.id);
    const due = store.list("release_run", project).filter(r => r.releaseId === release.id && !terminal.has(r.status) && Date.parse(r.scheduledTriggerAt) <= now()).sort((a,b) => a.sequence-b.sequence);
    // At most one new batch per timer event; pending batches retain their job ID.
    const run = due.find(r => r.status === "RUNNING" && !r.remoteSubmission?.submitted) ?? (due.some(r => r.status === "RUNNING") ? undefined : due.find(r => r.status === "SCHEDULED"));
    if (run) {
      const item = get("delivery_package", run.packageId), plan = await ensure(item);
      let current = get("release_run", run.id);
      // Verification and persistence can yield while an engineer cancels.
      // Re-read both records before claiming or submitting the frozen job.
      if (terminal.has(current.status) || get("release", release.id).status === "CANCELLED") return { releaseId: release.id, cancelled: true };
      if (!current.remoteSubmission) {
        assertBudget(); const prepared = runner.prepare({ sql: item.files["main.sql"], testSql: item.files["tests.sql"], context: plan.fixtures.context, validationContexts: plan.fixtures.validationContexts }, current.id);
        current = patch("release_run", current, { status: "RUNNING", stage: "SUBMITTING", isolation: "FUNCTION_PROCESS", reservedDurationMs: reservationSeconds*1000, schedulerTriggered: true, clockMode: "FC_TIMER", triggerName, triggeredAt: stamp(), remoteSubmission: { prepared, submitted: false }, published: true });
        patch("release",get("release",release.id),{status:"RUNNING_CLOUD_TEST",health:get("release",release.id).health==="CRITICAL"?"CRITICAL":"OBSERVING"});
        await persist();
      }
      if (terminal.has(get("release_run", current.id).status) || get("release", release.id).status === "CANCELLED") return { releaseId: release.id, cancelled: true };
      await runner.submit(current.remoteSubmission.prepared);
      current = get("release_run", current.id);
      if (!terminal.has(current.status) && get("release", release.id).status !== "CANCELLED") {
        patch("release_run", current, { stage: "WAITING_FOR_WORKER_RESULT", remoteSubmission: { ...current.remoteSubmission, submitted: true } }); await persist();
      }
    }
    const all = store.list("release_run", project).filter(r => r.releaseId === release.id), summary = { releaseId: release.id, succeeded: all.filter(r=>r.status==="SUCCEEDED").length, failed: all.filter(r=>r.status==="FAILED").length, pending: all.filter(r=>!terminal.has(r.status)).length };
    store.update("cloud_release_tick", event.id, project, { status: "COMPLETED", summary }); await persist(); return summary;
  }
  async function detail(agentId) {
    const release = store.list("release", project).find(r => r.mode === cloudPublicationMode && r.sourceAgentTaskId === agentId);
    if (!release) return { release: undefined, runs: [], alerts: [], events: [] };
    for (const run of store.list("release_run", project).filter(r => r.releaseId === release.id && r.status === "RUNNING")) await reconcile(run);
    return { release: clean(get("release", release.id)), runs: store.list("release_run", project).filter(r => r.releaseId === release.id).sort((a,b)=>a.sequence-b.sequence).map(clean), alerts: store.list("monitor_alert", project).filter(a=>a.releaseId===release.id), events:store.list("monitor_event",project).filter(e=>e.releaseId===release.id) };
  }
  async function cancel(agentId) {
    const release = store.list("release", project).find(r=>r.mode===cloudPublicationMode && r.sourceAgentTaskId===agentId);
    if (!release) throw fail(404,"未找到发布版本");
    if(release.status==="COMPLETED_CLOUD_TEST" || release.status==="CANCELLED")return detail(agentId);
    patch("release",release,{status:"CANCELLED",health:"STOPPED",cancelledAt:stamp()});
    const jobs=[]; for(const run of store.list("release_run",project).filter(r=>r.releaseId===release.id&&!terminal.has(r.status))) { patch("release_run",run,{status:"CANCELLED",finishedAt:stamp()}); if(run.remoteSubmission)jobs.push(run.remoteSubmission.prepared); }
    await persist(); for(const job of jobs)await runner.cancel(job);return detail(agentId);
  }
  return { publish, detail, tick, cancel };
}
