import test from "node:test";
import assert from "node:assert/strict";
import { verifyV2SparkWorkerOssPrivacy } from "../../scripts/verify-v2-spark-worker-oss-privacy.mjs";

const privateEvidence = {
  bucketAcl: { AccessControlList: { Grant: "private" }, Owner: { ID: "private-owner" } },
  objectAcl: { AccessControlList: { Grant: "default" } },
  bucketPolicyStatus: { IsPublic: false },
  bucketPublicAccessBlock: {
    PublicAccessBlockConfiguration: { BlockPublicAccess: true },
  },
};

test("Worker OSS privacy requires private ACLs, non-public policy and public-access block", () => {
  const result = verifyV2SparkWorkerOssPrivacy(privateEvidence);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    bucketAclPrivate: true,
    objectAclPrivateOrInherited: true,
    bucketPolicyNotPublic: true,
    bucketPublicAccessBlocked: true,
  });
  assert.equal(result.evidence.publicAccessVerified, true);
  assert.equal(result.evidence.containsResourceNames, false);
  assert.equal(JSON.stringify(result).includes("private-owner"), false);
});

test("public object ACL fails even when the bucket itself is private", () => {
  const result = verifyV2SparkWorkerOssPrivacy({
    ...privateEvidence,
    objectAcl: { AccessControlList: { Grant: "public-read" } },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["objectAclPrivateOrInherited"]);
  assert.equal(result.evidence.publicAccessVerified, false);
});

test("missing policy or public-access-block evidence fails closed", () => {
  const result = verifyV2SparkWorkerOssPrivacy({
    bucketAcl: privateEvidence.bucketAcl,
    objectAcl: privateEvidence.objectAcl,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, [
    "bucketPolicyNotPublic",
    "bucketPublicAccessBlocked",
  ]);
});
