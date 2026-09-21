import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderV2SparkWorkerFunction } from "../../scripts/render-v2-spark-worker-function.mjs";

const secret = "synthetic-worker-secret-32-characters-long";
const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  ALIBABA_CLOUD_REGION_ID: "cn-hangzhou",
  V2_FUNCTION_NAME: "shuduo-v2-control",
  V2_FUNCTION_ROLE_ARN: "acs:ram::1234567890123456:role/shuduo-v2-runtime",
  V2_SPARK_WORKER_FUNCTION_NAME: "shuduo-v2-spark-worker",
  V2_OSS_BUCKET: "shuduo-synthetic-staging",
  V2_SPARK_WORKER_PACKAGE_SHA256: "a".repeat(64),
  V2_SPARK_WORKER_PACKAGE_BYTES: "318914420",
  V2_VPC_ID: "vpc-synthetic123",
  V2_VSW_ID: "vsw-synthetic123",
  V2_SECURITY_GROUP_ID: "sg-synthetic123",
  V2_SPARK_WORKER_SECRET: secret,
};

test("Worker function body binds the private W2 plan and protected secret", () => {
  const result = renderV2SparkWorkerFunction(input),
    body = result.body;
  assert.equal(result.ok, true);
  assert.equal(body.code.ossObjectName, `data-platform-demo/v2/spark-worker/${"a".repeat(64)}.zip`);
  assert.equal(body.runtime, "custom.debian10");
  assert.equal(body.internetAccess, false);
  assert.equal(body.instanceConcurrency, 1);
  assert.equal(body.role, input.V2_FUNCTION_ROLE_ARN);
  assert.equal(body.environmentVariables.V2_SPARK_WORKER_SECRET, secret);
  assert.deepEqual(body.customRuntimeConfig.command, ["/opt/nodejs20/bin/node"]);
});

test("Worker body CLI writes once with mode 0600 and never echoes the secret", () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-worker-body-")),
    file = join(root, "function.json"),
    env = { ...process.env, ...input, V2_SPARK_WORKER_FUNCTION_BODY_FILE: file },
    first = spawnSync(process.execPath, ["scripts/render-v2-spark-worker-function.mjs"], {
      cwd: new URL("../..", import.meta.url),
      env,
      encoding: "utf8",
    });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.includes(secret), false);
  assert.equal(readFileSync(file, "utf8").includes(secret), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const original = readFileSync(file, "utf8"),
    second = spawnSync(process.execPath, ["scripts/render-v2-spark-worker-function.mjs"], {
      cwd: new URL("../..", import.meta.url),
      env,
      encoding: "utf8",
    });
  assert.notEqual(second.status, 0);
  assert.equal(second.stderr.includes(secret), false);
  assert.equal(readFileSync(file, "utf8"), original);
  writeFileSync(join(root, "kept.txt"), "safe");
});
