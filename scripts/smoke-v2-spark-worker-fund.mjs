import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../src/v2/delivery.mjs";
import { createFundTestSql, verifiedFundRun } from "../src/v2/fund-delivery.mjs";
import { fundContext, fundReferenceSql } from "../src/v2/fund-lookthrough.mjs";
import { fundContextIds } from "../src/v2/fund-contexts.mjs";

if (!process.argv[2]) throw new Error("请指定已解包的 Spark Worker 根目录");
const root = resolve(process.argv[2]);
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(metadata.name, "shuduo-v2-spark-worker");

const fromPackage = name => import(pathToFileURL(join(root, "src/v2", name)).href);
const [{ createRemoteSparkWorker }, { createQueuedSparkJob, queueConfigFromEnvironment, verifyQueuedSparkResult }, { runtimeConfig }] =
  await Promise.all([fromPackage("remote-spark-worker.mjs"), fromPackage("remote-spark-queue.mjs"), fromPackage("spark.mjs")]);
const secret = "synthetic-fund-package-smoke-key-only";
const bucket = "synthetic-fund-package-smoke";
const config = queueConfigFromEnvironment({ V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE", V2_SPARK_EXECUTOR_SECRET: secret });
const runtime = runtimeConfig({
  JAVA_HOME: process.env.JAVA_HOME,
  V2_PYTHON: process.env.V2_PYTHON,
  PYTHONPATH: process.env.PYTHONPATH,
  V2_ARTIFACT_ROOT: process.env.V2_ARTIFACT_ROOT,
  V2_RETAIN_SPARK_ARTIFACTS: "false",
}, root);
assert.equal(runtime.available, true, "Spark Worker 验收运行环境未就绪");
const objects = new Map();
const { server } = createRemoteSparkWorker({
  env: { V2_SPARK_WORKER_SECRET: secret, V2_SPARK_QUEUE_CONSUMER_ENABLED: "true" },
  runtime,
  queueConfig: config,
  queueTransport: {
    config: { bucket },
    read: async key => objects.get(key),
    create: async (key, body) => {
      if (objects.has(key)) {
        assert.equal(objects.get(key), body);
        return { created: false };
      }
      objects.set(key, body);
      return { created: true };
    },
  },
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

async function execute(context, testSql) {
  const job = createQueuedSparkJob({ sql: fundReferenceSql, context, testSql }, config);
  objects.set(job.jobKey, JSON.stringify(job.job));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/invoke`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" },
    signal: AbortSignal.timeout(config.timeoutMs + 5000),
    body: JSON.stringify({ events: [{
      eventSource: "acs:oss", eventName: "ObjectCreated:PutObject", region: "cn-hangzhou",
      oss: { bucket: { name: bucket }, object: { key: job.jobKey } },
    }] }),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.jobId, job.job.jobId);
  const result = verifyQueuedSparkResult(JSON.parse(objects.get(job.resultKey)), job.job.jobId, config);
  assert.equal(result.status, receipt.status);
  return result;
}

try {
  const cases = [];
  for (const id of fundContextIds) {
    const context = fundContext(id);
    const testSql = createFundTestSql(context.expected, id);
    const result = await execute(context, testSql);
    assert.equal(result.engineVersion, "3.5.9", "基金 Spark 执行未通过");
    assert.equal(verifiedFundRun(result, id), true, "基金登记输入或独立断言未通过");
    assert.equal(result.testSqlValidation?.passed, true);
    assert.equal(result.testSqlValidation.sqlHash, sha256(testSql));
    cases.push({ contextId: id, rows: result.rows.length, independentAssertions: result.validation.assertions.length });
  }
  const tampered = fundContext();
  const positions = tampered.tables.find(table => table.name === "fund_positions");
  positions.rows[0][4] = "1.00";
  const rejected = await execute(tampered, createFundTestSql(tampered.expected));
  assert.equal(rejected.status, "FAILED");
  assert.equal(rejected.error, "FUND_LOOKTHROUGH_INPUT_MISMATCH");
  assert.equal(rejected.mainSqlExecuted, undefined);
  console.log(JSON.stringify({ scope: "ISOLATED_PACKAGED_WORKER", sparkVersion: "3.5.9", cases, tamperedInputRejectedBeforeSpark: true }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
