import { verifiedStoredCloudDevelopment } from "./agent-development-workflow.mjs";
import { sha256 } from "./delivery.mjs";
import { checkedLiveExecutionProjection, storedExecutionStages } from "./live-lifecycle-execution.mjs";
import { sqlRequirementBinding } from "./sql-requirements.mjs";
import { liveEvidenceProvenance } from "./live-lifecycle-provenance.mjs";
import { uuid } from "./live-lifecycle-checkpoint.mjs";
import { validStoredAgentDerivation } from "./agent-context-derivation.mjs";

const failureStages=new Set(["FAILED","REQUIREMENT_CLARIFICATION_REQUIRED","REQUIREMENT_EVIDENCE_INVALID"]);
const settledSparkFailures=new Set(["FAILED","VALIDATION_FAILED"]);
const date=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));

export function validSettledDevelopmentFailure(failure) {
  return Boolean(failure && Object.keys(failure).length===7 && failureStages.has(failure.stage) &&
    date(failure.finishedAt) && Number.isSafeInteger(failure.taskVersion) && failure.taskVersion>0 &&
    Number.isSafeInteger(failure.modelAttempts) && failure.modelAttempts>=1 && failure.modelAttempts<=3 &&
    Number.isSafeInteger(failure.ledgerTokens) && failure.ledgerTokens>0 &&
    Number.isFinite(failure.sparkDurationMs) && failure.sparkDurationMs>=0 &&
    Array.isArray(failure.sparkRunIds) && failure.sparkRunIds.length<=failure.modelAttempts &&
    (failure.sparkRunIds.length>0 || failure.sparkDurationMs===0) &&
    failure.sparkRunIds.every(id=>typeof id==="string"&&uuid.test(id)) &&
    new Set(failure.sparkRunIds).size===failure.sparkRunIds.length);
}

function settledDevelopmentFailure(task,read,execution) {
  const {model}=execution;
  if (task.status!=="FAILED" || !failureStages.has(task.stage) ||
      !date(task.finishedAt) || !(Date.parse(task.finishedAt)>=Date.parse(task.createdAt)) ||
      task.durable?.leaseToken || task.durable?.leaseExpiresAt ||
      execution.evidence!=="STORED_METADATA" || model.state!=="OUTPUT_RECORDED" || model.usage!=="RECORDED" ||
      !model.attempts || model.ledgerTokens!==model.reportedTokens || model.reservedTokens!==0 ||
      model.unattributedTokens!==0 || model.unconfirmedAttempts!==0)
    return;
  const runs=[];
  let sparkDurationMs=0;
  for (const [index,attempt] of task.attempts.entries()) {
    if (attempt?.attempt!==index+1 || !date(attempt.modelFinishedAt)) return;
    if (!attempt.runId) continue;
    const revision=read("revision",attempt.revisionId), run=read("run",attempt.runId);
    const proof=liveEvidenceProvenance(revision,run);
    if (!revision || revision.author!==task.submittedBy || !run || runs.includes(run.id) ||
        proof.synthetic || proof.nonNative || proof.unconfirmed ||
        run.stage!=="COMPLETED" || !settledSparkFailures.has(run.status) || run.status!==attempt.status ||
        run.code==="REMOTE_SPARK_TIMEOUT" || run.engine!=="Apache Spark" ||
        run.mode!=="DURABLE_REMOTE_SUBMISSION" || run.isolation!=="FUNCTION_PROCESS" ||
        run.remoteSubmission?.prepared?.job?.jobId!==run.id || !date(run.finishedAt) ||
        !Number.isFinite(run.durationMs) || run.durationMs<0) return;
    const recorded=storedExecutionStages(task,read,{frozen:{taskId:task.id,revisionId:attempt.revisionId,
      revisionHash:revision.hash,runId:attempt.runId}}).spark;
    if (recorded?.state!=="RESULT_RECORDED" || recorded.resultStatus!==run.status) return;
    runs.push(run.id);
    sparkDurationMs+=run.durationMs;
  }
  if (task.runId!==undefined && !runs.includes(task.runId)) return;
  const failure={stage:task.stage,finishedAt:task.finishedAt,taskVersion:execution.taskVersion,
    modelAttempts:model.attempts,ledgerTokens:model.ledgerTokens,sparkRunIds:runs,sparkDurationMs};
  if (validSettledDevelopmentFailure(failure)) return failure;
}

export function agentExecutionEvidencePath(requestId) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new Error("原请求编号格式不合法");
  return `/agent/requests/${requestId}/execution-evidence`;
}

// The caller has already resolved the authenticated creator's original ledger key.
// The reader here only accesses persisted task metadata and never reconciles a job.
export function storedAgentExecutionEvidence(task, read) {
  const base = {protocol:"shuduo-agent-execution-evidence/v1", scope:"PRIVATE_CLOUD_TEST",
    verificationMode:"STORED_METADATA_ONLY", taskId:task.id, fullLifecycleE2E:false, publicDeployed:false};
  if (task.executionMode !== "DURABLE_SQL_AGENT_V1" || task.language !== "SPARK_SQL" || task.mode !== "LIVE_MODEL" ||
      !task.submittedBy || task.sourceRunId !== undefined ||
      typeof task.message !== "string" || typeof task.initialSql !== "string")
    return {...base, status:"UNCONFIRMED", reason:"NATIVE_FRESH_TASK_REQUIRED"};
  if (!validStoredAgentDerivation(task,read))
    return {...base,status:"UNCONFIRMED",reason:"DERIVATION_SOURCE_UNCONFIRMED"};
  const execution = checkedLiveExecutionProjection(storedExecutionStages(task, read), task.id);
  if (execution.state !== "RECORDED")
    return {...base, status:"UNCONFIRMED", reason:"EXECUTION_PROVENANCE_UNCONFIRMED"};
  const snapshot = {...base, status:"EXECUTION_RECORDED", taskCreatedAt:task.createdAt, contextId:task.contextId,
    requestSha256:sha256(task.message), seedSqlSha256:sha256(task.initialSql), execution,
    ...(task.derivedFrom?{derivedFrom:task.derivedFrom}:{})};
  const failure=settledDevelopmentFailure(task,read,execution);
  if (failure) return {...snapshot,settledFailure:failure};
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
