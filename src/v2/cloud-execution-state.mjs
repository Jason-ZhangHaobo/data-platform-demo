// An unavailable executor must never take saved query results offline or fall
// back to a local process in the cloud. No persisted configuration is changed.
export function cloudExecutionState(env, runner, descriptor, candidate) {
  if (runner) return { env, runner, descriptor };
  const unavailable = async () => {
    throw Object.assign(new Error("远程执行器尚未就绪；已保存结果仍可读取"), {
      status: 503, code: "REMOTE_SPARK_NOT_READY",
    });
  };
  const state = {
    ...descriptor, engine: "Apache Spark", isolation: "REMOTE_FUNCTION",
    healthVerified: false, publicWriteEnabled: false,
    errorCode: descriptor?.errorCode ?? "REMOTE_SPARK_NOT_READY",
  };
  unavailable.descriptor = state;
  const readPendingSparkResult = candidate?.descriptor?.transport === "PRIVATE_OSS_QUEUE" &&
    typeof candidate.durable?.read === "function"
    ? prepared => candidate.durable.read(prepared, {cancelOnTimeout:false}) : undefined;
  return {
    runner: unavailable,
    descriptor: state,
    readPendingSparkResult,
    env: {
      ...env,
      V2_EXECUTION_UNAVAILABLE: "true",
      V2_DURABLE_SQL_AGENT_ENABLED: "false",
      V2_DURABLE_MANUAL_DELIVERY_ENABLED: "false",
      V2_AGENT_DRIVER_MODE: "DISABLED",
      V2_PRIVATE_RELEASE_ENABLED: "false",
      V2_RELEASE_SCHEDULER_MODE: "DISABLED",
    },
  };
}
