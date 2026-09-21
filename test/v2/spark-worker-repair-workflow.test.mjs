import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL("../../.github/workflows/repair-v2-spark-worker.yml", import.meta.url),
  "utf8",
);

test("Worker repair is receipt, budget and immutable-evidence gated", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /v2-spark-worker-oss-receipt\.mjs --verify/);
  assert.match(workflow, /query-v2-monthly-spend\.sh/);
  assert.match(workflow, /verify-v2-spark-worker-repair\.mjs/);
  assert.match(workflow, /verify-v2-spark-worker-function\.mjs/);
  assert.match(workflow, /V2_FUNCTION_ROLE_ARN/);
});

test("Worker repair changes only the role and existing capacity boundaries", () => {
  assert.match(workflow, /\{role:\$role\}/);
  assert.match(workflow, /\{reservedConcurrency:1\}/);
  assert.match(workflow, /\{minInstances:0\}/);
  assert.doesNotMatch(workflow, /CreateFunction|POST \/2023-03-30\/functions/);
  assert.doesNotMatch(workflow, /DeleteFunction|DeleteObject|ossutil rm/);
  assert.doesNotMatch(workflow, /fc:InvokeFunction|\/invocations/);
});
