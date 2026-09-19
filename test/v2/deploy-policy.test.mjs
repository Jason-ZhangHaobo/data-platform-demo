import test from "node:test";
import assert from "node:assert/strict";
import { renderV2DeployPolicy } from "../../scripts/render-v2-deploy-policy.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/v2-runtime",
  V2_VSW_ID: "vsw-synthetic123",
  V2_SECURITY_GROUP_ID: "sg-synthetic123",
};

test("deployment policy scopes RAM, vSwitch and security-group access to exact resources", () => {
  const result = renderV2DeployPolicy(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.policy.Statement[0], {
    Effect: "Allow",
    Action: ["ram:GetRole", "ram:ListPoliciesForRole"],
    Resource: input.V2_FUNCTION_ROLE_ARN,
  });
  assert.equal(result.policy.Statement[1].Action, "ram:PassRole");
  assert.equal(result.policy.Statement[1].Resource, input.V2_FUNCTION_ROLE_ARN);
  assert.equal(result.policy.Statement[1].Condition.StringEquals["acs:Service"], "fc.aliyuncs.com");
  assert.equal(result.policy.Statement[2].Resource, "acs:vpc:cn-hangzhou:1234567890123456:vswitch/vsw-synthetic123");
  assert.equal(result.policy.Statement[3].Resource, "acs:ecs:cn-hangzhou:1234567890123456:securitygroup/sg-synthetic123");
});

test("deployment policy exposes only documented FC actions and no product-wide wildcard", () => {
  const { policy } = renderV2DeployPolicy(input);
  const fc = policy.Statement.find((statement) => Array.isArray(statement.Action) && statement.Action.some((action) => action.startsWith("fc:")));
  assert.deepEqual(fc.Action, [
    "fc:CreateFunction",
    "fc:GetFunction",
    "fc:UpdateFunction",
    "fc:PutConcurrencyConfig",
    "fc:GetConcurrencyConfig",
    "fc:PutScalingConfig",
    "fc:GetScalingConfig",
  ]);
  assert.equal(fc.Action.includes("fc:*"), false);
  assert.equal(policy.Statement.some((statement) => statement.Action === "ram:*"), false);
});

test("deployment policy rejects mismatched or malformed cloud identifiers", () => {
  const result = renderV2DeployPolicy({
    ...input,
    ALIYUN_ACCOUNT_ID: "1234567890123457",
    V2_VSW_ID: "not-a-vswitch",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["ACCOUNT_MISMATCH:V2_FUNCTION_ROLE_ARN", "INVALID:V2_VSW_ID"]);
});
