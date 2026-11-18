const triggers = new Set(["SIGNED_BACKGROUND_EVENT", "OWNER_ADVANCE", "PRIVATE_TICK"]);

export const agentExecutionTrigger = value => triggers.has(value) ? value : "UNRECORDED";

// Only use persisted attempts and their original run. A grant, an event count,
// a readback or a successful result alone cannot establish the trigger.
export function storedDevelopmentDrivers(task, readRun) {
  if (task.executionMode !== "DURABLE_SQL_AGENT_V1" || !task.attempts?.length) return;
  return task.attempts.map((attempt,index) => {
    const run = attempt.runId && readRun(attempt.runId);
    const bound = run && run.id === attempt.runId && run.agentTaskId === task.id &&
      run.revisionId === attempt.revisionId && run.mode === "DURABLE_REMOTE_SUBMISSION" &&
      run.remoteSubmission?.prepared?.job?.jobId === run.id;
    const source = bound && run.remoteSubmission?.agentSubmissionTriggers;
    return {
      attempt: index + 1,
      modelTrigger: agentExecutionTrigger(attempt.modelTrigger),
      ...(bound ? { spark: {
        runId: run.id,
        submissionTriggers: Array.isArray(source) && source.length
          ? [...new Set(source.map(agentExecutionTrigger))] : ["UNRECORDED"],
      } } : {}),
    };
  });
}
