import test from "node:test";
import assert from "node:assert/strict";
import { verifyV2SparkWorkerRepair } from "../../scripts/verify-v2-spark-worker-repair.mjs";

const role = "acs:ram::1234567890123456:role/shuduo-v2-runtime",
  secret = "synthetic-worker-secret-32-characters-long",
  input = {
    ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
    V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-v2-spark-worker",
    V2_SPARK_WORKER_PACKAGE_BYTES: "318911849",
    V2_SPARK_WORKER_SECRET: secret,
    V2_FUNCTION_ROLE_ARN: role,
    V2_VPC_ID: "vpc-synthetic123",
    V2_VSW_ID: "vsw-synthetic123",
    V2_SECURITY_GROUP_ID: "sg-synthetic123",
  },
  evidence = {
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
      role: "",
      layers: ["Nodejs20", "Python310", "Java17"].map((name) => ({ arn: `acs:fc:cn-hangzhou:official:layers/${name}/versions/3` })),
      customRuntimeConfig: { port: 9000, command: ["/opt/nodejs20/bin/node"], args: ["src/v2/remote-spark-worker.mjs"] },
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
        V2_SPARK_WORKER_SECRET: secret,
      },
      vpcConfig: { vpcId: input.V2_VPC_ID, vSwitchIds: [input.V2_VSW_ID], securityGroupId: input.V2_SECURITY_GROUP_ID },
    },
    concurrency: { reservedConcurrency: 1 },
    scaling: { minInstances: 0, enableOnDemandScaling: null },
  };

test("repair accepts only the expected missing runtime role", () => {
  const result = verifyV2SparkWorkerRepair(input, evidence);
  assert.equal(result.ok, true);
  assert.deepEqual(result.repairableChecks, ["runtimeRoleMatches"]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("repair refuses immutable function drift", () => {
  const result = verifyV2SparkWorkerRepair(input, {
    ...evidence,
    function: { ...evidence.function, internetAccess: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_REPAIR_SCOPE_EXCEEDED");
  assert.deepEqual(result.failed, ["noInternetEgress", "runtimeRoleMatches"]);
});
