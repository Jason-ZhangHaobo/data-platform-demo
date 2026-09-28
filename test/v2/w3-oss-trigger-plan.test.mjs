import test from "node:test";
import assert from "node:assert/strict";
import {
  W3_QUEUE,
  renderV2W3OssTriggerPlan,
} from "../../scripts/render-v2-w3-oss-trigger-plan.mjs";
import { SPARK_QUEUE_PREFIXES, queueConfigFromEnvironment } from "../../src/v2/remote-spark-queue.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-control-runtime",
  V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN:
    "acs:ram::1234567890123456:role/shuduo-spark-queue-runtime",
  V2_W3_OSS_TRIGGER_ROLE_ARN:
    "acs:ram::1234567890123456:role/aliyunosseventnotificationrole",
  V2_FUNCTION_NAME: "shuduo-control-api",
  V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-spark-worker",
  V2_OSS_BUCKET: "shuduo-private-artifacts",
  V2_SPARK_WORKER_PACKAGE_SHA256: "a".repeat(64),
  V2_W3_SPARK_WORKER_PACKAGE_SHA256: "b".repeat(64),
  V2_W3_SPARK_WORKER_PACKAGE_BYTES: "318914999",
  V2_CONTROL_PACKAGE_SHA256: "c".repeat(64),
  V2_W3_CONTROL_PACKAGE_SHA256: "d".repeat(64),
  V2_W3_CONTROL_PACKAGE_BYTES: "46861622",
};

test("W3 OSS trigger plan is non-applying and excludes control Invoke permission", () => {
  const result = renderV2W3OssTriggerPlan(input);
  assert.equal(result.ok, true);
  assert.equal(result.apply, false);
  assert.equal(result.decision, "PENDING_EXPLICIT_W3_CLOUD_APPROVAL");
  assert.equal(result.controlPlane.fcInvokePermission, false);
  assert.equal(result.resourceScoping.fcInvokeFunctionOnControlRole, "NOT_GRANTED");
  const runtime = queueConfigFromEnvironment({
    V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE",
    V2_SPARK_EXECUTOR_SECRET: "synthetic-shared-secret-32-characters-long",
  });
  assert.equal(runtime.jobPrefix, SPARK_QUEUE_PREFIXES.jobs);
  assert.equal(W3_QUEUE.jobsPrefix, `${runtime.jobPrefix}/`);
  assert.equal(W3_QUEUE.resultsPrefix, `${runtime.resultPrefix}/`);
  assert.equal(W3_QUEUE.cancellationsPrefix, `${runtime.cancellationPrefix}/`);
  assert.equal(result.controlPlane.requiredObjectCapabilities.writeCancellation, W3_QUEUE.cancellationsPrefix);
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
        "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/spark-queue/results/*",
      ],
    },
    {
      Effect: "Allow",
      Action: "oss:PutObject",
      Resource:
        "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/spark-queue/results/*",
    },
  ]);
  assert.deepEqual(result.controlPlane.queueOnlyPolicy.Statement.map((statement) => statement.Action), [
    "oss:GetObject", "oss:PutObject",
  ]);
  assert.deepEqual(result.triggerInvocationRole.trustPolicy.Statement[0].Principal.Service, ["oss.aliyuncs.com"]);
  assert.deepEqual(result.triggerInvocationRole.invocationPolicy.Statement, [
    { Effect: "Allow", Action: "fc:InvokeFunction", Resource: "*" },
  ]);
  assert.deepEqual(result.deploymentRole.passOnlyNewRolesPolicy.Statement.map((statement) => ({
    action: statement.Action,
    resource: statement.Resource,
    service: statement.Condition.StringEquals["acs:Service"],
  })), [
    { action: "ram:PassRole", resource: input.V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN, service: "fc.aliyuncs.com" },
    { action: "ram:PassRole", resource: input.V2_W3_OSS_TRIGGER_ROLE_ARN, service: "oss.aliyuncs.com" },
  ]);
  assert.equal(result.deploymentRole.fcInvokePermission, false);
  assert.equal(result.deploymentRole.fcDeleteTriggerPermission, false);
  assert.deepEqual(result.deploymentRole.manageOnlyTriggerCreationAndReadPolicy.Statement[0], {
    Effect: "Allow",
    Action: ["fc:CreateTrigger", "fc:GetTrigger", "fc:ListTriggers"],
    Resource: "*",
  });
  assert.deepEqual(result.packageUploadRole.exactObjectPolicy.Statement, [{
    Effect: "Allow",
    Action: ["oss:GetObject", "oss:PutObject"],
    Resource: [
      "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/spark-worker/" + "b".repeat(64) + ".zip",
      "acs:oss:*:1234567890123456:shuduo-private-artifacts/data-platform-demo/v2/control-plane/" + "d".repeat(64) + ".zip",
    ],
  }]);
  assert.equal(result.immutableControlPackage.bytes, 46861622);
  assert.equal(result.immutableControlPackage.uploadMustBeCreateOnly, true);
  assert.equal(JSON.stringify(result).includes(input.V2_FUNCTION_ROLE_ARN), false);
  assert.equal(
    JSON.stringify(result.redacted).includes(input.V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN),
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

test("W3 trigger Invoke role cannot be the control or Worker runtime role", () => {
  for (const [role, expected] of [
    [input.V2_FUNCTION_ROLE_ARN, "W3_TRIGGER_ROLE_MUST_DIFFER_FROM_CONTROL_ROLE"],
    [input.V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN, "W3_TRIGGER_ROLE_MUST_DIFFER_FROM_WORKER_RUNTIME_ROLE"],
  ]) {
    const result = renderV2W3OssTriggerPlan({
      ...input,
      V2_W3_OSS_TRIGGER_ROLE_ARN: role,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(expected));
  }
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

test("W3 plan rejects queue prefix overrides that would escape its permissions", () => {
  const result = renderV2W3OssTriggerPlan({
    ...input,
    V2_SPARK_QUEUE_CANCELLATION_PREFIX: "data-platform-demo/v2/spark-queue/jobs",
  });
  assert.deepEqual(result, { ok: false, errors: ["UNSUPPORTED:V2_SPARK_QUEUE_CANCELLATION_PREFIX"] });
});

test("W3 plan requires a new bounded control package and distinct functions", () => {
  const result = renderV2W3OssTriggerPlan({
    ...input,
    V2_FUNCTION_NAME: input.V2_SPARK_WORKER_FUNCTION_NAME,
    V2_W3_CONTROL_PACKAGE_SHA256: input.V2_CONTROL_PACKAGE_SHA256,
    V2_W3_CONTROL_PACKAGE_BYTES: String(71 * 1024 * 1024),
  });
  assert.deepEqual(result.errors, [
    "W3_WORKER_FUNCTION_MUST_DIFFER_FROM_CONTROL_FUNCTION",
    "W3_CONTROL_PACKAGE_MUST_CHANGE",
    "INVALID:V2_W3_CONTROL_PACKAGE_BYTES",
  ]);
});
