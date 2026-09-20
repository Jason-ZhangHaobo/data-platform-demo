import test from "node:test";
import assert from "node:assert/strict";
import {
  applyV2W2MinimumPolicies,
  validateV2W2MinimumPolicies,
} from "../../scripts/apply-v2-w2-minimum-policies.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_DEPLOY_ROLE_ARN:
    "acs:ram::1234567890123456:role/shuduo-v2-deployer",
  V2_FUNCTION_ROLE_ARN:
    "acs:ram::1234567890123456:role/shuduo-v2-runtime",
  V2_VSW_ID: "vsw-synthetic123",
  V2_SECURITY_GROUP_ID: "sg-synthetic123",
  V2_OSS_BUCKET: "shuduo-synthetic-staging",
  V2_SPARK_WORKER_PACKAGE_SHA256: "f".repeat(64),
};

const json = (value) => ({
  ok: true,
  status: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});

test("W2 policy bundle validates both policies before any cloud call", () => {
  const result = validateV2W2MinimumPolicies({
    ...input,
    V2_FUNCTION_ROLE_ARN: input.V2_DEPLOY_ROLE_ARN,
    V2_SPARK_WORKER_PACKAGE_SHA256: "bad",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "DEPLOYMENT:DEPLOYMENT_AND_RUNTIME_ROLES_MUST_DIFFER",
    "WORKER_PACKAGE:INVALID:V2_SPARK_WORKER_PACKAGE_SHA256",
  ]);
});

test("W2 policy bundle creates, attaches and verifies exactly two policies", () => {
  const calls = [],
    attached = new Set(),
    runner = (args) => {
      calls.push(args);
      const action = args[1],
        policyName = args[args.indexOf("--PolicyName") + 1];
      if (action === "GetPolicy")
        return {
          ok: false,
          status: 1,
          stdout: "",
          stderr: "EntityNotExist.Policy",
        };
      if (action === "CreatePolicy") return json({ RequestId: "synthetic" });
      if (action === "AttachPolicyToRole") {
        attached.add(policyName);
        return json({ RequestId: "synthetic" });
      }
      if (action === "ListPoliciesForRole")
        return json({
          Policies: {
            Policy: [...attached].map((name) => ({
              PolicyName: name,
              PolicyType: "Custom",
            })),
          },
        });
      throw new Error(`UNEXPECTED:${action}`);
    },
    result = applyV2W2MinimumPolicies(input, runner);
  assert.equal(result.ok, true);
  assert.deepEqual(attached, new Set([
    "DataPlatformV2DeployMinimal",
    "DataPlatformV2SparkWorkerPackageMinimal",
  ]));
  assert.deepEqual(result.boundaries, {
    productWildcards: false,
    ossListOrDelete: false,
    fcInvoke: false,
    policyReplacement: false,
  });
  assert.equal(
    calls.some((args) =>
      ["CreatePolicyVersion", "DeletePolicy", "DetachPolicyFromRole"].includes(
        args[1],
      ),
    ),
    false,
  );
});

test("W2 policy bundle stops before package policy after deployment drift", () => {
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
    () => applyV2W2MinimumPolicies(input, runner),
    /POLICY_DOCUMENT_MISMATCH/,
  );
});

