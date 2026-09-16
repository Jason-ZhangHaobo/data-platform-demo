import test from "node:test";
import assert from "node:assert/strict";
import { validateV2StagingConfig } from "../../scripts/verify-v2-staging-config.mjs";

const base = Object.fromEntries([
  "V2_PUBLIC_URL",
  "V2_PUBLIC_ORIGIN",
  "OSS_BUCKET",
  "V2_MYSQL_HOST",
  "V2_MYSQL_USER",
  "V2_MYSQL_PASSWORD",
  "V2_MYSQL_DATABASE",
  "V2_BOOTSTRAP_ADMIN_EMAIL",
  "V2_BOOTSTRAP_ADMIN_PASSWORD_HASH",
  "DASHSCOPE_API_KEY",
  "FUNCTION_NAME",
  "V2_FUNCTION_ROLE_ARN",
  "ALIYUN_ROLE_ARN",
  "ALIYUN_OIDC_PROVIDER_ARN",
  "V2_VPC_ID",
  "V2_VSW_ID",
  "V2_SECURITY_GROUP_ID",
].map((name) => [name, `synthetic-${name}`]));
base.V2_PUBLIC_URL = "https://demo.example.cn";
base.V2_PUBLIC_ORIGIN = "https://demo.example.cn";
base.FUNCTION_NAME = "dataplatform-v2-staging-api";
base.V2_FUNCTION_ROLE_ARN = "acs:ram::123456789012:role/v2-runtime";
base.ALIYUN_ROLE_ARN = "acs:ram::123456789012:role/v2-deploy";

test("V2 staging config accepts complete protected input without exposing values", () => {
  const result = validateV2StagingConfig(base);
  assert.deepEqual(result, { ok: true, missing: [], errors: [] });
  assert.equal(JSON.stringify(result).includes("synthetic-"), false);
});

test("V2 staging config fails closed for missing secrets and unsafe URLs", () => {
  const result = validateV2StagingConfig({
    ...base,
    V2_MYSQL_PASSWORD: "",
    V2_PUBLIC_URL: "http://demo.example.cn",
    V2_PUBLIC_ORIGIN: "http://other.example.cn",
    V2_FUNCTION_ROLE_ARN: base.ALIYUN_ROLE_ARN,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["V2_MYSQL_PASSWORD"]);
  assert.deepEqual(result.errors, [
    "V2_PUBLIC_URL_MUST_USE_HTTPS",
    "V2_PUBLIC_ORIGIN_MISMATCH",
    "EXECUTION_AND_DEPLOYMENT_ROLES_MUST_DIFFER",
  ]);
});
