import test from "node:test";
import assert from "node:assert/strict";
import { applyV2ControlPackagePolicy, validateControlPackageApply } from "../../scripts/apply-v2-control-package-policy.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  V2_DEPLOY_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-v2-deployer",
  V2_OSS_BUCKET: "synthetic-private-bucket",
  V2_CONTROL_PACKAGE_SHA256: "b".repeat(64),
  V2_CONTROL_PACKAGE_BYTES: "46860069",
};
const ok = (value) => ({ok:true,stdout:JSON.stringify(value),stderr:""});

test("control package policy creates, attaches and verifies only its fixed identity", () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[1] === "GetPolicy") return {ok:false,stdout:"",stderr:"EntityNotExist.Policy"};
    if (args[1] === "CreatePolicy" || args[1] === "AttachPolicyToRole") return ok({RequestId:"synthetic"});
    if (args[1] === "ListPoliciesForRole") return ok({Policies:{Policy:calls.some((c) => c[1] === "AttachPolicyToRole") ? [{PolicyName:"DataPlatformV2ControlPackageMinimal",PolicyType:"Custom"}] : []}});
    throw new Error(args[1]);
  };
  assert.deepEqual(applyV2ControlPackagePolicy(input, runner), {ok:true,policyName:"DataPlatformV2ControlPackageMinimal",created:true,attached:true,verified:true});
  const create = calls.find((call) => call[1] === "CreatePolicy");
  const document = JSON.parse(create[create.indexOf("--PolicyDocument") + 1]);
  assert.deepEqual(document.Statement[0].Action, ["oss:GetObject", "oss:PutObject"]);
  assert.equal(calls.some((call) => call[1] === "DeletePolicy" || call[1] === "CreatePolicyVersion"), false);
});

test("control package policy refuses same-name drift before attachment", () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[1] === "GetPolicy") return ok({Policy:{DefaultVersion:"v1"}});
    if (args[1] === "GetPolicyVersion") return ok({PolicyVersion:{PolicyDocument:'{"Version":"1","Statement":[]}'}});
    throw new Error("unexpected write");
  };
  assert.throws(() => applyV2ControlPackagePolicy(input, runner), /POLICY_DOCUMENT_MISMATCH/);
  assert.equal(calls.some((call) => call[1] === "AttachPolicyToRole"), false);
  assert.deepEqual(validateControlPackageApply({...input, V2_DEPLOY_ROLE_ARN:"acs:ram::9999999999999999:role/foreign"}).errors, ["ACCOUNT_MISMATCH:V2_DEPLOY_ROLE_ARN"]);
});
