import test from "node:test";
import assert from "node:assert/strict";
import { renderV2SparkWorkerW2Plan } from "../../scripts/render-v2-spark-worker-w2-plan.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_FUNCTION_NAME: "shuduo-v2-control",
  V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-v2-spark-worker",
  V2_OSS_BUCKET: "shuduo-synthetic-staging",
  V2_SPARK_WORKER_PACKAGE_SHA256: "a".repeat(64),
  V2_SPARK_WORKER_PACKAGE_BYTES: "318911849",
  V2_VPC_ID: "vpc-synthetic123",
  V2_VSW_ID: "vsw-synthetic123",
  V2_SECURITY_GROUP_ID: "sg-synthetic123",
  V2_SPARK_WORKER_SECRET: "synthetic-worker-secret-32-characters-long",
};

test("W2 plan binds one immutable OSS package and three official runtimes", () => {
  const result = renderV2SparkWorkerW2Plan(input),
    plan = result.plan;
  assert.equal(result.ok, true);
  assert.equal(plan.scope, "W2_PREPARED_NOT_DEPLOYED");
  assert.equal(plan.publicDeployed, false);
  assert.equal(plan.package.ossObjectName, `data-platform-demo/v2/spark-worker/${"a".repeat(64)}.zip`);
  assert.deepEqual(plan.function.layers, [
    "acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3",
    "acs:fc:cn-hangzhou:official:layers/Python310/versions/3",
    "acs:fc:cn-hangzhou:official:layers/Java17/versions/3",
  ]);
  assert.equal(plan.function.environmentVariables.JAVA_HOME, "/opt/java17");
  assert.equal(plan.function.environmentVariables.V2_PYTHON, "/opt/python3.10/bin/python3");
  assert.equal(plan.function.customRuntimeConfig.command[0], "/opt/nodejs20/bin/node");
  assert.equal(plan.function.instanceConcurrency, 1);
  assert.equal(plan.concurrency.reservedConcurrency, 1);
  assert.equal(plan.scaling.minInstances, 0);
  assert.equal(plan.function.internetAccess, false);
  assert.equal(plan.futureControlPlanePermission.authorized, false);
  assert.equal(JSON.stringify(plan).includes(input.V2_SPARK_WORKER_SECRET), false);
});

test("W2 permission delta is exact-object read/write without list, delete or FC invoke", () => {
  const policy = renderV2SparkWorkerW2Plan(input).plan.deploymentPermissionDelta,
    statement = policy.Statement[0];
  assert.deepEqual(statement.Action, ["oss:GetObject", "oss:PutObject"]);
  assert.equal(statement.Resource, `acs:oss:*:${input.ALIYUN_ACCOUNT_ID}:${input.V2_OSS_BUCKET}/data-platform-demo/v2/spark-worker/${"a".repeat(64)}.zip`);
  assert.equal(JSON.stringify(policy).includes("Delete"), false);
  assert.equal(JSON.stringify(policy).includes("List"), false);
  assert.equal(JSON.stringify(policy).includes("fc:InvokeFunction"), false);
});

test("W2 plan fails closed for oversized packages, shared functions and weak secrets", () => {
  const secret = "do-not-echo-this-short-secret",
    result = renderV2SparkWorkerW2Plan({
      ...input,
      V2_SPARK_WORKER_FUNCTION_NAME: input.V2_FUNCTION_NAME,
      V2_SPARK_WORKER_PACKAGE_BYTES: String(500 * 1024 * 1024 + 1),
      V2_SPARK_WORKER_SECRET: secret,
    });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "WORKER_AND_CONTROL_FUNCTIONS_MUST_DIFFER",
    "INVALID:V2_SPARK_WORKER_PACKAGE_BYTES",
    "INVALID:V2_SPARK_WORKER_SECRET",
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
