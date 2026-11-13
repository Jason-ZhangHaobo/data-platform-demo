import { validationDetails, validationWithoutRawComparisons } from "./validation-details.mjs";
import { syncSqlOutputSchemaDetails } from "./sync-sql-input.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { verifiedWorkerResultDigest } from "./worker-result-evidence.mjs";

const terminal = new Set(["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED"]);

export function publicDevelopmentRun(run, revision) {
  if (!run) return run;
  const { remoteSubmission, workerResultDigest, syncOutputSchema: storedSchema, ...visible } = run;
  if (!terminal.has(run.status)) delete visible.durationMs;
  const syncOutputSchema = syncSqlOutputSchemaDetails(run, revision);
  return { ...visible, validation: validationWithoutRawComparisons(visible.validation), validationDetails: validationDetails(run, revision),
    ...(syncOutputSchema ? { syncOutputSchema } : {}) };
}

export async function submitDurableDevelopment(run, revision, { runner, store, project, persist, context, validationContexts }) {
  let current = store.get("run", run.id, project);
  if (terminal.has(current.status) || current.remoteSubmission?.submitted) return current;
  if (!current.remoteSubmission) {
    const prepared = runner.prepare({ sql: revision.sql, context, validationContexts }, run.id);
    current = store.update("run", run.id, project, {
      remoteSubmission: { prepared, submitted: false },
      isolation: "FUNCTION_PROCESS", mode: "DURABLE_REMOTE_SUBMISSION",
      stage: "SUBMITTING", durationMs: 30000,
    });
    await persist();
  }
  await runner.submit(current.remoteSubmission.prepared);
  current = store.update("run", run.id, project, {
    remoteSubmission: { ...current.remoteSubmission, submitted: true },
    stage: "WAITING_FOR_WORKER_RESULT", submittedAt: new Date().toISOString(),
  });
  await persist();
  return current;
}

export async function reconcileDurableDevelopment(run, { runner, store, project, persist, contextIds, contractId, allowSubmit = true, settleResultEvent }) {
  if(run.validationContractId!==undefined&&run.validationContractId!==contractId)
    throw Object.assign(new Error("运行批次与业务口径验证契约不一致"),{code:"REMOTE_SPARK_CONTRACT_MISMATCH"});
  if (!run.remoteSubmission || (!settleResultEvent && terminal.has(run.status))) return run;
  const prepared = run.remoteSubmission.prepared;
  let result, workerResultDigest;
  try {
    result = await runner.read(prepared);
    if (!result) {
      if (settleResultEvent) throw Object.assign(new Error("原开发结果对象暂不可读取"), {status:503});
      if (!run.remoteSubmission.submitted && allowSubmit && !settleResultEvent) {
        await runner.submit(run.remoteSubmission.prepared);
        const submitted = store.update("run", run.id, project, {
          remoteSubmission: { ...run.remoteSubmission, submitted: true },
          stage: "WAITING_FOR_WORKER_RESULT", submittedAt: new Date().toISOString(),
        });
        await persist();
        return submitted;
      }
      return run;
    }
    if (settleResultEvent) {
      workerResultDigest = verifiedWorkerResultDigest(result);
      if (!workerResultDigest || typeof prepared.serialized!=="string" ||
          result.queueJobDigest!==createHash("sha256").update(prepared.serialized).digest("hex")) return run;
      if (result.status==="VALIDATION_FAILED" && (result.mainSqlExecuted!==true || result.validation?.passed!==false ||
          !Array.isArray(result.validation.regressions) || result.validation.regressions.length!==contextIds.length ||
          !contextIds.every(id=>result.validation.regressions.filter(check=>check?.contextId===id && typeof check.passed==="boolean").length===1) ||
          !result.validation.regressions.some(check=>check?.passed===false)))
        throw Object.assign(new Error("云端任务缺少独立校验失败证据"), {status:502,code:"REMOTE_SPARK_INVALID_RESULT"});
    }
    if (!terminal.has(result.status) || result.engine !== "Apache Spark" ||
        (result.engineVersion !== undefined && result.engineVersion !== "3.5.9"))
      throw Object.assign(new Error("云端任务回执不合法"), { code: "REMOTE_SPARK_INVALID_RESULT" });
    if(result.validation?.contractId!==undefined&&result.validation.contractId!==contractId)
      throw Object.assign(new Error("云端回执声明了不同的业务口径验证契约"),{code:"REMOTE_SPARK_INVALID_RESULT"});
    if (result.status === "SUCCEEDED" &&
        (result.engine !== "Apache Spark" || result.engineVersion !== "3.5.9" ||
         result.mainSqlExecuted !== true || result.testDouble === true || result.validation?.passed !== true ||
         !Array.isArray(result.validation?.regressions)||result.validation.regressions.length!==contextIds.length||
         new Set(result.validation.regressions.map(c=>c?.contextId)).size!==contextIds.length||
         !contextIds.every(id => result.validation.regressions.some(c => c?.contextId === id && c.passed === true))))
      throw Object.assign(new Error("云端任务缺少完整独立验证"), { code: "REMOTE_SPARK_INVALID_RESULT" });
  } catch (error) {
    if (settleResultEvent || error.code !== "REMOTE_SPARK_TIMEOUT") throw error;
    result = { status: "FAILED", code: error.code, error: "云端任务超时" };
  }
  const current = store.get("run", run.id, project);
  if (!settleResultEvent && terminal.has(current.status)) return current;
  const receipt = Object.fromEntries([
    "status", "engine", "engineVersion", "mainSqlExecuted", "validation", "rows", "columns", "durationMs",
    "log", "stdout", "stderr", "code", "error", "isolation", "adapter", "mode", "remoteWorker",
  ].filter(key => result[key] !== undefined).map(key => [key, result[key]]));
  const outcome = {
    ...receipt, durationMs: typeof receipt.durationMs === "number" ? receipt.durationMs : undefined,
    stage: "COMPLETED",
    ...(receipt.validation ? { validation: { ...receipt.validation, contractId } } : {}),
  };
  // An older controller may have persisted the run just before it stopped.
  // Only the matching signed receipt can complete that pending Agent update.
  if (settleResultEvent && terminal.has(current.status) &&
      !Object.entries(outcome).every(([key,value])=>isDeepStrictEqual(current[key],value)))
    throw Object.assign(new Error("原开发回执与已保存批次不一致"), {status:409,code:"REMOTE_SPARK_RESULT_MISMATCH"});
  const save = () => store.update("run", run.id, project, {
    ...outcome, finishedAt: terminal.has(current.status) ? current.finishedAt : new Date().toISOString(),
    ...(workerResultDigest ? {workerResultDigest} : {}),
  }, {expectedVersion:run.version});
  if (settleResultEvent) {
    store.deduplicate(`${project}:agent-development-result:${run.id}`,workerResultDigest,()=>{
      const saved=save();
      settleResultEvent(saved);
      return saved;
    });
  } else {
    save();
  }
  await persist();
  return store.get("run",run.id,project);
}
