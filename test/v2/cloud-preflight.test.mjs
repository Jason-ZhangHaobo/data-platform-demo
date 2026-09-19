import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { evaluateCloudPreflight } from "../../scripts/verify-v2-cloud-preflight.mjs";

const now = Date.parse("2026-09-15T04:00:00Z");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const target = { functionName: "v2-personal-staging", publicUrl: "https://demo.example.cn" };
const ready = () => ({
  format: "shuduo-aliyun-readonly-audit/v1",
  generatedAt: "2026-09-15T11:00:00+08:00",
  region: "cn-hangzhou",
  billingCycle: "2026-09",
  bill: { available: true, pretaxAmount: 0.59 },
  rds: {
    available: true,
    status: "Running",
    engine: "MySQL",
    engineVersion: "8.0",
    serverless: { AutoPause: true },
    network: { intranet: 1 },
    databases: { platformMetaExists: true },
    accounts: { platformAppExists: true },
  },
  oss: { available: true, location: "oss-cn-hangzhou", acl: "private" },
  function: {
    available: true,
    dedicatedFunctionTarget: true,
    targetHash: hash(target.functionName),
    roleConfigured: true,
    vpcConfigured: true,
    instanceConcurrency: 1,
  },
  crossChecks: { sameVpc: true },
  domain: {
    icpVerified: true,
    ownershipMatched: true,
    httpsReady: true,
    hostHash: hash("demo.example.cn"),
  },
});

test("cloud deployment preflight requires dedicated function, current bill and ICP evidence", () => {
  assert.equal(evaluateCloudPreflight(ready(), now, target).ready, true);
  for (const [mutate, check] of [
    [(v) => { v.generatedAt = "2026-09-13T00:00:00Z"; }, "freshEvidence"],
    [(v) => { v.billingCycle = "2026-08"; }, "currentBillingCycle"],
    [(v) => { v.bill.pretaxAmount = 200; }, "belowHardBudget"],
    [(v) => { v.rds.status = "STOPPED"; }, "mysqlReady"],
    [(v) => { v.oss.acl = "public-read"; }, "privateOssReady"],
    [(v) => { v.function.dedicatedFunctionTarget = false; }, "dedicatedFunctionVerified"],
    [(v) => { v.crossChecks.sameVpc = false; }, "sameVpc"],
    [(v) => { v.domain.icpVerified = false; }, "domainFiledAndOwned"],
    [(v) => { v.function.environmentKeys = ["COMPANY_INTERNAL"]; }, "sanitizedEvidence"],
    [(v) => { v.function.bucketName = "private-bucket"; }, "sanitizedEvidence"],
  ]) {
    const candidate = ready();
    mutate(candidate);
    const result = evaluateCloudPreflight(candidate, now, target);
    assert.equal(result.ready, false);
    assert.ok(result.failedChecks.includes(check));
  }
  assert.ok(
    evaluateCloudPreflight(ready(), now, {
      ...target,
      functionName: "different-function",
    }).failedChecks.includes("functionTargetMatches"),
  );
  assert.ok(
    evaluateCloudPreflight(ready(), now, {
      ...target,
      publicUrl: "https://other.example.cn",
    }).failedChecks.includes("publicHostMatches"),
  );
  assert.ok(
    evaluateCloudPreflight(ready(), now, {
      ...target,
      publicUrl: "https://127.0.0.1",
    }).failedChecks.includes("publicHostMatches"),
  );
});
