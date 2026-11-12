/** @param {{status?: string, schedulerTriggered?: boolean, stage?: unknown}} run */
export function privateReleasePendingStage(run) {
  if (run.status !== "RUNNING") return;
  if (run.schedulerTriggered === true) {
    if (run.stage === "SUBMITTING" || run.stage === "WAITING_FOR_WORKER_RESULT") return run.stage;
  }
  return "UNCONFIRMED";
}

/** @param {{status?: string, schedulerTriggered?: boolean, stage?: unknown}} run */
export function privateReleasePendingLabel(run) {
  switch (privateReleasePendingStage(run)) {
    case "SUBMITTING": return "提交待确认";
    case "WAITING_FOR_WORKER_RESULT": return "等待 Worker 结果";
    case "UNCONFIRMED": return "运行阶段待确认";
  }
}
