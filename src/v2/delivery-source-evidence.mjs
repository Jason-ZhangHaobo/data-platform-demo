const localVersions = new Set(['3.5.7', '3.5.8', '3.5.9']);
const remoteVersions = new Set(['3.5.8', '3.5.9']);

export const supportedDeliverySparkVersion = (version, remote = false) =>
  (remote ? remoteVersions : localVersions).has(version);

// Shared by file creation and the read-only source picker. A successful status
// does not establish that SQL actually ran, or that the executor was real.
export function deliverySourceExecutionIssue(run) {
  if (run?.testDouble === true)
    return {code:'DELIVERY_SOURCE_SIMULATED',message:'来源被标记为模拟执行，不能作为真实 Spark 交付依据；原记录可继续查看。'};
  if (run?.mainSqlExecuted !== true)
    return {code:'DELIVERY_SOURCE_EXECUTION_UNCONFIRMED',message:'来源尚未确认主 SQL 已实际执行，不能生成真实 Spark 交付包；原记录保留，不自动重跑。'};
  if (run.engine !== 'Apache Spark' || !supportedDeliverySparkVersion(run.engineVersion, run.isolation === 'FUNCTION_PROCESS'))
    return {code:'DELIVERY_SOURCE_ENGINE_UNSUPPORTED',message:'来源没有可用的真实 Spark 引擎及版本证据，不能生成交付包；原记录可继续查看。'};
}
