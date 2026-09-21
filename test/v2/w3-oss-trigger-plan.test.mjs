import test from "node:test";
import assert from "node:assert/strict";
import {
  W3_QUEUE,
  renderV2W3OssTriggerPlan,
} from "../../scripts/render-v2-w3-oss-trigger-plan.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-control-runtime",
  V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN:
    "acs:ram::1234567890123456:role/shuduo-spark-queue-runtime",
  V2_W3_OSS_TRIGGER_ROLE_ARN:
    "acs:ram::1234567890123456:role/aliyunosseventnotificationrole",
  V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-spark-worker",
  V2_OSS_BUCKET: "shuduo-private-artifacts",
  V2_SPARK_WORKER_PACKAGE_SHA256: "a".repeat(64),
  V2_W3_SPARK_WORKER_PACKAGE_SHA256: "b".repeat(64),
  V2_W3_SPARK_WORKER_PACKAGE_BYTES: "318914999",
};

test("W3 OSS trigger plan is non-applying and excludes control Invoke permission", () => {
  const result = renderV2W3OssTriggerPlan(input);
  assert.equal(result.ok, true);
  assert.equal(result.apply, false);
  assert.equal(result.decision, "PENDING_EXPLICIT_W3_CLOUD_APPROVAL");
  assert.equal(result.controlPlane.fcInvokePermission, false);
  assert.equal(result.resourceScoping.fcInvokeFunctionOnControlRole, "NOT_GRANTED");
  assert.deepEqual(result.ossTrigger.emitsOnlyFor, {
    event: "oss:ObjectCreated:PutObject",
    prefix: W3_QUEUE.jobsPrefix,
    suffix: ".json",
  });
  assert.equal(
    result.ossTrigger.triggerConfig,
    JSON.stringify({
      events: ["oss:ObjectCreated:PutObject"],
      filter: { key: { prefix: W3_QUEUE.jobsPrefix, suffix: ".json" } },
    }),
  );
  assert.deepEqual(result.workerRuntimeRole.queueOnlyPolicy.Statement, [
    {
      Effect: "Allow",
      Action: "oss:GetObject",
      Resource: [
        "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/spark-worker/" +
          "b".repeat(64) +
          ".zip",
        "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/spark-queue/jobs/*",
        "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/spark-queue/cancellations/*",
      ],
    },
    {
      Effect: "Allow",
      Action: "oss:PutObject",
      Resource:
        "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/spark-queue/results/*",
    },
  ]);
  assert.equal(JSON.stringify(result).includes(input.V2_FUNCTION_ROLE_ARN), false);
  assert.equal(
    JSON.stringify(result).includes(input.V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN),
    false,
  );
});

test("W3 trigger plan rejects a shared runtime role or unchanged Worker package", () => {
  const result = renderV2W3OssTriggerPlan({
    ...input,
    V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN: input.V2_FUNCTION_ROLE_ARN,
    V2_W3_SPARK_WORKER_PACKAGE_SHA256:
      input.V2_SPARK_WORKER_PACKAGE_SHA256,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "W3_WORKER_RUNTIME_ROLE_MUST_DIFFER_FROM_CONTROL_ROLE",
    "W3_WORKER_PACKAGE_MUST_CHANGE",
  ]);
});

test("W3 trigger plan fails closed for cross-account roles and invalid package size", () => {
  const result = renderV2W3OssTriggerPlan({
    ...input,
    V2_W3_OSS_TRIGGER_ROLE_ARN:
      "acs:ram::9999999999999999:role/aliyunosseventnotificationrole",
    V2_W3_SPARK_WORKER_PACKAGE_BYTES: "0",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "ACCOUNT_MISMATCH:V2_W3_OSS_TRIGGER_ROLE_ARN",
    "INVALID:V2_W3_SPARK_WORKER_PACKAGE_BYTES",
  ]);
});
