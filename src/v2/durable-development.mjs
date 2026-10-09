const terminal = new Set(["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED"]);

export function publicDevelopmentRun(run) {
  if (!run) return run;
  const { remoteSubmission, ...visible } = run;
  if (!terminal.has(run.status)) delete visible.durationMs;
  return visible;
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

export async function reconcileDurableDevelopment(run, { runner, store, project, persist, contextIds, contractId }) {
  if (!run.remoteSubmission || terminal.has(run.status)) return run;
  let result;
  try {
    result = await runner.read(run.remoteSubmission.prepared);
    if (!result) {
      if (!run.remoteSubmission.submitted) {
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
    if (!terminal.has(result.status) || result.engine !== "Apache Spark" || result.engineVersion !== "3.5.9")
      throw Object.assign(new Error("云端任务回执不合法"), { code: "REMOTE_SPARK_INVALID_RESULT" });
    if (result.status === "SUCCEEDED" &&
        (result.engine !== "Apache Spark" || result.engineVersion !== "3.5.9" ||
         result.mainSqlExecuted !== true || result.testDouble === true || result.validation?.passed !== true ||
         !contextIds.every(id => result.validation?.regressions?.some(c => c.contextId === id && c.passed))))
      throw Object.assign(new Error("云端任务缺少完整独立验证"), { code: "REMOTE_SPARK_INVALID_RESULT" });
  } catch (error) {
    if (error.code !== "REMOTE_SPARK_TIMEOUT") throw error;
    result = { status: "FAILED", code: error.code, error: "云端任务超时" };
  }
  const current = store.get("run", run.id, project);
  if (terminal.has(current.status)) return current;
  const receipt = Object.fromEntries([
    "status", "engine", "engineVersion", "mainSqlExecuted", "validation", "rows", "columns", "durationMs",
    "stdout", "stderr", "code", "error", "isolation", "adapter", "mode", "remoteWorker",
  ].filter(key => result[key] !== undefined).map(key => [key, result[key]]));
  const updated = store.update("run", run.id, project, {
    ...receipt, stage: "COMPLETED", finishedAt: new Date().toISOString(),
    ...(receipt.validation ? { validation: { ...receipt.validation, contractId } } : {}),
  });
  await persist();
  return updated;
}
