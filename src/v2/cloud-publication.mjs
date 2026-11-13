import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateDeliveryPackage, resolveDeliverySchedule } from "./delivery.mjs";
import { deliveryArtifactValue } from "./artifact-store.mjs";
import { validationWithoutRawComparisons } from "./validation-details.mjs";
import { manualCloudDeliverySource, durableDeliveryMode, storedFundFileRehearsal } from "./agent-development-workflow.mjs";
import {sameAssistedDevelopmentReference} from './assisted-development-reference.mjs';
import {standaloneManualPublicationSource} from './standalone-manual-publication-source.mjs';
import {assertSqlRequirementPackageSource} from './sql-requirements.mjs';
import {assertSqlClarificationTask} from './sql-clarification.mjs';
import {storedAgentReviewEvidence} from './agent-review-evidence.mjs';
import {exactPublicationReceipt,exactPublicationReviewBasis,passedCloudReleaseBatch,projectCloudReleaseBatchStage} from "./cloud-release-evidence.mjs";
import {publicationAttestationKeys} from './publication-request.mjs';
import {fundDevelopmentBinding} from "./fund-delivery.mjs";
import {verifiedWorkerResultDigest} from "./worker-result-evidence.mjs";

export const cloudPublicationMode = "DURABLE_PRIVATE_RELEASE_V1";
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const savedUnconfirmed = () => Object.assign(fail(409, "已保存的发布与运维证据无法核验，请核对原交付与演练"), {
  code: "PUBLICATION_HISTORY_UNCONFIRMED",
});
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
    if(agent?.clarification)assertSqlClarificationTask(agent,{store,project});
    assertSqlRequirementPackageSource(item,{agent,run,revision});
  };
  const exactReceipt = release => exactPublicationReceipt(store,project,release,now());
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
  function reviewedSource({ agentId, manualDeliveryTaskId, sourceKind, sourceRunId, packageDigest, verificationId, actorId }, { historical = false } = {}) {
    if(standaloneManual){if(sourceKind!=='MANUAL'||agentId!==undefined)throw fail(422,'独立手工发布不接受Agent来源');return standaloneManualPublicationSource({store,project,manualDeliveryTaskId,sourceRunId,packageDigest,verificationId,actorId});}
    const agent = get("agent", agentId);
    const candidates = store.list("agent_delivery_task", project).filter(t => t.sourceAgentTaskId === agentId && t.verificationId === verificationId &&
      (t.sourceKind ?? "AGENT") === sourceKind && t.status === "SUCCEEDED" && t.actualExecution === true);
    if (candidates.length !== 1 || agent.executionMode !== "DURABLE_SQL_AGENT_V1") throw fail(409, "源任务或文件演练尚未通过；人工版本需要独立的发布审阅");
    const delivery = candidates[0], item = get("delivery_package", delivery.packageId), verification = get("delivery_verification", verificationId), plan = validateDeliveryPackage(item, item.digest);
    assertRequirementSource(item);
    if (item.digest !== packageDigest || item.digest !== delivery.packageDigest || verification.packageId !== item.id ||
        verification.packageDigest !== item.digest || !passedCloudReleaseBatch(verification,item,plan) ||
        (plan.source.derivation!==undefined && !isDeepStrictEqual(plan.source.derivation,agent.derivedFrom)))
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
    if (plan.source.fundDevelopment) {
      if (agent.mode !== "LIVE_MODEL" || item.sourceKind === "MANUAL" || actorId !== agent.submittedBy ||
          delivery.submittedBy !== actorId || delivery.sourceRunId !== plan.source.runId ||
          delivery.sourceRevisionId !== plan.source.revisionId || delivery.sourceSqlHash !== plan.source.sqlHash ||
          item.sourceRunId !== plan.source.runId || item.agentDeliveryTaskId !== delivery.id ||
          sourceRunId !== plan.source.runId || !storedFundFileRehearsal(store,project,delivery,verification,item,plan))
        throw fail(409,"基金发布须关联原工程师、确切开发和签名演练");
      const { attribution,evidence } = fundDevelopmentBinding({agent,
        run:get("run",plan.source.runId),revision:get("revision",plan.source.revisionId)});
      if (!isDeepStrictEqual(attribution,plan.source.attribution) || !isDeepStrictEqual(evidence,plan.source.fundDevelopment))
        throw fail(409,"基金原开发来源已变化");
      return {agent,delivery,item,verification,plan,sourceRunId:plan.source.runId};
    }
    const last = historical
      ? agent.attempts?.find(attempt => attempt.runId === item.sourceRunId && attempt.revisionId === plan.source.revisionId)
      : agent.attempts?.at(-1);
    if ((!historical && agent.status !== "SUCCEEDED") || agent.mode !== "LIVE_MODEL" || last?.status !== "SUCCEEDED" || !last.model || /TEST_DOUBLE|unconfirmed/.test(last.model) ||
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
  function businessSchedule(plan) {
    const businessDate = plan.fixtures.context.businessDate;
    const index = plan.calendar.tradingDays.indexOf(businessDate), nextDay = plan.calendar.tradingDays[index + 1];
    if (!nextDay) throw fail(422, "日历缺少下一交易日");
    const scheduledFor = `${nextDay}T${plan.schedule.at}+08:00`;
    const occurrence = resolveDeliverySchedule(plan,scheduledFor);
    if (!occurrence.eligible || occurrence.businessDate !== businessDate) throw fail(422,"调度文件与冻结数据日期不一致");
    return {businessDate,businessScheduledFor:scheduledFor};
  }
  function reviewBasis({agent,delivery,item,verification,plan,sourceRunId},actorId) {
    if (!actorId || agent.submittedBy !== actorId || delivery.submittedBy !== actorId)
      throw fail(403,"确切发布审阅只允许原任务创建者");
    const evidence = storedAgentReviewEvidence({task:agent,delivery,bundle:item,verification,
      revision:get("revision",plan.source.revisionId),run:get("run",sourceRunId),
      requestSha256:hash(agent.message ?? ""),store});
    if (evidence.status !== "REVIEW_EVIDENCE_READY") throw fail(409,"原文件演练与开发核验尚未绑定");
    return exactPublicationReviewBasis(evidence,businessSchedule(plan));
  }
  async function publicationPreflight(agentId, input) {
    const selector = internalSelector(input);
    if (standaloneManual || selector.sourceKind !== "AGENT" || !selector.sourceRunId ||
        !selector.packageDigest || !selector.verificationId || selector.releaseId)
      throw fail(422,"须指定原任务、开发批次、包摘要和演练批次");
    const selection = {agentId,...selector}, initial = reviewedSource(selection);
    const basis = reviewBasis(initial,selector.actorId);
    await ensure(initial.item);
    const fresh = reviewedSource(selection);
    if (hash(JSON.stringify(initial)) !== hash(JSON.stringify(fresh)))
      throw fail(409,"发布来源在读取期间变化，请重新核对");
    return {protocol:"shuduo-cloud-publication-preflight/v1", basis, reviewDigest:hash(JSON.stringify(basis)),
      package:deliveryArtifactValue(fresh.item), schedulerAvailable:enabled};
  }
  function originalRequestRelease(agentId, requestId, actorId) {
    if (standaloneManual || !identifier(requestId) || !actorId || get("agent",agentId).submittedBy !== actorId)
      throw fail(403,"发布回执只允许原任务创建者读取");
    const releaseId = store.deduplicatedId(`${project}:cloud-publication:${actorId}:${requestId}`);
    if (!releaseId) throw fail(404,"未找到原发布请求回执");
    const release = get("release",releaseId);
    if (!matches(release,agentId,{sourceKind:"AGENT"}) || release.submittedBy !== actorId || !release.reviewDigest)
      throw fail(404,"未找到原发布请求回执");
    return release;
  }
  const publicationRequestReceipt = (agentId, requestId, actorId) => exactReceipt(originalRequestRelease(agentId, requestId, actorId));
  async function publish({ agent, manualDelivery, sourceKind = "AGENT", sourceRunId, packageDigest, verificationId, attestations, reviewDigest, actorId, idempotencyKey }) {
    if (!enabled) throw fail(503, "云端发布驱动尚未配置");
    const subject=standaloneManual?manualDelivery:agent;if(!subject||typeof subject.id!=='string'||standaloneManual&&agent!==undefined)throw fail(422,'发布缺少指定来源任务');
    const publicationScope = { ...identity(subject.id), packageDigest, verificationId };
    assertPublicationScope(publicationScope);
    const required = publicationAttestationKeys;
    if (!attestations || typeof attestations !== "object" || Array.isArray(attestations) || Object.keys(attestations).length !== required.length || !required.every(key => attestations[key] === true) || !actorId ||
        typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 100)
      throw fail(422, "请逐项审阅代码、核验、交付文件和云端测试范围");
    const requested = validatePublicationSelector({ sourceKind, ...(sourceRunId === undefined ? {} : { sourceRunId }), packageDigest, verificationId }, actorId);
    const input = { ...identity(subject.id), ...requested }, initial = reviewedSource(input);
    await ensure(initial.item);
    // The immutable artifact check yields. Reload every source record and reject
    // changes before approving; an earlier in-memory success is not authority.
    const fresh = reviewedSource(input);
    if (hash(JSON.stringify(initial)) !== hash(JSON.stringify(fresh))) throw fail(409, "发布来源在审阅期间变化，请重新核对确切版本");
    const { item, plan } = fresh;
    if (plan.source.fundDevelopment && (!singleRelease || !reviewDigest))
      throw fail(403,"基金发布只接受独立窗口内的确切审阅摘要");
    const selector = { ...requested, sourceRunId: fresh.sourceRunId };
    if (reviewDigest !== undefined && (standaloneManual || sourceKind !== "AGENT" || sourceRunId !== fresh.sourceRunId ||
        reviewDigest !== hash(JSON.stringify(reviewBasis(fresh,actorId)))))
      throw fail(409,"人工审阅摘要与当前确切交付不一致");
    assertPublicationScope(publicationScope);
    const confirmed = Object.fromEntries(required.map(key => [key,true]));
    const signature = hash(JSON.stringify({ ...identity(subject.id), packageDigest, verificationId, actorId, attestations: confirmed,
      ...(sourceKind === "MANUAL" ? { sourceKind, sourceRunId } : {}), ...(reviewDigest ? {reviewDigest} : {}) }));
    const key = `${project}:${standaloneManual?"manual-publication":"cloud-publication"}:${actorId}:${idempotencyKey}`;
    const prior = store.deduplicatedId(key);
    if (prior) {
      store.deduplicate(key, signature, () => { throw fail(409, "原发布幂等记录缺失"); });
      const previous = get("release", prior);
      if (!matches(previous, subject.id, selector)) throw fail(409, "原发布请求绑定了不同来源或演练");
      authorizeManualRead(subject.id, selector, previous);
      await persist(); return reviewDigest ? exactReceipt(previous) : detail(subject.id, { ...selector, releaseId: previous.id });
    }
    const samePackage = store.list("release", project).filter(r => r.mode === cloudPublicationMode && r[sourceField] === subject.id && r.packageDigest === item.digest);
    const existing = samePackage.filter(r => matches(r, subject.id, selector) && (singleRelease || !["CANCELLED", "ROLLED_BACK"].includes(r.status)));
    if (existing.length > 1 || singleRelease && samePackage.some(r => !matches(r, subject.id, selector)))
      throw fail(409, "此交付包已有另一演练或发布记录，不能借用旧批准");
    if (existing.length === 1) {
      authorizeManualRead(subject.id, selector, existing[0]);
      if (reviewDigest && (existing[0].reviewDigest !== reviewDigest || existing[0].submittedBy !== actorId))
        throw fail(409,"此交付包已有不同审阅的发布，须核对原编号");
      const saved = store.deduplicate(key, signature, () => existing[0]);
      await persist(); return reviewDigest ? exactReceipt(existing[0]) : detail(subject.id, { ...selector, releaseId: saved.id });
    }
    const {businessScheduledFor} = businessSchedule(plan);
    // Artifact verification yields; an approval window may close before records
    // are created. Re-check without changing the reviewed package or its scope.
    assertPublicationScope(publicationScope);
    const attribution = { sourceKind, sourceRunId: fresh.sourceRunId,
      ...(plan.source.fundDevelopment ? { modelMode:plan.source.attribution.modelMode, fundBusinessDate:plan.source.fundLookthrough.businessDate } : {}), ...(reviewDigest ? {reviewDigest} : {}), ...(sourceKind === "MANUAL" ? { sourceAttribution: standaloneManual?'ENGINEER_AUTHORED':"ENGINEER_ASSISTED", agentIndependentE2E: false } : {}),
      ...(standaloneManual?{source:{kind:'MANUAL_RUN',runId:fresh.run.id,revisionId:fresh.revision.id,revisionHash:fresh.revision.hash,manualDeliveryTaskId:subject.id},manualDeliveryTaskId:subject.id}:{}) };
    const created = store.deduplicate(key, signature, () => {
      const review = store.create("delivery_review", project, { ...attribution, packageId: item.id, packageDigest, verificationId, status: "REVIEWED", scope: "PRIVATE_CLOUD_TEST", submittedBy: actorId, attestations: confirmed, reviewedAt: stamp() });
      const approval = store.create("release_approval", project, { ...attribution, packageId: item.id, packageDigest, rehearsalId: verificationId, reviewId: review.id, sourceRevisionId: plan.source.revisionId, sourceCodeHash: plan.source.sqlHash, status: "APPROVED", scope: "PRIVATE_CLOUD_TEST", submittedBy: actorId, approvedAt: stamp() });
      const release = store.create("release", project, { ...attribution, mode: cloudPublicationMode, [sourceField]: subject.id, submittedBy: actorId, reviewId: review.id, approvalId: approval.id, packageId: item.id, packageDigest, verificationId, sourceRevisionId: plan.source.revisionId, sourceCodeHash: plan.source.sqlHash, businessScheduledFor, status: "WAITING_SCHEDULER", health: "PENDING", scope: "PRIVATE_CLOUD_TEST", runCount: 2, publicDeployed: false, fullLifecycleE2E: false });
      for (let sequence = 1; sequence <= 2; sequence++) store.create("release_run", project, { ...attribution, mode: cloudPublicationMode, [sourceField]: subject.id, submittedBy: actorId, releaseId: release.id, packageId: item.id, packageDigest, sequence, businessScheduledFor, status: "SCHEDULED", schedulerTriggered: false, scheduledTriggerAt: new Date(now() + (sequence - 1) * 60000).toISOString(), published: false, publicDeployed: false });
      return release;
    });
    await persist(); return reviewDigest ? exactReceipt(get("release",created.id)) : detail(subject.id, { ...selector, releaseId: created.id });
  }
  async function finish(run, receipt, resultEvent) {
    const current = get("release_run", run.id), release = get("release", run.releaseId);
    if (terminal.has(current.status) || release.status === "CANCELLED") return;
    const item = get("delivery_package", run.packageId), plan = await ensure(item), passed = passedCloudReleaseBatch(receipt, item, plan);
    const latest = get("release_run", run.id), latestRelease=get("release",run.releaseId);
    if (terminal.has(latest.status) || latestRelease.status === "CANCELLED") return;
    if (plan.source.fundDevelopment) {
      const prepared = latest.remoteSubmission?.prepared;
      if (!verifiedWorkerResultDigest(receipt) || typeof prepared?.serialized !== "string" ||
          receipt.queueJobDigest !== hash(prepared.serialized))
        throw fail(409,"基金发布结果未绑定原签名批次");
      if (receipt.status === "SUCCEEDED" && !passed)
        throw fail(409,"基金发布结果与登记交易日或独立断言不一致");
    }
    if (release.reviewDigest) {
      if (latest.remoteSubmission?.prepared?.job?.jobId !== latest.id || latest.reviewDigest !== release.reviewDigest ||
          latestRelease.reviewDigest!==release.reviewDigest || latestRelease.packageDigest!==item.digest ||
          latest.packageId !== item.id || latest.packageDigest !== item.digest)
        throw fail(409,"调度批次与原 Worker 回执不一致");
      if (resultEvent) {
        if (latest.version!==run.version) throw fail(409,"原发布批次在核验期间变化");
        exactReceipt(latestRelease);
      }
      const workerResultDigest=resultEvent?.digest ?? verifiedWorkerResultDigest(receipt);
      store.deduplicate(`${project}:cloud-release-result:${run.id}`,workerResultDigest??hash(JSON.stringify(receipt)),
        ()=>{
          const saved=recordBatchResult(latest,latestRelease,item,receipt,passed,workerResultDigest);
          if (resultEvent) recordTickSummary(release.id,resultEvent.tick);
          return saved;
        });
    } else recordBatchResult(latest,release,item,receipt,passed);
    await persist();
    return true;
  }
  function recordBatchResult(run, release, item, receipt, passed, workerResultDigest) {
    const values = Object.fromEntries(["engine", "engineVersion", "mainSqlExecuted", "testSqlValidation", "validation", "durationMs", "rows", "columns", "log", "inputEvidence"].filter(k => receipt[k] !== undefined).map(k => [k, receipt[k]]));
    if (release.reviewDigest && !(Number.isFinite(values.durationMs) && values.durationMs>0)) delete values.durationMs;
    const saved = patch("release_run", run, { ...values, ...(workerResultDigest?{workerResultDigest}:{}),
      status: passed ? "SUCCEEDED" : "FAILED", stage: "COMPLETED", finishedAt: stamp(), ...(passed ? {} : { error: "云端发布批次执行或独立校验未通过" }) });
    store.create("monitor_event", project, { releaseId: release.id, releaseRunId: run.id, type: passed ? "BATCH_SUCCEEDED" : "BATCH_FAILED", status: saved.status, observedAt: stamp(), packageDigest: item.digest });
    if (!passed) store.create("monitor_alert", project, { releaseId: release.id, releaseRunId: run.id, status: "OPEN", severity: "ERROR", code: "CLOUD_RELEASE_BATCH_FAILED", message: saved.error, openedAt: stamp() });
    else for (const alert of store.list("monitor_alert", project)) if (alert.releaseId === release.id && alert.status === "OPEN" && Date.parse(alert.openedAt) <= now()) store.update("monitor_alert", alert.id, project, { status: "RESOLVED", resolvedAt: stamp(), recoveryRunId: run.id });
    const runs = store.list("release_run", project).filter(r => r.releaseId === release.id), successCount = runs.filter(r => r.status === "SUCCEEDED").length, openAlerts = store.list("monitor_alert", project).filter(a => a.releaseId === release.id && a.status === "OPEN").length;
    const allFinished=runs.every(r=>terminal.has(r.status));
    patch("release", get("release", release.id), { status: allFinished ? "COMPLETED_CLOUD_TEST" : "ACTIVE_CLOUD_TEST", health: openAlerts ? "CRITICAL" : successCount >= 2 ? "HEALTHY" : allFinished ? "RECOVERED_WITH_FAILURE" : "OBSERVING", successfulRunCount: successCount, openAlertCount: openAlerts, lastRunId: run.id, lastObservedAt: stamp() });
    return saved;
  }
  async function reconcile(run, {passive=false}={}) {
    if (terminal.has(run.status) || !run.remoteSubmission) return;
    passive=passive||Boolean(run.reviewDigest);
    let receipt;
    if (passive && run.remoteSubmission.prepared?.job?.jobId!==run.id)
      throw fail(409,"调度批次与原 Worker 编号不一致");
    try { receipt = await runner.read(run.remoteSubmission.prepared,passive?{cancelOnTimeout:false}:undefined); }
    catch (error) { if (passive || error.code !== "REMOTE_SPARK_TIMEOUT") throw error; receipt = { status: "FAILED" }; }
    if (receipt) await finish(run, receipt);
  }
  async function settleResultEvent({id,key}, assertResultTarget) {
    const run=store.get("release_run",id,project), prepared=run?.remoteSubmission?.prepared;
    if (!runner || standaloneManual || run?.mode!==cloudPublicationMode || run.sourceKind!=="AGENT" ||
        !run.reviewDigest || run.clockMode!=="FC_TIMER" || run.schedulerTriggered!==true ||
        run.published!==true || run.isolation!=="FUNCTION_PROCESS" ||
        prepared?.resultKey!==key || prepared.job?.jobId!==id || prepared.job.projectId!==project ||
        store.deduplicatedId(`${project}:cloud-release-claim:${id}`,run.reviewDigest)!==id) return;
    const release=get("release",run.releaseId);
    if (release.mode!==cloudPublicationMode || release.sourceKind!=="AGENT" ||
        release.submittedBy!==run.submittedBy) throw fail(409,"发布批次与原发布来源不一致");
    assertResultTarget(release);
    exactReceipt(release);
    if (terminal.has(run.status) || release.status==="CANCELLED") return {state:"RELEASE_BATCH_ALREADY_SETTLED"};
    if (run.status!=="RUNNING" || !["SUBMITTING","WAITING_FOR_WORKER_RESULT"].includes(run.stage)) return;
    const claims=store.list("cloud_release_tick",project).filter(event=>event.batchId===id);
    const tick=claims.length===1 ? claims[0] : undefined;
    if (!tick || tick.releaseId!==release.id || tick.triggerName!==run.triggerName ||
        store.deduplicatedId(`${project}:cloud-release-tick:${tick.requestId}`,
          hash(JSON.stringify({releaseId:tick.releaseId,triggerName:tick.triggerName,triggerTime:tick.triggerTime})))!==tick.id)
      throw fail(409,"原调度事件与发布批次不一致");
    const owner=store.get("auth_user",release.submittedBy,project);
    if (owner?.status!=="ACTIVE" || !owner.memberships?.some(member=>member.projectId===project && member.role==="ADMIN"))
      return {state:"RELEASE_BATCH_OWNER_INACTIVE"};
    // The timer already reserved this batch. Even if the queue ACK was lost,
    // a signed result can finish it after the timer or write window expires.
    const receipt=await runner.read(prepared,{cancelOnTimeout:false});
    if (!receipt) throw fail(503,"原发布批次结果对象暂不可读取");
    const digest=verifiedWorkerResultDigest(receipt);
    if (!digest || typeof prepared.serialized!=="string" || receipt.queueJobDigest!==hash(prepared.serialized))
      return {state:"RELEASE_BATCH_RESULT_UNCONFIRMED"};
    const settled=await finish(run,receipt,{digest,tick});
    return {state:settled ? "RELEASE_BATCH_SETTLED" : "RELEASE_BATCH_ALREADY_SETTLED"};
  }
  function recordTickSummary(releaseId,event) {
    const all = store.list("release_run",project).filter(run=>run.releaseId===releaseId);
    const summary = {releaseId,succeeded:all.filter(run=>run.status==="SUCCEEDED").length,
      failed:all.filter(run=>run.status==="FAILED").length,pending:all.filter(run=>!terminal.has(run.status)).length};
    store.update("cloud_release_tick",event.id,project,{status:"COMPLETED",summary});
    return summary;
  }
  async function finishTick(releaseId,event) {
    const summary=recordTickSummary(releaseId,event);
    await persist();
    return summary;
  }
  async function replayExactTick(releaseId,event) {
    if (event.batchId) {
      const original = get("release_run",event.batchId);
      if (original.releaseId !== releaseId) throw fail(409,"原调度事件与批次不一致");
      if (original.status === "RUNNING") {
        await reconcile(original,{passive:true});
        if (terminal.has(get("release_run",original.id).status))
          return {replayed:true,...await finishTick(releaseId,event)};
      }
    }
    return {replayed:true,...(event.status === "COMPLETED" ? event.summary : await finishTick(releaseId,event))};
  }
  function exactTickSource(release) {
    exactReceipt(release);
    const source = reviewedSource({agentId:release.sourceAgentTaskId,sourceKind:"AGENT",sourceRunId:release.sourceRunId,
      packageDigest:release.packageDigest,verificationId:release.verificationId,actorId:release.submittedBy});
    const basis=reviewBasis(source,release.submittedBy);
    if (hash(JSON.stringify(basis)) !== release.reviewDigest || basis.businessScheduledFor!==release.businessScheduledFor ||
        source.plan.source.revisionId!==release.sourceRevisionId || source.plan.source.sqlHash!==release.sourceCodeHash)
      throw fail(409,"签名调度须沿用原审阅版本");
    return source;
  }
  async function tickExact(release, input, old) {
    exactReceipt(release);
    const {releaseId,requestId,triggerName,triggerTime}=input;
    // Completing the timer request does not mean its Worker has returned.
    // Replays can read the batch this event claimed, even after an empty read.
    if (old) return replayExactTick(releaseId,old);
    const key = `${project}:cloud-release-tick:${requestId}`;
    const saved = store.deduplicate(key,hash(JSON.stringify({releaseId,triggerName,triggerTime})),()=>
      store.create("cloud_release_tick",project,{requestId,releaseId,triggerName,triggerTime,status:"RUNNING"}));
    const event = get("cloud_release_tick",saved.id);
    if (saved.replayed) return replayExactTick(releaseId,event);
    await persist();
    const releaseRuns = () => store.list("release_run",project).filter(run=>run.releaseId===releaseId);
    for (const run of releaseRuns().filter(run=>run.status==="RUNNING")) await reconcile(run,{passive:true});
    // Only a fresh signed event reaches the claim. A pending earlier batch
    // keeps the queue serial.
    const all=releaseRuns();
    const selected = !all.some(run=>run.status==="RUNNING") &&
      all.filter(run=>run.status==="SCHEDULED" && Date.parse(run.scheduledTriggerAt)<=now())
        .sort((a,b)=>a.sequence-b.sequence)[0];
    if (!selected) return finishTick(releaseId,event);
    const {item} = exactTickSource(get("release",releaseId)), plan=await ensure(item);
    const current=get("release_run",selected.id), active=get("release",releaseId);
    if (active.status==="CANCELLED" || current.status!=="SCHEDULED" || releaseRuns().some(run=>run.status==="RUNNING"))
      return finishTick(releaseId,event);
    assertExecutionScope(active);
    exactTickSource(active);
    assertBudget();
    const reserved=store.deduplicate(`${project}:cloud-release-claim:${current.id}`,active.reviewDigest,()=>{
      const prepared=runner.prepare({sql:item.files["main.sql"],testSql:item.files["tests.sql"],
        context:plan.fixtures.context,validationContexts:plan.fixtures.validationContexts},current.id);
      const claim=patch("release_run",current,{status:"RUNNING",stage:"SUBMITTING",isolation:"FUNCTION_PROCESS",
        reservedDurationMs:reservationSeconds*1000,schedulerTriggered:true,clockMode:"FC_TIMER",triggerName,triggeredAt:stamp(),
        fileHashes:Object.fromEntries(["main.sql","tests.sql"].map(name=>[name,item.manifest.files[name].sha256])),
        remoteSubmission:{prepared,submitted:false},published:true});
      patch("release",active,{status:"RUNNING_CLOUD_TEST",health:active.health==="CRITICAL"?"CRITICAL":"OBSERVING"});
      store.update("cloud_release_tick",event.id,project,{batchId:current.id});
      return claim;
    });
    if (reserved.replayed) return finishTick(releaseId,event);
    await persist();
    const claimed=get("release_run",current.id), latest=get("release",releaseId);
    if (latest.status==="CANCELLED" || terminal.has(claimed.status)) return finishTick(releaseId,event);
    if (claimed.version!==current.version+1 || get("cloud_release_tick",event.id).batchId!==current.id)
      throw fail(409,"原调度批次已变化");
    assertExecutionScope(latest);
    exactTickSource(latest);
    await runner.submit(claimed.remoteSubmission.prepared,{retry:false});
    const acknowledged=get("release_run",current.id);
    if (!terminal.has(acknowledged.status) && get("release",releaseId).status!=="CANCELLED")
      patch("release_run",acknowledged,{stage:"WAITING_FOR_WORKER_RESULT",remoteSubmission:{...acknowledged.remoteSubmission,submitted:true}});
    return finishTick(releaseId,event);
  }
  async function tick({ releaseId, requestId, triggerName, triggerTime }) {
    if (!enabled) throw fail(503, "云端发布驱动未启用");
    let release = get("release", releaseId);
    if (release.mode !== cloudPublicationMode || (standaloneManual?typeof release.manualDeliveryTaskId!=="string"||release.sourceAgentTaskId!==undefined:release.manualDeliveryTaskId!==undefined) || !["WAITING_SCHEDULER", "RUNNING_CLOUD_TEST", "ACTIVE_CLOUD_TEST", "COMPLETED_CLOUD_TEST"].includes(release.status)) throw fail(409, "发布版本已失效");
    if (typeof requestId !== "string" || !/^[a-f0-9]{64}$/.test(requestId) || typeof triggerName !== "string" || !triggerName || !Number.isFinite(Date.parse(triggerTime))) throw fail(422, "调度事件标识不合法");
    const old = store.list("cloud_release_tick", project).find(t => t.requestId === requestId);
    if (old && old.releaseId !== release.id) throw fail(409, "同一事件不能调用另一发布版本");
    if (old && release.reviewDigest && (old.triggerName!==triggerName || old.triggerTime!==triggerTime))
      throw fail(409,"同一签名编号不能替换调度时间或触发器");
    if (release.reviewDigest) return tickExact(release,{releaseId,requestId,triggerName,triggerTime},old);
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
    return finishTick(release.id,event);
  }
  function publicationView(release) {
    if (!release) return { release: undefined, runs: [], alerts: [], events: [] };
    const observedAt = now();
    const runs = store.list("release_run", project).filter(run => run.releaseId === release.id)
      .sort((a,b) => a.sequence-b.sequence).map(run => clean(projectCloudReleaseBatchStage(run, observedAt)));
    const monitoringVerified = release.fundBusinessDate && release.status === "COMPLETED_CLOUD_TEST"
      ? exactReceipt(release).monitoring.status === "VERIFIED" : undefined;
    return { release: clean(release), runs, ...(monitoringVerified!==undefined?{monitoringVerified}:{}), alerts: store.list("monitor_alert", project).filter(a => a.releaseId === release.id),
      events: store.list("monitor_event", project).filter(e => e.releaseId === release.id) };
  }
  function savedDelivery(agentId, selector) {
    const owner = get("agent", agentId).submittedBy;
    const candidates = store.list("agent_delivery_task", project).filter(task =>
      task.sourceAgentTaskId === agentId && (task.sourceKind ?? "AGENT") === selector.sourceKind &&
      (!selector.packageDigest || task.packageDigest === selector.packageDigest) &&
      (!selector.verificationId || task.verificationId === selector.verificationId) &&
      (!selector.sourceRunId || task.sourceRunId === selector.sourceRunId));
    if (!owner || candidates.length !== 1) throw savedUnconfirmed();
    const [delivery] = candidates;
    const bundle = store.get("delivery_package", delivery.packageId ?? "", project);
    const verification = store.get("delivery_verification", delivery.verificationId ?? "", project);
    const run = store.get("run", delivery.sourceRunId ?? "", project);
    const revision = store.get("revision", delivery.sourceRevisionId ?? "", project);
    if (!bundle || !verification || (delivery.submittedBy !== undefined && delivery.submittedBy !== owner) ||
        bundle.digest !== delivery.packageDigest || bundle.manifest?.source?.runId !== delivery.sourceRunId ||
        bundle.manifest?.source?.revisionId !== delivery.sourceRevisionId ||
        (bundle.agentDeliveryTaskId !== undefined && bundle.agentDeliveryTaskId !== delivery.id) ||
        (bundle.sourceRunId !== undefined && bundle.sourceRunId !== delivery.sourceRunId) ||
        !run || !revision || run.revisionId !== revision.id || run.revisionHash !== revision.hash ||
        bundle.manifest.source.sqlHash !== revision.hash || (revision.author !== undefined && revision.author !== owner) ||
        (run.agentTaskId !== undefined && run.agentTaskId !== agentId) ||
        verification.packageId !== bundle.id || verification.packageDigest !== bundle.digest ||
        (verification.agentDeliveryTaskId !== undefined && verification.agentDeliveryTaskId !== delivery.id))
      throw savedUnconfirmed();
    return { bundle, verification };
  }
  function checkedSavedView(agentId, release, selector) {
    const sourceRunId = runOf(release);
    try {
      const { bundle, verification } = savedDelivery(agentId, { ...selector, sourceRunId, packageDigest: release.packageDigest,
        verificationId: release.verificationId });
      const source = reviewedSource({ agentId, sourceKind: kindOf(release), sourceRunId, packageDigest: release.packageDigest,
        verificationId: release.verificationId, actorId: selector.actorId }, { historical: true });
      const review = get("delivery_review", release.reviewId), approval = get("release_approval", release.approvalId);
      const view = publicationView(release);
      const validatedRun = run => source.plan.source.fundDevelopment ? get("release_run",run.id) : run;
      const successfulEvent = run => {
        const events = view.events.filter(event => event.releaseRunId === run.id && event.type === "BATCH_SUCCEEDED");
        return events.length === 1 && events[0].status === "SUCCEEDED" && events[0].packageDigest === bundle.digest &&
          Date.parse(events[0].observedAt) >= Date.parse(run.finishedAt);
      };
      if (release.scope !== "PRIVATE_CLOUD_TEST" || bundle.id !== release.packageId || source.item.id !== bundle.id ||
          release.sourceRevisionId !== source.plan.source.revisionId || release.sourceCodeHash !== source.plan.source.sqlHash ||
          review.status !== "REVIEWED" || review.verificationId !== verification.id ||
          approval.status !== "APPROVED" || approval.reviewId !== review.id || approval.rehearsalId !== verification.id ||
          approval.sourceRevisionId !== release.sourceRevisionId || approval.sourceCodeHash !== release.sourceCodeHash ||
          [review, approval].some(item => item.packageId !== bundle.id || item.packageDigest !== bundle.digest ||
            item.scope !== release.scope || item.submittedBy !== release.submittedBy) ||
          !publicationAttestationKeys.every(key => review.attestations?.[key] === true) ||
          view.runs.length !== 2 || view.runs.some((run, i) => run.sequence !== i + 1 || run.mode !== cloudPublicationMode ||
            run.packageId !== bundle.id || run.packageDigest !== bundle.digest || run.sourceAgentTaskId !== agentId ||
            (run.sourceRunId !== undefined && run.sourceRunId !== sourceRunId) ||
            (run.status === "SUCCEEDED" && (!passedCloudReleaseBatch(validatedRun(run), bundle, source.plan) || !successfulEvent(run)))) ||
          [...view.events, ...view.alerts].some(item => (item.packageDigest !== undefined && item.packageDigest !== bundle.digest) ||
            [item.releaseRunId, item.recoveryRunId].some(id => id !== undefined && !view.runs.some(run => run.id === id)) ||
            (item.recoveryReleaseId !== undefined && item.recoveryReleaseId !== release.id)) ||
          (release.reviewDigest !== undefined && exactReceipt(release).monitoring.status === "UNCONFIRMED"))
        throw savedUnconfirmed();
      return { ...view, readMode: "SAVED_HISTORY" };
    } catch {
      throw savedUnconfirmed();
    }
  }
  function savedDetail(agentId, input = {}) {
    const selector = internalSelector(input), release = select(agentId, selector);
    if (release) return checkedSavedView(agentId, release, selector);
    if (selector.releaseId) throw savedUnconfirmed();
    if (selector.packageDigest || selector.verificationId || selector.sourceRunId) {
      const { bundle, verification } = savedDelivery(agentId, selector);
      try { validateDeliveryPackage(bundle, bundle.digest); } catch { throw savedUnconfirmed(); }
      if (store.list("release", project).some(item => item.mode === cloudPublicationMode && item.sourceAgentTaskId === agentId &&
          item.verificationId === verification.id)) throw savedUnconfirmed();
    }
    return { ...publicationView(), readMode: "SAVED_HISTORY" };
  }
  function savedRequestReceipt(agentId, requestId, actorId) {
    const release = originalRequestRelease(agentId, requestId, actorId);
    const { bundle } = savedDelivery(agentId, { sourceKind: "AGENT", sourceRunId: runOf(release),
      packageDigest: release.packageDigest, verificationId: release.verificationId });
    try {
      const plan = validateDeliveryPackage(bundle, release.packageDigest);
      if (bundle.id !== release.packageId || plan.source.revisionId !== release.sourceRevisionId ||
          plan.source.sqlHash !== release.sourceCodeHash) throw savedUnconfirmed();
    } catch { throw savedUnconfirmed(); }
    return exactReceipt(release);
  }
  async function detail(agentId, input = {}) {
    const selector = internalSelector(input), release = select(agentId, selector);
    if (!release) return publicationView();
    if (!release.reviewDigest)
      for (const run of store.list("release_run", project).filter(r => r.releaseId === release.id && r.status === "RUNNING")) await reconcile(run);
    const latest = select(agentId, { ...selector, releaseId: release.id });
    if (!latest) throw fail(409, "发布来源在读取期间变化，请重新读取原记录");
    if (latest.fundBusinessDate) return checkedSavedView(agentId,latest,selector);
    return publicationView(latest);
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
  return { publish, detail, savedDetail, tick, settleResultEvent, cancel, sourceForNavigation, publicationPreflight, publicationRequestReceipt, savedRequestReceipt };
}

export function createStandaloneManualPublication(options){
  const engine=createCloudPublication({...options,standaloneManual:true});
  return {publish:({manualDeliveryTaskId,...input})=>engine.publish({...input,manualDelivery:options.store.get('manual_delivery_task',manualDeliveryTaskId,options.project)}),detail:engine.detail,tick:engine.tick,cancel:engine.cancel};
}
