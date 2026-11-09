import { createHash } from "node:crypto";
import { validateDeliveryPackage, resolveDeliverySchedule, validationMatchesFamily } from "./delivery.mjs";
import { deliveryArtifactValue } from "./artifact-store.mjs";
import { validationWithoutRawComparisons } from "./validation-details.mjs";
import { manualCloudDeliverySource, durableDeliveryMode } from "./agent-development-workflow.mjs";
import {sameAssistedDevelopmentReference} from './assisted-development-reference.mjs';
import {standaloneManualPublicationSource} from './standalone-manual-publication-source.mjs';
import {assertSqlRequirementPackageSource} from './sql-requirements.mjs';

export const cloudPublicationMode = "DURABLE_PRIVATE_RELEASE_V1";
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const selectorKeys = ["sourceKind", "sourceRunId", "packageDigest", "verificationId", "releaseId"];
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
// The caller injects the authenticated actor separately; no request may select
// its own identity. This validates shape only, never approval or ownership.
export function validatePublicationSelector(input = {}, actorId) {
  const invalid = () => Object.assign(fail(422, "发布来源选择不完整或包含不支持字段"), { code: "PUBLICATION_SELECTOR_INVALID" });
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !selectorKeys.includes(key))) throw invalid();
  const sourceKind = Object.hasOwn(input, "sourceKind") ? input.sourceKind : "AGENT";
  if (!["AGENT", "MANUAL"].includes(sourceKind)) throw invalid();
  for (const key of ["sourceRunId", "verificationId", "releaseId"]) if (Object.hasOwn(input, key) && !identifier(input[key])) throw invalid();
  if (Object.hasOwn(input, "packageDigest") && (typeof input.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.packageDigest))) throw invalid();
  if (actorId !== undefined && !identifier(actorId)) throw invalid();
  if (sourceKind === "MANUAL" && (!identifier(input.sourceRunId) || !input.packageDigest || !identifier(input.verificationId) || !identifier(actorId))) throw invalid();
  return { ...input, sourceKind, ...(actorId === undefined ? {} : { actorId }) };
}
const internalSelector = (selector = {}) => {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return validatePublicationSelector(selector);
  const { actorId, ...input } = selector;
  return validatePublicationSelector(input, actorId);
};
const clean = item => {
  const { remoteSubmission, submittedBy, rows, log, stdout, stderr, ...result } = item;
  return Object.hasOwn(result, "validation") ? { ...result, validation: validationWithoutRawComparisons(result.validation) } : result;
};

