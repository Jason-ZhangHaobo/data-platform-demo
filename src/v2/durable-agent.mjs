import { createHash, randomUUID } from "node:crypto";
import { reconcileDurableDevelopment } from "./durable-development.mjs";
import { safeModelDiagnostic, modelFailure as diagnosticFailure } from "./model-diagnostics.mjs";
import { sameSqlIgnoringLayout } from "./sql-repair-progress.mjs";
import { buildSqlRepairFeedback } from "./sql-repair-feedback.mjs";
import { resolveExplicitSqlRepairSource } from "./sql-repair-source.mjs";
import { resolveAgentContextDerivation } from "./agent-context-derivation.mjs";
import {resolveSqlRepairComparison,repairComparisonAttribution,explicitRepairAttribution} from './sql-repair-comparison.mjs';
import {resolveAssistedContinuation} from './assisted-sql-delivery-source.mjs';
import {resolveManualContinuation} from './manual-sql-continuation.mjs';
import {sqlRequirementReport,bindSqlRequirementRevision,sqlRequirementBinding} from './sql-requirements.mjs';
import {resolveSqlClarification,assertSqlClarificationTask} from './sql-clarification.mjs';
import {clarificationAttribution} from './sql-clarification-contract.mjs';
import {liveEvidenceProvenance} from './live-lifecycle-provenance.mjs';

export const durableSqlAgentMode = "DURABLE_SQL_AGENT_V1";
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function settledDevelopmentPatch(task,run,now) {
  const attempts=task.attempts.map((attempt,index)=>index===task.attempts.length-1 ? {...attempt,status:run.status} : attempt);
  const finish=(status,error)=>({attempts,status,stage:status,error,finishedAt:new Date(now).toISOString()});
  if (run.status==="SUCCEEDED") return finish("SUCCEEDED");
  if (run.status==="CANCELLED") return finish("CANCELLED","计算任务已取消");
  if (run.code==="REMOTE_SPARK_TIMEOUT") return finish("FAILED","计算任务超时；已保留原批次，请检查执行环境，不自动触发模型重写");
  if (!["FAILED","VALIDATION_FAILED"].includes(run.status))
    throw fail(409,"AGENT_RUN_STATE_INVALID","运行状态需要人工核查");
  if (attempts.length>=task.maxAttempts || task.usedTokens>=task.tokenBudget)
    return finish("FAILED","已达到修正次数或预算上限，请人工检查");
  return {attempts,stage:"READY_FOR_MODEL",status:"QUEUED",
    durable:{...task.durable,validationError:String(run.error ?? run.validation?.issues?.join("；") ?? "执行失败").slice(0,8000)}};
}

// This event path can only settle a previously reserved development job. It
// shares the normal result validation and never has a model or queue writer.
export async function settleAgentDevelopmentResult({id,key},{store,project,runner,persist,validationFamily,now=Date.now,assertResultTarget}) {
  const run=store.get("run",id,project), prepared=run?.remoteSubmission?.prepared;
  if (run?.mode!=="DURABLE_REMOTE_SUBMISSION" || run.isolation!=="FUNCTION_PROCESS" ||
      !run.agentTaskId || prepared?.resultKey!==key || prepared.job?.jobId!==id || prepared.job.projectId!==project) return;
  const task=store.get("agent",run.agentTaskId,project), revision=store.get("revision",run.revisionId,project);
  if (task?.executionMode!==durableSqlAgentMode || task.runId!==id || task.revisionId!==revision?.id ||
      revision?.source!=="LIVE_MODEL" || revision.author!==task.submittedBy || revision.contextId!==task.contextId ||
      run.contextId!==task.contextId || run.revisionHash!==revision.hash || typeof revision.sql!=="string" ||
      revision.sql!==task.sql || createHash("sha256").update(revision.sql).digest("hex")!==revision.hash ||
      task.attempts?.at(-1)?.runId!==id || task.attempts.at(-1).revisionId!==revision.id ||
      store.deduplicatedId(`${project}:durable-agent-run:${task.id}:${task.attempts.length}`,
        digest({revisionId:revision.id,hash:revision.hash}))!==id) return;
  assertResultTarget?.(task);
  if ((terminal.has(run.status) || run.status==="VALIDATION_FAILED") && task.stage!=="WAITING_FOR_RUN")
    return {state:"DEVELOPMENT_BATCH_ALREADY_SETTLED"};
  if (task.stage!=="WAITING_FOR_RUN") return;
  const proof=liveEvidenceProvenance(task,revision,run);
  if (proof.synthetic || proof.nonNative || proof.unconfirmed) return;
  const owner=store.get("auth_user",task.submittedBy,project);
  if (owner?.status!=="ACTIVE" || !owner.memberships?.some(member=>member.projectId===project &&
      ["ADMIN","ENGINEER"].includes(member.role))) return {state:"DEVELOPMENT_BATCH_OWNER_INACTIVE"};
  const family=validationFamily(task.contextId);
  if (!family || family.id!==task.validationContractId || family.id!==run.validationContractId) return;
  let payload;
  try { payload=JSON.parse(prepared.job.body); }
  catch { throw fail(409,"AGENT_RUN_LINK_INVALID","原开发批次正文不合法"); }
  if (payload?.sql!==revision.sql || payload.context?.id!==task.contextId ||
      !Array.isArray(payload.validationContexts) || payload.validationContexts.length!==family.contextIds.length ||
      !family.contextIds.every((contextId,index)=>payload.validationContexts[index]?.id===contextId)) return;
  const saved=await reconcileDurableDevelopment(run,{runner,store,project,persist,contextIds:family.contextIds,
    contractId:family.id,allowSubmit:false,settleResultEvent:result=>{
      store.update("agent",task.id,project,settledDevelopmentPatch(task,result,now()),{expectedVersion:task.version});
    }});
  return {state:saved.workerResultDigest ? "DEVELOPMENT_BATCH_SETTLED" : "DEVELOPMENT_BATCH_RESULT_UNCONFIRMED"};
}

