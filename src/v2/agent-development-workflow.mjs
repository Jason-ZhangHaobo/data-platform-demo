import { createHash } from "node:crypto";
import { createDeliveryPackage, validateDeliveryPackage, resolveDeliverySchedule, validationMatchesFamily } from "./delivery.mjs";
import { getContext, validationContractId, validationFamilyForContext } from "./context.mjs";
import { deliveryArtifactValue } from "./artifact-store.mjs";

export const durableDeliveryMode = "DURABLE_AGENT_DELIVERY_V1";
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
export function publicDeliveryTask(task) {
  if (!task) return task;
  const { remoteSubmission, submittedBy, ...visible } = task;
  return visible;
}

export function developmentVerificationReport(task, run, revision) {
  const context = getContext(task.contextId), expected = context?.expected ?? [];
  const family = validationFamilyForContext(task.contextId), legacy = family?.id === validationContractId;
  const rows = run?.rows ?? [], fields = ["holding_market_value", "available_cash", "total_assets", "security_count"];
  const numericEqual = (a, b) => a !== null && a !== undefined && String(a).trim() !== "" && Number.isFinite(Number(a)) && Number(a) === Number(b);
  const resultsMatch = rows.length === expected.length && expected.every(want => {
    const matches = rows.filter(row => row.client_id === want.client_id);
    return matches.length === 1 && fields.every(field => numericEqual(matches[0][field], want[field]));
  });
  const checks = [
    { id: "revision", label: "结果对应当前代码版本", passed: Boolean(revision && revision.contextId === task.contextId &&
      (run?.contextId === undefined || run.contextId === task.contextId) && run?.revisionId === revision.id && run.revisionHash === revision.hash && hash(revision.sql) === revision.hash) },
    { id: "execution", label: "Spark 实际执行完成", passed: run?.status === "SUCCEEDED" && run.engine === "Apache Spark" && run.mainSqlExecuted === true && run.testDouble !== true },
    { id: "results", label: "客户、金额与证券数量匹配独立预期", passed: resultsMatch },
    { id: "regressions", label: legacy ? "重复持仓、现金变化及现金客户等五场景通过" : "股票持仓、现金变化及现金客户等五场景通过", passed:
      (task.validationContractId === undefined || task.validationContractId === family?.id) &&
      (run?.validationContractId === undefined || run.validationContractId === family?.id) &&
      validationMatchesFamily(run?.validation, family, { requireContract: true }) },
  ];
  const passed = checks.every(check => check.passed);
  return {
    schema: "shuduo-development-verification/v1", taskId: task.id, revisionId: revision?.id,
    revisionHash: revision?.hash, runId: run?.id, contextId: task.contextId,
    status: passed ? "PASSED" : !run || ![...terminal, "VALIDATION_FAILED"].includes(run.status) ? "PENDING" : "NEEDS_ATTENTION",
    summary: passed ? legacy ? "当前证券业务口径下，代码版本、真实执行、结果和五场景核验均通过，可以准备交付。" : "股票持仓＋可用现金口径的代码、执行、结果和五场景核验均通过；结果不等于客户全资产。" : "尚未形成完整核验结论，请先查看未通过项。",
    definition: context?.definition, checks, rowCount: rows.length, engine: run?.engine, engineVersion: run?.engineVersion,
    finishedAt: run?.finishedAt, validationContractId: family?.id, validationFamily: family, completionScope: "KNOWN_SECURITIES_CONTRACT",
    notice: "核验仅覆盖所选数据与已登记口径；新增指标需要新的独立预期。",
  };
}

export function manualCloudDeliverySource({store, project, runId, actorId, requireVerified = true}) {
  const run = store.get("run", runId, project), revision = store.get("revision", run?.revisionId ?? "", project),
    provenance = revision?.manualProvenance, agent = store.get("agent", provenance?.originAgentTaskId ?? "", project);
  if (!actorId || !agent || agent.executionMode !== "DURABLE_SQL_AGENT_V1" || agent.language !== "SPARK_SQL" ||
      agent.submittedBy !== actorId || revision?.author !== actorId || revision.source !== "MANUAL" ||
      provenance?.kind !== "ENGINEER_EDIT" || provenance.actorId !== actorId || provenance.agentIndependentE2E !== false ||
      revision.contextId !== agent.contextId || run?.contextId !== revision.contextId || run.revisionHash !== revision.hash ||
      hash(revision.sql) !== revision.hash)
    throw fail(403, "人工交付必须属于当前工程师、原任务与同一已保存代码版本");
  const report = {...developmentVerificationReport(agent, run, revision), sourceKind: "MANUAL", agentIndependentE2E: false,
    originAgentStatus: agent.status, notice: "此核验属于工程师接管版本；原 Agent 的失败、尝试及预算记录保持不变，不计为自主完成。"};
  if (requireVerified && (report.status !== "PASSED" || run.engineVersion !== "3.5.9" || run.isolation !== "FUNCTION_PROCESS" ||
      run.mode !== "DURABLE_REMOTE_SUBMISSION" && run.adapter !== "remote-spark-worker-v1"))
    throw fail(409, "请先完成此人工版本的云端隔离 Spark 执行与五场景独立核验");
  return {agent, revision, run, report};
}

