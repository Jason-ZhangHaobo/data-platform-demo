import { createHash } from "node:crypto";
import { createDeliveryPackage, validateDeliveryPackage, resolveDeliverySchedule } from "./delivery.mjs";
import { getContext, contextIds, validationContractId } from "./context.mjs";
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
  const rows = run?.rows ?? [], fields = ["holding_market_value", "available_cash", "total_assets", "security_count"];
  const numericEqual = (a, b) => a !== null && a !== undefined && String(a).trim() !== "" && Number.isFinite(Number(a)) && Number(a) === Number(b);
  const resultsMatch = rows.length === expected.length && expected.every(want => {
    const matches = rows.filter(row => row.client_id === want.client_id);
    return matches.length === 1 && fields.every(field => numericEqual(matches[0][field], want[field]));
  });
  const checks = [
    { id: "revision", label: "结果对应当前代码版本", passed: Boolean(revision && run?.revisionId === revision.id && run.revisionHash === revision.hash && hash(revision.sql) === revision.hash) },
    { id: "execution", label: "Spark 实际执行完成", passed: run?.status === "SUCCEEDED" && run.engine === "Apache Spark" && run.mainSqlExecuted === true && run.testDouble !== true },
    { id: "results", label: "客户、金额与证券数量匹配独立预期", passed: resultsMatch },
    { id: "regressions", label: "重复持仓、现金变化及现金客户等五场景通过", passed: run?.validation?.passed === true && run.validation.contractId === validationContractId && contextIds.every(id => run.validation.regressions?.some(check => check.contextId === id && check.passed)) },
  ];
  const passed = checks.every(check => check.passed);
  return {
    schema: "shuduo-development-verification/v1", taskId: task.id, revisionId: revision?.id,
    revisionHash: revision?.hash, runId: run?.id, contextId: task.contextId,
    status: passed ? "PASSED" : !run || ![...terminal, "VALIDATION_FAILED"].includes(run.status) ? "PENDING" : "NEEDS_ATTENTION",
    summary: passed ? "当前证券业务口径下，代码版本、真实执行、结果和五场景核验均通过，可以准备交付。" : "尚未形成完整核验结论，请先查看未通过项。",
    definition: context?.definition, checks, rowCount: rows.length, engine: run?.engine, engineVersion: run?.engineVersion,
    finishedAt: run?.finishedAt, validationContractId, completionScope: "KNOWN_SECURITIES_CONTRACT",
    notice: "核验仅覆盖所选数据与已登记口径；新增指标需要新的独立预期。",
  };
}

// Each POST crosses one durable boundary; GET only reads a signed Worker receipt.
export function createDurableAgentDelivery({ store, project, runner, artifactStore, persist, assertRunBudget = () => {}, reservationSeconds = 30 }) {
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
    return { item, plan };
  };
  async function create(agent, key) {
    const { run, revision } = source(agent);
    const existing = store.list("agent_delivery_task", project).find(t => t.mode === durableDeliveryMode && t.sourceAgentTaskId === agent.id && t.sourceSqlHash === revision.hash && ["QUEUED", "RUNNING", "SUCCEEDED"].includes(t.status));
    if (existing) return publicDeliveryTask(existing);
    const bundle = createDeliveryPackage({ run, revision, name: "客户资产 T+1 · Agent交付" });
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
    const passed = receipt.status === "SUCCEEDED" && receipt.engine === "Apache Spark" && receipt.engineVersion === plan.deployment.runtime.version && receipt.mainSqlExecuted === true && receipt.testDouble !== true && receipt.testSqlValidation?.passed === true && receipt.testSqlValidation.sqlHash === hash(item.files["tests.sql"]) && receipt.validation?.passed === true && contextIds.every(id => receipt.validation.regressions?.some(c => c.contextId === id && c.passed));
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
    if (expectedVersion !== task.version) throw fail(409, "交付任务已更新，请刷新后继续");
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
    task = change(task, { status: "CANCELLED", stage: "CANCELLED", finishedAt: new Date().toISOString() });
    if (task.verificationId) store.update("delivery_verification", task.verificationId, project, { status: "CANCELLED", finishedAt: task.finishedAt });
    await persist();
    if (task.remoteSubmission) await runner.cancel(task.remoteSubmission.prepared);
    return publicDeliveryTask(task);
  }
  return { create, advance, reconcile, cancel, bundleFor };
}
