import test from "node:test";
import assert from "node:assert/strict";
import { createV2ControlPackageOssReceipt, verifyV2ControlPackageOssReceipt } from "../../scripts/v2-control-package-oss-receipt.mjs";

const sha = "b".repeat(64);
const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  V2_OSS_BUCKET: "synthetic-private-bucket",
  V2_CONTROL_PACKAGE_SHA256: sha,
  V2_CONTROL_PACKAGE_BYTES: "46860069",
  V2_CONTROL_CODE_OBJECT: `data-platform-demo/v2/control-plane/${sha}.zip`,
  V2_CONTROL_PACKAGE_UPLOAD_RUN_ID: "36112268933",
  V2_CONTROL_PACKAGE_UPLOAD_HEAD_SHA: "a".repeat(40),
};
const evidence = {
  head: { "Content-Length": "46860069", "x-oss-meta-shuduo-sha256": sha, ETag: '"1234567890abcdef"' },
  downloadedSha256: sha,
  downloadedBytes: 46860069,
  bucketAcl: { grant: "private" },
  objectAcl: { grant: "default" },
  bucketPolicyStatus: { isPublic: false },
  bucketPublicAccessBlock: { blockPublicAccess: true },
};

test("control receipt binds private object, exact bytes, upload run and six-hour window", () => {
  const now = new Date("2026-09-25T09:00:00Z");
  const created = createV2ControlPackageOssReceipt(input, evidence, now);
  assert.equal(created.ok, true);
  assert.equal(created.receipt.containsResourceNames, false);
  assert.equal(JSON.stringify(created.receipt).includes(input.V2_OSS_BUCKET), false);
  assert.equal(verifyV2ControlPackageOssReceipt(input, created.receipt, now).ok, true);
  assert.deepEqual(verifyV2ControlPackageOssReceipt(input, created.receipt, new Date("2026-09-25T15:00:00Z")).failed, ["timeWindowValid"]);
});

test("control receipt rejects a public object or substituted downloaded bytes", () => {
  assert.deepEqual(createV2ControlPackageOssReceipt(input, {...evidence, objectAcl:{grant:"public-read"}}).errors, ["OSS_PRIVACY_EVIDENCE_FAILED"]);
  assert.deepEqual(createV2ControlPackageOssReceipt(input, {...evidence, downloadedSha256:"c".repeat(64)}).errors, ["OSS_CONTENT_EVIDENCE_FAILED"]);
});
