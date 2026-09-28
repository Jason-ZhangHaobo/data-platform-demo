import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyV2W3BuildEvidence } from "../../scripts/verify-v2-w3-build-evidence.mjs";

const evidence = JSON.parse(readFileSync(new URL("../../docs/evidence/v2-w3-package-build-20260928.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../../src/v2/remote-spark-queue.mjs", import.meta.url), "utf8");
const workerEnv = {
  V2_SPARK_WORKER_PACKAGE_SHA256: evidence.worker.innerZipSha256,
  V2_SPARK_WORKER_PACKAGE_BYTES: String(evidence.worker.innerZipBytes),
};
const controlEnv = {
  V2_CONTROL_PACKAGE_SHA256: evidence.controlPlane.innerZipSha256,
  V2_CONTROL_PACKAGE_BYTES: String(evidence.controlPlane.innerZipBytes),
  V2_CONTROL_PACKAGE_BUILD_RUN_ID: evidence.controlPlane.buildRun.split("/").at(-1),
  V2_CONTROL_PACKAGE_BUILD_HEAD_SHA: evidence.sourceCommit,
};

test("W3 upload gates accept only the independently verified Worker and control packages", () => {
  assert.equal(verifyV2W3BuildEvidence("worker", workerEnv, evidence, source).ok, true);
  assert.equal(verifyV2W3BuildEvidence("controlPlane", controlEnv, evidence, source).ok, true);
});

test("W3 upload gates reject digest, source and run drift before OSS writes", () => {
  assert.equal(verifyV2W3BuildEvidence("worker", {
    ...workerEnv,
    V2_SPARK_WORKER_PACKAGE_SHA256: "a".repeat(64),
  }, evidence, source).code, "W3_BUILD_IDENTITY_MISMATCH");
  assert.equal(verifyV2W3BuildEvidence("worker", workerEnv, evidence, `${source}\n`).code,
    "W3_BUILD_EVIDENCE_INVALID");
  assert.equal(verifyV2W3BuildEvidence("controlPlane", {
    ...controlEnv,
    V2_CONTROL_PACKAGE_BUILD_RUN_ID: "123456789",
  }, evidence, source).code, "W3_CONTROL_BUILD_RUN_MISMATCH");
});
