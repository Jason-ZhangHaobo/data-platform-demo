import test from "node:test";
import assert from "node:assert/strict";
import { applyV2W3Iam, validateV2W3IamInput } from "../../scripts/apply-v2-w3-iam.mjs";

const account = "1234567890123456";
const role = (name) => `acs:ram::${account}:role/${name}`;
const input = {
  ALIYUN_ACCOUNT_ID: account,
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_DEPLOY_ROLE_ARN: role("shuduo-deploy"),
  V2_FUNCTION_ROLE_ARN: role("shuduo-control-runtime"),
  V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN: role("shuduo-worker-runtime"),
  V2_W3_OSS_TRIGGER_ROLE_ARN: role("shuduo-oss-trigger"),
  V2_FUNCTION_NAME: "shuduo-control",
  V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-worker",
  V2_OSS_BUCKET: "shuduo-private-artifacts",
  V2_SPARK_WORKER_PACKAGE_SHA256: "a".repeat(64),
  V2_W3_SPARK_WORKER_PACKAGE_SHA256: "b".repeat(64),
  V2_W3_SPARK_WORKER_PACKAGE_BYTES: "318922243",
  V2_CONTROL_PACKAGE_SHA256: "c".repeat(64),
  V2_W3_CONTROL_PACKAGE_SHA256: "d".repeat(64),
  V2_W3_CONTROL_PACKAGE_BYTES: "46861622",
};

function cloud() {
  const roles = new Map([
    ["shuduo-deploy", { RoleName: "shuduo-deploy" }],
    ["shuduo-control-runtime", { RoleName: "shuduo-control-runtime" }],
  ]);
  const policies = new Map(), attached = new Map([
    ["shuduo-deploy", []], ["shuduo-control-runtime", []],
  ]), calls = [];
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  const success = (data) => ({ ok: true, stdout: JSON.stringify(data), stderr: "" });
  const missing = (type) => ({ ok: false, stdout: "", stderr: `EntityNotExist.${type}` });
  const runner = (args) => {
    const action = `${args[0]}:${args[1]}`;
    calls.push(action);
    if (action === "sts:GetCallerIdentity") return success({ AccountId: account });
    if (action === "ram:GetRole") {
      const role = roles.get(value(args, "--RoleName"));
      return role ? success({ Role: role }) : missing("Role");
    }
    if (action === "ram:CreateRole") {
      const name = value(args, "--RoleName");
      const created = { RoleName: name, AssumeRolePolicyDocument: value(args, "--AssumeRolePolicyDocument") };
      roles.set(name, created); attached.set(name, []);
      return success({ Role: created });
    }
    if (action === "ram:GetPolicy") {
      const policy = policies.get(value(args, "--PolicyName"));
      return policy ? success({ Policy: { DefaultVersion: "v1" } }) : missing("Policy");
    }
    if (action === "ram:GetPolicyVersion") {
      const policy = policies.get(value(args, "--PolicyName"));
      return policy ? success({ PolicyVersion: { PolicyDocument: JSON.stringify(policy) } }) : missing("Policy");
    }
    if (action === "ram:CreatePolicy") {
      policies.set(value(args, "--PolicyName"), JSON.parse(value(args, "--PolicyDocument")));
      return success({ Policy: { DefaultVersion: "v1" } });
    }
    if (action === "ram:ListPoliciesForRole") {
      const assigned = attached.get(value(args, "--RoleName"));
      return assigned ? success({ Policies: { Policy: assigned } }) : missing("Role");
    }
    if (action === "ram:AttachPolicyToRole") {
      attached.get(value(args, "--RoleName")).push({ PolicyName: value(args, "--PolicyName"), PolicyType: "Custom" });
      return success({ RequestId: "synthetic" });
    }
    throw new Error(`Unexpected ${action}`);
  };
  return { roles, policies, attached, calls, runner };
}

test("W3 IAM application first verifies identity and drift, then creates only four exact policies", () => {
  const fake = cloud();
  const result = applyV2W3Iam(input, fake.runner);
  assert.equal(result.ok, true);
  assert.deepEqual(result.createdRoles, ["shuduo-worker-runtime", "shuduo-oss-trigger"]);
  assert.equal(result.createdPolicies.length, 4);
  assert.equal(result.controlHasFcInvoke, false);
  assert.equal(result.cloudFunctionUpdated, false);
  assert.equal(result.ossTriggerCreated, false);
  assert.equal(fake.calls.filter((item) => item === "ram:CreateRole").length, 2);
  assert.equal(fake.calls.filter((item) => item === "ram:CreatePolicy").length, 4);
  assert.equal(fake.calls.filter((item) => item === "ram:AttachPolicyToRole").length, 4);
  const again = applyV2W3Iam(input, fake.runner);
  assert.equal(again.ok, true);
  assert.deepEqual(again.createdRoles, []);
  assert.deepEqual(again.createdPolicies, []);
  assert.equal(fake.calls.filter((item) => item === "ram:CreateRole").length, 2);
  assert.equal(fake.calls.filter((item) => item === "ram:CreatePolicy").length, 4);
});

