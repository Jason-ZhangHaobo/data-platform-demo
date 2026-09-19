import { RemoteSparkClient } from "../src/v2/remote-spark.mjs";
import { contextIds, getContext, referenceSql } from "../src/v2/context.mjs";
import { createTestSql } from "../src/v2/delivery.mjs";

const endpoint = process.env.V2_SPARK_SMOKE_URL,
  sharedSecret = process.env.V2_SPARK_WORKER_SECRET;
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1\/execute$/.test(endpoint ?? ""))
  throw new Error("Spark Worker冒烟测试只允许本机回环地址");
if (typeof sharedSecret !== "string" || sharedSecret.length < 32)
  throw new Error("Spark Worker冒烟测试密钥未配置");

const client = new RemoteSparkClient({
  endpoint,
  sharedSecret,
  projectId: "project-securities-lab",
  timeoutMs: 180_000,
  maxRequestBytes: 2 * 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
});

let health;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    health = await client.health();
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!health) throw new Error("Spark Worker未在15秒内就绪");

const context = getContext("holdings-t1"),
  result = await client.execute({
    sql: referenceSql,
    context,
    validationContexts: contextIds.map(getContext),
    testSql: createTestSql(context.expected),
    timeoutMs: 180_000,
  });
if (
  result.status !== "SUCCEEDED" ||
  result.engine !== "Apache Spark" ||
  result.engineVersion !== "3.5.9" ||
  result.isolation !== "FUNCTION_PROCESS" ||
  result.validation?.passed !== true ||
  result.testSqlValidation?.passed !== true ||
  result.validation.regressions?.length !== contextIds.length ||
  result.validation.regressions.some((item) => item.passed !== true)
)
  throw new Error("Spark Worker证券SQL或独立断言未通过");

process.stdout.write(
  JSON.stringify({
    ok: true,
    engine: result.engine,
    engineVersion: result.engineVersion,
    isolation: result.isolation,
    regressionCount: result.validation.regressions.length,
    testSqlPassed: true,
  }) + "\n",
);
