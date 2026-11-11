import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { sha256 } from "../src/v2/delivery.mjs";
import { checkpointCaseScope, readCheckpoint, stop, uuid } from "../src/v2/live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract, liveCaseCheckpoint, liveLifecyclePlan, verifiedLiveTaskSnapshotBinding } from "../src/v2/live-lifecycle-evaluation.mjs";
import { liveEvidenceProvenance } from "../src/v2/live-lifecycle-provenance.mjs";
import { normalizeSessionBase } from "../src/v2/session-credential.mjs";
import { verifyV2MonthlyBillPages } from "./verify-v2-monthly-bill-pages.mjs";

const revisionPattern = /^[a-f0-9]{40}$/;
const id = value => typeof value === "string" && uuid.test(value);
const sourceRevision = value => typeof value === "string" && revisionPattern.test(value);
const firstPlan = () => liveLifecyclePlan(1, {contractId:currentLiveLifecycleContract.id});
const requestBody = definition => ({message:definition.request, sql:definition.seedSql, contextId:definition.contextId});
const requestHash = definition => sha256(JSON.stringify(requestBody(definition)));

function writeCheckpoint(path, state, initial = false) {
  const destination = initial ? path : path + "." + randomUUID() + ".tmp";
  let fd, created = false;
  try {
    fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    if (!initial) renameSync(destination, path);
    const parent = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!initial && created && existsSync(destination)) unlinkSync(destination);
  }
}

function snapshot(client, path) {
  const {state} = readCheckpoint(path, {privateFile:true});
  if (!id(state?.evaluationRunId)) stop("须使用原云端首例检查点");
  const {plan, contractId} = checkpointCaseScope(state, state.evaluationRunId);
  if (contractId !== currentLiveLifecycleContract.id || state.caseLimit !== 1 ||
      state.outcomes.length !== 1 || !sourceRevision(state.reviewedSource))
    stop("云端启动检查点与固定 v3 首例不一致");
  const base = new URL(normalizeSessionBase(client.baseUrl));
  if (base.pathname !== "/api/v2" || base.origin !== state.origin || client.projectId !== state.projectId)
    stop("读取或提交入口与原评测入口或项目不一致");
  if (base.protocol === "https:" && !client.sessionFile) stop("请使用绑定原入口的受保护会话文件");
  const [definition] = plan.selectedCases, [item] = state.outcomes, action = item.actions?.agent;
  if (!id(action?.key) || action.bodyHash !== requestHash(definition) ||
      !["PREPARED","SUBMITTING","UNKNOWN","CONFIRMED"].includes(action.status) ||
      (action.status === "PREPARED" && (item.taskId !== undefined || action.id !== undefined || state.submission !== undefined)) ||
      (action.status === "CONFIRMED" && (!id(action.id) || action.id !== item.taskId)))
    stop("原请求编号或请求体摘要不一致");
  return {state, definition, item, action};
}

function readCurrentBill(path, at) {
  const {state} = readCheckpoint(path, {privateFile:true});
  const checkedAt = Date.parse(state?.checkedAt);
  const month = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit"}).format(at);
  const bill = verifyV2MonthlyBillPages(state?.pages, 200);
  if (!Number.isFinite(checkedAt) || checkedAt > at || at - checkedAt >= 3600000 || !bill.ok || bill.billingCycle !== month ||
      !Number.isFinite(state.unsettledReserveCny) || state.unsettledReserveCny < 0 ||
      !Number.isFinite(state.maxIncrementCny) || state.maxIncrementCny <= 0 ||
      Number(bill.spendCny) + state.unsettledReserveCny + state.maxIncrementCny >= 200)
    stop("当前月完整账单、未结算预留或本次增量未通过预算核对");
  return {checkedAt:state.checkedAt, month, spendCny:Number(bill.spendCny), recordCount:bill.recordCount,
    unsettledReserveCny:state.unsettledReserveCny, maxIncrementCny:state.maxIncrementCny};
}

function submissionSnapshot(status, session, client, bill, at) {
  if (session?.authenticated !== true || session.role !== "ADMIN" || session.user?.projectId !== client.projectId ||
      !id(session.user.id) || session.developmentOnly !== true || session.developmentTaskOnly === true ||
      session.readOnly !== false || !(Date.parse(session.developmentStartsAt) <= at && at < Date.parse(session.developmentExpiresAt)))
    stop("当前会话未处于获准的新任务开发窗口");
  if (status?.mode !== "PUBLIC_INVITATION" || status.projectId !== client.projectId ||
      status.model?.configured !== true || status.spark?.available !== true || status.spark.healthVerified !== true ||
      status.spark.isolation !== "REMOTE_FUNCTION" || status.agentDevelopment?.durableEnabled !== true ||
      status.agentDevelopment.sqlMaxAttempts !== 3 || !Number.isSafeInteger(status.agentDevelopment.sqlTokenBudget) ||
      status.agentDevelopment.sqlTokenBudget < 1 || status.agentDevelopment.sqlTokenBudget > 32000)
    stop("云端模型、隔离 Spark 或持久 Agent 未就绪");
  const budget = status.budget, observed = budget?.account?.observedSpendCny;
  if (budget?.enforced !== "ALLOW" || budget.month !== bill.month || !Number.isFinite(observed) || observed < 0 ||
      !Number.isFinite(budget.hardLimitCny) || budget.hardLimitCny <= 0 ||
      Math.max(observed, bill.spendCny) + bill.unsettledReserveCny + bill.maxIncrementCny >= Math.min(200, budget.hardLimitCny))
    stop("云端用量门或本次账单核对未通过");
  const modelCalls = budget.model?.recordedCalls, remoteSparkRuns = budget.remoteSpark?.runCount;
  const remoteSparkSeconds = budget.remoteSpark?.seconds;
  if (![modelCalls, remoteSparkRuns].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isFinite(remoteSparkSeconds) || remoteSparkSeconds < 0)
    stop("当前云端模型与 Spark 用量基线未确认");
  return {actorId:session.user.id, windowExpiresAt:session.developmentExpiresAt, bill,
    usage:{modelCalls, remoteSparkRuns, remoteSparkSeconds}, sparkIsolation:status.spark.isolation};
}

