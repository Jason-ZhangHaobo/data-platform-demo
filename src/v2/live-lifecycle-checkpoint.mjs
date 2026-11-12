import {mkdirSync, readFileSync, existsSync, openSync, closeSync, lstatSync, fstatSync, constants} from "node:fs";
import {isAbsolute} from "node:path";
import {
  currentLiveLifecycleContract, legacyLiveLifecycleContract, liveCaseRequestDigest, liveContractById,
  liveLifecycleCases, liveLifecyclePlan, validatedLiveConsumptionSource,
} from "./live-lifecycle-evaluation.mjs";

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function stop(message) {
  throw Object.assign(Error(message), {publicMessage:message});
}

export function loopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    stop("本机评测入口必须为固定回环 HTTP 地址");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    stop("本机评测入口须为固定回环 HTTP 地址，不接受云端地址或任意路径");
  return url.origin;
}

export function directory(path, create=false) {
  if (!existsSync(path)) {
    if (!create) stop("找不到原检查点目录，不会新建替代运行");
    mkdirSync(path, {mode:0o700});
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) stop("评测目录不允许符号链接或非目录路径");
}

export function readCheckpoint(path, {privateFile=false} = {}) {
  let fd;
  try {
    if (privateFile && !isAbsolute(path)) stop("原评测检查点须使用受保护的绝对路径");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) stop("原检查点不是受支持的有界文件");
    if (privateFile && ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 ||
        (process.getuid && stat.uid !== process.getuid()))) stop("原评测检查点须为当前用户所有的 0600 单链接文件");
    const text = readFileSync(fd, "utf8");
    return {state:JSON.parse(text), text};
  } catch (error) {
    if (error.publicMessage) throw error;
    stop("原检查点读取未确认，不新建、不改写原报告");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function checkpointCaseScope(state, runId) {
  if (!state || state.evaluationRunId !== runId || !Number.isFinite(Date.parse(state.startedAt)) ||
      !Number.isSafeInteger(state.caseLimit) || state.caseLimit < 1 || state.caseLimit > 20 || !Array.isArray(state.outcomes))
    stop("原评测编号、案例范围或检查点不合法");
  const contractId = state.contract?.id;
  if (!liveContractById(contractId)) stop("原报告契约未知，不能迁移或当作新契约继续执行");
  const plan = liveLifecyclePlan(state.caseLimit, {contractId});
  if (state.caseSetDigest !== plan.caseSetDigest) stop("恢复范围与原评测的入口、案例数或案例集不一致");
  const allowed = new Map(plan.selectedCases.map(definition => [definition.id, definition]));
  if (new Set(state.outcomes.map(item => item?.caseId)).size !== state.outcomes.length ||
      state.outcomes.some(item => !allowed.has(item?.caseId)))
    stop("原检查点包含重复或范围外案例");
  if (contractId !== legacyLiveLifecycleContract.id && state.outcomes.some(item => item.contractId !== contractId))
    stop("新契约检查点的案例来源不一致，未执行恢复");
  if (contractId === currentLiveLifecycleContract.id && state.outcomes.some(item =>
    item.evaluationRunId !== runId || item.evaluationStartedAt !== state.startedAt ||
    item.caseSetDigest !== plan.caseSetDigest || item.requestDigest !== liveCaseRequestDigest(allowed.get(item.caseId), contractId)))
    stop("案例不属于原评测运行，不能混用其他运行的成功来源");
  return {plan, contractId};
}

export function checkpointScope(state, runId, env) {
  const {plan, contractId} = checkpointCaseScope(state, runId);
  const origin = loopbackOrigin(state.origin);
  if ((env.V2_LIVE_EVALUATION_ORIGIN !== undefined && loopbackOrigin(env.V2_LIVE_EVALUATION_ORIGIN) !== origin) ||
      (env.V2_LIVE_EVALUATION_CASE_LIMIT !== undefined && Number(env.V2_LIVE_EVALUATION_CASE_LIMIT) !== state.caseLimit) ||
      (env.V2_LIVE_EVALUATION_CONTRACT !== undefined && env.V2_LIVE_EVALUATION_CONTRACT !== contractId))
    stop("恢复范围与原评测的入口、案例数或案例集不一致");
  return {plan, origin, contractId};
}

function exactLocalNavigationSource(state, outcomes) {
  const definition = liveLifecycleCases(state.contractId ?? legacyLiveLifecycleContract.id).find(item => item.id === state.caseId);
  if (!definition) return undefined;
  const parent = outcomes.find(item => item.caseId === definition.sourceCaseId);
  const source = validatedLiveConsumptionSource(definition, state, {sourceCheckpoint:parent});
  if (!source) return undefined;
  const ids = [source.taskId, source.revisionId, source.developmentRunId, source.packageId,
    source.verificationId, source.releaseId, ...source.batches.map(batch => batch.id)];
  return ids.every(value => uuid.test(value)) ? source : undefined;
}

export function liveAgentTaskUrl(origin, taskId) {
  return uuid.test(taskId ?? "") ? origin + "/v2/?module=agent-center&task=" + taskId : undefined;
}

export function links(state, origin, outcomes=[]) {
  const taskId = uuid.test(state.taskId ?? "") ? state.taskId : undefined;
  const taskUrl = liveAgentTaskUrl(origin,taskId);
  const source = exactLocalNavigationSource(state, outcomes);
  if (!taskId || source?.taskId !== taskId) return {taskUrl};
  const query = new URLSearchParams({
    module:"services", source_task:taskId, source_package:source.packageDigest,
    source_release:source.releaseId, source_kind:"AGENT", source_scope:"LOCAL_TEST_ONLY",
    source_revision:source.revisionId, source_run:source.developmentRunId,
  });
  return {
    taskUrl, servicesUrl:origin + "/v2/?" + query, navigationOnly:true, sourceSelection:"EXACT_LOCAL_RELEASE",
    servicesNotice:"导航定位同一原任务、人工审阅过的包及本机发布版本；页面须实际回读并核对同源后才可操作。链接本身不授权，不自动创建或调用接口。",
    consumptionTarget:{taskId, packageDigest:source.packageDigest, releaseId:source.releaseId, batchIds:source.batches.map(batch => batch.id)},
  };
}
