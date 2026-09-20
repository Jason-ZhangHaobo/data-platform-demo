import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computePythonManifestDigest,
  createPythonDeliveryPackage,
  pythonSha256,
  unpackPythonDeliveryPackage,
  validatePythonDeliveryPackage,
  verifyPythonDeliveryDirectory,
} from "../../src/v2/python-delivery.mjs";
import {
  contextIds,
  validationContractId,
} from "../../src/v2/context.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const code = `def transform(data, params):
    return []`;
const source = () => {
  const revision = {
      id: "python-revision-test",
      projectId: PROJECT,
      contextId: "holdings-t1",
      code,
      codeHash: pythonSha256(code),
    },
    run = {
      id: "python-run-test",
      projectId: PROJECT,
      revisionId: revision.id,
      revisionHash: revision.codeHash,
      contextId: revision.contextId,
      validationContractId,
      status: "SUCCEEDED",
      engine: "CPython",
      engineVersion: "3.12.14",
      validation: {
        passed: true,
        regressions: contextIds.map((contextId) => ({ contextId, passed: true })),
      },
      resourceLimits: { cpu: true, addressSpace: false, fileSize: true },
    };
  return { run, revision };
};

test("Python delivery package contains executable code, DAG and explicit local boundary", () => {
  const bundle = createPythonDeliveryPackage(source()),
    plan = validatePythonDeliveryPackage(bundle, bundle.digest);
  assert.equal(bundle.manifest.format, "shuduo-python-delivery/v1");
  assert.equal(plan.deployment.adapter, "local-restricted-python-v1");
  assert.equal(plan.deployment.publicDeployed, false);
  assert.equal(plan.deployment.runtime.memoryLimitVerified, false);
  assert.deepEqual(
    plan.order.map((item) => item.kind),
    ["python_transform", "python_assertions", "record_evidence"],
  );
  assert.equal(JSON.stringify(bundle).includes("DASHSCOPE_API_KEY"), false);
});

test("Python delivery rejects changed code even after internal hashes are recomputed", () => {
  const bundle = createPythonDeliveryPackage(source()),
    changed = structuredClone(bundle);
  changed.files["main.py"] += "\n# changed";
  changed.manifest.files["main.py"] = {
    sha256: pythonSha256(changed.files["main.py"]),
    bytes: Buffer.byteLength(changed.files["main.py"]),
  };
  changed.digest = computePythonManifestDigest(changed.manifest);
  assert.throws(
    () => validatePythonDeliveryPackage(changed, changed.digest),
    /源验证|内容|校验|清单/,
  );
});

test("Python delivery executes the unpacked file and retains five assertions", async () => {
  const bundle = createPythonDeliveryPackage(source()),
    directory = join(
      mkdtempSync(join(tmpdir(), "shuduo-python-delivery-")),
      "package",
    );
  unpackPythonDeliveryPackage(bundle, directory, bundle.digest);
  const receipt = await verifyPythonDeliveryDirectory(
    {
      directory,
      expectedDigest: bundle.digest,
      scheduledFor: "2026-09-11T09:00:00+08:00",
    },
    {
      pythonRunner: async ({ code: executed }) => ({
        status: "SUCCEEDED",
        engine: "CPython",
        engineVersion: "3.12.14",
        validation: {
          passed: true,
          issues: [],
          regressions: contextIds.map((contextId) => ({
            contextId,
            passed: true,
          })),
        },
        resourceLimits: { cpu: true, addressSpace: false, fileSize: true },
        executedMatchesFile: executed === code,
      }),
    },
  );
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.mode, "LOCAL_PYTHON_FILE_REHEARSAL");
  assert.equal(receipt.validation.regressions.length, 5);
  assert.equal(receipt.executedMatchesFile, true);
  assert.equal(receipt.workflowTrace.every((item) => item.status === "SUCCEEDED"), true);
});
