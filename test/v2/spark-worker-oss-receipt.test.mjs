import test from "node:test";
import assert from "node:assert/strict";
import {
  createV2SparkWorkerOssReceipt,
  verifyV2SparkWorkerOssReceipt,
} from "../../scripts/v2-spark-worker-oss-receipt.mjs";

const sha = "a".repeat(64),
  input = {
    V2_SPARK_WORKER_PACKAGE_SHA256: sha,
    V2_SPARK_WORKER_PACKAGE_BYTES: "318914420",
    V2_SPARK_WORKER_CODE_OBJECT: `data-platform-demo/v2/spark-worker/${sha}.zip`,
    V2_SPARK_WORKER_UPLOAD_RUN_ID: "35485173329",
    V2_SPARK_WORKER_UPLOAD_HEAD_SHA: "b".repeat(40),
  },
  evidence = {
    head: {
      headers: {
        "content-length": "318914420",
        "x-oss-meta-shuduo-sha256": sha,
        etag: '"0123456789abcdef0123456789abcdef"',
      },
    },
    bucketAcl: { AccessControlList: { Grant: "private" } },
    objectAcl: { AccessControlList: { Grant: "default" } },
    bucketPolicyStatus: { IsPublic: false },
    bucketPublicAccessBlock: { BlockPublicAccess: true },
  },
  now = new Date("2026-09-20T03:00:00.000Z");

test("creates and verifies a six-hour sanitized W2 OSS receipt", () => {
  const created = createV2SparkWorkerOssReceipt(input, evidence, now),
    receipt = created.receipt,
    verified = verifyV2SparkWorkerOssReceipt(input, receipt, now);
  assert.equal(created.ok, true);
  assert.equal(verified.ok, true);
  assert.equal(receipt.publicAccessVerified, true);
  assert.equal(receipt.containsResourceNames, false);
  assert.equal(receipt.validUntil, "2026-09-20T09:00:00.000Z");
  assert.equal(JSON.stringify(receipt).includes("shuduo-synthetic"), false);
});

test("receipt creation fails when any privacy evidence is unsafe", () => {
  const result = createV2SparkWorkerOssReceipt(
    input,
    { ...evidence, objectAcl: { AccessControlList: { Grant: "public-read" } } },
    now,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["OSS_PRIVACY_EVIDENCE_FAILED"]);
});

test("receipt verification rejects stale, foreign or manipulated evidence", () => {
  const receipt = createV2SparkWorkerOssReceipt(input, evidence, now).receipt;
  assert.equal(
    verifyV2SparkWorkerOssReceipt(input, receipt, new Date("2026-09-20T09:00:00.001Z")).ok,
    false,
  );
  assert.equal(
    verifyV2SparkWorkerOssReceipt(
      { ...input, V2_SPARK_WORKER_UPLOAD_HEAD_SHA: "c".repeat(40) },
      receipt,
      now,
    ).ok,
    false,
  );
  assert.equal(
    verifyV2SparkWorkerOssReceipt(
      input,
      { ...receipt, privacyChecks: { ...receipt.privacyChecks, bucketPolicyNotPublic: false } },
      now,
    ).ok,
    false,
  );
});

