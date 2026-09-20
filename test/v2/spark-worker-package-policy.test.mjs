import test from "node:test";
import assert from "node:assert/strict";
import {
  applyV2SparkWorkerPackagePolicy,
  validateSparkWorkerPolicyApplyInput,
} from "../../scripts/apply-v2-spark-worker-package-policy.mjs";
import { renderV2SparkWorkerPackagePolicy } from "../../scripts/render-v2-spark-worker-package-policy.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  V2_DEPLOY_ROLE_ARN:
    "acs:ram::1234567890123456:role/shuduo-v2-deployer",
  V2_OSS_BUCKET: "shuduo-synthetic-staging",
  V2_SPARK_WORKER_PACKAGE_SHA256: "f".repeat(64),
};
const json = (value) => ({
  ok: true,
  stdout: JSON.stringify(value),
  stderr: "",
});

test("Worker package policy grants only exact-object Get and Put", () => {
  const result = renderV2SparkWorkerPackagePolicy(input),
    statement = result.policy.Statement[0];
  assert.equal(result.ok, true);
  assert.deepEqual(statement.Action, ["oss:GetObject", "oss:PutObject"]);
  assert.equal(
    statement.Resource,
    `acs:oss:*:${input.ALIYUN_ACCOUNT_ID}:${input.V2_OSS_BUCKET}/data-platform-demo/v2/spark-worker/${input.V2_SPARK_WORKER_PACKAGE_SHA256}.zip`,
  );
  assert.equal(JSON.stringify(result.policy).includes("Delete"), false);
  assert.equal(JSON.stringify(result.policy).includes("List"), false);
  assert.equal(statement.Action.includes("oss:*"), false);
});

test("Worker package policy is created, attached and verified idempotently", () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[1] === "GetPolicy")
      return {
        ok: false,
        stdout: "",
        stderr: "EntityNotExist.Policy",
      };
    if (args[1] === "CreatePolicy" || args[1] === "AttachPolicyToRole")
      return json({ RequestId: "synthetic" });
    if (args[1] === "ListPoliciesForRole") {
      const attached = calls.some(
        (call) => call[1] === "AttachPolicyToRole",
      );
      return json({
        Policies: {
          Policy: attached
            ? [
                {
                  PolicyName: "DataPlatformV2SparkWorkerPackageMinimal",
                  PolicyType: "Custom",
                },
              ]
            : [],
        },
      });
    }
    throw new Error(`UNEXPECTED:${args[1]}`);
  };
  assert.deepEqual(applyV2SparkWorkerPackagePolicy(input, runner), {
    ok: true,
    policyName: "DataPlatformV2SparkWorkerPackageMinimal",
    created: true,
    attached: true,
    verified: true,
  });
  const document = JSON.parse(
    calls
      .find((call) => call[1] === "CreatePolicy")
      .at(-1),
  );
  assert.deepEqual(
    document,
    renderV2SparkWorkerPackagePolicy(input).policy,
  );
});

test("existing mismatched Worker package policy fails closed", () => {
  const runner = (args) => {
    if (args[1] === "GetPolicy")
      return json({ Policy: { DefaultVersion: "v1" } });
    if (args[1] === "GetPolicyVersion")
      return json({
        PolicyVersion: {
          PolicyDocument: '{"Version":"1","Statement":[]}',
        },
      });
    throw new Error(`UNEXPECTED:${args[1]}`);
  };
  assert.throws(
    () => applyV2SparkWorkerPackagePolicy(input, runner),
    /POLICY_DOCUMENT_MISMATCH/,
  );
});

test("Worker package policy rejects foreign roles and malformed package identity", () => {
  assert.deepEqual(
    validateSparkWorkerPolicyApplyInput({
      ...input,
      V2_DEPLOY_ROLE_ARN:
        "acs:ram::1234567890123457:role/shuduo-v2-deployer",
      V2_SPARK_WORKER_PACKAGE_SHA256: "not-a-digest",
    }).errors,
    [
      "INVALID:V2_SPARK_WORKER_PACKAGE_SHA256",
      "ACCOUNT_MISMATCH:V2_DEPLOY_ROLE_ARN",
    ],
  );
});
