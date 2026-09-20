import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateV2StagingConfig } from "../../scripts/verify-v2-staging-config.mjs";
import { mergeSecretBundle, parseSecretBundle } from "../../scripts/export-v2-staging-secret-bundle.mjs";

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
base.V2_MYSQL_HOST = "rm-example.mysql.rds.aliyuncs.com";
base.V2_MYSQL_USER = "platform_app";
base.V2_MYSQL_PASSWORD = "Valid-Password-2026";
base.V2_MYSQL_DATABASE = "platform_meta";
base.V2_BOOTSTRAP_ADMIN_EMAIL = "admin@example.test";
base.V2_BOOTSTRAP_ADMIN_PASSWORD_HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 1).toString("base64url")}$${Buffer.alloc(64, 2).toString("base64url")}`;
base.DASHSCOPE_API_KEY = "sk-synthetic-value-for-tests";

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

test("V2 provisioning mode can create a private function before domain filing", () => {
  const result = validateV2StagingConfig({ ...base, V2_PROVISIONING_ONLY: "true" });
  assert.deepEqual(result, { ok: true, missing: [], errors: [] });
});

test("JASONSECRETS supports platform and optional source MySQL keys without exposing values", () => {
  const bundle = JSON.stringify({
    V2_MYSQL_PASSWORD: "hidden-password",
    DASHSCOPE_API_KEY: "hidden-key",
    V2_MYSQL_SOURCE_USER: "sync_reader",
    V2_MYSQL_SOURCE_PASSWORD: "hidden-source-password",
  });
  assert.deepEqual(parseSecretBundle(bundle), {
    V2_MYSQL_PASSWORD: "hidden-password",
    DASHSCOPE_API_KEY: "hidden-key",
    V2_MYSQL_SOURCE_USER: "sync_reader",
    V2_MYSQL_SOURCE_PASSWORD: "hidden-source-password",
  });
  const merged = mergeSecretBundle({ V2_MYSQL_PASSWORD: "already-set", JASONSECRETS: bundle });
  assert.equal(merged.V2_MYSQL_PASSWORD, "already-set");
  assert.equal(merged.DASHSCOPE_API_KEY, "hidden-key");
  assert.equal(merged.V2_MYSQL_SOURCE_USER, "sync_reader");
  assert.equal(JSON.stringify({ ok: true, loadedKeys: Object.keys(merged) }).includes("hidden"), false);
});

test("JASONSECRETS rejects unknown keys and multiline values", () => {
  assert.throws(() => parseSecretBundle(JSON.stringify({ UNKNOWN: "x" })));
  assert.throws(() => parseSecretBundle(JSON.stringify({ V2_MYSQL_PASSWORD: "line1\nline2" })));
  assert.deepEqual(parseSecretBundle("V2_MYSQL_USER='user'\n# comment\nV2_MYSQL_PASSWORD=pass"), {
    V2_MYSQL_USER: "user",
    V2_MYSQL_PASSWORD: "pass",
  });
});

test("staging config rejects placeholders and invalid administrator hashes by key only", () => {
  const result = validateV2StagingConfig({
    ...base,
    V2_MYSQL_HOST: "...",
    V2_BOOTSTRAP_ADMIN_PASSWORD_HASH: "not-a-hash",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "PLACEHOLDER_VALUE:V2_MYSQL_HOST",
    "INVALID_VALUE:V2_BOOTSTRAP_ADMIN_PASSWORD_HASH",
  ]);
  assert.equal(JSON.stringify(result).includes("not-a-hash"), false);
});

test("staging config validates optional source MySQL secrets when present", () => {
  const result = validateV2StagingConfig({
    ...base,
    V2_MYSQL_SOURCE_HOST: "https://not-a-host",
    V2_MYSQL_SOURCE_PORT: "70000",
    V2_MYSQL_SOURCE_USER: "bad-user",
    V2_MYSQL_SOURCE_PASSWORD: "short",
    V2_MYSQL_SOURCE_DATABASE: "bad-db",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "INVALID_VALUE:V2_MYSQL_SOURCE_PORT",
    "INVALID_VALUE:V2_MYSQL_SOURCE_USER",
    "INVALID_VALUE:V2_MYSQL_SOURCE_DATABASE",
    "INVALID_VALUE:V2_MYSQL_SOURCE_HOST",
    "INVALID_VALUE:V2_MYSQL_SOURCE_PASSWORD",
  ]);
});

test("bundle exporter masks values before writing the GitHub environment file", () => {
  const root = mkdtempSync(resolve(tmpdir(), "shuduo-secret-export-")),
    githubEnv = resolve(root, "github-env"),
    secretValue = "Valid-Password-2026";
  try {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/export-v2-staging-secret-bundle.mjs"),
      output = execFileSync(process.execPath, [script], {
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_ENV: githubEnv,
          JASONSECRETS: JSON.stringify({ V2_MYSQL_PASSWORD: secretValue }),
        },
      }).toString("utf8");
    assert.match(output, /::add-mask::/);
    assert.equal(output.includes(secretValue), true);
    assert.equal(readFileSync(githubEnv, "utf8"), `V2_MYSQL_PASSWORD=${secretValue}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid individual secrets override invalid bundle placeholders", () => {
  const root = mkdtempSync(resolve(tmpdir(), "shuduo-secret-override-")),
    githubEnv = resolve(root, "github-env"),
    script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../scripts/export-v2-staging-secret-bundle.mjs",
    );
  try {
    const output = JSON.parse(
      execFileSync(process.execPath, [script], {
        env: {
          ...process.env,
          GITHUB_ENV: githubEnv,
          V2_MYSQL_PASSWORD: "Valid-Individual-Password-2026",
          JASONSECRETS: JSON.stringify({
            V2_MYSQL_PASSWORD: "change-me",
            V2_SCHEDULER_TICK_SECRET:
              "synthetic-scheduler-secret-32-characters",
          }),
        },
      }).toString("utf8"),
    );
    assert.deepEqual(output.loadedKeys, ["V2_SCHEDULER_TICK_SECRET"]);
    assert.deepEqual(output.overriddenKeys, ["V2_MYSQL_PASSWORD"]);
    assert.equal(
      readFileSync(githubEnv, "utf8"),
      "V2_SCHEDULER_TICK_SECRET=synthetic-scheduler-secret-32-characters\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging config CLI reads process.env instead of validating an empty object", () => {
  const env = {
    ...process.env,
    ...base,
    V2_PROVISIONING_ONLY: "true",
    JASONSECRETS: JSON.stringify({ V2_MYSQL_PASSWORD: "bundle-password" }),
  };
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/verify-v2-staging-config.mjs");
  const result = JSON.parse(execFileSync(process.execPath, [script], { env }).toString("utf8"));
  assert.deepEqual(result, { ok: true, missing: [], errors: [] });
});
