import {createHash} from "node:crypto";
import {validationFamilyForContext} from "./context.mjs";
import {uuid} from "./live-lifecycle-checkpoint.mjs";
import {verifiedLiveTaskSnapshotBinding} from "./live-lifecycle-evaluation.mjs";
import {liveEvidenceProvenance} from "./live-lifecycle-provenance.mjs";

const unresolved = {state:"UNCONFIRMED"};
const modelStages = new Map([
  ["READY_FOR_MODEL","READY"], ["MODEL_IN_FLIGHT","IN_FLIGHT"],
  ["MODEL_OUTCOME_UNKNOWN","OUTCOME_UNKNOWN"], ["MODEL_NOT_SENT","NOT_SENT"],
]);
const recordedRunStatuses = new Set(["SUCCEEDED","FAILED","VALIDATION_FAILED","CANCELLED","INTERRUPTED"]);
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;

function modelSnapshot(task) {
  let reportedTokens = 0, reservedTokens = 0, unconfirmedAttempts = 0;
  const ledgerTokens = nonnegative(task.usedTokens) ? task.usedTokens : null;
  for (const attempt of task.attempts) {
    const total = attempt?.usage?.total_tokens;
    const estimated = attempt?.usageEstimated === true ||
      ["IN_FLIGHT","OUTCOME_UNKNOWN","NOT_SENT"].includes(modelStages.get(attempt?.status));
    if (estimated || !nonnegative(total)) unconfirmedAttempts++;
    if (nonnegative(total)) {
      if (estimated) reservedTokens += total;
      else reportedTokens += total;
    }
  }
  const accounted = reportedTokens + reservedTokens;
  const comparable = ledgerTokens !== null && nonnegative(accounted) && accounted <= ledgerTokens;
  const unattributedTokens = comparable ? ledgerTokens - accounted : null;
  const latest = task.attempts.at(-1);
  let state = modelStages.get(task.stage) ?? modelStages.get(latest?.status);
  if (!state && latest?.usageEstimated === true && latest.diagnostic?.requestMayHaveBeenSent === true) state = "OUTCOME_UNKNOWN";
  if (!state) {
    if (latest?.modelFinishedAt || latest?.revisionId || latest?.runId) state = "OUTPUT_RECORDED";
    else if (!latest && task.status === "QUEUED") state = "READY";
    else state = "UNCONFIRMED";
  }
  return {state, attempts:task.attempts.length, ledgerTokens,
    reportedTokens:nonnegative(reportedTokens) ? reportedTokens : null,
    reservedTokens:nonnegative(reservedTokens) ? reservedTokens : null,
    unattributedTokens, unconfirmedAttempts,
    usage:!comparable ? "UNCONFIRMED" : (unconfirmedAttempts || unattributedTokens ? "PENDING" : "RECORDED")};
}

function sparkSnapshot(definition, state, task, read) {
  const latest = task.attempts.at(-1);
  const frozen = state.code;
  if (frozen && frozen.taskId !== task.id) return unresolved;
  const revisionId = frozen ? frozen.revisionId : latest?.revisionId;
  const runId = frozen ? frozen.runId : latest?.runId;
  if (!revisionId && !runId && !frozen) return {state:"NOT_LINKED"};
  if (!uuid.test(revisionId ?? "") || (frozen && !uuid.test(runId ?? "")) ||
      (runId !== undefined && !uuid.test(runId))) return unresolved;
  const attempt = task.attempts.find(item => item?.revisionId === revisionId && item.runId === runId);
  if (!attempt) return unresolved;
  const revision = read("revision", revisionId);
  if (!revision || revision.id !== revisionId || revision.contextId !== definition.contextId ||
      revision.source !== "LIVE_MODEL" || typeof revision.sql !== "string" ||
      createHash("sha256").update(revision.sql).digest("hex") !== revision.hash ||
      (frozen && frozen.revisionHash !== revision.hash)) return unresolved;
  const revisionProof = liveEvidenceProvenance(revision);
  if (revisionProof.nonNative || revisionProof.unconfirmed) return unresolved;
  const binding = {revisionId, revisionHash:revision.hash, pinned:Boolean(frozen)};
  if (!runId) return {state:"REVISION_RECORDED", ...binding, ...(revisionProof.synthetic ? {testHarness:true} : {})};
  const run = read("run", runId);
  const contractId = validationFamilyForContext(definition.contextId)?.id;
  if (!run || run.id !== runId || run.agentTaskId !== task.id || run.revisionId !== revisionId ||
      run.revisionHash !== revision.hash || run.contextId !== definition.contextId ||
      run.validationContractId !== contractId ||
      (run.validation?.contractId !== undefined && run.validation.contractId !== contractId)) return unresolved;
  const proof = liveEvidenceProvenance(run);
  if (proof.nonNative || proof.unconfirmed) return unresolved;
  let runState = "UNCONFIRMED";
  if (run.code === "REMOTE_SPARK_TIMEOUT") runState = "RESULT_UNCONFIRMED";
  else if (recordedRunStatuses.has(run.status)) runState = "RESULT_RECORDED";
  else if (["SUBMITTING","WAITING_FOR_WORKER_RESULT"].includes(run.stage)) {
    if (run.remoteSubmission?.prepared?.job?.jobId !== runId) return unresolved;
    runState = run.remoteSubmission.submitted === true ? "WAITING_FOR_RESULT" : "SUBMISSION_UNCONFIRMED";
  }
  else if (["QUEUED","RUNNING"].includes(run.status)) runState = run.status;
  return {state:runState, ...binding, runId,
    ...(runState === "RESULT_RECORDED" ? {resultStatus:run.status} : {}),
    ...(proof.synthetic || revisionProof.synthetic ? {testHarness:true} : {})};
}

