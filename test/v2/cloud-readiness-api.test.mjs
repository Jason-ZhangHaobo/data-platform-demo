import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const target = { functionName: "v2-test-function", publicUrl: "https://demo.example.cn" };
const evidence = () => ({
  format: "shuduo-aliyun-readonly-audit/v1",
  generatedAt: new Date().toISOString(),
  region: "cn-hangzhou",
  billingCycle: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).replace("/", "-"),
  bill: { available: true, pretaxAmount: 0.59 },
  rds: { available: true, status: "Running", engine: "MySQL", engineVersion: "8.0", serverless: { AutoPause: true }, network: { intranet: 1 }, databases: { platformMetaExists: true }, accounts: { platformAppExists: true } },
  oss: { available: true, location: "oss-cn-hangzhou", acl: "private" },
  function: { available: true, dedicatedFunctionTarget: true, targetHash: hash(target.functionName), roleConfigured: true, vpcConfigured: true, instanceConcurrency: 1 },
  crossChecks: { sameVpc: true },
  domain: { icpVerified: true, ownershipMatched: true, httpsReady: true, hostHash: hash("demo.example.cn") },
});

test("cloud readiness endpoint exposes only sanitized deployment evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-cloud-readiness-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      env: { V2_LOCAL_DEVELOPMENT: "true", V2_FUNCTION_NAME: target.functionName, V2_PUBLIC_URL: target.publicUrl },
      cloudReadinessEvidence: evidence(),
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/cloud/readiness`),
      body = await response.json(),
      encoded = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.ready, true);
    assert.equal(body.evidence.bill.pretaxAmount, 0.59);
    assert.equal(body.checks.dedicatedFunctionVerified, true);
    assert.equal(encoded.includes(target.functionName), false);
    assert.equal(encoded.includes(target.publicUrl), false);
    assert.equal(encoded.includes("bucket"), false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("public anonymous callers cannot read deployment readiness evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-cloud-readiness-public-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({ root, store, env: { V2_LOCAL_DEVELOPMENT: "false" } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/cloud/readiness`),
      body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.code, "AUTHENTICATION_REQUIRED");
    assert.equal("checks" in body, false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
