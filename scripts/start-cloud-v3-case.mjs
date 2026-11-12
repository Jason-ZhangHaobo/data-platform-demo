import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { agentExecutionEvidencePath, validSettledDevelopmentFailure } from "../src/v2/agent-execution-evidence.mjs";
import { durableDeliveryMode } from "../src/v2/agent-development-workflow.mjs";
import { readCloudV3Review } from "../src/v2/cloud-v3-review.mjs";
import { cloudV3BaseCases, cloudV3CheckpointCase, cloudV3PredecessorApprovals, cloudV3UsageKeys } from "../src/v2/cloud-v3-case-selection.mjs";
import { getContext, validationFamilyForContext } from "../src/v2/context.mjs";
import { validateConsumerSource } from "../src/v2/consumer-source.mjs";
import { sha256, validateDeliveryPackage } from "../src/v2/delivery.mjs";
import { deliveryPreparationBody, deliveryPreparationHashMatches, deliveryPreparationRequirement } from "../src/v2/delivery-preparation-request.mjs";
import { bindExternalConsumption } from "../src/v2/external-consumption-binding.mjs";
import { readCheckpoint, stop, uuid } from "../src/v2/live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract, liveCaseCheckpoint, liveLifecyclePlan, verifiedLiveTaskSnapshotBinding } from "../src/v2/live-lifecycle-evaluation.mjs";
import { checkedLiveExecutionProjection } from "../src/v2/live-lifecycle-execution.mjs";
import { privateReleasePendingStage } from "../src/v2/private-release-stage.mjs";
import { liveEvidenceProvenance, nonLiveModelLabel } from "../src/v2/live-lifecycle-provenance.mjs";
import { publicationAttestationKeys, publicationPreflightPath, publicationReadPath, publicationRequestReceiptPath } from "../src/v2/publication-request.mjs";
import { normalizeSessionBase } from "../src/v2/session-credential.mjs";
import { serviceSourceReadPath } from "../src/v2/service-source-request.mjs";
import { sqlRequirementProtocol } from "../src/v2/sql-requirement-contract.mjs";
import { verifyV2MonthlyBillPages } from "./verify-v2-monthly-bill-pages.mjs";
import { validateConsumerPlan } from "./verify-service-consumer.mjs";
import { cloudWindowApplicationBinding, cloudWindowCheckpointBinding, firstCloudWindowReceiptProtocol, nextCloudWindowReceiptProtocol, preparedFirstCloudBinding, validFirstCloudBinding } from "./first-cloud-v3-window.mjs";
import { developmentRequestDigest } from "../src/v2/public-development-access.mjs";
import { withCloudCheckpoint } from "./cloud-v3-checkpoint-lock.mjs";
import { cloudV3CompletionScope, cloudV3FailureReceipt, readCloudV3BaseCases } from "./cloud-v3-run.mjs";
import { boundedBytes } from "./control-code-transport.mjs";
import { inspectedControlEntryScript, WEB_ENTRY_SCRIPT_LIMIT, WEB_INDEX_LIMIT } from "./control-web-entry.mjs";

const revisionPattern = /^[a-f0-9]{40}$/;
const id = value => typeof value === "string" && uuid.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
  const {definition,item}=cloudV3CheckpointCase(state), action=item.actions?.agent;
  if (!sourceRevision(state.reviewedSource)) stop("云端检查点未绑定已审阅源码");
  const base = new URL(normalizeSessionBase(client.baseUrl));
  if (base.pathname !== "/api/v2" || base.origin !== state.origin || client.projectId !== state.projectId)
    stop("读取或提交入口与原评测入口或项目不一致");
  if (base.protocol === "https:" && !client.sessionFile) stop("请使用绑定原入口的受保护会话文件");
  if (!id(action?.key) || action.bodyHash !== requestHash(definition) ||
      !["PREPARED","SUBMITTING","UNKNOWN","CONFIRMED"].includes(action.status) ||
      (action.status === "PREPARED" && (item.taskId !== undefined || action.id !== undefined || state.submission !== undefined)) ||
      (action.status === "CONFIRMED" && (!id(action.id) || action.id !== item.taskId)) ||
      (state.previousCase && action.status!=="PREPARED" && !Number.isFinite(Date.parse(state.submission?.submittedAt))))
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
  return {actorId:session.user.id, windowExpiresAt:session.developmentExpiresAt, bill,
    usage:budgetBaseline(status.budget,bill), sparkIsolation:status.spark.isolation};
}

function budgetBaseline(budget, bill) {
  const observed = budget?.account?.observedSpendCny;
  if (budget?.enforced !== "ALLOW" || budget.month !== bill.month || !Number.isFinite(observed) || observed < 0 ||
      !Number.isFinite(budget.hardLimitCny) || budget.hardLimitCny <= 0 ||
      Math.max(observed, bill.spendCny) + bill.unsettledReserveCny + bill.maxIncrementCny >= Math.min(200, budget.hardLimitCny))
    stop("云端用量门或本次账单核对未通过");
  const modelCalls = budget.model?.recordedCalls, remoteSparkRuns = budget.remoteSpark?.runCount;
  const remoteSparkSeconds = budget.remoteSpark?.seconds;
  if (![modelCalls, remoteSparkRuns].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isFinite(remoteSparkSeconds) || remoteSparkSeconds < 0)
    stop("当前云端模型与 Spark 用量基线未确认");
  return {modelCalls, remoteSparkRuns, remoteSparkSeconds};
}

function result(state, item, status, reason) {
  return {protocol:"shuduo-cloud-v3-start/v1", evaluationRunId:state.evaluationRunId, caseId:item.caseId,
    expectedCaseCount:currentLiveLifecycleContract.expectedCaseCount, status, ...(reason ? {reason} : {}),
    ...(id(item.taskId) ? {taskId:item.taskId} : {}), fullLifecycleE2E:false, publicDeployed:false};
}