// Reads only stored task, revision and run metadata. It deliberately does not
// use the development APIs that reconcile worker results into the store.
export function liveExecutionSnapshot(definition, entry, sourceCheckpoint, {read, testHarness=false}) {
  const task = read("agent", entry.taskId);
  if (!verifiedLiveTaskSnapshotBinding(definition, entry, task, sourceCheckpoint)) return unresolved;
  const proof = liveEvidenceProvenance(task, entry, sourceCheckpoint);
  if (proof.nonNative || proof.unconfirmed || task.attempts.length > 3) return unresolved;
  const spark = sparkSnapshot(definition, entry, task, read);
  return {state:"RECORDED", taskId:task.id, taskVersion:task.version,
    evidence:testHarness || proof.synthetic || spark.testHarness ? "TEST_HARNESS" : "STORED_METADATA",
    model:modelSnapshot(task), spark};
}

// Accept only the public projection when the CLI reads the workbench API.
export function checkedLiveExecutionProjection(value, taskId, frozen) {
  if (value?.state !== "RECORDED" || value.taskId !== taskId || !nonnegative(value.taskVersion) ||
      !["TEST_HARNESS","STORED_METADATA"].includes(value.evidence)) return unresolved;
  const model = value.model, spark = value.spark;
  const amountKeys = ["ledgerTokens","reportedTokens","reservedTokens","unattributedTokens"];
  if (!model || !["READY","IN_FLIGHT","OUTCOME_UNKNOWN","NOT_SENT","OUTPUT_RECORDED","UNCONFIRMED"].includes(model.state) ||
      !["RECORDED","PENDING","UNCONFIRMED"].includes(model.usage) ||
      !nonnegative(model.attempts) || model.attempts > 3 || !nonnegative(model.unconfirmedAttempts) ||
      model.unconfirmedAttempts > model.attempts ||
      amountKeys.some(key => model[key] !== null && !nonnegative(model[key]))) return unresolved;
  let sparkView = unresolved;
  if (spark?.state === "NOT_LINKED" && !frozen) sparkView = {state:"NOT_LINKED"};
  else if (spark && uuid.test(spark.revisionId ?? "") && /^[a-f0-9]{64}$/.test(spark.revisionHash ?? "") &&
      spark.pinned === Boolean(frozen) &&
      (!frozen || (spark.revisionId === frozen.revisionId && spark.revisionHash === frozen.revisionHash && spark.runId === frozen.runId))) {
    const bound = {state:spark.state, revisionId:spark.revisionId, revisionHash:spark.revisionHash, pinned:spark.pinned};
    if (spark.state === "REVISION_RECORDED" && !frozen && spark.runId === undefined) sparkView = bound;
    else if (uuid.test(spark.runId ?? "") &&
      ["QUEUED","RUNNING","WAITING_FOR_RESULT","SUBMISSION_UNCONFIRMED","RESULT_UNCONFIRMED","RESULT_RECORDED","UNCONFIRMED"].includes(spark.state) &&
      (spark.state !== "RESULT_RECORDED" || recordedRunStatuses.has(spark.resultStatus))) {
      sparkView = {...bound, runId:spark.runId, ...(spark.state === "RESULT_RECORDED" ? {resultStatus:spark.resultStatus} : {})};
    }
  }
  return {
    state:"RECORDED", taskId, taskVersion:value.taskVersion, evidence:value.evidence,
    model:{state:model.state, usage:model.usage, attempts:model.attempts, unconfirmedAttempts:model.unconfirmedAttempts,
      ...Object.fromEntries(amountKeys.map(key => [key, model[key]]))},
    spark:sparkView,
  };
}