function result(state, item, status, reason) {
  return {protocol:"shuduo-cloud-v3-start/v1", evaluationRunId:state.evaluationRunId, caseId:item.caseId,
    expectedCaseCount:currentLiveLifecycleContract.expectedCaseCount, status, ...(reason ? {reason} : {}),
    ...(id(item.taskId) ? {taskId:item.taskId} : {}), fullLifecycleE2E:false, publicDeployed:false};
}

function confirmReceipt({state, definition, item, action}, receipt, path) {
  const proof = liveEvidenceProvenance(receipt);
  if (proof.synthetic || proof.nonNative || proof.unconfirmed || receipt?.executionMode !== "DURABLE_SQL_AGENT_V1" ||
      !id(receipt.id) || (item.taskId !== undefined && item.taskId !== receipt.id))
    return false;
  const original = {...item, taskId:receipt.id, actions:{...item.actions, agent:{...action,id:receipt.id,status:"CONFIRMED"}}};
  if (!verifiedLiveTaskSnapshotBinding(definition, original, receipt)) return false;
  state.outcomes = [original];
  writeCheckpoint(path, state);
  return original;
}

export function prepareCloudV3Start(path, client, reviewedSource) {
  if (!isAbsolute(path) || !sourceRevision(reviewedSource)) stop("须提供受保护的绝对路径和已审阅源码版本");
  const base = new URL(normalizeSessionBase(client.baseUrl));
  if (base.pathname !== "/api/v2") stop("评测须绑定原 V2 API 入口");
  const plan = firstPlan(), [definition] = plan.selectedCases, evaluationRunId = randomUUID(), startedAt = new Date().toISOString();
  const item = {...liveCaseCheckpoint(definition, startedAt, plan.caseSetDigest, {contractId:plan.contract.id, evaluationRunId}),
    actions:{agent:{key:randomUUID(), bodyHash:requestHash(definition), status:"PREPARED"}}};
  const state = {evaluationRunId, contract:plan.contract, startedAt, caseSetDigest:plan.caseSetDigest,
    caseLimit:1, origin:base.origin, projectId:client.projectId, reviewedSource, outcomes:[item]};
  writeCheckpoint(path, state, true);
  return result(state, item, "PREPARED");
}

export async function continueCloudV3Start(path, client, {billPath, reconcile=false} = {}) {
  if (!isAbsolute(path)) stop("须使用原检查点的绝对路径");
  const lockPath = path + ".lock";
  let lock;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { stop("原检查点已有锁或不可写，请核对原进程"); }
  try {
    writeFileSync(lock, JSON.stringify({pid:process.pid}) + "\n");
    const original = snapshot(client, path), {state, definition, item, action} = original;
    if (action.status === "CONFIRMED") return result(state, item, "CREATION_CONFIRMED");
    if (reconcile) {
      if (!["UNKNOWN","SUBMITTING"].includes(action.status)) return result(state, item, "PREPARED");
      if (!id(state.submission?.actorId)) stop("原创建者尚未确认");
      const session = await client.request("/auth/session");
      if (session?.authenticated !== true || session.user?.id !== state.submission.actorId ||
          session.user?.projectId !== state.projectId)
        stop("当前会话与原任务创建者不一致");
      let receipt;
      try { receipt = await client.request(`/agent/requests/${action.key}`); }
      catch { return result(state, item, "PENDING", "ORIGINAL_CREATION_UNCONFIRMED"); }
      const saved = confirmReceipt(original, receipt, path);
      return saved ? result(state, saved, "CREATION_CONFIRMED") : result(state, item, "PENDING", "ORIGINAL_CREATION_UNCONFIRMED");
    }
    if (action.status !== "PREPARED") return result(state, item, "PENDING", "RECONCILE_ORIGINAL_CREATION");
    const bill = readCurrentBill(billPath, Date.now());
    const {status, session} = await client.request("/status?include=session");
    const now = Date.now(), submittedAt = new Date(now).toISOString();
    if (now - Date.parse(bill.checkedAt) >= 3600000) stop("当前月账单在预检期间到期");
    state.submission = submissionSnapshot(status, session, client, bill, now);
    state.startedAt = item.evaluationStartedAt = submittedAt;
    item.status = "PAUSED"; item.phase = "CODE_AND_DEBUG"; action.status = "SUBMITTING";
    writeCheckpoint(path, state);
    let receipt;
    try {
      receipt = await client.request("/agent/tasks", {method:"POST", body:requestBody(definition), idempotencyKey:action.key});
    } catch {
      action.status = "UNKNOWN";
      writeCheckpoint(path, state);
      return result(state, item, "PENDING", "RECONCILE_ORIGINAL_CREATION");
    }
    const saved = confirmReceipt(original, receipt, path);
    if (saved) return result(state, saved, "CREATION_CONFIRMED");
    action.status = "UNKNOWN";
    writeCheckpoint(path, state);
    return result(state, item, "PENDING", "RECONCILE_ORIGINAL_CREATION");
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
