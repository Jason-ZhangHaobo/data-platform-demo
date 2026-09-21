import test from "node:test";
import assert from "node:assert/strict";
import { renderV2W3InvokeBoundary } from "../../scripts/render-v2-w3-invoke-boundary.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-control-runtime",
  V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-spark-worker",
};

test("W3 boundary discloses the official account-wide Invoke limit", () => {
  const result = renderV2W3InvokeBoundary(input);
  assert.equal(result.ok, true);
  assert.equal(result.decision, "PENDING_USER_APPROVAL");
  assert.deepEqual(result.options.directInvoke.policy.Statement, [
    { Effect: "Allow", Action: "fc:InvokeFunction", Resource: "*" },
  ]);
  assert.equal(result.options.directInvoke.resourceScopedByRam, false);
  assert.equal(result.apply, false);
});

test("W3 recommends a durable queue when account-wide Invoke is rejected", () => {
  const result = renderV2W3InvokeBoundary(input);
  assert.equal(result.recommendation, "PRIVATE_OSS_QUEUE");
  assert.equal(result.options.privateOssQueue.fcInvokePermissionOnControlRole, false);
  assert.equal(result.options.privateOssQueue.durable, true);
  assert.equal(result.options.privateOssQueue.recoverableAfterFreeze, true);
  assert.equal(JSON.stringify(result).includes(input.V2_FUNCTION_ROLE_ARN), false);
  assert.equal(JSON.stringify(result).includes(input.V2_SPARK_WORKER_FUNCTION_NAME), false);
});

test("W3 boundary fails closed on cross-account or malformed identities", () => {
  const result = renderV2W3InvokeBoundary({
    ...input,
    ALIYUN_ACCOUNT_ID: "9999999999999999",
    V2_SPARK_WORKER_FUNCTION_NAME: "bad/name",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "ACCOUNT_MISMATCH:V2_FUNCTION_ROLE_ARN",
    "INVALID:V2_SPARK_WORKER_FUNCTION_NAME",
  ]);
});
