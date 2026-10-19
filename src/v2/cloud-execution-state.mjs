// An unavailable executor must never take saved query results offline or fall
// back to a local process in the cloud. No persisted configuration is changed.
export function cloudExecutionState(env, runner, descriptor) {
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
  return {
    runner: unavailable,
    descriptor: state,
    env: env.V2_PRIVATE_DATA_SERVICES_ENABLED === "true" ? {
      ...env,
      V2_EXECUTION_UNAVAILABLE: "true",
      V2_DURABLE_SQL_AGENT_ENABLED: "false",
      V2_AGENT_DRIVER_MODE: "DISABLED",
      V2_PRIVATE_RELEASE_ENABLED: "false",
      V2_RELEASE_SCHEDULER_MODE: "DISABLED",
    } : env,
  };
}