test("W3 IAM refuses an unexpected policy on a proposed isolated role before any write", () => {
  const fake = cloud();
  fake.roles.set("shuduo-worker-runtime", {
    RoleName: "shuduo-worker-runtime",
    AssumeRolePolicyDocument: JSON.stringify({ Version: "1", Statement: [] }),
  });
  fake.attached.set("shuduo-worker-runtime", [{ PolicyName: "AliyunAdministratorAccess", PolicyType: "System" }]);
  assert.throws(() => applyV2W3Iam(input, fake.runner), /W3_ROLE_TRUST_MISMATCH/);
  assert.equal(fake.calls.some((item) => item.startsWith("ram:Create") || item === "ram:AttachPolicyToRole"), false);
});

test("W3 IAM rejects an existing same-name policy with different rights before any write", () => {
  const fake = cloud();
  fake.policies.set("ShuduoV2W3ExactPackages", {
    Version: "1",
    Statement: [{ Effect: "Allow", Action: "oss:*", Resource: "*" }],
  });
  assert.throws(() => applyV2W3Iam(input, fake.runner), /W3_POLICY_DOCUMENT_MISMATCH/);
  assert.equal(fake.calls.some((item) => item.startsWith("ram:Create") || item === "ram:AttachPolicyToRole"), false);
});

test("W3 IAM rejects a role with matching trust but unexpected attached policy", () => {
  const fake = cloud();
  fake.roles.set("shuduo-oss-trigger", {
    RoleName: "shuduo-oss-trigger",
    AssumeRolePolicyDocument: JSON.stringify({
      Version: "1",
      Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: ["oss.aliyuncs.com"] } }],
    }),
  });
  fake.attached.set("shuduo-oss-trigger", [{ PolicyName: "AliyunAdministratorAccess", PolicyType: "System" }]);
  assert.throws(() => applyV2W3Iam(input, fake.runner), /W3_NEW_ROLE_HAS_UNEXPECTED_POLICY/);
  assert.equal(fake.calls.some((item) => item.startsWith("ram:Create") || item === "ram:AttachPolicyToRole"), false);
});

test("W3 IAM rejects a deploy role reused as the OSS Invoke role without contacting cloud", () => {
  const checked = validateV2W3IamInput({ ...input, V2_W3_OSS_TRIGGER_ROLE_ARN: input.V2_DEPLOY_ROLE_ARN });
  assert.deepEqual(checked.errors, ["W3_ALL_FOUR_ROLES_MUST_BE_DISTINCT"]);
});

test("W3 IAM rejects an unsafe local CLI profile before contacting cloud", () => {
  const previous = process.env.V2_ALIYUN_CLI_PROFILE;
  process.env.V2_ALIYUN_CLI_PROFILE = "other profile; command";
  try { assert.throws(() => applyV2W3Iam(input), /W3_CLI_PROFILE_INVALID/); }
  finally {
    if (previous === undefined) delete process.env.V2_ALIYUN_CLI_PROFILE;
    else process.env.V2_ALIYUN_CLI_PROFILE = previous;
  }
});

test("W3 IAM retries only a transient read, not a timed-out write", () => {
  const fake = cloud();
  let readTimedOut = false;
  const afterReadRetry = applyV2W3Iam(input, (args) => {
    if (args[1] === "GetRole" && !readTimedOut) {
      readTimedOut = true;
      fake.calls.push("ram:GetRole:timeout");
      return { ok: false, stdout: "", stderr: "context deadline exceeded" };
    }
    return fake.runner(args);
  });
  assert.equal(afterReadRetry.ok, true);
  assert.equal(readTimedOut, true);
  assert.equal(fake.calls.filter((item) => item === "ram:CreateRole").length, 2);

  const next = cloud();
  let timedOutWrites = 0;
  assert.throws(() => applyV2W3Iam(input, (args) => {
    if (args[1] === "CreateRole") {
      timedOutWrites++;
      return { ok: false, stdout: "", stderr: "context deadline exceeded" };
    }
    return next.runner(args);
  }), /W3_CREATE_ROLE_FAILED/);
  assert.equal(timedOutWrites, 1);
});
