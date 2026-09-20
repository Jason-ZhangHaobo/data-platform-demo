import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateV2ProtectedConfig } from "../../scripts/verify-v2-protected-config.mjs";

const input = {
  OSS_BUCKET: "synthetic-private-bucket",
  V2_MYSQL_HOST: "rm-synthetic.mysql.rds.aliyuncs.com",
  V2_MYSQL_USER: "platform_app",
  V2_MYSQL_PASSWORD: "synthetic-password",
  V2_MYSQL_DATABASE: "platform_meta",
  V2_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
  V2_BOOTSTRAP_ADMIN_PASSWORD_HASH: `scrypt$16384$8$1$${Buffer.alloc(16, 1).toString("base64url")}$${Buffer.alloc(64, 2).toString("base64url")}`,
  DASHSCOPE_API_KEY: "sk-synthetic-model-key",
  FUNCTION_NAME: "shuduo-v2-staging",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-runtime",
  ALIYUN_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-deployer",
  ALIYUN_OIDC_PROVIDER_ARN:
    "acs:ram::1234567890123456:oidc-provider/github-actions",
  V2_VPC_ID: "vpc-synthetic123",
  V2_VSW_ID: "vsw-synthetic123",
  V2_SECURITY_GROUP_ID: "sg-synthetic123",
  V2_PUBLIC_URL: "https://shuduo.example.test",
  V2_PUBLIC_ORIGIN: "https://shuduo.example.test",
  V2_SPARK_EXECUTOR_SECRET: "synthetic-worker-secret-32-characters-long",
  V2_SCHEDULER_TICK_SECRET: "synthetic-scheduler-secret-32-characters",
};

test("protected configuration validates effective bundle values without echoing them", () => {
  const result = validateV2ProtectedConfig(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.present.worker, true);
  assert.equal(result.present.scheduler, true);
  assert.equal(result.containsSecretValues, false);
  for (const secret of [
    input.V2_MYSQL_PASSWORD,
    input.DASHSCOPE_API_KEY,
    input.V2_SPARK_EXECUTOR_SECRET,
  ]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("protected configuration names missing and partial optional source config", () => {
  const result = validateV2ProtectedConfig({
    ...input,
    V2_SPARK_EXECUTOR_SECRET: "",
    V2_SCHEDULER_TICK_SECRET: "short",
    V2_MYSQL_SOURCE_HOST: "rm-source.internal",
  });
  assert.equal(result.ok, false);
  assert.equal(result.missing.includes("V2_SPARK_EXECUTOR_SECRET"), true);
  assert.equal(
    result.errors.includes("INVALID_VALUE:V2_SCHEDULER_TICK_SECRET"),
    true,
  );
  assert.equal(result.errors.includes("V2_MYSQL_SOURCE_CONFIG_PARTIAL"), true);
});

test("protected configuration workflow never requests cloud credentials", async () => {
  const workflow = await readFile(
    new URL(
      "../../.github/workflows/validate-v2-protected-config.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /verify-v2-protected-config\.mjs/);
  assert.match(workflow, /export-v2-staging-secret-bundle\.mjs/);
  assert.doesNotMatch(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /configure-aliyun-credentials|aliyun [a-z]/);
  assert.doesNotMatch(workflow, /vars\.V2_/);
  assert.doesNotMatch(workflow, /\$\{\{ secrets\.[^}]+ \}\}.*echo/);
});