export function publicDurableAgent(task) {
  if (!task || task.executionMode !== durableSqlAgentMode) return task;
  const { durable, submittedBy, ...result } = task;
  return { ...result, recovery: {
    supported: true, driver: "EXPLICIT_ADVANCE", backgroundDispatcherVerified: false,
    confirmationRequired: task.stage === "MODEL_OUTCOME_UNKNOWN",
    modelLeaseExpiresAt: durable?.leaseExpiresAt,
  } };
}

// One explicit POST advances one durable boundary. GET never starts paid work.
// A background dispatcher is intentionally not implied by this implementation.
export function createDurableSqlAgent({ store, project, runner, generator, persist,
  getContext, contextIds, contractId, resolveValidationFamily, assertModelBudget = () => {}, assertRunBudget = () => {}, assertExecutionScope = () => {},
  tokenBudget = 32000, requestTokenLimit = 12000, maxAttempts = 3,
  now = Date.now, modelLeaseMs = 90000 }) {
  for (const value of [tokenBudget, requestTokenLimit, maxAttempts, modelLeaseMs])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("持久 Agent 配置不合法");
  if (!runner?.prepare || !runner?.submit || !runner?.read || !runner?.cancel)
    throw new Error("持久 Agent 需要可恢复的执行器");
  const active = new Map();
  const stamp = () => new Date(now()).toISOString();
  const get = id => {
    const task = store.get("agent", id, project);
    if (!task || task.executionMode !== durableSqlAgentMode)
      throw fail(404, "DURABLE_AGENT_NOT_FOUND", "未找到当前项目的持久任务");
    return task;
  };
  const change = (task, patch) => store.update("agent", task.id, project, patch, { expectedVersion: task.version });
  const validationFamily = id => {
    const family=resolveValidationFamily?resolveValidationFamily(id):{id:contractId,contextIds};
    if(!family||typeof family.id!=="string"||!family.id||!Array.isArray(family.contextIds)||family.contextIds.length<1||family.contextIds.length>5||
      new Set(family.contextIds).size!==family.contextIds.length||!family.contextIds.includes(id)||family.contextIds.some(key=>!getContext(key)))
      throw fail(409,"AGENT_VALIDATION_FAMILY_INVALID","业务口径或验证用例族不可用，请复核后再执行");
    return family;
  };
  const contextDigest = id => {const family=validationFamily(id);return digest({context:getContext(id),validation:family.contextIds.map(getContext),contractId:family.id});};
  const ownedLease = (id, token) => {
    const task = get(id);
    return task.stage === "MODEL_IN_FLIGHT" && task.durable.leaseToken === token && !terminal.has(task.status);
  };
  const finish = async (task, status, error) => {
    const saved = change(task, { status, stage: status, error, finishedAt: stamp() });
    await persist(); return publicDurableAgent(saved);
  };
  const replaceAttempt = (task, patch) => task.attempts.map((a, i) => i === task.attempts.length - 1 ? { ...a, ...patch } : a);
  const explicitRepairSource = (sourceRunId, actorId, contextId, currentSql) => resolveExplicitSqlRepairSource({sourceRunId, actorId, contextId, currentSql, project,
    read:(kind,id)=>store.get(kind,id,project)});
  const contextDerivation = (derivation, actorId, targetContextId, currentSql) => resolveAgentContextDerivation({derivation, actorId, targetContextId, currentSql, project,
    read:(kind,id)=>store.get(kind,id,project)});
  const markUnknown = async (task, diagnostic = safeModelDiagnostic(diagnosticFailure("MODEL_INTERRUPTED", "LEASE"))) => {
    const saved = change(task, { status: "INTERRUPTED", stage: "MODEL_OUTCOME_UNKNOWN",
      attempts: replaceAttempt(task, { status: "MODEL_OUTCOME_UNKNOWN", usageEstimated: true,
        diagnostic: { ...diagnostic, recordedAt: stamp() } }),
      error: "模型调用结果未确认；已保留预算预留，不会自动重复调用。确认后可在剩余额度内重试。",
      durable: { ...task.durable, leaseToken: undefined, leaseExpiresAt: undefined } });
    active.get(task.id)?.abort();
    await persist(); return saved;
  };
  const markNotSent = async (task, diagnostic) => {
    const saved = change(task, {status:"INTERRUPTED",stage:"MODEL_NOT_SENT",
      attempts:replaceAttempt(task,{status:"MODEL_NOT_SENT",usageEstimated:true,diagnostic:{...diagnostic,recordedAt:stamp()}}),
      error:"模型请求在发送前停止；请先处理配置或预算问题，再选择继续原任务。本次未发起模型请求，此前尝试与保守预算预留保持不变。",
      durable:{...task.durable,leaseToken:undefined,leaseExpiresAt:undefined}});
    active.get(task.id)?.abort();
    await persist();return saved;
  };

  const comparisonBasis=(binding,task)=>resolveSqlRepairComparison({store,project,actorId:task.submittedBy??task.actorId,sourceRunId:task.sourceRunId,
    contextId:task.contextId,currentSql:task.initialSql??task.currentSql,binding});
  const continuationBasis=task=>resolveAssistedContinuation({store,project,actorId:task.submittedBy??task.actorId,binding:task.assistedContinuation,contextId:task.contextId,currentSql:task.initialSql??task.currentSql});
  const manualBasis=task=>resolveManualContinuation({store,project,actorId:task.submittedBy??task.actorId,binding:task.manualContinuation,contextId:task.contextId,currentSql:task.initialSql??task.currentSql});
  async function create({ message, currentSql, contextId, actorId, idempotencyKey, sourceRunId, sourceError, derivation, repairComparison, assistedContinuation, manualContinuation, clarification:clarificationRef, requestBound = false }) {
    assertExecutionScope(undefined);
    if (!getContext(contextId) || typeof message !== "string" || !message.trim() || message.length > 2000 ||
        typeof currentSql !== "string" || !currentSql.trim() || currentSql.length > 20000 ||
        typeof actorId !== "string" || !actorId || typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 100)
      throw fail(422, "DURABLE_AGENT_INPUT_INVALID", "持久任务输入不合法");
    if(clarificationRef!==undefined&&[sourceRunId,sourceError,derivation,repairComparison,assistedContinuation,manualContinuation].some(v=>v!==undefined))throw fail(422,'CLARIFICATION_INPUT_CONFLICT','澄清答复不能混用修正、人工或口径派生来源');
    const clarification=clarificationRef===undefined?undefined:resolveSqlClarification({store,project,actorId,binding:clarificationRef,contextId,currentSql,answer:message});
    if(manualContinuation!==undefined&&[sourceRunId,sourceError,derivation,repairComparison,assistedContinuation].some(v=>v!==undefined))throw fail(422,'MANUAL_CONTINUATION_CONFLICT','手工成功版本续改不能混用其他来源');
    if(assistedContinuation!==undefined&&[sourceRunId,sourceError,derivation,repairComparison].some(v=>v!==undefined))throw fail(422,'ASSISTED_CONTINUATION_CONFLICT','成功版本续改不能混用失败来源、对照或口径派生');
    if (derivation !== undefined && (sourceRunId !== undefined || sourceError !== undefined || repairComparison !== undefined))
      throw fail(422, "AGENT_CONTEXT_DERIVATION_CONFLICT", "成功版本口径变更不能同时引用失败修正来源");
    const derivedFrom = derivation === undefined ? undefined : contextDerivation(derivation, actorId, contextId, currentSql);
    if ((sourceRunId !== undefined || sourceError !== undefined) &&
        (typeof sourceRunId !== "string" || !/^[a-f0-9-]{36}$/.test(sourceRunId) || typeof sourceError !== "string" || !sourceError || sourceError.length > 8000))
      throw fail(422, "DURABLE_AGENT_REPAIR_INVALID", "修正任务必须绑定有效失败批次及其错误");
    if (sourceRunId) {
      const {run}=explicitRepairSource(sourceRunId,actorId,contextId,currentSql);
      const actualError=String(run.error || run.validation?.issues?.join("；") || "独立业务校验未通过").slice(0,8000);
      if (sourceError!==actualError) throw fail(409,"AGENT_REPAIR_SOURCE_INVALID","修正错误必须来自同一已保存失败批次，不能替换诊断内容");
    }
    const basis=repairComparison===undefined?undefined:comparisonBasis(repairComparison,{actorId,sourceRunId,contextId,currentSql});
    const continuation=assistedContinuation===undefined?undefined:continuationBasis({actorId,assistedContinuation,contextId,currentSql});
    const manual=manualContinuation===undefined?undefined:manualBasis({actorId,manualContinuation,contextId,currentSql});
    const family=validationFamily(contextId);
    const signature = digest({ message, currentSql, contextId, ...(sourceRunId ? { sourceRunId, sourceError } : {}), ...(derivedFrom ? {derivation:derivedFrom} : {}),...(basis?{repairComparison:basis.binding}:{}),...(continuation?{assistedContinuation:continuation.binding}:{}),...(manual?{manualContinuation:manual.binding}:{}),...(clarification?{clarification:clarification.digest}:{}) });
    const result = store.deduplicate(`${project}:durable-agent:${actorId}:${idempotencyKey}`, signature, () =>
      store.create("agent", project, { message, sql: currentSql, initialSql: currentSql, sourceRunId, language: "SPARK_SQL", contextId,
        ...(requestBound ? {requestBound:true} : {}),
        ...(clarification?{clarification,...clarificationAttribution({clarification})}:derivedFrom?clarificationAttribution(store.get('agent',derivedFrom.taskId,project)):{}),
        ...(derivedFrom ? {derivedFrom} : {}),...(sourceRunId?explicitRepairAttribution(sourceRunId):{}),...(basis?{repairComparison:basis.binding,...basis.attribution}:{}),
        ...(continuation?{assistedContinuation:continuation.binding,...continuation.attribution}:{}),...(manual?{manualContinuation:manual.binding,...manual.attribution}:{}),
        submittedBy: actorId, status: "QUEUED", stage: "READY_FOR_MODEL", attempts: [], usedTokens: 0,
        maxAttempts, tokenBudget, requestTokenLimit, executionMode: durableSqlAgentMode, mode: "LIVE_MODEL",
        completionScope: "SQL_DEVELOPMENT", fullLifecycleE2E: false, validationContractId: family.id,
        durable: { contextDigest: contextDigest(contextId), ...(sourceError ? { validationError: sourceError } : {}) } }));
    await persist(); return publicDurableAgent(get(result.id));
  }

  async function generate(task) {
    if(task.clarification){try{assertSqlClarificationTask(task,{store,project});}catch(cause){return finish(change(task,{code:'CLARIFICATION_SOURCE_CHANGED'}),'FAILED',cause.message);}}
    if(task.manualContinuation)manualBasis(task);
    if(task.assistedContinuation)continuationBasis(task);
    const comparison=task.repairComparison?comparisonBasis(task.repairComparison,task):undefined;
    if (task.derivedFrom !== undefined && task.revisionId === undefined) {
      const {kind, taskId, revisionId, runId, revisionHash} = task.derivedFrom;
      const checked = contextDerivation({kind, taskId, revisionId, runId, revisionHash}, task.submittedBy, task.contextId, task.sql);
      if (JSON.stringify(checked) !== JSON.stringify(task.derivedFrom) || task.initialSql !== task.sql)
        throw fail(409, "AGENT_CONTEXT_SOURCE_INVALID", "原成功来源与保存的派生关系不一致，未启动模型");
    }
    const explicitSource = !task.runId && task.sourceRunId
      ? explicitRepairSource(task.sourceRunId,task.submittedBy,task.contextId,task.sql) : undefined;
    const remaining = task.tokenBudget - task.usedTokens;
    if (remaining < 1 || task.attempts.length >= task.maxAttempts)
      return finish(task, "FAILED", "已达到模型预算或尝试次数上限");
    assertModelBudget();
    const reserved = Math.min(task.requestTokenLimit, remaining), token = randomUUID();
    task = change(task, { status: "RUNNING", stage: "MODEL_IN_FLIGHT", error: undefined, startedAt: task.startedAt ?? stamp(),
      usedTokens: task.usedTokens + reserved,
      attempts: [...task.attempts, { attempt: task.attempts.length + 1, status: "MODEL_IN_FLIGHT", startedAt: stamp(),
        model: "unconfirmed", usage: { total_tokens: reserved }, usageEstimated: true }],
      durable: { ...task.durable, leaseToken: token, leaseExpiresAt: new Date(now() + modelLeaseMs).toISOString() } });
    await persist(); // Never call a model before its attempt and budget are durable.
    if (!ownedLease(task.id, token)) return publicDurableAgent(get(task.id));
    if (now() >= Date.parse(task.durable.leaseExpiresAt)) return publicDurableAgent(await markUnknown(get(task.id)));
    const controller = new AbortController(); active.set(task.id, controller);
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new Error("Model step interrupted"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const watchdog = setTimeout(() => controller.abort(), Math.max(1, Math.min(modelLeaseMs, Date.parse(task.durable.leaseExpiresAt) - now())));
    watchdog.unref?.();
    let generated;
    const modelStarted = now();
    try {
      const work = Promise.resolve().then(() => {
        if (controller.signal.aborted || now() >= Date.parse(task.durable.leaseExpiresAt) || !ownedLease(task.id, token)) throw new Error("Model step no longer owned");
        if(task.clarification){try{assertSqlClarificationTask(get(task.id),{store,project});}catch{throw Object.assign(Error('原澄清依据已变化；没有发送模型请求'),{clarificationSourceChanged:true});}}
        const previousRun = store.get("run", task.runId ?? "", project);
        const feedbackRun = previousRun?.agentTaskId===task.id && previousRun.revisionId===task.revisionId ? previousRun : explicitSource?.run;
        return generator({ message: task.message, context: getContext(task.contextId),
          ...(task.clarification?{clarification:task.clarification}:{}),
          currentSql: task.sql, error: task.durable.validationError,
          repairFeedback: feedbackRun ? buildSqlRepairFeedback(feedbackRun, task.contextId,{currentSql:task.sql}) : undefined,
          ...(!task.runId&&comparison?{repairComparison:comparison.summary}:{}),
          remainingBudget: reserved, signal: controller.signal,
          modelBudgetReservation: { taskId: task.id, attempt: task.attempts.length, leaseToken: token } });
      });
      generated = await Promise.race([work, interrupted]);
    } catch (error) {
      if (ownedLease(task.id, token)) {
        const current=get(task.id),deadline=Date.parse(current.durable?.leaseExpiresAt);
        if(error?.clarificationSourceChanged){
          const saved=change(current,{attempts:replaceAttempt(current,{status:'CLARIFICATION_SOURCE_CHANGED',modelRequestSent:false,usageEstimated:true}),
            durable:{...current.durable,leaseToken:undefined,leaseExpiresAt:undefined},code:'CLARIFICATION_SOURCE_CHANGED'});
          return finish(saved,'FAILED','原澄清依据已变化；没有发送模型请求，原尝试与保留额度仍在。请回答当前问题后新建任务。');
        }
        const interrupted=controller.signal.aborted || !Number.isFinite(deadline) || now()>=deadline;
        const diagnostic=safeModelDiagnostic(interrupted
          ? diagnosticFailure("MODEL_INTERRUPTED", "LEASE", {elapsedMs:now()-modelStarted}) : error,now()-modelStarted);
        if (diagnostic.phase==="PREPARE" && diagnostic.requestMayHaveBeenSent===false) await markNotSent(current,diagnostic);
        else await markUnknown(current,diagnostic);
      }
      return publicDurableAgent(get(task.id));
    } finally {
      clearTimeout(watchdog);
      controller.signal.removeEventListener("abort", onAbort);
      if (active.get(task.id) === controller) active.delete(task.id);
    }
    if (!ownedLease(task.id, token)) return publicDurableAgent(get(task.id));
    task = get(task.id);
    if (now() >= Date.parse(task.durable.leaseExpiresAt)) return publicDurableAgent(await markUnknown(task));
    const reported = Number(generated?.usage?.total_tokens);
    const spent = Number.isSafeInteger(reported) && reported > 0 ? reported : reserved;
    const attempts = replaceAttempt(task, { model: generated?.model ?? "unconfirmed",
      usage: generated?.usage && Number.isSafeInteger(reported) && reported > 0 ? generated.usage : { total_tokens: reserved },
      usageEstimated: !(Number.isSafeInteger(reported) && reported > 0), status: "GENERATED", modelFinishedAt: stamp() });
    const completedPatch = { usedTokens: task.usedTokens - reserved + spent, attempts,
      durable: { ...task.durable, leaseToken: undefined, leaseExpiresAt: undefined } };
    const modelFailure = (code, message) => finish(change(task, { ...completedPatch,
      attempts: attempts.map((a, i) => i === attempts.length - 1 ? { ...a, status: code } : a) }), "FAILED", message);
    if (spent > reserved || completedPatch.usedTokens > task.tokenBudget)
      return modelFailure("MODEL_BUDGET_EXCEEDED", "模型返回的用量超出本次预算，未提交计算任务");
    if(task.clarification){try{assertSqlClarificationTask(task,{store,project});}catch{return modelFailure('CLARIFICATION_SOURCE_CHANGED','原澄清依据在模型返回前发生变化；本次用量保留，未提交计算。');}}
    const requirements=sqlRequirementReport({task,message:task.message,context:getContext(task.contextId),generated,attempt:attempts.length});
    if(requirements&&requirements.status!=='MODEL_PROPOSED'){
      const code=requirements.status==='CLARIFICATION_REQUIRED'?'REQUIREMENT_CLARIFICATION_REQUIRED':'REQUIREMENT_EVIDENCE_INVALID';
      const saved=change(task,{...completedPatch,requirements,status:'FAILED',stage:code,code,finishedAt:stamp(),
        error:requirements.interpretation?.question??requirements.reason,
        attempts:attempts.map((a,i)=>i===attempts.length-1?{...a,status:code,computationSkipped:true}:a)});
      await persist();return publicDurableAgent(saved);
    }
    if (typeof generated?.sql !== "string" || !generated.sql.trim() || generated.sql.length > 20000 ||
        typeof generated?.model !== "string" || !generated.model || generated.model.length > 200)
      return modelFailure("MODEL_OUTPUT_INVALID", "模型未返回有效 SQL 或模型标识，未提交计算任务");
    const previous = task.attempts.slice(0, -1).findLast(attempt => attempt.runId === task.runId && attempt.revisionId === task.revisionId);
    let failedRun = store.get("run", previous?.runId ?? "", project),
      failedRevision = store.get("revision", previous?.revisionId ?? "", project);
    const sameFailedSource = previous && ["FAILED", "VALIDATION_FAILED"].includes(previous.status) && failedRun?.status === previous.status &&
      failedRun.agentTaskId === task.id && failedRun.id === task.runId && failedRun.contextId === task.contextId &&
      failedRun.engine === "Apache Spark" && failedRun.testDouble !== true && failedRun.remoteSubmission?.prepared?.job?.jobId === failedRun.id &&
      (failedRun.status !== "VALIDATION_FAILED" || failedRun.mainSqlExecuted === true) &&
      failedRevision?.id === task.revisionId && failedRun.revisionId === failedRevision.id && failedRevision.contextId === task.contextId &&
      failedRevision.author === task.submittedBy && typeof failedRevision.sql === "string" && failedRevision.sql === task.sql &&
      failedRun.revisionHash === failedRevision.hash && createHash("sha256").update(failedRevision.sql).digest("hex") === failedRevision.hash;
    if (explicitSource) {
      try { const source=explicitRepairSource(task.sourceRunId,task.submittedBy,task.contextId,task.sql);failedRun=source.run;failedRevision=source.revision; }
      catch { return modelFailure("AGENT_REPAIR_SOURCE_INVALID","原失败来源已变化，本次模型调用已计入历史，但未提交新的计算任务"); }
    }
    if ((sameFailedSource || explicitSource) && sameSqlIgnoringLayout(generated.sql, failedRevision.sql)) {
      const code = "AGENT_SQL_UNCHANGED_AFTER_FAILURE";
      return finish(change(task, { ...completedPatch, code, sql:failedRevision.sql, revisionId:failedRevision.id, runId:failedRun.id,
        attempts: attempts.map((attempt, index) => index === attempts.length - 1 ? { ...attempt, status: "NO_SQL_CHANGE", code,
          sourceRevisionId: failedRevision.id, sourceRunId: failedRun.id, computationSkipped: true,
          ...(explicitSource ? {sourceKind:"EXPLICIT_FAILED_RUN"} : {}) } : attempt),
      }), "FAILED", "模型本次未对已失败的 SQL 作出有效修改，已停止重复计算。原失败版本和批次保留，请人工修改后重新核验；本次模型调用与费用仍计入历史。");
    }
    if(task.repairComparison){
      try{comparisonBasis(task.repairComparison,task);}catch(cause){
        task=change(task,completedPatch);await persist();return finish(task,'FAILED',cause.message);
      }
    }
    if(task.assistedContinuation){try{continuationBasis(task);}catch(cause){return modelFailure('ASSISTED_CONTINUATION_CHANGED',cause.message);}}
    if(task.manualContinuation){try{manualBasis(task);}catch(cause){return modelFailure('MANUAL_CONTINUATION_CHANGED',cause.message);}}
    // Revision creation and task linkage share an atomic local transaction.
    const linked = store.deduplicate(`${project}:durable-agent-revision:${task.id}:${attempts.length}`,
      digest(generated.sql), () => {
        const rev = store.create("revision", project, { sql: generated.sql.trim(), contextId: task.contextId,
          source: "LIVE_MODEL", author: task.submittedBy, ...repairComparisonAttribution(task),...clarificationAttribution(task), hash: createHash("sha256").update(generated.sql.trim()).digest("hex") });
        if(requirements)store.update('revision',rev.id,project,{requirementBinding:sqlRequirementBinding(bindSqlRequirementRevision(requirements,rev))});
        change(task, { ...completedPatch, stage: "READY_FOR_RUN", sql: rev.sql, revisionId: rev.id,
          ...(requirements?{requirements:bindSqlRequirementRevision(requirements,rev)}:{}),
          explanation: typeof generated.explanation === "string" ? generated.explanation.slice(0,8000) : "",
          attempts: attempts.map((a, i) => i === attempts.length - 1 ? { ...a, revisionId: rev.id } : a) });
        return rev;
      });
    if (get(task.id).revisionId !== linked.id) throw fail(409, "AGENT_REVISION_LINK_INVALID", "代码版本关联不一致");
    await persist(); return publicDurableAgent(get(task.id));
  }

  async function runStep(task) {
    if(task.clarification&&task.stage==='READY_FOR_RUN'){try{assertSqlClarificationTask(task,{store,project});}catch(cause){return finish(change(task,{code:'CLARIFICATION_SOURCE_CHANGED'}),'FAILED',cause.message);}}
    if(task.manualContinuation&&task.stage==='READY_FOR_RUN')manualBasis(task);
    if(task.assistedContinuation&&task.stage==='READY_FOR_RUN')continuationBasis(task);
    if(task.repairComparison&&task.stage==='READY_FOR_RUN')comparisonBasis(task.repairComparison,task);
    const family=validationFamily(task.contextId);
    if(task.validationContractId!==family.id)throw fail(409,"AGENT_VALIDATION_CONTRACT_CHANGED","任务绑定的业务口径版本与当前验证契约不一致");
    if (task.stage === "READY_FOR_RUN") {
      const rev = store.get("revision", task.revisionId, project);
      if (!rev) throw fail(409, "AGENT_REVISION_MISSING", "任务代码版本缺失");
      store.deduplicate(`${project}:durable-agent-run:${task.id}:${task.attempts.length}`,
        digest({ revisionId: rev.id, hash: rev.hash }), () => {
          assertRunBudget();
          const run = store.create("run", project, { status: "QUEUED", revisionId: rev.id,
            revisionHash: rev.hash, contextId: task.contextId, validationContractId: family.id,
            agentTaskId: task.id,...repairComparisonAttribution(task),...clarificationAttribution(task), mode: "DURABLE_REMOTE_SUBMISSION", isolation: "FUNCTION_PROCESS", durationMs: 30000 });
          const prepared = runner.prepare({ sql: rev.sql, context: getContext(task.contextId), validationContexts: family.contextIds.map(getContext) }, run.id);
          if (prepared?.job?.jobId !== run.id) throw new Error("持久运行标识不一致");
          store.update("run", run.id, project, { stage: "SUBMITTING", remoteSubmission: { prepared, submitted: false } });
          change(task, { stage: "WAITING_FOR_RUN", runId: run.id,
            attempts: replaceAttempt(task, { runId: run.id, status: "QUEUED" }) });
          return run;
        });
      await persist(); task = get(task.id);
    }
    if (terminal.has(task.status) || task.stage === "CANCELLING") return publicDurableAgent(task);
    let run = store.get("run", task.runId, project);
    if (!run || run.agentTaskId !== task.id) throw fail(409, "AGENT_RUN_LINK_INVALID", "运行批次关联不一致");
    // Reconcile reads an existing receipt before considering a resubmission.
    // This also recovers a completed job after its submission deadline elapsed.
    const guarded=task.clarification?{prepare:(...a)=>runner.prepare(...a),read:(...a)=>runner.read(...a),cancel:(...a)=>runner.cancel(...a),submit:p=>{
      assertSqlClarificationTask(get(task.id),{store,project});return runner.submit(p);
    }}:runner;
    try{run = await reconcileDurableDevelopment(run, { runner:guarded, store, project, persist, contextIds:family.contextIds, contractId:family.id });}
    catch(cause){if(!String(cause.code??'').startsWith('CLARIFICATION_'))throw cause;
      task=change(get(task.id),{status:'INTERRUPTED',stage:'CLARIFICATION_SOURCE_CHANGED',code:'CLARIFICATION_SOURCE_CHANGED',
        error:'原澄清依据已变化，停止新增提交；原运行编号保留，请先查询已有回执，不能据此假定计算失败。'});await persist();return publicDurableAgent(task);}
    task = get(task.id);
    if (terminal.has(task.status) || task.stage === "CANCELLING") return publicDurableAgent(task);
    if (["QUEUED", "RUNNING"].includes(run.status)) return publicDurableAgent(task);
    const saved=change(task,settledDevelopmentPatch(task,run,now()));
    await persist(); return publicDurableAgent(saved);
  }

  async function advance(id, { expectedVersion, confirmModelRetry = false } = {}) {
    let task = get(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw fail(422, "AGENT_VERSION_REQUIRED", "请提供已读取的任务版本");
    if (typeof confirmModelRetry !== "boolean")
      throw fail(422, "AGENT_RETRY_CONFIRMATION_INVALID", "重试确认必须为布尔值");
    if (task.version !== expectedVersion)
      throw fail(409, "STALE_AGENT_VERSION", "任务已推进，请刷新后再操作");
    if (terminal.has(task.status)) return publicDurableAgent(task);
    assertExecutionScope(task);
    if (task.durable.contextDigest !== contextDigest(task.contextId))
      throw fail(409, "AGENT_CONTEXT_CHANGED", "任务上下文或验证契约已变化，请审阅后创建新任务");
    if (task.stage === "MODEL_IN_FLIGHT") {
      if (now() < Date.parse(task.durable.leaseExpiresAt))
        throw fail(409, "AGENT_STEP_BUSY", "模型步骤仍有有效租约，不能重复发起");
      task = await markUnknown(task);
    }
    if (task.stage === "MODEL_OUTCOME_UNKNOWN") {
      if (!confirmModelRetry) return publicDurableAgent(task);
      task = change(task, { status: "QUEUED", stage: "READY_FOR_MODEL" }); await persist();
    }
    if (task.stage === "CANCELLING") return cancel(id);
    // Only an explicit advance reaches MODEL_NOT_SENT. Background callers must
    // leave it paused; generate rechecks all existing limits before mutation.
    if (["READY_FOR_MODEL", "MODEL_NOT_SENT"].includes(task.stage)) return generate(task);
    if (["READY_FOR_RUN", "WAITING_FOR_RUN"].includes(task.stage)) return runStep(task);
    throw fail(409, "AGENT_STAGE_INVALID", "无法自动推进当前阶段");
  }

  // Review only: persist a new checkpoint, never call a model from this endpoint.
  async function prepareResume(id, { expectedVersion, confirmModelRetry = false } = {}) {
    const task = get(id);
    assertExecutionScope(task);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== task.version)
      throw fail(409, "STALE_AGENT_VERSION", "任务已变化，请刷新后审阅");
    if (typeof confirmModelRetry !== "boolean") throw fail(422, "AGENT_RETRY_CONFIRMATION_INVALID", "重试确认必须为布尔值");
    if (task.durable.contextDigest !== contextDigest(task.contextId))
      throw fail(409, "AGENT_CONTEXT_CHANGED", "上下文已变化，不能沿用旧任务批准");
    if (!["MODEL_OUTCOME_UNKNOWN", "MODEL_NOT_SENT", "READY_FOR_MODEL", "READY_FOR_RUN", "WAITING_FOR_RUN"].includes(task.stage) || terminal.has(task.status))
      throw fail(409, "AGENT_STAGE_INVALID", "当前步骤不可恢复后台");
    if (task.stage === "MODEL_OUTCOME_UNKNOWN" && !confirmModelRetry)
      throw fail(409, "AGENT_RETRY_CONFIRMATION_REQUIRED", "请审阅未知调用和预算后明确确认重试");
    if (["MODEL_OUTCOME_UNKNOWN", "MODEL_NOT_SENT", "READY_FOR_MODEL"].includes(task.stage)) {
      if (task.attempts.length >= task.maxAttempts || task.usedTokens >= task.tokenBudget)
        throw fail(409, "AGENT_RETRY_LIMIT", "原任务尝试次数或预算已耗尽");
      assertModelBudget();
    }
    const saved = change(task, { ...(["MODEL_OUTCOME_UNKNOWN", "MODEL_NOT_SENT"].includes(task.stage) ? { status: "QUEUED", stage: "READY_FOR_MODEL" } : {}),
      durable: { ...task.durable, resumeReview: { version: task.version, reviewedAt: stamp(), confirmModelRetry } } });
    await persist(); return publicDurableAgent(saved);
  }

  async function cancel(id) {
    let task = get(id);
    if (terminal.has(task.status)) return publicDurableAgent(task);
    assertExecutionScope(task);
    task = change(task, { stage: "CANCELLING", durable: { ...task.durable, leaseToken: undefined, leaseExpiresAt: undefined } });
    await persist(); active.get(id)?.abort();
    const run = task.runId && store.get("run", task.runId, project);
    if (run && !terminal.has(run.status) && run.status !== "VALIDATION_FAILED") {
      if (run.remoteSubmission?.prepared) await runner.cancel(run.remoteSubmission.prepared);
      store.update("run", run.id, project, { status: "CANCELLED", finishedAt: stamp() });
    }
    return finish(get(id), "CANCELLED", "用户取消任务");
  }
  return { create, advance, prepareResume, cancel, get: id => publicDurableAgent(get(id)) };
}