// Each POST crosses one durable boundary; GET only reads a signed Worker receipt.
export function createDurableAgentDelivery({ store, project, runner, artifactStore, persist, assertRunBudget = () => {}, assertExecutionScope = () => {}, reservationSeconds = 30 }) {
  if (!Number.isFinite(reservationSeconds) || reservationSeconds < 1 || reservationSeconds > 300) throw new Error("交付计算预留无效");
  const get = id => {
    const item = store.get("agent_delivery_task", id, project);
    if (!item || item.mode !== durableDeliveryMode) throw fail(404, "未找到持久交付任务");
    return item;
  };
  const change = (item, patch) => store.update("agent_delivery_task", item.id, project, patch, { expectedVersion: item.version });
  const source = agent => {
    const attempt = agent.attempts?.at(-1), revision = store.get("revision", attempt?.revisionId, project), run = store.get("run", attempt?.runId, project);
    if (agent.status !== "SUCCEEDED" || agent.mode !== "LIVE_MODEL" || attempt?.status !== "SUCCEEDED" || !attempt.model || /TEST_DOUBLE|unconfirmed/.test(attempt.model) || developmentVerificationReport(agent, run, revision).status !== "PASSED")
      throw fail(409, "请先完成真实模型、Spark 与独立结果核验");
    return { revision, run };
  };
  const bundleFor = async task => {
    const item = store.get("delivery_package", task.packageId, project);
    if (!item || item.digest !== task.packageDigest || item.manifest.source.sqlHash !== task.sourceSqlHash)
      throw fail(409, "交付文件与已核验源版本不一致");
    await artifactStore.verify(item.artifact, "delivery-package", item.digest, deliveryArtifactValue(item));
    const plan = validateDeliveryPackage(item, task.packageDigest);
    if (task.sourceKind === "MANUAL" && (plan.source.attribution?.kind !== "ENGINEER_ASSISTED" ||
        plan.source.attribution.originAgentTaskId !== task.sourceAgentTaskId || plan.source.attribution.actorId !== task.submittedBy ||
        plan.source.attribution.agentIndependentE2E !== false)) throw fail(409, "人工交付来源与不可变清单不一致");
    return { item, plan };
  };
  const assertTaskScope = task => {
    const agent = store.get("agent", task.sourceAgentTaskId, project);
    assertExecutionScope(agent);
    if (task.sourceKind === "MANUAL") {
      const source = manualCloudDeliverySource({store, project, runId: task.sourceRunId, actorId: task.submittedBy});
      if (source.agent.id !== task.sourceAgentTaskId || source.revision.id !== task.sourceRevisionId || source.revision.hash !== task.sourceSqlHash)
        throw fail(409, "人工交付来源已变化");
    }
  };
  async function persistManualArtifact(task) {
    const item = store.get("delivery_package", task.packageId, project);
    if (item?.artifact) return task;
    assertTaskScope(task);
    if (!item || item.digest !== task.packageDigest) throw fail(409, "人工交付包检查点不完整");
    validateDeliveryPackage(item, task.packageDigest);
    const artifact = await artifactStore.put("delivery-package", item.digest, deliveryArtifactValue(item));
    task = get(task.id);
    if (terminal.has(task.status)) return task;
    assertTaskScope(task);
    store.update("delivery_package", item.id, project, {artifact});
    task = change(task, {stage: "PACKAGE_READY"}); await persist(); return task;
  }
  async function createManual({runId, actorId, key}) {
    const {agent, revision, run} = manualCloudDeliverySource({store, project, runId, actorId});
    assertExecutionScope(agent);
    if (typeof key !== "string" || !key || key.length > 100) throw fail(422, "人工交付缺少有效幂等编号");
    const existing = store.list("agent_delivery_task", project).find(t => t.sourceKind === "MANUAL" && t.sourceAgentTaskId === agent.id &&
      t.sourceRunId === run.id && t.sourceRevisionId === revision.id && t.sourceSqlHash === revision.hash && ["QUEUED", "RUNNING", "SUCCEEDED"].includes(t.status));
    const dedup = store.deduplicate(`${project}:manual-cloud-delivery:${actorId}:${key}`, hash(JSON.stringify({runId: run.id, revisionHash: revision.hash, origin: agent.id})), () => {
      if (existing) return existing;
      const bundle = createDeliveryPackage({run, revision, name: "工程师接管 · 已核验证券加工交付"});
      const task = store.create("agent_delivery_task", project, {mode: durableDeliveryMode, sourceKind: "MANUAL", sourceAgentTaskId: agent.id,
        sourceRunId: run.id, sourceRevisionId: revision.id, sourceSqlHash: revision.hash, submittedBy: actorId, status: "QUEUED", stage: "PACKAGE_PERSISTING",
        packageDigest: bundle.digest, completionScope: "MANUAL_DELIVERY_PREPARATION", agentIndependentE2E: false, fullLifecycleE2E: false, publicDeployed: false});
      const item = store.create("delivery_package", project, {...bundle, sourceRunId: run.id, agentDeliveryTaskId: task.id, sourceKind: "MANUAL", agentIndependentE2E: false, stage: "M2A", published: false});
      return change(task, {packageId: item.id});
    });
    await persist(); // Persist the exact package before OSS; an unknown PUT resumes its digest.
    const task = get(dedup.id);
    return publicDeliveryTask(terminal.has(task.status) ? task : await persistManualArtifact(task));
  }
  async function create(agent, key) {
    assertExecutionScope(agent);
    const { run, revision } = source(agent);
    const existing = store.list("agent_delivery_task", project).find(t => t.mode === durableDeliveryMode && t.sourceAgentTaskId === agent.id && t.sourceRevisionId === revision.id && t.sourceRunId === run.id && t.sourceSqlHash === revision.hash && ["QUEUED", "RUNNING", "SUCCEEDED"].includes(t.status));
    if (existing) return publicDeliveryTask(existing);
    const family = validationFamilyForContext(revision.contextId);
    const bundle = createDeliveryPackage({ run, revision, name: family?.id === validationContractId ? "客户资产 T+1 · Agent交付" : "股票持仓＋可用现金（非客户全资产）· Agent交付" });
    const artifact = await artifactStore.put("delivery-package", bundle.digest, bundle);
    const dedup = store.deduplicate(`${project}:durable-delivery:${agent.id}:${key}`, hash(JSON.stringify({ runId: run.id, revisionHash: revision.hash })), () => {
      const task = store.create("agent_delivery_task", project, { mode: durableDeliveryMode, sourceAgentTaskId: agent.id, sourceRunId: run.id, sourceRevisionId: revision.id, sourceSqlHash: revision.hash, submittedBy: agent.submittedBy, status: "QUEUED", stage: "PACKAGE_READY", packageDigest: bundle.digest, completionScope: "DELIVERY_PREPARATION", fullLifecycleE2E: false, publicDeployed: false });
      const item = store.create("delivery_package", project, { ...bundle, artifact, sourceRunId: run.id, agentDeliveryTaskId: task.id, stage: "M2A", published: false });
      return change(task, { packageId: item.id });
    });
    await persist(); return publicDeliveryTask(get(dedup.id));
  }
  async function reconcile(id) {
    let task = get(id);
    if (terminal.has(task.status) || !task.remoteSubmission) return publicDeliveryTask(task);
    const { item, plan } = await bundleFor(task);
    let receipt;
    try { receipt = await runner.read(task.remoteSubmission.prepared); }
    catch (error) { if (error.code !== "REMOTE_SPARK_TIMEOUT") throw error; receipt = { status: "FAILED", error: "交付文件演练超时" }; }
    if (!receipt) return publicDeliveryTask(task);
    task = get(id); if (terminal.has(task.status)) return publicDeliveryTask(task);
    const family = { id: plan.source.validationContractId, contextIds: plan.fixtures.validationContexts.map(context => context.id) };
    const passed = receipt.status === "SUCCEEDED" && receipt.engine === "Apache Spark" && receipt.engineVersion === plan.deployment.runtime.version && receipt.mainSqlExecuted === true && receipt.testDouble !== true && receipt.testSqlValidation?.passed === true && receipt.testSqlValidation.sqlHash === hash(item.files["tests.sql"]) && validationMatchesFamily(receipt.validation, family);
    const verification = store.get("delivery_verification", task.verificationId, project);
    // Whitelist receipt fields; a Worker cannot overwrite package/source identifiers.
    const result = Object.fromEntries(["engine", "engineVersion", "mainSqlExecuted", "testSqlValidation", "validation", "rows", "columns", "log", "durationMs", "error", "testDouble"].filter(k => receipt[k] !== undefined).map(k => [k, receipt[k]]));
    store.update("delivery_verification", verification.id, project, { ...result, status: passed ? "SUCCEEDED" : "FAILED", finishedAt: new Date().toISOString(), mode: "CLOUD_ISOLATED_FILE_REHEARSAL", actualExecution: passed, published: false });
    task = change(task, { status: passed ? "SUCCEEDED" : "FAILED", stage: passed ? "AWAITING_ENGINEER_REVIEW" : "FILE_REHEARSAL_FAILED", actualExecution: passed, finishedAt: new Date().toISOString(), ...(passed ? {} : { error: "演练未通过真实执行、测试SQL或独立回归，请检查演练记录。" }) });
    await persist(); return publicDeliveryTask(task);
  }
  async function advance(id, expectedVersion) {
    let task = get(id);
    if (terminal.has(task.status)) return publicDeliveryTask(task);
    assertTaskScope(task);
    if (expectedVersion !== task.version) throw fail(409, "交付任务已更新，请刷新后继续");
    if (task.sourceKind === "MANUAL") task = await persistManualArtifact(task);
    if (terminal.has(task.status)) return publicDeliveryTask(task);
    if (task.sourceKind === "MANUAL" && task.remoteSubmission && !task.remoteSubmission.submitted) {
      await reconcile(task.id); task = get(task.id);
      if (terminal.has(task.status)) return publicDeliveryTask(task);
    }
    const { item, plan } = await bundleFor(task);
    if (!task.remoteSubmission) {
      assertRunBudget();
      const businessIndex = plan.calendar.tradingDays.indexOf(plan.fixtures.context.businessDate), nextDay = plan.calendar.tradingDays[businessIndex + 1];
      if (!nextDay) throw fail(422, "日历中缺少下一交易日，无法演练");
      const scheduledFor = `${nextDay}T${plan.schedule.at}+08:00`, occurrence = resolveDeliverySchedule(plan, scheduledFor);
      if (!occurrence.eligible || occurrence.businessDate !== plan.fixtures.context.businessDate) throw fail(422, "调度业务日与冻结输入不一致");
      const verification = store.create("delivery_verification", project, { packageId: item.id, packageDigest: item.digest, agentDeliveryTaskId: task.id, scheduledFor, occurrence, status: "RUNNING", mode: durableDeliveryMode, isolation: "FUNCTION_PROCESS", reservedDurationMs: reservationSeconds * 1000, published: false });
      const prepared = runner.prepare({ sql: item.files["main.sql"], testSql: item.files["tests.sql"], context: plan.fixtures.context, validationContexts: plan.fixtures.validationContexts }, verification.id);
      task = change(task, { status: "RUNNING", stage: "FILE_REHEARSAL_SUBMITTING", verificationId: verification.id, remoteSubmission: { prepared, submitted: false } });
      await persist();
    }
    if (!task.remoteSubmission.submitted) {
      await runner.submit(task.remoteSubmission.prepared);
      task = get(id); if (terminal.has(task.status)) return publicDeliveryTask(task);
      task = change(task, { stage: "FILE_REHEARSAL_RUNNING", remoteSubmission: { ...task.remoteSubmission, submitted: true } });
      await persist();
    }
    return reconcile(id);
  }
  async function cancel(id) {
    let task = get(id); if (terminal.has(task.status)) return publicDeliveryTask(task);
    assertExecutionScope(store.get("agent", task.sourceAgentTaskId, project));
    task = change(task, { status: "CANCELLED", stage: "CANCELLED", finishedAt: new Date().toISOString() });
    if (task.verificationId) store.update("delivery_verification", task.verificationId, project, { status: "CANCELLED", finishedAt: task.finishedAt });
    await persist();
    if (task.remoteSubmission) await runner.cancel(task.remoteSubmission.prepared);
    return publicDeliveryTask(task);
  }
  return { create, createManual, advance, reconcile, cancel, bundleFor };
}
