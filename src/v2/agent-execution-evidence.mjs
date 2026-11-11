import { developmentVerificationReport } from "./agent-development-workflow.mjs";
import { validationFamilyForContext } from "./context.mjs";
import { sha256 } from "./delivery.mjs";
import { checkedLiveExecutionProjection, storedExecutionStages } from "./live-lifecycle-execution.mjs";
import { liveEvidenceProvenance, nonLiveModelLabel } from "./live-lifecycle-provenance.mjs";
import { sqlRequirementBinding } from "./sql-requirements.mjs";

export function agentExecutionEvidencePath(requestId) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new Error("原请求编号格式不合法");
  return `/agent/requests/${requestId}/execution-evidence`;
}

export function verifiedStoredCloudDevelopment(task, revision, run) {
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  const attempt = attempts.at(-1), family = validationFamilyForContext(task.contextId);
  if (!family || task.status !== "SUCCEEDED" || attempt?.status !== "SUCCEEDED" ||
      typeof attempt.model !== "string" || !attempt.model || attempt.model.length > 200 || nonLiveModelLabel(attempt.model) ||
      attempts.length > 3 || !Number.isSafeInteger(task.usedTokens) || task.usedTokens < 0 || task.usedTokens > 32000 ||
      revision?.source !== "LIVE_MODEL" || revision.id !== attempt.revisionId || revision.author !== task.submittedBy ||
      typeof revision.sql !== "string" || revision.sql !== task.sql ||
      !run || run.id !== attempt.runId || run.agentTaskId !== task.id || run.contextId !== task.contextId ||
      run.mode !== "DURABLE_REMOTE_SUBMISSION" || run.isolation !== "FUNCTION_PROCESS" || run.engineVersion !== "3.5.9" ||
      run.remoteSubmission?.prepared?.job?.jobId !== run.id ||
      !Array.isArray(run.rows) || run.rows.some(row => !row || typeof row !== "object" || Array.isArray(row)))
    return;
  try {
    if (developmentVerificationReport(task, run, revision).status === "PASSED") return {attempt, attempts, family};
  } catch {
    return;
  }
}

// The caller has already resolved the authenticated creator's original ledger key.
// The reader here only accesses persisted task metadata and never reconciles a job.
export function storedAgentExecutionEvidence(task, read) {
  const base = {protocol:"shuduo-agent-execution-evidence/v1", scope:"PRIVATE_CLOUD_TEST",
    verificationMode:"STORED_METADATA_ONLY", taskId:task.id, fullLifecycleE2E:false, publicDeployed:false};
  if (task.executionMode !== "DURABLE_SQL_AGENT_V1" || task.language !== "SPARK_SQL" || task.mode !== "LIVE_MODEL" ||
      !task.submittedBy || task.sourceRunId !== undefined || task.derivedFrom !== undefined ||
      typeof task.message !== "string" || typeof task.initialSql !== "string")
    return {...base, status:"UNCONFIRMED", reason:"NATIVE_FRESH_TASK_REQUIRED"};
  const execution = checkedLiveExecutionProjection(storedExecutionStages(task, read), task.id);
  if (execution.state !== "RECORDED")
    return {...base, status:"UNCONFIRMED", reason:"EXECUTION_PROVENANCE_UNCONFIRMED"};
  const snapshot = {...base, status:"EXECUTION_RECORDED", taskCreatedAt:task.createdAt, contextId:task.contextId,
    requestSha256:sha256(task.message), seedSqlSha256:sha256(task.initialSql), execution};
  if (execution.evidence !== "STORED_METADATA" || execution.spark.state !== "RESULT_RECORDED" ||
      execution.spark.resultStatus !== "SUCCEEDED") return snapshot;
  const revision = read("revision", execution.spark.revisionId), run = read("run", execution.spark.runId);
  const verified = verifiedStoredCloudDevelopment(task, revision, run);
  if (!verified) return snapshot;
  return {...snapshot, development:{revisionId:revision.id, revisionHash:revision.hash, runId:run.id,
    engine:run.engine, engineVersion:run.engineVersion, validationContractId:verified.family.id,
    regressionCount:run.validation.regressions.length, model:verified.attempt.model,
    ...(task.requirements ? {requirementBinding:sqlRequirementBinding(task.requirements)} : {})}};
}
