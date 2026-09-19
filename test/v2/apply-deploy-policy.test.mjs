import test from "node:test";
import assert from "node:assert/strict";
import { applyV2DeployPolicy, validateApplyInput } from "../../scripts/apply-v2-deploy-policy.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_DEPLOY_ROLE_ARN: "acs:ram::1234567890123456:role/v2-deployer",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/v2-runtime",
  V2_VSW_ID: "vsw-synthetic123",
  V2_SECURITY_GROUP_ID: "sg-synthetic123",
};

function json(value) {
  return { ok: true, status: 0, stdout: JSON.stringify(value), stderr: "" };
}

test("policy apply creates, attaches and verifies one deterministic custom policy", () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const action = args[1];
    if (action === "GetPolicy") return { ok: false, status: 1, stdout: "", stderr: "EntityNotExist.Policy" };
    if (action === "CreatePolicy" || action === "AttachPolicyToRole") return json({ RequestId: "synthetic" });
    if (action === "ListPoliciesForRole") {
      const attached = calls.some((call) => call[1] === "AttachPolicyToRole");
      return json({ Policies: { Policy: attached ? [{ PolicyName: "DataPlatformV2DeployMinimal", PolicyType: "Custom" }] : [] } });
    }
    throw new Error(`UNEXPECTED:${action}`);
  };
  const result = applyV2DeployPolicy(input, runner);
  assert.deepEqual(result, {
    ok: true,
    policyName: "DataPlatformV2DeployMinimal",
    created: true,
    attached: true,
    verified: true,
  });
  const create = calls.find((call) => call[1] === "CreatePolicy");
  const document = JSON.parse(create[create.indexOf("--PolicyDocument") + 1]);
  assert.equal(document.Statement[2].Action, "vpc:DescribeVSwitchAttributes");
  assert.equal(document.Statement.some((statement) => statement.Action === "fc:*"), false);
});

test("existing identical policy is reused without creating another version", () => {
  const expected = validateApplyInput(input).policy;
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[1] === "GetPolicy") return json({ Policy: { DefaultVersion: "v1" } });
    if (args[1] === "GetPolicyVersion") return json({ PolicyVersion: { PolicyDocument: JSON.stringify(expected) } });
    if (args[1] === "ListPoliciesForRole")
      return json({ Policies: { Policy: [{ PolicyName: "DataPlatformV2DeployMinimal", PolicyType: "Custom" }] } });
    throw new Error(`UNEXPECTED:${args[1]}`);
  };
  const result = applyV2DeployPolicy(input, runner);
  assert.equal(result.created, false);
  assert.equal(calls.some((call) => call[1] === "CreatePolicyVersion"), false);
  assert.equal(calls.some((call) => call[1] === "AttachPolicyToRole"), false);
});

test("existing mismatched policy fails closed instead of widening or replacing it", () => {
  const runner = (args) => {
    if (args[1] === "GetPolicy") return json({ Policy: { DefaultVersion: "v1" } });
    if (args[1] === "GetPolicyVersion") return json({ PolicyVersion: { PolicyDocument: '{"Version":"1","Statement":[]}' } });
    throw new Error(`UNEXPECTED:${args[1]}`);
  };
  assert.throws(() => applyV2DeployPolicy(input, runner), /POLICY_DOCUMENT_MISMATCH/);
});

test("apply input rejects a deployment role outside the account or equal to runtime role", () => {
  assert.deepEqual(
    validateApplyInput({ ...input, V2_DEPLOY_ROLE_ARN: "acs:ram::1234567890123457:role/v2-deployer" }).errors,
    ["ACCOUNT_MISMATCH:V2_DEPLOY_ROLE_ARN"],
  );
  assert.deepEqual(validateApplyInput({ ...input, V2_DEPLOY_ROLE_ARN: input.V2_FUNCTION_ROLE_ARN }).errors, [
    "DEPLOYMENT_AND_RUNTIME_ROLES_MUST_DIFFER",
  ]);
});