// Bounded cloud test releases. The driver is external and must be authenticated;
// reads reconcile existing receipts but never submit a new Spark job.
export function createCloudPublication({ store, project, runner, artifactStore, persist, enabled = false,
  assertBudget = () => {}, assertPublicationScope = () => {}, assertExecutionScope = () => {},
  singleRelease = false, now = Date.now, reservationSeconds = 30, standaloneManual = false }) {
  if (!Number.isFinite(reservationSeconds) || reservationSeconds < 1 || reservationSeconds > 300) throw new Error("发布计算预留无效");
  const get = (kind, id) => { const item = store.get(kind, id, project); if (!item) throw fail(404, "未找到当前项目发布记录"); return item; };
  const sourceField=standaloneManual?'manualDeliveryTaskId':'sourceAgentTaskId',identity=id=>({[standaloneManual?'manualDeliveryTaskId':'agentId']:id});
  const stamp = () => new Date(now()).toISOString();
  const patch = (kind, item, values) => store.update(kind, item.id, project, values, { expectedVersion: item.version });
  const ensure = async item => { await artifactStore.verify(item.artifact, "delivery-package", item.digest, deliveryArtifactValue(item)); return validateDeliveryPackage(item, item.digest); };
  const assertRequirementSource=item=>{
    const s=item.manifest.source,run=store.get('run',s.runId,project),revision=store.get('revision',s.revisionId,project),
      agent=revision?.source==='LIVE_MODEL'&&run?.agentTaskId?store.get('agent',run.agentTaskId,project):undefined;
    assertSqlRequirementPackageSource(item,{agent,run,revision});
  };
  const passes = (receipt, item, plan) => receipt?.status === "SUCCEEDED" && receipt.engine === "Apache Spark" && receipt.engineVersion === plan.deployment.runtime.version && receipt.mainSqlExecuted === true && receipt.testDouble !== true && receipt.testSqlValidation?.passed === true && receipt.testSqlValidation.sqlHash === hash(item.files["tests.sql"]) &&
    validationMatchesFamily(receipt.validation, { id: plan.source.validationContractId, contextIds: plan.fixtures.validationContexts.map(context => context.id) });
  const kindOf = release => release.sourceKind ?? "AGENT";
  const runOf = release => release.sourceRunId ?? (kindOf(release) === "AGENT" ? store.get("delivery_package", release.packageId, project)?.manifest?.source?.runId : undefined);
  const matches = (release, agentId, selector) => release.mode === cloudPublicationMode && release[sourceField] === agentId && (!standaloneManual||release.sourceAgentTaskId===undefined) && kindOf(release) === selector.sourceKind &&
    (!selector.sourceRunId || runOf(release) === selector.sourceRunId) && (!selector.packageDigest || release.packageDigest === selector.packageDigest) &&
    (!selector.verificationId || release.verificationId === selector.verificationId) && (!selector.releaseId || release.id === selector.releaseId);
  const authorizeManualRead = (agentId, selector, release) => {
    if (selector.sourceKind !== "MANUAL") return;
    const owner = store.get(standaloneManual?"manual_delivery_task":"agent", agentId, project)?.submittedBy;
    if (!owner || owner !== selector.actorId || release && release.submittedBy !== selector.actorId)
      throw fail(403, "人工发布记录仅属于原任务工程师和发布者");
  };
  const select = (agentId, selector) => {
    authorizeManualRead(agentId, selector);
    const records = store.list("release", project).filter(release => matches(release, agentId, selector));
    if (records.length > 1) throw Object.assign(fail(409, "存在多个发布版本，请指定确切发布记录"), { code: "PUBLICATION_SELECTOR_AMBIGUOUS" });
    authorizeManualRead(agentId, selector, records[0]);
    return records[0];
  };
  function reviewedSource({ agentId, manualDeliveryTaskId, sourceKind, sourceRunId, packageDigest, verificationId, actorId }) {
    if(standaloneManual){if(sourceKind!=='MANUAL'||agentId!==undefined)throw fail(422,'独立手工发布不接受Agent来源');return standaloneManualPublicationSource({store,project,manualDeliveryTaskId,sourceRunId,packageDigest,verificationId,actorId});}
    const agent = get("agent", agentId);
    const candidates = store.list("agent_delivery_task", project).filter(t => t.sourceAgentTaskId === agentId && t.verificationId === verificationId &&
      (t.sourceKind ?? "AGENT") === sourceKind && t.status === "SUCCEEDED" && t.actualExecution === true);
    if (candidates.length !== 1 || agent.executionMode !== "DURABLE_SQL_AGENT_V1") throw fail(409, "源任务或文件演练尚未通过；人工版本需要独立的发布审阅");
    const delivery = candidates[0], item = get("delivery_package", delivery.packageId), verification = get("delivery_verification", verificationId), plan = validateDeliveryPackage(item, item.digest);
    assertRequirementSource(item);
    if (item.digest !== packageDigest || item.digest !== delivery.packageDigest || verification.packageId !== item.id || verification.packageDigest !== item.digest || !passes(verification, item, plan))
      throw fail(409, "审阅必须绑定当前代码、包摘要和真实演练");
    if (sourceKind === "MANUAL") {
      const source = manualCloudDeliverySource({store, project, runId: sourceRunId, actorId});
      const { run, revision } = source, attribution = plan.source.attribution;
      if (source.agent.id !== agentId || delivery.mode !== durableDeliveryMode || delivery.submittedBy !== actorId ||
          delivery.sourceRunId !== run.id || delivery.sourceRevisionId !== revision.id || delivery.sourceSqlHash !== revision.hash || delivery.agentIndependentE2E !== false ||
          item.sourceKind !== "MANUAL" || item.agentIndependentE2E !== false || item.agentDeliveryTaskId !== delivery.id || item.sourceRunId !== run.id ||
          plan.source.runId !== run.id || plan.source.revisionId !== revision.id || plan.source.sqlHash !== revision.hash || plan.source.contextId !== revision.contextId ||
          run.validationContractId !== plan.source.validationContractId || run.validation?.contractId !== plan.source.validationContractId ||
          attribution?.kind !== "ENGINEER_ASSISTED" || attribution.originAgentTaskId !== agentId || attribution.actorId !== actorId || attribution.agentIndependentE2E !== false ||
          !sameAssistedDevelopmentReference(attribution.developmentReference,source.developmentReference)||!sameAssistedDevelopmentReference(delivery.developmentReference,source.developmentReference)||
          verification.agentDeliveryTaskId !== delivery.id || verification.actualExecution !== true || verification.isolation !== "FUNCTION_PROCESS" || verification.mode !== "CLOUD_ISOLATED_FILE_REHEARSAL")
        throw fail(409, "人工版本、来源工程师、交付包和文件演练不一致");
      return { agent, delivery, item, verification, plan, run, revision, sourceRunId: run.id };
    }
    const last = agent.attempts?.at(-1);
    if (agent.status !== "SUCCEEDED" || agent.mode !== "LIVE_MODEL" || last?.status !== "SUCCEEDED" || !last.model || /TEST_DOUBLE|unconfirmed/.test(last.model) ||
        item.sourceKind === "MANUAL" || plan.source.attribution !== undefined ||
        item.manifest.source.revisionId !== last.revisionId || item.sourceRunId !== last.runId || sourceRunId && sourceRunId !== last.runId)
      throw fail(409, "源任务或文件演练尚未通过；审阅必须绑定当前模型版本");
    return { agent, delivery, item, verification, plan, sourceRunId: last.runId };
  }
  // Navigation is a read-only projection of the exact configured review target,
  // never an approval. Resolve the stored kind before applying the same source
  // checks as publication; do not fall back to the failed Agent's last attempt.
  function sourceForNavigation({ agentId, packageDigest, verificationId, actorId }) {
    const target = { taskId: agentId, packageDigest, verificationId };
    if(standaloneManual)return {manualDeliveryTaskId:agentId,packageDigest,verificationId,status:'UNAVAILABLE'};
    try {
      const candidates = store.list("agent_delivery_task", project).filter(t =>
        t.sourceAgentTaskId === agentId && t.packageDigest === packageDigest && t.verificationId === verificationId);
      if (candidates.length !== 1) return { ...target, status: "UNAVAILABLE" };
      const delivery = candidates[0], sourceKind = delivery.sourceKind ?? "AGENT";
      if (!["AGENT", "MANUAL"].includes(sourceKind)) return { ...target, status: "UNAVAILABLE" };
      const source = reviewedSource({ agentId, sourceKind, sourceRunId: delivery.sourceRunId, packageDigest, verificationId, actorId });
      return { ...target, status: "RESOLVED", sourceKind, revisionId: source.plan.source.revisionId, runId: source.sourceRunId };
    } catch {
      return { ...target, status: "UNAVAILABLE" };
    }
  }
  async function publish({ agent, manualDelivery, sourceKind = "AGENT", sourceRunId, packageDigest, verificationId, attestations, actorId, idempotencyKey }) {
    if (!enabled) throw fail(503, "云端发布驱动尚未配置");
    const subject=standaloneManual?manualDelivery:agent;if(!subject||typeof subject.id!=='string'||standaloneManual&&agent!==undefined)throw fail(422,'发布缺少指定来源任务');
    const publicationScope = { ...identity(subject.id), packageDigest, verificationId };
    assertPublicationScope(publicationScope);
    const required = ["code", "assertions", "deliveryFiles", "cloudScope"];
    if (!attestations || Object.keys(attestations).length !== required.length || !required.every(key => attestations[key] === true) || !actorId ||
        typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 100)
      throw fail(422, "请逐项审阅代码、核验、交付文件和云端测试范围");
    const requested = validatePublicationSelector({ sourceKind, ...(sourceRunId === undefined ? {} : { sourceRunId }), packageDigest, verificationId }, actorId);
    const input = { ...identity(subject.id), ...requested }, initial = reviewedSource(input);
    await ensure(initial.item);
    // The immutable artifact check yields. Reload every source record and reject
    // changes before approving; an earlier in-memory success is not authority.
    const fresh = reviewedSource(input);
    if (hash(JSON.stringify(initial)) !== hash(JSON.stringify(fresh))) throw fail(409, "发布来源在审阅期间变化，请重新核对确切版本");
    const { item, plan } = fresh, selector = { ...requested, sourceRunId: fresh.sourceRunId };
    assertPublicationScope(publicationScope);
    const confirmed = Object.fromEntries(required.map(key => [key,true]));
    const signature = hash(JSON.stringify({ ...identity(subject.id), packageDigest, verificationId, actorId, attestations: confirmed,
      ...(sourceKind === "MANUAL" ? { sourceKind, sourceRunId } : {}) }));
    const key = `${project}:${standaloneManual?"manual-publication":"cloud-publication"}:${actorId}:${idempotencyKey}`;
    const prior = store.deduplicatedId(key);
    if (prior) {
      store.deduplicate(key, signature, () => { throw fail(409, "原发布幂等记录缺失"); });
      const previous = get("release", prior);
      if (!matches(previous, subject.id, selector)) throw fail(409, "原发布请求绑定了不同来源或演练");
      authorizeManualRead(subject.id, selector, previous);
      await persist(); return detail(subject.id, { ...selector, releaseId: previous.id });
    }
    const samePackage = store.list("release", project).filter(r => r.mode === cloudPublicationMode && r[sourceField] === subject.id && r.packageDigest === item.digest);
    const existing = samePackage.filter(r => matches(r, subject.id, selector) && (singleRelease || !["CANCELLED", "ROLLED_BACK"].includes(r.status)));
    if (existing.length > 1 || singleRelease && samePackage.some(r => !matches(r, subject.id, selector)))
      throw fail(409, "此交付包已有另一演练或发布记录，不能借用旧批准");
    if (existing.length === 1) {
      authorizeManualRead(subject.id, selector, existing[0]);
      const saved = store.deduplicate(key, signature, () => existing[0]);
      await persist(); return detail(subject.id, { ...selector, releaseId: saved.id });
    }
    const index = plan.calendar.tradingDays.indexOf(plan.fixtures.context.businessDate), nextDay = plan.calendar.tradingDays[index + 1];
    if (!nextDay) throw fail(422, "日历缺少下一交易日");
    const businessScheduledFor = `${nextDay}T${plan.schedule.at}+08:00`, occurrence = resolveDeliverySchedule(plan, businessScheduledFor);
    if (!occurrence.eligible || occurrence.businessDate !== plan.fixtures.context.businessDate) throw fail(422, "调度文件与冻结数据日期不一致");
    // Artifact verification yields; an approval window may close before records
    // are created. Re-check without changing the reviewed package or its scope.
    assertPublicationScope(publicationScope);
    const attribution = { sourceKind, sourceRunId: fresh.sourceRunId, ...(sourceKind === "MANUAL" ? { sourceAttribution: standaloneManual?'ENGINEER_AUTHORED':"ENGINEER_ASSISTED", agentIndependentE2E: false } : {}),
      ...(standaloneManual?{source:{kind:'MANUAL_RUN',runId:fresh.run.id,revisionId:fresh.revision.id,revisionHash:fresh.revision.hash,manualDeliveryTaskId:subject.id},manualDeliveryTaskId:subject.id}:{}) };
    const created = store.deduplicate(key, signature, () => {
      const review = store.create("delivery_review", project, { ...attribution, packageId: item.id, packageDigest, verificationId, status: "REVIEWED", scope: "PRIVATE_CLOUD_TEST", submittedBy: actorId, attestations: confirmed, reviewedAt: stamp() });
      const approval = store.create("release_approval", project, { ...attribution, packageId: item.id, packageDigest, rehearsalId: verificationId, reviewId: review.id, sourceRevisionId: plan.source.revisionId, sourceCodeHash: plan.source.sqlHash, status: "APPROVED", scope: "PRIVATE_CLOUD_TEST", submittedBy: actorId, approvedAt: stamp() });
      const release = store.create("release", project, { ...attribution, mode: cloudPublicationMode, [sourceField]: subject.id, submittedBy: actorId, reviewId: review.id, approvalId: approval.id, packageId: item.id, packageDigest, verificationId, sourceRevisionId: plan.source.revisionId, sourceCodeHash: plan.source.sqlHash, businessScheduledFor, status: "WAITING_SCHEDULER", health: "PENDING", scope: "PRIVATE_CLOUD_TEST", runCount: 2, publicDeployed: false, fullLifecycleE2E: false });
      for (let sequence = 1; sequence <= 2; sequence++) store.create("release_run", project, { ...attribution, mode: cloudPublicationMode, [sourceField]: subject.id, submittedBy: actorId, releaseId: release.id, packageId: item.id, packageDigest, sequence, businessScheduledFor, status: "SCHEDULED", schedulerTriggered: false, scheduledTriggerAt: new Date(now() + (sequence - 1) * 60000).toISOString(), published: false, publicDeployed: false });
      return release;
    });
    await persist(); return detail(subject.id, { ...selector, releaseId: created.id });
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
    if (release.mode !== cloudPublicationMode || (standaloneManual?typeof release.manualDeliveryTaskId!=="string"||release.sourceAgentTaskId!==undefined:release.manualDeliveryTaskId!==undefined) || !["WAITING_SCHEDULER", "RUNNING_CLOUD_TEST", "ACTIVE_CLOUD_TEST", "COMPLETED_CLOUD_TEST"].includes(release.status)) throw fail(409, "发布版本已失效");
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
        assertRequirementSource(item);
        assertExecutionScope(get("release", release.id));
        assertBudget(); const prepared = runner.prepare({ sql: item.files["main.sql"], testSql: item.files["tests.sql"], context: plan.fixtures.context, validationContexts: plan.fixtures.validationContexts }, current.id);
        current = patch("release_run", current, { status: "RUNNING", stage: "SUBMITTING", isolation: "FUNCTION_PROCESS", reservedDurationMs: reservationSeconds*1000, schedulerTriggered: true, clockMode: "FC_TIMER", triggerName, triggeredAt: stamp(), remoteSubmission: { prepared, submitted: false }, published: true });
        patch("release",get("release",release.id),{status:"RUNNING_CLOUD_TEST",health:get("release",release.id).health==="CRITICAL"?"CRITICAL":"OBSERVING"});
        await persist();
      }
      if (terminal.has(get("release_run", current.id).status) || get("release", release.id).status === "CANCELLED") return { releaseId: release.id, cancelled: true };
      // Persisting the claim can cross the approved deadline. Unknown-submit
      // retries must pass the same fresh scope check before touching the queue.
      assertExecutionScope(get("release", release.id));
      assertRequirementSource(item);
      await runner.submit(current.remoteSubmission.prepared);
      current = get("release_run", current.id);
      if (!terminal.has(current.status) && get("release", release.id).status !== "CANCELLED") {
        patch("release_run", current, { stage: "WAITING_FOR_WORKER_RESULT", remoteSubmission: { ...current.remoteSubmission, submitted: true } }); await persist();
      }
    }
    const all = store.list("release_run", project).filter(r => r.releaseId === release.id), summary = { releaseId: release.id, succeeded: all.filter(r=>r.status==="SUCCEEDED").length, failed: all.filter(r=>r.status==="FAILED").length, pending: all.filter(r=>!terminal.has(r.status)).length };
    store.update("cloud_release_tick", event.id, project, { status: "COMPLETED", summary }); await persist(); return summary;
  }
  async function detail(agentId, input = {}) {
    const selector = internalSelector(input), release = select(agentId, selector);
    if (!release) return { release: undefined, runs: [], alerts: [], events: [] };
    for (const run of store.list("release_run", project).filter(r => r.releaseId === release.id && r.status === "RUNNING")) await reconcile(run);
    const latest = select(agentId, { ...selector, releaseId: release.id });
    if (!latest) throw fail(409, "发布来源在读取期间变化，请重新读取原记录");
    return { release: clean(latest), runs: store.list("release_run", project).filter(r => r.releaseId === release.id).sort((a,b)=>a.sequence-b.sequence).map(clean), alerts: store.list("monitor_alert", project).filter(a=>a.releaseId===release.id), events:store.list("monitor_event",project).filter(e=>e.releaseId===release.id) };
  }
  async function cancel(agentId, input = {}) {
    const selector = internalSelector(input), release = select(agentId, selector);
    if (!release) throw fail(404,"未找到发布版本");
    // Stop uses only persisted identity/source and the live approval boundary.
    // A broken receipt read must not prevent stopping a selected running job.
    assertPublicationScope({ ...identity(agentId), packageDigest: release.packageDigest, verificationId: release.verificationId });
    if(release.status==="COMPLETED_CLOUD_TEST" || release.status==="CANCELLED")return detail(agentId, { ...selector, releaseId: release.id });
    patch("release",release,{status:"CANCELLED",health:"STOPPED",cancelledAt:stamp()});
    const jobs=[]; for(const run of store.list("release_run",project).filter(r=>r.releaseId===release.id&&!terminal.has(r.status))) { patch("release_run",run,{status:"CANCELLED",finishedAt:stamp()}); if(run.remoteSubmission)jobs.push(run.remoteSubmission.prepared); }
    await persist(); for(const job of jobs)await runner.cancel(job);return detail(agentId, { ...selector, releaseId: release.id });
  }
  return { publish, detail, tick, cancel, sourceForNavigation };
}

export function createStandaloneManualPublication(options){
  const engine=createCloudPublication({...options,standaloneManual:true});
  return {publish:({manualDeliveryTaskId,...input})=>engine.publish({...input,manualDelivery:options.store.get('manual_delivery_task',manualDeliveryTaskId,options.project)}),detail:engine.detail,tick:engine.tick,cancel:engine.cancel};
}
