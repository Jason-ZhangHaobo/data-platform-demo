import { isDeepStrictEqual } from "node:util";
import { getContext, validationFamilyForContext } from "./context.mjs";
import { sha256, validationMatchesFamily } from "./delivery.mjs";
import { deliverySourceExecutionIssue } from "./delivery-source-evidence.mjs";
import { isFundContext } from "./fund-contexts.mjs";
import { fundValidationMatches } from "./fund-delivery.mjs";
import { uuid } from "./live-lifecycle-checkpoint.mjs";
import { nonLiveModelLabel } from "./live-lifecycle-provenance.mjs";
import { syncSqlContractId } from "./sync-sql-contract.mjs";

const unavailable = () => Object.assign(Error("原对话的 SQL、版本或运行记录尚未核对"), {
  status:409, code:"CHAT_SQL_DEVELOPMENT_UNCONFIRMED",
});

function validationSummary(task, run) {
  const context = validationFamilyForContext(task.contextId);
  const family = task.syncInput && context ? {...context,id:syncSqlContractId} : context;
  const saved = run.validation;
  const contractId = saved?.contractId ?? run.validationContractId ?? null;
  const agrees = family && contractId === family.id &&
    [task.validationContractId,run.validationContractId].every(id => id === undefined || id === contractId);
  const checks = Array.isArray(saved?.regressions) ? saved.regressions : [];
  const regressions = checks.filter(check => family?.contextIds.includes(check?.contextId) && typeof check.passed === "boolean")
    .map(({contextId,passed}) => ({contextId,name:getContext(contextId).name ?? contextId,passed}));
  let state = "UNCONFIRMED";
  if (agrees && saved?.passed === false) state = "FAILED";
  if (agrees && run.status === "SUCCEEDED" && !saved?.issues?.length &&
      (isFundContext(task.contextId) ? fundValidationMatches(saved,undefined,task.contextId) : validationMatchesFamily(saved,family)))
    state = "PASSED";
  return {state,contractId,regressions};
}

// All four records come from one project. This path never calls the execution
// reconciler: inspecting a completed conversation must not advance a Worker.
export function storedChatSqlDevelopment({intent,step,actor,read,authorize}) {
  if (!actor || intent.submittedBy !== actor)
    throw Object.assign(Error("请使用原对话的项目账号"),{status:403,code:"PROJECT_PERMISSION_DENIED"});
  if (step?.executionEvidence !== "SPECIALIST_TASK_LINKED" || step.specialistTaskKind !== "agent" ||
      !uuid.test(step.specialistTaskId) || !step.handoffId) throw unavailable();
  const handoff = read("agent_intent_handoff",step.handoffId);
  const approval = handoff?.approvalId && read("agent_intent_approval",handoff.approvalId);
  if (handoff?.destinationId !== "development" || handoff.intentId !== intent.id || handoff.specialistTaskId !== step.specialistTaskId ||
      handoff.specialistTaskKind !== "agent" || approval?.status !== "BOUND" || approval.intentId !== intent.id ||
      approval.destinationId !== "development" || approval.specialistTaskId !== step.specialistTaskId ||
      approval.specialistTaskKind !== "agent" || approval.objectiveHash !== step.objectiveHash ||
      typeof handoff.objective !== "string" || sha256(handoff.objective) !== step.objectiveHash) throw unavailable();
  const task = read("agent",step.specialistTaskId);
  if (!task || task.submittedBy !== actor || task.language !== "SPARK_SQL" ||
      !["SUCCEEDED","FAILED","CANCELLED","INTERRUPTED","VALIDATION_FAILED"].includes(task.status) || !Array.isArray(task.attempts))
    throw unavailable();
  const last = task.attempts.at(-1);
  // Older local tasks only stored the run ID on the completed attempt.
  if (!uuid.test(last?.runId) || !uuid.test(last.revisionId) || task.revisionId !== last.revisionId ||
      (task.runId !== undefined && task.runId !== last.runId)) throw unavailable();
  const revision = read("revision",last.revisionId), run = read("run",last.runId);
  if (!revision || !run || revision.author !== actor || revision.contextId !== task.contextId ||
      run.contextId !== task.contextId || run.agentTaskId !== task.id || run.revisionId !== revision.id ||
      typeof revision.sql !== "string" || revision.sql !== task.sql || sha256(revision.sql) !== revision.hash ||
      run.revisionHash !== revision.hash || last.status !== run.status ||
      (task.status === "SUCCEEDED" && run.status !== "SUCCEEDED") ||
      !["SUCCEEDED","FAILED","VALIDATION_FAILED","CANCELLED"].includes(run.status) ||
      !isDeepStrictEqual(revision.syncInput,task.syncInput) || !isDeepStrictEqual(run.syncInput,task.syncInput) ||
      !isDeepStrictEqual(revision.fundPreparation,task.fundPreparation) || !isDeepStrictEqual(run.fundPreparation,task.fundPreparation)) throw unavailable();
  authorize(task,revision,run);
  const attempts=task.attempts.map(item=>{
    const entry={attempt:item.attempt,status:item.status};
    if (item === last) return {...entry,revisionId:revision.id,runId:run.id};
    if (!item.runId) return entry;
    if (!uuid.test(item.runId) || !uuid.test(item.revisionId)) return {attempt:item.attempt,status:"UNCONFIRMED"};
    const earlier=read("run",item.runId), code=read("revision",item.revisionId);
    if (!earlier || !code || earlier.agentTaskId!==task.id || earlier.revisionId!==code.id ||
        code.author!==actor || code.contextId!==task.contextId || earlier.contextId!==task.contextId ||
        earlier.status!==item.status || typeof code.sql!=="string" || earlier.revisionHash!==code.hash ||
        sha256(code.sql)!==code.hash) return {attempt:item.attempt,status:"UNCONFIRMED"};
    authorize(task,code,earlier);
    return {...entry,revisionId:code.id,runId:earlier.id,
      failedChecks:validationSummary(task,earlier).regressions.filter(check=>!check.passed).map(check=>check.name)};
  });
  let codeSource="UNCONFIRMED";
  const knownModel=typeof last.model==="string" && last.model.trim() && !/unconfirmed|unknown|unrecorded/i.test(last.model);
  if ([revision.source,task.mode].some(source=>["SYNTHETIC_MODEL","TEST_DOUBLE"].includes(source)) ||
      (knownModel && nonLiveModelLabel(last.model))) codeSource="SYNTHETIC_MODEL";
  else if (revision.source==="LIVE_MODEL" && task.mode==="LIVE_MODEL" && knownModel) codeSource="RECORDED_MODEL";
  return {
    protocol:"shuduo-chat-sql-development/v1",
    binding:{intentId:intent.id,taskId:task.id,contextId:task.contextId,revisionId:revision.id,runId:run.id,revisionHash:revision.hash},
    sql:revision.sql, codeSource, taskStatus:task.status, runStatus:run.status,
    engine:run.engine ?? null, engineVersion:run.engineVersion ?? null,
    testDouble:run.testDouble === true ? true : deliverySourceExecutionIssue(run) ? null : false,
    attempts,
    validation:validationSummary(task,run),
  };
}
