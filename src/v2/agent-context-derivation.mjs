import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getContext, validationFamilyForContext } from "./context.mjs";
import { developmentVerificationReport } from "./agent-development-workflow.mjs";

const keys = ["kind", "taskId", "revisionId", "runId", "revisionHash"];
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const failure = (code, message, status = 409) => Object.assign(new Error(message), { status, code });
const invalidSource = () => failure("AGENT_CONTEXT_SOURCE_INVALID", "变更口径须引用当前账号同项目的原生 SQL Agent 成功版本与完整独立核验；来源不明或代码已变化时不能派生");
const native = value => value && [undefined, "AGENT"].includes(value.sourceKind) && value.sourceAttribution === undefined &&
  value.manualProvenance === undefined && value.attribution === undefined && value.testDouble !== true && value.computationSkipped !== true;

// Syntax only. Ownership, immutable code and execution evidence are checked by
// resolveAgentContextDerivation through the caller's project-scoped store.
export function validateAgentContextDerivation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key)) || value.kind !== "REGISTERED_CONTEXT_CHANGE" ||
      ![value.taskId, value.revisionId, value.runId].every(uuid) || typeof value.revisionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.revisionHash))
    throw failure("AGENT_CONTEXT_DERIVATION_INVALID", "口径变更来源必须包含确切任务、代码版本、运行及代码摘要", 422);
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export const agentContextDerivationRequest = source => ({
  kind:"REGISTERED_CONTEXT_CHANGE",taskId:source.taskId,revisionId:source.revisionId,
  runId:source.runId,revisionHash:source.revisionHash,
});

export function agentContextDerivationBody({message,sql,contextId,derivation}) {
  return {message,sql,contextId,language:"SPARK_SQL",derivation:validateAgentContextDerivation(derivation)};
}

export function validStoredAgentDerivation(task,read) {
  if (task.derivedFrom===undefined) return true;
  try {
    return isDeepStrictEqual(task.derivedFrom,resolveAgentContextDerivation({
      derivation:agentContextDerivationRequest(task.derivedFrom),actorId:task.submittedBy,
      targetContextId:task.contextId,currentSql:task.initialSql,project:task.projectId,read,
    }));
  } catch {
    return false;
  }
}

// Returns genealogy only, never approval, budget, result rows or inherited run
// pointers. Successful source and new target each keep their own context family.
export function resolveAgentContextDerivation({ derivation, actorId, targetContextId, currentSql, project, read }) {
  const selected = validateAgentContextDerivation(derivation), targetFamily = validationFamilyForContext(targetContextId);
  if (!targetFamily || !getContext(targetContextId))
    throw failure("AGENT_CONTEXT_TARGET_INVALID", "请选择已登记的不同业务口径");
  if (typeof actorId !== "string" || !actorId || typeof project !== "string" || !project ||
      typeof currentSql !== "string" || typeof read !== "function") throw invalidSource();
  const task = read("agent", selected.taskId), revision = read("revision", selected.revisionId), run = read("run", selected.runId);
  if (![task, revision, run].every(value => native(value) && value.projectId === project)) throw invalidSource();
  const family = validationFamilyForContext(task.contextId), attempt = Array.isArray(task.attempts) ? task.attempts.at(-1) : undefined;
  if (!family || !getContext(task.contextId) || task.id !== selected.taskId || revision.id !== selected.revisionId || run.id !== selected.runId ||
      task.submittedBy !== actorId || revision.author !== actorId || task.language !== "SPARK_SQL" || task.mode !== "LIVE_MODEL" || task.status !== "SUCCEEDED" ||
      !native(attempt) || attempt.status !== "SUCCEEDED" || attempt.revisionId !== revision.id || attempt.runId !== run.id ||
      typeof attempt.model !== "string" || !attempt.model || /test.?double|unconfirmed|fixture|stub|synthetic|mock/i.test(attempt.model) ||
      task.revisionId !== revision.id || task.runId !== undefined && task.runId !== run.id ||
      revision.source !== "LIVE_MODEL" || revision.contextId !== task.contextId || run.contextId !== task.contextId ||
      typeof revision.sql !== "string" || currentSql !== revision.sql || task.sql !== revision.sql ||
      createHash("sha256").update(revision.sql).digest("hex") !== selected.revisionHash || revision.hash !== selected.revisionHash || run.revisionHash !== selected.revisionHash ||
      run.agentTaskId !== task.id || run.revisionId !== revision.id || run.status !== "SUCCEEDED" || run.engine !== "Apache Spark" || run.mainSqlExecuted !== true ||
      !Array.isArray(run.rows) || run.rows.length > 1000 || !run.rows.every(row => row && typeof row === "object" && !Array.isArray(row)) ||
      developmentVerificationReport(task, run, revision).status !== "PASSED") throw invalidSource();
  if (targetContextId === task.contextId)
    throw failure("AGENT_CONTEXT_TARGET_INVALID", "目标口径与原任务相同，请选择已登记的不同业务口径");
  return { ...selected, contextId: task.contextId, validationContractId: family.id };
}
