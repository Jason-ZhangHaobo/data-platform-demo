import test from "node:test";
import assert from "node:assert/strict";
import { verifyV2SparkWorkerOssObject } from "../../scripts/verify-v2-spark-worker-oss-object.mjs";

const digest = "b".repeat(64),
  bytes = 318_911_849,
  input = {
    V2_SPARK_WORKER_PACKAGE_SHA256: digest,
    V2_SPARK_WORKER_PACKAGE_BYTES: String(bytes),
    V2_SPARK_WORKER_CODE_OBJECT: `data-platform-demo/v2/spark-worker/${digest}.zip`,
  };

test("OSS Worker evidence requires exact size, digest metadata and ETag", () => {
  const result = verifyV2SparkWorkerOssObject(input, {
    headers: {
      "Content-Length": String(bytes),
      "X-Oss-Meta-Shuduo-Sha256": digest,
      ETag: '"0123456789abcdef0123456789abcdef"',
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    sizeMatches: true,
    digestMetadataMatches: true,
    etagPresent: true,
  });
  assert.match(result.evidence.objectKeyHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(input.V2_SPARK_WORKER_CODE_OBJECT), false);
});

test("OSS Worker evidence fails closed for a truncated or substituted object", () => {
  const result = verifyV2SparkWorkerOssObject(input, {
    contentLength: bytes - 1,
    metadata: { shuduoSha256: "c".repeat(64) },
    etag: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["sizeMatches", "digestMetadataMatches"]);
  assert.equal(result.evidence.contentAddressedKey, true);
  assert.equal(result.evidence.overwriteProtectionVerified, false);
  assert.equal(result.evidence.publicAccessVerified, false);
});

test("OSS Worker evidence diagnostics never echo malformed object values", () => {
  const privateValue = "do-not-echo-private-object-name";
  const result = verifyV2SparkWorkerOssObject(
    {
      ...input,
      V2_SPARK_WORKER_CODE_OBJECT: privateValue,
    },
    { headers: {} },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["INVALID:V2_SPARK_WORKER_CODE_OBJECT"]);
  assert.equal(JSON.stringify(result).includes(privateValue), false);
});