function confirmReceipt({state, definition, item, action}, receipt, path) {
  const proof = liveEvidenceProvenance(receipt);
  if (proof.synthetic || proof.nonNative || proof.unconfirmed || receipt?.executionMode !== "DURABLE_SQL_AGENT_V1" ||
      !id(receipt.id) || (item.taskId !== undefined && item.taskId !== receipt.id) ||
      (state.previousCase && !(Date.parse(receipt.createdAt)>=Date.parse(state.submission.submittedAt))))
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

export function prepareCloudV3Next(path,client,{firstPath,completionPath,recordsPath,reviewedSource}={}) {
  if (!isAbsolute(path ?? "") || !sourceRevision(reviewedSource)) stop("须提供续接检查点和已审阅源码版本");
  const {original,fullPlan,entries,approvals,reserveCny,usageFloor}=readCloudV3BaseCases(firstPath,{completionPath,recordsPath});
  const {state:first}=original, parent=entries.at(-1);
  const base=new URL(normalizeSessionBase(client.baseUrl));
  if (base.pathname!=="/api/v2" ||
      base.origin!==first.origin || first.projectId!==client.projectId ||
      !(base.protocol==="https:"?["INVITED_CLOUD_MATCHED","INVITED_CLOUD_SETTLED_FAILURE"]:
        ["LOCAL_MATCHED_ONLY","LOCAL_SETTLED_FAILURE_ONLY"]).includes(parent.completion?.scope))
    stop("须核对同一评测的上一例结算回执及原入口");
  const definition=cloudV3BaseCases()[entries.length], caseLimit=entries.length+1;
  if (!definition) stop("固定基础案例已全部记录");
  const previousCase={checkpointDigest:sha256(parent.checkpoint.text),completionDigest:parent.completion.completionDigest,
    approvalDigest:parent.checkpoint.state.submission?.windowApprovalDigest ?? null,reserveCny,
    ...(caseLimit>2?{approvalDigests:approvals}:{}),
    ...(usageFloor&&(caseLimit>2||parent.completion.failure)?{usageFloor}:{})};
  // The same original evaluation always yields the same request key, even
  // if a local preparation is interrupted and recreated in another file.
  const entropy=sha256(JSON.stringify([first.evaluationRunId,entries[0].item.actions.agent.key,definition.id]));
  const key=[entropy.slice(0,8),entropy.slice(8,12),"4"+entropy.slice(13,16),"8"+entropy.slice(17,20),entropy.slice(20,32)].join("-");
  const item={...liveCaseCheckpoint(definition,first.startedAt,fullPlan.caseSetDigest,{
    contractId:fullPlan.contract.id,evaluationRunId:first.evaluationRunId,
  }),actions:{agent:{key,bodyHash:requestHash(definition),status:"PREPARED"}}};
  const state={evaluationRunId:first.evaluationRunId,contract:fullPlan.contract,startedAt:first.startedAt,caseSetDigest:fullPlan.caseSetDigest,
    caseLimit,origin:first.origin,projectId:first.projectId,reviewedSource,previousCase,outcomes:[item]};
  cloudV3CheckpointCase(state);
  writeCheckpoint(path,state,true);
  return result(state,item,"PREPARED");
}

function mergedApplicationTree(revision, cwd) {
  if (!sourceRevision(revision)) stop("须使用完整的已合入应用源码 SHA");
  const git = (...args) => execFileSync("git", args, {cwd, encoding:"utf8", timeout:5000,
    env:{...process.env,GIT_NO_LAZY_FETCH:"1",GIT_NO_REPLACE_OBJECTS:"1"}, stdio:["ignore","pipe","pipe"]}).trim();
  try {
    if (git("rev-parse", "--verify", revision + "^{commit}") !== revision) throw Error();
    git("merge-base", "--is-ancestor", revision, "refs/remotes/origin/main");
    const tree = git("rev-parse", "--verify", revision + "^{tree}");
    if (!sourceRevision(tree)) throw Error();
    return tree;
  } catch {
    stop("无法在本机 origin/main 确认确切应用源码及其 Git 树");
  }
}

function sourceRebindReview(checkpoint, source, applicationTree) {
  return {protocol:"SHUDUO_FIRST_V3_SOURCE_REVIEW_V1", checkpoint, source, applicationTree};
}

function rebindableFirstCloudCheckpoint(path) {
  const {state,text} = readCheckpoint(path,{privateFile:true});
  const checkpoint = preparedFirstCloudBinding(state,text);
  const [item] = state.outcomes;
  if (item.status !== "NOT_RUN" || item.phase !== "REQUIREMENT" || Object.keys(item.actions).length !== 1)
    stop("首例已有其他执行记录，须按原编号核对");
  return {state,checkpoint};
}

export function exportCloudV3SourceReview(path, source, outPath, {cwd = process.cwd()} = {}) {
  if (!isAbsolute(outPath)) stop("须使用受保护的绝对路径保存源码审阅");
  const {checkpoint} = rebindableFirstCloudCheckpoint(path);
  if (source === checkpoint.sourceRevision) stop("新源码与原检查点一致");
  const applicationTree = mergedApplicationTree(source,cwd);
  const review = sourceRebindReview(checkpoint,source,applicationTree);
  writeCheckpoint(outPath,review,true);
  return {status:"SOURCE_REVIEW_EXPORTED", evaluationRunId:checkpoint.evaluationRunId,
    previousSource:checkpoint.sourceRevision, source, applicationTree,
    reviewDigest:sha256(readCheckpoint(outPath,{privateFile:true}).text), submissionState:"PREPARED"};
}

export async function rebindCloudV3PreparedSource(path, reviewPath, reviewDigest, {cwd = process.cwd()} = {}) {
  if (!digest(reviewDigest)) stop("须明确确认已审阅文件的 SHA-256");
  const {state:review,text:reviewText} = readCheckpoint(reviewPath,{privateFile:true});
  if (sha256(reviewText) !== reviewDigest) stop("源码审阅文件与确认摘要不一致");
  if (!validFirstCloudBinding(review?.checkpoint)) stop("源码审阅未绑定原首例");
  const applicationTree = mergedApplicationTree(review?.source,cwd);
  if (!isDeepStrictEqual(review,sourceRebindReview(review.checkpoint,review.source,applicationTree)))
    stop("源码审阅文件与确切 Git 树不一致");
  return withCloudCheckpoint(path,() => {
    const {state,checkpoint} = rebindableFirstCloudCheckpoint(path);
    const history = state.sourceRebinds ?? [];
    if (!Array.isArray(history)) stop("原源码审阅历史不可核对");
    const latest = history.at(-1);
    const outcome = status => ({status,evaluationRunId:checkpoint.evaluationRunId,
      source:review.source,applicationTree,reviewDigest,submissionState:"PREPARED"});
    if (checkpoint.sourceRevision === review.source && latest?.reviewDigest === reviewDigest) {
      const beforeAudit = {...state};
      if (history.length === 1) delete beforeAudit.sourceRebinds;
      else beforeAudit.sourceRebinds = history.slice(0,-1);
      if (latest.from !== review.checkpoint.sourceRevision || latest.to !== review.source || latest.applicationTree !== applicationTree ||
          latest.previousCheckpointDigest !== review.checkpoint.checkpointDigest ||
          latest.resultStateDigest !== sha256(JSON.stringify(beforeAudit))) stop("原换绑结果已变化，请核对检查点");
      return outcome("SOURCE_ALREADY_REBOUND");
    }
    if (!isDeepStrictEqual(checkpoint,review.checkpoint) || checkpoint.sourceRevision === review.source)
      stop("原检查点、请求或旧源码已变化，请重新核对审阅");
    const updated = {...state,reviewedSource:review.source};
    const audit = {from:checkpoint.sourceRevision,to:review.source,applicationTree,reviewDigest,
      previousCheckpointDigest:checkpoint.checkpointDigest,resultStateDigest:sha256(JSON.stringify(updated)),
      confirmedAt:new Date().toISOString()};
    updated.sourceRebinds = [...history,audit];
    writeCheckpoint(path,updated);
    return outcome("SOURCE_REBOUND");
  });
}

async function requireOriginalCreator(state, client, session) {
  if (!id(state.submission?.actorId)) stop("原创建者尚未确认");
  session ??= await client.request("/auth/session");
  if (session?.authenticated !== true || session.user?.id !== state.submission.actorId ||
      session.user?.projectId !== state.projectId)
    stop("当前会话与原任务创建者不一致");
  return session;
}

function assertDeliveryWindow(session, taskId, bill) {
  const now = Date.now();
  if (session.role !== "ADMIN" || session.developmentOnly !== true || session.readOnly !== false ||
      !(Date.parse(session.developmentStartsAt) <= now && now < Date.parse(session.developmentExpiresAt)) ||
      (session.developmentTaskOnly === true && session.developmentTaskId !== taskId) ||
      (bill && now - Date.parse(bill.checkedAt) >= 3600000))
    stop("原任务未处于获准交付操作的开发窗口");
}

function checkedWindowReceipt(path,windowPath,applicationPath,client,bill,previousCase) {
  if (!windowPath) {
    if (previousCase || new URL(client.baseUrl).protocol==="https:" || applicationPath) stop("云端提交须提供本案例的独立开发窗口回执");
    return;
  }
  const {state:receipt}=readCheckpoint(windowPath,{privateFile:true}), bounds=receipt?.bill;
  const starts=Date.parse(receipt?.startsAt), ends=Date.parse(receipt?.expiresAt), checked=Date.parse(bounds?.checkedAt);
  const now=Date.now();
  if (receipt?.protocol!==(previousCase?nextCloudWindowReceiptProtocol:firstCloudWindowReceiptProtocol) ||
      !digest(receipt.approvalDigest) || cloudV3PredecessorApprovals(previousCase).includes(receipt.approvalDigest) ||
      !isDeepStrictEqual(receipt.checkpoint,cloudWindowCheckpointBinding(path)) ||
      !Number.isFinite(starts) || !Number.isFinite(ends) || !(starts<=now&&now<ends&&ends-starts<=7200000) ||
      !Number.isFinite(checked) || checked>starts || starts-checked>=3600000 ||
      bounds.month!==bill.month || !digest(bounds.pagesDigest) || !Number.isFinite(bounds.spendCny) || bounds.spendCny<0 ||
      !Number.isSafeInteger(bounds.recordCount) || bounds.recordCount<0 ||
      bounds.unsettledReserveCny!==bill.unsettledReserveCny || bounds.maxIncrementCny!==bill.maxIncrementCny ||
      bounds.maxIncrementCny>5 || bounds.spendCny+bounds.unsettledReserveCny+bounds.maxIncrementCny>=200)
    stop("独立开发窗口、原检查点或预算范围不一致");
  if (previousCase && bill.unsettledReserveCny<previousCase.reserveCny) stop("须保留原评测未结算预留");
  if (!applicationPath) stop("云端提交须提供独立验包文件");
  const {state:inspection}=readCheckpoint(applicationPath,{privateFile:true});
  const application = cloudWindowApplicationBinding(inspection,receipt.checkpoint);
  const crc64 = receipt.application?.crc64;
  if (!application || typeof crc64!=="string" || !/^\d{1,30}$/.test(crc64) ||
      !isDeepStrictEqual(receipt.application,{...application,crc64}))
    stop("窗口回执与独立验包证据不一致");
  return receipt;
}

async function readFirstWindowAsset(client, asset, signal) {
  const started = performance.now();
  let response, headersMs;
  const result = (status, reason, extra = {}) => ({
    status, ...(reason ? {reason} : {}),
    ...(response ? {httpStatus:response.status,headersMs} : {}),
    elapsedMs: Math.round(performance.now() - started), ...extra,
  });
  try {
    const url = new URL(asset.path,client.baseUrl);
    response = await client.fetchImpl(url.href,{
      method:"GET", redirect:"error", cache:"no-store", credentials:"omit", signal,
      headers:{Accept:asset.accept,"Cache-Control":"no-cache"},
    });
    headersMs = Math.round(performance.now() - started);
    if (response.status !== 200 || !asset.contentType.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      return result("UNCONFIRMED",asset.invalidResponse);
    }
    const bytes = await boundedBytes(response,asset.limit);
    return bytes.length === asset.bytes && sha256(bytes) === asset.digest
      ? result("MATCHED",undefined,{observedBytes:bytes.length})
      : result("MISMATCH",`${asset.label}_CONTENT_MISMATCH`,{observedBytes:bytes.length});
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    const reason = signal.aborted ? "TIMEOUT" : error?.safeCode === "OBJECT_TOO_LARGE" ? "TOO_LARGE" : "TRANSPORT_UNCONFIRMED";
    return result("UNCONFIRMED",`${asset.label}_${reason}`);
  }
}

function readFirstWindowEntry(client, application, signal) {
  return readFirstWindowAsset(client,{
    path:"/v2/", accept:"text/html", contentType:/^text\/html(?:;|$)/i,
    invalidResponse:"ENTRY_NOT_HTML", label:"ENTRY", limit:WEB_INDEX_LIMIT,
    bytes:application.webIndexBytes, digest:application.webIndexSha256,
  },signal);
}

async function verifyFirstWindowEntry(client, application) {
  const probe = await readFirstWindowEntry(client, application, AbortSignal.timeout(client.timeoutMs ?? 15000));
  if (probe.status === "MISMATCH")
    stop("正式入口 HTML 与验包证据不一致，请保留原请求和检查点");
  if (probe.status !== "MATCHED")
    stop("正式入口 HTML 未能核对，请保留原请求和检查点");
}

export async function checkCloudV3PreparedEntry(path, client, applicationPath, timeoutMs = client.timeoutMs ?? 15000, zipPath) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    stop("首例只读入口预检的超时须为 1—30000 毫秒");
  const checkpoint = cloudWindowCheckpointBinding(path);
  const base = new URL(normalizeSessionBase(client.baseUrl));
  if (base.pathname !== "/api/v2" || base.origin !== checkpoint.origin || client.projectId !== checkpoint.projectId)
    stop("入口预检须使用原评测入口和项目");
  const {state:inspection} = readCheckpoint(applicationPath,{privateFile:true});
  const application = cloudWindowApplicationBinding(inspection,checkpoint);
  const report = {protocol:"shuduo-cloud-v3-entry-preflight/v1",scope:"READ_ONLY",checkpointStatus:"PREPARED",
    checkpointDigest:checkpoint.checkpointDigest,sourceRevision:checkpoint.sourceRevision,entryRequests:0,agentSubmissions:0,
    ...(zipPath ? {scriptRequests:0} : {})};
  if (!application) return {...report,status:"UNCONFIRMED",reason:"APPLICATION_BINDING_MISMATCH"};
  let expectedScript;
  if (zipPath) {
    try { expectedScript = inspectedControlEntryScript(zipPath,application); }
    catch (error) {
      return {...report,status:"UNCONFIRMED",reason:error?.safeCode === "APPLICATION_ZIP_MISMATCH"
        ? "APPLICATION_ZIP_MISMATCH" : "APPLICATION_ENTRY_INVALID"};
    }
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const probe = await readFirstWindowEntry(client,application,signal);
  let script;
  if (expectedScript && probe.status === "MATCHED") {
    if (!signal.aborted) {
      report.scriptRequests = 1;
      script = await readFirstWindowAsset(client,{
        ...expectedScript, accept:"text/javascript, application/javascript",
        contentType:/^(?:text|application)\/javascript(?:;|$)/i,
        invalidResponse:"ENTRY_SCRIPT_NOT_JAVASCRIPT", label:"ENTRY_SCRIPT", limit:WEB_ENTRY_SCRIPT_LIMIT,
      },signal);
    } else {
      script = {status:"UNCONFIRMED",reason:"ENTRY_SCRIPT_TIMEOUT"};
    }
  }
  let unchanged = false;
  try { unchanged = cloudWindowCheckpointBinding(path).checkpointDigest === checkpoint.checkpointDigest; }
  catch { /* An updated checkpoint needs its own preflight. */ }
  return {...report,entryRequests:1,applicationInspectionDigest:application.inspectionDigest,
    ...probe,...(script?{htmlStatus:probe.status,script,status:script.status,...(script.reason?{reason:script.reason}:{})}:{}),
    ...(!unchanged?{status:"UNCONFIRMED",reason:"CHECKPOINT_CHANGED"}:{})};
}

export async function continueCloudV3Start(path, client, {billPath, windowPath, applicationPath, reconcile=false} = {}) {
  return withCloudCheckpoint(path, async () => {
    const original = snapshot(client, path), {state, definition, item, action} = original;
    if (action.status === "CONFIRMED") return result(state, item, "CREATION_CONFIRMED");
    if (reconcile) {
      if (!["UNKNOWN","SUBMITTING"].includes(action.status)) return result(state, item, "PREPARED");
      await requireOriginalCreator(state, client);
      let receipt;
      try { receipt = await client.request(`/agent/requests/${action.key}`); }
      catch { return result(state, item, "PENDING", "ORIGINAL_CREATION_UNCONFIRMED"); }
      const saved = confirmReceipt(original, receipt, path);
      return saved ? result(state, saved, "CREATION_CONFIRMED") : result(state, item, "PENDING", "ORIGINAL_CREATION_UNCONFIRMED");
    }
    if (action.status !== "PREPARED") return result(state, item, "PENDING", "RECONCILE_ORIGINAL_CREATION");
    const bill = readCurrentBill(billPath, Date.now());
    const window = checkedWindowReceipt(path,windowPath,applicationPath,client,bill,state.previousCase);
    const {status, session} = await client.request("/status?include=session");
    if (window && (session?.developmentStartsAt!==window.startsAt || session?.developmentExpiresAt!==window.expiresAt ||
        !(status?.budget?.account?.observedSpendCny>=window.bill.spendCny)))
      stop("实际运行时与原独立开发窗口不一致");
    if (state.previousCase && (session?.developmentRequestOnly!==true ||
        session.developmentRequestDigest!==developmentRequestDigest(window.checkpoint.requestKeyHash,action.bodyHash)))
      stop("运行时尚未绑定本案例的确切请求");
    const submission = submissionSnapshot(status,session,client,bill,Date.now());
    const floor=state.previousCase?.usageFloor;
    if (floor && (bill.month<floor.month ||
        (floor.month===bill.month && cloudV3UsageKeys.some(key=>key==="remoteSparkSeconds" ?
          Math.round(submission.usage[key]*1000)<Math.round(floor[key]*1000) : submission.usage[key]<floor[key]))))
      stop("本月模型或 Spark 用量低于原评测已记录的基线");
    if (window) await verifyFirstWindowEntry(client,window.application);
    const now = Date.now(), submittedAt = new Date(now).toISOString();
    if (now - Date.parse(bill.checkedAt) >= 3600000 || now >= Date.parse(submission.windowExpiresAt))
      stop("当前账单或开发窗口在预检期间到期");
    state.submission = {...submission,
      ...(state.previousCase?{submittedAt}:{}),
      ...(window?{windowApprovalDigest:window.approvalDigest,application:window.application}:{})};
    if (!state.previousCase) state.startedAt = item.evaluationStartedAt = submittedAt;
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
  }, {reconcile});
}

function verifiedDevelopmentCode(definition, view, execution) {
  const {development} = view, {spark, model} = execution, family = validationFamilyForContext(definition.contextId);
  if (!development || execution.evidence !== "STORED_METADATA" || spark.state !== "RESULT_RECORDED" ||
      spark.resultStatus !== "SUCCEEDED" || development.revisionId !== spark.revisionId ||
      development.revisionHash !== spark.revisionHash || development.runId !== spark.runId ||
      development.engine !== "Apache Spark" || development.engineVersion !== "3.5.9" ||
      development.validationContractId !== family.id || development.regressionCount !== family.contextIds.length ||
      typeof development.model !== "string" || !development.model || development.model.length > 200 ||
      nonLiveModelLabel(development.model) || !Number.isSafeInteger(model.ledgerTokens) || model.ledgerTokens > 32000 ||
      !Number.isSafeInteger(model.reportedTokens) || model.unattributedTokens === null || model.attempts < 1) return;
  const requirement = development.requirementBinding;
  if (requirement !== undefined && (requirement?.protocol !== sqlRequirementProtocol || requirement.taskId !== view.taskId ||
      !digest(requirement.basisDigest) || !digest(requirement.reportDigest))) return;
  return {sourceKind:"AGENT", taskId:view.taskId, createdAt:view.taskCreatedAt, revisionId:spark.revisionId,
    revisionHash:spark.revisionHash, runId:spark.runId, model:development.model, modelAttempts:model.attempts,
    reportedTokens:model.reportedTokens, accountedTokens:model.ledgerTokens, reservedTokens:model.reservedTokens,
    unattributedTokens:model.unattributedTokens, contextId:definition.contextId, validationContractId:family.id,
    ...(requirement ? {requirementBinding:{protocol:requirement.protocol, taskId:requirement.taskId,
      basisDigest:requirement.basisDigest, reportDigest:requirement.reportDigest}} : {})};
}

const rehearsalStages = new Set(["FILE_REHEARSAL_SUBMITTING","FILE_REHEARSAL_RUNNING","FILE_REHEARSAL_FAILED","AWAITING_ENGINEER_REVIEW","CANCELLED"]);

function bindRehearsal(item, receipt) {
  const rehearsal = receipt.rehearsal, old = item.rehearsal, action = item.actions.rehearsal;
  if (!rehearsal) return !old && (!action || receipt.verificationId === undefined);
  if (!id(rehearsal.id) || rehearsal.id !== receipt.verificationId || !rehearsalStages.has(receipt.stage) ||
      rehearsal.status !== receipt.status || !["RUNNING","SUCCEEDED","FAILED","CANCELLED"].includes(rehearsal.status) ||
      !Number.isFinite(rehearsal.reservedDurationMs) || rehearsal.reservedDurationMs <= 0 ||
      (rehearsal.status === "SUCCEEDED" && (receipt.stage !== "AWAITING_ENGINEER_REVIEW" || receipt.actualExecution !== true)) ||
      (old && (old.id !== rehearsal.id || old.reservedDurationMs !== rehearsal.reservedDurationMs ||
        (old.status !== "RUNNING" && old.status !== rehearsal.status))) ||
      (action?.id !== undefined && action.id !== rehearsal.id)) return false;
  item.rehearsal = {id:rehearsal.id, status:rehearsal.status, stage:receipt.stage,
    reservedDurationMs:rehearsal.reservedDurationMs,
    ...(Number.isFinite(rehearsal.durationMs) && rehearsal.durationMs >= 0 ? {durationMs:rehearsal.durationMs} : {})};
  if (action) item.actions.rehearsal = {...action, id:rehearsal.id, status:"CONFIRMED"};
  return true;
}

function bindOriginalDelivery(item, code, receipt) {
  const action = item.actions.delivery;
  const proof = liveEvidenceProvenance(receipt);
  if (proof.synthetic || proof.nonNative || proof.unconfirmed || !id(receipt?.id) || receipt.mode !== durableDeliveryMode ||
      (action.id !== undefined && action.id !== receipt.id) || receipt.sourceAgentTaskId !== item.taskId ||
      receipt.sourceRevisionId !== code.revisionId || receipt.sourceSqlHash !== code.revisionHash ||
      receipt.sourceRunId !== code.runId || !id(receipt.packageId) || !digest(receipt.packageDigest) ||
      (action.packageId !== undefined && action.packageId !== receipt.packageId) ||
      (action.packageDigest !== undefined && action.packageDigest !== receipt.packageDigest) ||
      !isDeepStrictEqual(receipt.sourceRequirementBinding,deliveryPreparationRequirement(code)) ||
      !bindRehearsal(item,receipt))
    return;
  item.actions.delivery = {...action, id:receipt.id, status:"CONFIRMED",
    packageId:receipt.packageId, packageDigest:receipt.packageDigest};
  return {status:"CONFIRMED", id:receipt.id, packageId:receipt.packageId, packageDigest:receipt.packageDigest,
    ...(Number.isSafeInteger(receipt.version) && receipt.version > 0 ? {version:receipt.version} : {}),
    ...(receipt.stage === "PACKAGE_PERSISTING" ? {storagePending:true} : {}),
    ...(receipt.stage === "PACKAGE_READY" ? {readyForRehearsal:true} : {}),
    ...(item.rehearsal ? {rehearsal:item.rehearsal} : {})};
}

async function reconcileOriginalDelivery(client, item, code) {
  const action = item.actions.delivery;
  if (!action || action.status === "PREPARED") return {status:"REQUEST_NOT_SUBMITTED"};
  if (!id(action.key) || !deliveryPreparationHashMatches(action.bodyHash,code) ||
      !["SUBMITTING","UNKNOWN","CONFIRMED"].includes(action.status) ||
      (action.status === "CONFIRMED" && !id(action.id))) return {status:"UNCONFIRMED"};
  let receipt;
  try { receipt = await client.request(`/agent/tasks/${item.taskId}/delivery-requests/${action.key}`); }
  catch { return {status:"PENDING"}; }
  return bindOriginalDelivery(item,code,receipt) ?? {status:"UNCONFIRMED"};
}

export async function prepareCloudV3Delivery(path, client, billPath) {
  return withCloudCheckpoint(path, async () => {
    const {state, item, action} = snapshot(client,path);
    const response = (status, reason) => result(state,item,status,reason);
    if (action.status !== "CONFIRMED" || item.phase !== "DELIVERY_PREPARATION" || item.code?.taskId !== item.taskId)
      return response("PENDING","DEVELOPMENT_RESULT_UNCONFIRMED");
    const body = deliveryPreparationBody(item.code);
    if (item.actions.delivery !== undefined)
      return response("PENDING","INSPECT_ORIGINAL_DELIVERY");
    const bill = readCurrentBill(billPath,Date.now());
    const startupBill = state.submission?.bill;
    if (!Number.isFinite(startupBill?.unsettledReserveCny) || bill.unsettledReserveCny < startupBill.unsettledReserveCny)
      stop("交付准备须保留原评测的未结算预留");
    assertDeliveryWindow(await requireOriginalCreator(state,client),item.taskId,bill);
    const deliveryAction = {key:randomUUID(),bodyHash:sha256(JSON.stringify(body)),status:"SUBMITTING",bill};
    item.actions.delivery = deliveryAction;
    writeCheckpoint(path,state);
    let receipt;
    try {
      receipt = await client.request(`/agent/tasks/${item.taskId}/prepare-delivery`,
        {method:"POST",body,idempotencyKey:deliveryAction.key});
    } catch {
      deliveryAction.status = "UNKNOWN";
      writeCheckpoint(path,state);
      return response("PENDING","INSPECT_ORIGINAL_DELIVERY");
    }
    const delivery = bindOriginalDelivery(item,item.code,receipt);
    if (!delivery) deliveryAction.status = "UNKNOWN";
    writeCheckpoint(path,state);
    return delivery ? {...response("DELIVERY_CREATION_CONFIRMED"), delivery}
      : response("PENDING","INSPECT_ORIGINAL_DELIVERY");
  });
}

export async function advanceCloudV3Rehearsal(path, client, {billPath, settle=false} = {}) {
  return withCloudCheckpoint(path, async () => {
    const {state,item,action} = snapshot(client,path), code = item.code, original = item.actions.delivery;
    const response = (status,reason) => result(state,item,status,reason);
    if (action.status !== "CONFIRMED" || code?.taskId !== item.taskId || original?.status !== "CONFIRMED" ||
        !id(original.id) || !id(original.packageId) || !digest(original.packageDigest))
      return response("PENDING","ORIGINAL_DELIVERY_UNCONFIRMED");
    if (!settle && (item.actions.rehearsal || item.rehearsal))
      return response("PENDING","INSPECT_ORIGINAL_REHEARSAL");

    let session, bill, usage;
    if (settle) {
      session = await requireOriginalCreator(state,client);
    } else {
      bill = readCurrentBill(billPath,Date.now());
      const reserve = state.submission?.bill?.unsettledReserveCny;
      if (!Number.isFinite(reserve) || bill.unsettledReserveCny < Math.max(reserve,original.bill?.unsettledReserveCny ?? 0))
        stop("文件演练须保留原评测和交付的未结算预留");
      const current = await client.request("/status?include=session");
      if (!current.session) stop("原创建者会话未确认");
      session = await requireOriginalCreator(state,client,current.session);
      const {status} = current;
      if (status?.mode !== "PUBLIC_INVITATION" || status.projectId !== state.projectId ||
          status.spark?.available !== true || status.spark.healthVerified !== true || status.spark.isolation !== "REMOTE_FUNCTION" ||
          status.agentDevelopment?.durableDeliveryEnabled !== true)
        stop("云端隔离 Spark 文件演练未就绪");
      usage = budgetBaseline(status.budget,bill);
    }
    assertDeliveryWindow(session,item.taskId,bill);
    const before = JSON.stringify(item);
    const delivery = await reconcileOriginalDelivery(client,item,code);
    if (JSON.stringify(item) !== before) writeCheckpoint(path,state);
    if (delivery.status !== "CONFIRMED" || !delivery.version)
      return response("PENDING","ORIGINAL_DELIVERY_UNCONFIRMED");
    if (settle ? !delivery.rehearsal : !delivery.readyForRehearsal)
      return response("PENDING","INSPECT_ORIGINAL_REHEARSAL");
    if (settle && delivery.rehearsal.status !== "RUNNING")
      return {...response("REHEARSAL_RECORDED"),delivery};

    const rehearsal = {packageId:delivery.packageId, packageDigest:delivery.packageDigest,
      ...(settle ? {verificationId:delivery.rehearsal.id} : {})};
    if (!settle) {
      item.actions.rehearsal = {status:"SUBMITTING", deliveryId:delivery.id,
        packageId:delivery.packageId, packageDigest:delivery.packageDigest, expectedVersion:delivery.version, bill, usage};
      writeCheckpoint(path,state);
    }
    let saved;
    try {
      const receipt = await client.request(`/agent/deliveries/${delivery.id}/advance`,{
        method:"POST",body:{expectedVersion:delivery.version,rehearsal},
      });
      saved = bindOriginalDelivery(item,code,receipt);
    } catch {
      // Recovery uses the original delivery receipt, never another submission.
    }
    if (saved?.rehearsal) {
      writeCheckpoint(path,state);
      return {...response("REHEARSAL_RECORDED"),delivery:saved};
    }
    if (!settle) {
      item.actions.rehearsal.status = "UNKNOWN";
      writeCheckpoint(path,state);
    }
    return response("PENDING","INSPECT_ORIGINAL_REHEARSAL");
  });
}

async function checkedPublicationPreflight(path, client, item) {
  const bound = await readCloudV3Review(path,client);
  if (bound.status !== "REVIEW_EVIDENCE_BOUND" || item.rehearsal?.status !== "SUCCEEDED" ||
      item.rehearsal.id !== bound.verificationId)
    stop("须先核对原交付包与成功演练");
  const selector = {sourceKind:"AGENT",sourceRunId:bound.developmentRunId,
    packageDigest:bound.packageDigest,verificationId:bound.verificationId};
  const current = await client.request(publicationPreflightPath(bound.taskId,selector));
  const basis = current?.basis, evidence = basis?.evidence;
  if (current?.protocol !== "shuduo-cloud-publication-preflight/v1" || basis?.scope !== "PRIVATE_CLOUD_TEST" ||
      basis.plannedBatchCount !== 2 || !digest(current.reviewDigest) ||
      current.reviewDigest !== sha256(JSON.stringify(basis)) ||
      evidence?.status !== "REVIEW_EVIDENCE_READY" || evidence.taskId !== bound.taskId ||
      evidence.deliveryId !== bound.deliveryId || evidence.requestSha256 !== bound.requestSha256 ||
      evidence.development?.revisionId !== bound.revisionId || evidence.development?.revisionHash !== item.code.revisionHash ||
      evidence.development?.runId !== bound.developmentRunId || evidence.delivery?.packageId !== bound.packageId ||
      evidence.delivery?.packageDigest !== bound.packageDigest || evidence.delivery?.verificationId !== bound.verificationId)
    stop("发布预检与原核验回执不一致");
  validateDeliveryPackage(current.package,bound.packageDigest);
  if (!Object.entries(current.package.manifest.files).every(([name,file])=>evidence.delivery.fileHashes?.[name]===file.sha256))
    stop("审阅文件摘要与原演练不一致");
  return {selector,current,review:{protocol:"shuduo-cloud-publication-review/v1",
    taskId:bound.taskId, reviewDigest:current.reviewDigest, basis, package:current.package}};
}

export async function exportCloudV3PublicationReview(path,client,outFile) {
  return withCloudCheckpoint(path,async()=>{
    const {state,item} = snapshot(client,path);
    if (!isAbsolute(outFile)) stop("审阅文件须写入受保护的绝对路径");
    await requireOriginalCreator(state,client);
    const {review,current} = await checkedPublicationPreflight(path,client,item);
    const attestations = Object.fromEntries(publicationAttestationKeys.map(key=>[key,false]));
    writeCheckpoint(outFile,{...review,attestations},true);
    return {...result(state,item,"REVIEW_FILE_READY"),reviewDigest:review.reviewDigest,
      schedulerAvailable:current.schedulerAvailable===true,approvalRecorded:false};
  });
}

function publicationBody(selection) {
  return {sourceKind:"AGENT",sourceRunId:selection.sourceRunId,packageDigest:selection.packageDigest,
    verificationId:selection.verificationId,reviewDigest:selection.reviewDigest,
    attestations:Object.fromEntries(publicationAttestationKeys.map(key=>[key,true]))};
}

function bindPublication(item, receipt) {
  const action = item.actions.publication, release = receipt?.release, runs = receipt?.runs;
  if (receipt?.protocol !== "shuduo-cloud-publication-receipt/v1" || !id(release?.id) ||
      release.taskId !== item.taskId || release.sourceRunId !== action.sourceRunId ||
      release.sourceRevisionId !== item.code?.revisionId || release.sourceCodeHash !== item.code?.revisionHash ||
      release.scope !== "PRIVATE_CLOUD_TEST" ||
      ["packageId","packageDigest","verificationId","reviewDigest","businessScheduledFor"].some(key=>release[key]!==action[key]) ||
      !id(release.reviewId) || !id(release.approvalId) || !Array.isArray(runs) || runs.length!==2 ||
      new Set(runs.map(run=>run?.id)).size!==2 || !runs.every((run,index)=>id(run?.id) && run.sequence===index+1) ||
      !["WAITING_SCHEDULER","RUNNING_CLOUD_TEST","ACTIVE_CLOUD_TEST","COMPLETED_CLOUD_TEST","CANCELLED"].includes(release.status) ||
      action.id && (action.id !== release.id || action.reviewId !== release.reviewId || action.approvalId !== release.approvalId ||
        !isDeepStrictEqual(action.batchIds,runs.map(run=>run.id))))
    return;
  const monitoring=receipt.monitoring;
  let verified;
  if (monitoring?.status==="VERIFIED") {
    if (release.status!=="COMPLETED_CLOUD_TEST" || monitoring.health!=="HEALTHY" || monitoring.openAlertCount!==0 ||
        !Array.isArray(monitoring.batches) || monitoring.batches.length!==2 ||
        new Set(monitoring.batches.map(batch=>batch?.eventId)).size!==2 ||
        !monitoring.batches.every((batch,index)=>batch?.batchId===runs[index].id && id(batch.eventId) &&
          Number.isFinite(Date.parse(batch.observedAt)) && runs[index].status==="SUCCEEDED" && runs[index].schedulerTriggered===true))
      return;
    verified=monitoring.batches.map(({batchId,eventId,observedAt})=>({batchId,eventId,observedAt}));
  }
  if (action.monitoring && !isDeepStrictEqual(action.monitoring,verified)) return;
  const saved = {releaseId:release.id, reviewId:release.reviewId, approvalId:release.approvalId,
    batchIds:runs.map(run=>run.id), status:release.status,
    batches:runs.map(run=>{
      const stage = privateReleasePendingStage(run);
      return {id:run.id,status:run.status,...(stage ? {stage} : {}),
        ...(Number.isFinite(run.reservedDurationMs)&&run.reservedDurationMs>0?{reservedDurationMs:run.reservedDurationMs}:{})};
    }),
    ...(["PENDING","NEEDS_ATTENTION","UNCONFIRMED","VERIFIED"].includes(monitoring?.status)?{monitoringStatus:monitoring.status}:{}),
    ...(verified?{monitoring:verified}:{})};
  item.actions.publication = {...action,id:release.id,status:"CONFIRMED",reviewId:release.reviewId,
    approvalId:release.approvalId,batchIds:saved.batchIds,...(verified?{monitoring:verified}:{})};
  return saved;
}

export async function submitCloudV3Publication(path,client,{reviewPath,billPath,reconcile=false}={}) {
  return withCloudCheckpoint(path,async()=>{
    const {state,item} = snapshot(client,path), action = item.actions.publication;
    const response = (status,reason) => result(state,item,status,reason);
    if (reconcile) {
      if (!id(action?.key) || !["SUBMITTING","UNKNOWN","CONFIRMED"].includes(action.status) ||
          action.bodyHash !== sha256(JSON.stringify(publicationBody(action))))
        return response("PENDING","ORIGINAL_PUBLICATION_UNCONFIRMED");
      await requireOriginalCreator(state,client);
      let receipt;
      try { receipt=await client.request(publicationRequestReceiptPath(item.taskId,action.key)); }
      catch { return response("PENDING","ORIGINAL_PUBLICATION_UNCONFIRMED"); }
      const publication = bindPublication(item,receipt);
      if (!publication) return response("PENDING","ORIGINAL_PUBLICATION_UNCONFIRMED");
      if (!isDeepStrictEqual(action,item.actions.publication)) writeCheckpoint(path,state);
      return {...response("PUBLICATION_RECORDED"),publication};
    }
    if (action) return response("PENDING","INSPECT_ORIGINAL_PUBLICATION");
    const {state:reviewed} = readCheckpoint(reviewPath,{privateFile:true});
    const attestations = reviewed?.attestations;
    if (!attestations || Object.keys(attestations).length !== publicationAttestationKeys.length ||
        !publicationAttestationKeys.every(key=>attestations[key]===true))
      stop("须由工程师在原审阅文件逐项确认");
    const bill = readCurrentBill(billPath,Date.now()), reserve = state.submission?.bill?.unsettledReserveCny;
    if (!Number.isFinite(reserve) || bill.unsettledReserveCny < Math.max(reserve,
      item.actions.delivery?.bill?.unsettledReserveCny ?? 0,item.actions.rehearsal?.bill?.unsettledReserveCny ?? 0))
      stop("发布须保留原评测、交付和演练的未结算预留");
    const current = await client.request("/status?include=session");
    if (!current.session) stop("原发布会话未确认");
    const session = await requireOriginalCreator(state,client,current.session);
    const {review,selector,current:preflight} = await checkedPublicationPreflight(path,client,item);
    if (!isDeepStrictEqual(reviewed,{...review,attestations})) stop("审阅文件与当前确切证据不一致");
    const now = Date.now();
    if (session.role !== "ADMIN" || session.publicationOnly !== true || session.manualPublicationOnly === true ||
        session.readOnly !== false || session.publicationTaskId !== item.taskId ||
        session.publicationPackageDigest !== selector.packageDigest || session.publicationVerificationId !== selector.verificationId ||
        !(Date.parse(session.publicationStartsAt) <= now && now < Date.parse(session.publicationExpiresAt)) ||
        now - Date.parse(bill.checkedAt) >= 3600000 || preflight.schedulerAvailable !== true ||
        current.status?.mode !== "PUBLIC_INVITATION" || current.status?.projectId !== state.projectId)
      stop("此确切版本的独立发布窗口或调度器尚未就绪");
    const usage = budgetBaseline(current.status.budget,bill);
    const selection = {...selector, reviewDigest:review.reviewDigest, packageId:review.basis.evidence.delivery.packageId,
      businessScheduledFor:review.basis.businessScheduledFor};
    const body = publicationBody(selection);
    const pending = {key:randomUUID(),...selection,bodyHash:sha256(JSON.stringify(body)),status:"SUBMITTING",bill,usage};
    item.actions.publication = pending;
    writeCheckpoint(path,state);
    let receipt;
    try { receipt=await client.request(publicationReadPath(item.taskId),{method:"POST",body,idempotencyKey:pending.key}); }
    catch { /* Reconcile by the frozen key after an ambiguous response. */ }
    const publication = bindPublication(item,receipt);
    if (!publication) pending.status = "UNKNOWN";
    writeCheckpoint(path,state);
    return publication ? {...response("PUBLICATION_RECORDED"),publication}
      : response("PENDING","INSPECT_ORIGINAL_PUBLICATION");
  }, {reconcile});
}

async function readVerifiedConsumptionBatches(state,item,client,batchId) {
  const action=item.actions.publication, code=item.code;
  if (action?.status!=="CONFIRMED" || !id(action.key) || !id(action.id) ||
      !Array.isArray(action.batchIds) || (batchId!==undefined && !action.batchIds.includes(batchId)) || !Array.isArray(action.monitoring) ||
      action.bodyHash!==sha256(JSON.stringify(publicationBody(action))))
    stop("消费须绑定已核验的两个原发布批次和所选原编号");
  await requireOriginalCreator(state,client);
  const receipt=await client.request(publicationRequestReceiptPath(item.taskId,action.key));
  const publication=bindPublication(item,receipt);
  if (publication?.monitoringStatus!=="VERIFIED" || !isDeepStrictEqual(publication.monitoring,action.monitoring))
    stop("原发布监控待核验");
  const selector={agentTaskId:item.taskId,packageDigest:action.packageDigest,releaseId:action.id};
  const batches=await client.request(serviceSourceReadPath("sources",selector));
  if (!Array.isArray(batches) || batches.length!==2 || new Set(batches.map(run=>run?.id)).size!==2 ||
      !batches.every(run=>action.batchIds.includes(run?.id) && run.releaseId===action.id &&
        run.sourceAgentTaskId===item.taskId && run.sourceKind==="AGENT" && run.scope==="PRIVATE_CLOUD_TEST" &&
        run.packageDigest===action.packageDigest && run.sourceRevisionId===code.revisionId &&
        run.sourceRevisionHash===code.revisionHash && run.sourceRunId===code.runId && run.status==="SUCCEEDED" &&
        run.published===true && run.schedulerTriggered===true && run.engine==="Apache Spark" && run.engineVersion==="3.5.9" &&
        run.mainSqlExecuted===true && run.testSqlValidation?.passed===true && run.validation?.passed===true))
    stop("数据服务的原发布来源与监控不一致");
  return {selector,batchIds:publication.batchIds};
}

function consumptionSourceForBatch(item,batches,batchId) {
  if (!batches.batchIds.includes(batchId)) stop("消费批次不在原已核验发布内");
  const {code,actions:{publication:action}}=item;
  return {selector:batches.selector,source:validateConsumerSource({schema:"shuduo-service-consumer-source/v1",
    scope:"PRIVATE_CLOUD_TEST",sourceKind:"AGENT",taskId:item.taskId,revisionId:code.revisionId,
    revisionHash:code.revisionHash,developmentRunId:code.runId,contextId:code.contextId,
    validationContractId:code.validationContractId,packageDigest:action.packageDigest,
    releaseId:action.id,sourceReleaseRunId:batchId})};
}

function readOriginalConsumerReport(planPath,state,definition,callIdDigest) {
  if (!digest(callIdDigest)) stop("须提供原 XAPI 成功调用摘要");
  const {state:plan}=readCheckpoint(planPath,{privateFile:true});
  validateConsumerPlan(plan);
  const ordered=rows=>[...rows].sort((a,b)=>a.client_id.localeCompare(b.client_id));
  if (plan.protocol!=="SERVICE_CONSUMER_V2" || plan.origin!==state.origin ||
      plan.testOnly!==(new URL(state.origin).protocol==="http:") ||
      !isDeepStrictEqual(ordered(plan.expectedRows),ordered(getContext(definition.contextId).expected)))
    stop("消费者计划须绑定原入口及独立登记的证券业务预期");
  const {state:report}=readCheckpoint(plan.reportFile,{privateFile:true});
  const successful=row=>row?.phase==="consume" && row.statusCode===200;
  const xapi=Array.isArray(report?.requests) && report.requests.find(row=>successful(row) &&
    row.type==="XAPI" && row.serviceId===plan.xapi.id && row.callIdDigest===callIdDigest);
  const dapi=Array.isArray(report?.requests) && report.requests.find(row=>successful(row) && row.type==="DAPI" &&
    plan.dapis.some(service=>service.granted && row.serviceId===service.id));
  if (!xapi || !digest(dapi?.callIdDigest)) stop("报告须包含同一应用的原 DAPI 和 XAPI 成功请求");
  return {plan,report,callIdDigest,dapiCallIdDigest:dapi.callIdDigest};
}

async function checkOriginalConsumerProof(client,{source,selector},{plan,report,callIdDigest,dapiCallIdDigest}) {
  if (!isDeepStrictEqual(source,validateConsumerSource(plan.source))) stop("消费者计划与冻结原批次不一致");
  const evidence=digest=>client.request(serviceSourceReadPath("task-evidence",{...selector,callIdDigest:digest}));
  const [taskEvidence,dapiEvidence]=await Promise.all([evidence(callIdDigest),evidence(dapiCallIdDigest)]);
  const decision=bindExternalConsumption({expectedSource:source,plan,report,taskEvidence,dapiEvidence});
  if (!["MATCHED","MATCHED_ONLY"].includes(decision.status) || decision.callIdDigest!==callIdDigest)
    return {reason:decision.reason};
  return {proof:{batchId:source.sourceReleaseRunId, status:decision.status, sourceDigest:decision.sourceDigest,
    planDigest:decision.planDigest, reportDigest:decision.reportDigest, xapiCallIdDigest:decision.callIdDigest,
    xapiRowsDigest:decision.rowsDigest, dapiCallIdDigest:decision.dapiCallIdDigest,dapiRowsDigest:decision.dapiRowsDigest}};
}

export async function bindCloudV3Consumption(path,client,{batchId,outFile,planPath,callIdDigest}={}) {
  return withCloudCheckpoint(path,async()=>{
    const {state,item,definition}=snapshot(client,path);
    if (outFile!==undefined) {
      if (!id(batchId) || !isAbsolute(outFile)) stop("须提供原发布批次及受保护的导出路径");
      const batches=await readVerifiedConsumptionBatches(state,item,client,batchId);
      const {source}=consumptionSourceForBatch(item,batches,batchId);
      writeCheckpoint(outFile,source,true);
      return {...result(state,item,"CONSUMPTION_SOURCE_READY"),batchId:source.sourceReleaseRunId,releaseId:source.releaseId};
    }
    const report=readOriginalConsumerReport(planPath,state,definition,callIdDigest);
    const batches=await readVerifiedConsumptionBatches(state,item,client,report.plan.source.sourceReleaseRunId);
    const source=consumptionSourceForBatch(item,batches,report.plan.source.sourceReleaseRunId);
    const {proof,reason}=await checkOriginalConsumerProof(client,source,report);
    if (!proof) return result(state,item,"CONSUMPTION_UNCONFIRMED",reason);
    const prior=item.consumption?.[proof.batchId];
    if (prior && !isDeepStrictEqual(prior,proof)) stop("此批次已有原消费回执，须核对原报告");
    if (!prior) {
      item.consumption={...item.consumption,[proof.batchId]:proof};
      writeCheckpoint(path,state);
    }
    return {...result(state,item,"CONSUMPTION_BOUND"),consumption:proof,externalSystemVerified:false,agentIndependentE2E:false};
  });
}

export async function verifyCloudV3Completion(path,client,{firstPlanPath,secondPlanPath,outFile}={}) {
  if (!isAbsolute(outFile ?? "") || existsSync(outFile)) stop("须提供尚不存在的绝对回执路径");
  return withCloudCheckpoint(path,async()=>{
    const original=readCheckpoint(path,{privateFile:true});
    const {state,item,definition}=snapshot(client,path);
    const action=item.actions.publication;
    const provenance=liveEvidenceProvenance(item);
    if (provenance.synthetic || provenance.nonNative || provenance.unconfirmed)
      stop("原案例的执行来源未获确认");
    if (!Array.isArray(action?.batchIds) || action.batchIds.length!==2 ||
        new Set(action.batchIds).size!==2 || !action.batchIds.every(id) ||
        !action.batchIds.every(batchId=>item.consumption?.[batchId]?.batchId===batchId))
      stop("须先分别保存两个原批次的消费回执");
    const reportPaths=[firstPlanPath,secondPlanPath];
    const reports=action.batchIds.map((batchId,index)=>{
      const proof=item.consumption[batchId];
      const report=readOriginalConsumerReport(reportPaths[index],state,definition,proof.xapiCallIdDigest);
      if (report.plan.source.sourceReleaseRunId!==batchId || report.dapiCallIdDigest!==proof.dapiCallIdDigest)
        stop("消费计划顺序、批次或原调用不一致");
      return report;
    });
    const batches=await readVerifiedConsumptionBatches(state,item,client);
    const review=await readCloudV3Review(path,client);
    if (review.status!=="REVIEW_EVIDENCE_BOUND" || item.rehearsal?.status!=="SUCCEEDED" ||
        review.taskId!==item.taskId || review.packageDigest!==action.packageDigest ||
        review.verificationId!==action.verificationId || review.verificationId!==item.rehearsal.id)
      stop("原开发、八文件和演练核验未通过");
    const proofs=[];
    for (const [index,batchId] of batches.batchIds.entries()) {
      const {proof}=await checkOriginalConsumerProof(client,consumptionSourceForBatch(item,batches,batchId),reports[index]);
      if (!proof || !isDeepStrictEqual(proof,item.consumption[batchId]))
        stop("原批次的消费报告或平台回执未通过重验");
      proofs.push(proof);
    }
    if (new Set(proofs.flatMap(proof=>[proof.dapiCallIdDigest,proof.xapiCallIdDigest])).size!==4)
      stop("两个原批次不得共享消费调用回执");
    const current=readCheckpoint(path,{privateFile:true});
    if (current.text!==original.text) stop("重验期间原检查点已变化");
    const scope=cloudV3CompletionScope(state,proofs);
    const body={protocol:"shuduo-cloud-v3-completion/v1",scope,checkedAt:new Date().toISOString(),
      checkpointDigest:sha256(original.text),evaluationRunId:state.evaluationRunId,caseSetDigest:state.caseSetDigest,
      caseId:definition.id,requestDigest:item.requestDigest,taskId:item.taskId,revisionId:review.revisionId,
      developmentRunId:review.developmentRunId,packageDigest:review.packageDigest,verificationId:review.verificationId,
      releaseId:action.id,batchIds:batches.batchIds,consumptionDigest:sha256(JSON.stringify(proofs))};
    const completionDigest=sha256(JSON.stringify(body));
    writeCheckpoint(outFile,{...body,completionDigest},true);
    return {...result(state,item,"COMPLETION_RECEIPT_SAVED"),scope,completionDigest,
      independentlyVerifiedCloudCase:scope==="INVITED_CLOUD_MATCHED",externalSystemVerified:false,agentIndependentE2E:false};
  },{reconcile:true});
}

async function readOriginalCloudExecution({state,definition,item,action},client) {
  const response = (status, reason) => ({unconfirmed:result(state,item,status,reason)});
  if (action.status !== "CONFIRMED") return response("PENDING", "ORIGINAL_CREATION_UNCONFIRMED");
  await requireOriginalCreator(state, client);
  let view;
  try { view = await client.request(agentExecutionEvidencePath(action.key)); }
  catch { return response("UNCONFIRMED", "CLOUD_EXECUTION_READ_UNCONFIRMED"); }
  if (view?.protocol !== "shuduo-agent-execution-evidence/v1" || view.scope !== "PRIVATE_CLOUD_TEST" ||
      view.verificationMode !== "STORED_METADATA_ONLY" || view.status !== "EXECUTION_RECORDED" ||
      view.fullLifecycleE2E !== false || view.publicDeployed !== false || view.taskId !== item.taskId ||
      view.contextId !== definition.contextId || view.requestSha256 !== sha256(definition.request) ||
      view.seedSqlSha256 !== sha256(definition.seedSql.trim()) || !Number.isFinite(Date.parse(view.taskCreatedAt)) ||
      Date.parse(view.taskCreatedAt) < Date.parse(state.previousCase ? state.submission.submittedAt : item.evaluationStartedAt))
    return response("UNCONFIRMED", "ORIGINAL_EXECUTION_MISMATCH");
  const execution = checkedLiveExecutionProjection(view.execution, item.taskId);
  if (execution.state !== "RECORDED" || execution.evidence !== "STORED_METADATA")
    return response("UNCONFIRMED", "CLOUD_EXECUTION_PROVENANCE_UNCONFIRMED");
  return {view,execution};
}

export async function settleCloudV3DevelopmentFailure(path,client,outFile) {
  if (!isAbsolute(outFile ?? "") || existsSync(outFile)) stop("须提供尚不存在的绝对失败回执路径");
  return withCloudCheckpoint(path,async()=>{
    const original=readCheckpoint(path,{privateFile:true}), selected=snapshot(client,path);
    const {state,item}=selected;
    if (Object.keys(item.actions).length!==1 || item.code || item.rehearsal || item.consumption)
      stop("此命令仅结算原开发阶段的失败");
    const {unconfirmed,view,execution}=await readOriginalCloudExecution(selected,client);
    if (unconfirmed) return unconfirmed;
    const failure=view.settledFailure, {model,spark}=execution;
    if (!validSettledDevelopmentFailure(failure) || failure.taskVersion!==execution.taskVersion ||
        model.state!=="OUTPUT_RECORDED" || model.usage!=="RECORDED" ||
        model.reservedTokens!==0 || model.unconfirmedAttempts!==0 || model.unattributedTokens!==0 ||
        model.attempts!==failure.modelAttempts || model.ledgerTokens!==failure.ledgerTokens ||
        model.reportedTokens!==failure.ledgerTokens ||
        !["NOT_LINKED","REVISION_RECORDED","RESULT_RECORDED"].includes(spark.state) ||
        (spark.state==="RESULT_RECORDED" &&
          (!["FAILED","VALIDATION_FAILED"].includes(spark.resultStatus) || !failure.sparkRunIds.includes(spark.runId))))
      return result(state,item,"PENDING","DEVELOPMENT_FAILURE_NOT_SETTLED");
    if (readCheckpoint(path,{privateFile:true}).text!==original.text) stop("重验期间原检查点已变化");
    const receipt=cloudV3FailureReceipt(original,item,failure,new Date().toISOString());
    writeCheckpoint(outFile,receipt,true);
    return {...result(state,item,"FAILURE_RECEIPT_SAVED"),scope:receipt.scope,completionDigest:receipt.completionDigest};
  },{reconcile:true});
}

export async function inspectCloudV3Execution(path, client) {
  return withCloudCheckpoint(path, async () => {
    const selected=snapshot(client,path), {state,definition,item}=selected;
    const {unconfirmed,view,execution}=await readOriginalCloudExecution(selected,client);
    if (unconfirmed) return unconfirmed;
    const response = (status, reason) => result(state,item,status,reason);
    const code = verifiedDevelopmentCode(definition, view, execution);
    if (!code) return {...response("EXECUTION_RECORDED", "DEVELOPMENT_RESULT_UNCONFIRMED"), execution};
    if (item.code && !isDeepStrictEqual(item.code,code))
      return response("UNCONFIRMED", "ORIGINAL_DEVELOPMENT_MISMATCH");

    const before = JSON.stringify(item);
    item.code = code;
    if (item.phase === "CODE_AND_DEBUG") item.phase = "DELIVERY_PREPARATION";
    const delivery = await reconcileOriginalDelivery(client, item, code);
    if (JSON.stringify(item) !== before) writeCheckpoint(path,state);
    return {...response("DEVELOPMENT_BOUND"), execution, delivery};
  }, {reconcile:true});
}
