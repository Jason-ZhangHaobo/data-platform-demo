import test from "node:test";
import assert from "node:assert/strict";
import { verifyV2SparkWorkerFunction } from "../../scripts/verify-v2-spark-worker-function.mjs";

const input = {
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-v2-spark-worker",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-v2-runtime",
  V2_SPARK_WORKER_PACKAGE_BYTES: "318911849",
  V2_SPARK_WORKER_SECRET: "synthetic-worker-secret-32-characters-long",
  V2_VPC_ID: "vpc-synthetic123",
  V2_VSW_ID: "vsw-synthetic123",
  V2_SECURITY_GROUP_ID: "sg-synthetic123",
};

const evidence = {
  function: {
    functionName: input.V2_SPARK_WORKER_FUNCTION_NAME,
    state: null,
    lastUpdateStatus: null,
    lastUpdateStatusReasonCode: null,
    lastUpdateStatusReason: null,
    codeSize: 318911849,
    runtime: "custom.debian10",
    cpu: 1,
    memorySize: 2048,
    diskSize: 10240,
    timeout: 180,
    instanceConcurrency: 1,
    internetAccess: false,
    disableOndemand: null,
    role: input.V2_FUNCTION_ROLE_ARN,
    layers: [
      { arn: "acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3" },
      { arn: "acs:fc:cn-hangzhou:official:layers/Python310/versions/3" },
      { arn: "acs:fc:cn-hangzhou:official:layers/Java17/versions/3" },
    ],
    customRuntimeConfig: {
      port: 9000,
      command: ["/opt/nodejs20/bin/node"],
      args: ["src/v2/remote-spark-worker.mjs"],
    },
    environmentVariables: {
      PATH: "/opt/nodejs20/bin:/opt/python3.10/bin:/opt/java17/bin:/usr/bin",
      JAVA_HOME: "/opt/java17",
      PYTHONPATH: "/code/python",
      V2_PYTHON: "/opt/python3.10/bin/python3",
      V2_ARTIFACT_ROOT: "/tmp",
      V2_RETAIN_SPARK_ARTIFACTS: "false",
      V2_SPARK_WORKER_RUN_TIMEOUT_MS: "120000",
      V2_SPARK_WORKER_MAX_BODY_BYTES: "2097152",
      V2_SPARK_WORKER_MAX_SKEW_MS: "60000",
      V2_SPARK_WORKER_PRIVATE_SMOKE_ENABLED: "true",
      V2_SPARK_WORKER_SECRET: input.V2_SPARK_WORKER_SECRET,
    },
    vpcConfig: {
      vpcId: input.V2_VPC_ID,
      vSwitchIds: [input.V2_VSW_ID],
      securityGroupId: input.V2_SECURITY_GROUP_ID,
    },
  },
  concurrency: { reservedConcurrency: 1 },
  scaling: { minInstances: 0, enableOnDemandScaling: null },
};

test("W2 function evidence requires exact runtime, layers, bounds and secret", () => {
  const result = verifyV2SparkWorkerFunction(input, evidence);
  assert.equal(result.ok, true);
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.deepEqual(result.evidence, {
    scope: "W2_FUNCTION_CONFIGURATION",
    publicDeployed: false,
    controlPlaneConnected: false,
    containsSecret: false,
  });
  assert.equal(JSON.stringify(result).includes(input.V2_SPARK_WORKER_SECRET), false);
});

test("wrong layer, public egress or secret fails without echoing values", () => {
  const privateSecret = "another-private-worker-secret-32-characters";
  const result = verifyV2SparkWorkerFunction(
    { ...input, V2_SPARK_WORKER_SECRET: privateSecret },
    {
      ...evidence,
      function: {
        ...evidence.function,
        internetAccess: true,
        layers: evidence.function.layers.slice(0, 2),
      },
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, [
    "noInternetEgress",
    "officialLayersMatch",
    "protectedSecretMatches",
  ]);
  assert.equal(JSON.stringify(result).includes(privateSecret), false);
  assert.equal(JSON.stringify(result).includes(input.V2_SPARK_WORKER_SECRET), false);
});

test("missing concurrency or scaling evidence fails before inspection", () => {
  const result = verifyV2SparkWorkerFunction(input, {
    function: evidence.function,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["INVALID:SPARK_WORKER_FUNCTION_EVIDENCE"]);
});

test("explicitly disabling on-demand capacity fails even with zero minimum instances", () => {
  const result = verifyV2SparkWorkerFunction(input, {
    ...evidence,
    function: { ...evidence.function, disableOndemand: true },
    scaling: { minInstances: 0, enableOnDemandScaling: false },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["onDemandAllowed", "scalesToZero"]);
});

test("an explicit FC update failure is rejected even when the optional state is absent", () => {
  const result = verifyV2SparkWorkerFunction(input, {
    ...evidence,
    function: {
      ...evidence.function,
      lastUpdateStatus: "Failed",
      lastUpdateStatusReasonCode: "InvalidConfiguration",
      lastUpdateStatusReason: "synthetic private reason",
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, [
    "updateSuccessfulOrOmitted",
    "noUpdateFailureReason",
  ]);
  assert.equal(JSON.stringify(result).includes("synthetic private reason"), false);
});
