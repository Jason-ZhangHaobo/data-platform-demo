import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL(
  "../../.github/workflows/provision-v2-spark-worker.yml",
  import.meta.url,
);

test("Worker provisioning requires a fresh OSS receipt and complete budget pages", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /v2-spark-worker-oss-receipt\.mjs --verify/);
  assert.match(workflow, /bssopenapi QueryBill/);
  assert.match(workflow, /--PageNum "\$page"/);
  assert.match(workflow, /verify-v2-monthly-bill-pages\.mjs/);
  assert.match(workflow, /\.belowBudget == true/);
  assert.doesNotMatch(workflow, /QueryBillOverview/);
  assert.doesNotMatch(workflow, /bssapi:QueryBillOverview/);
});

test("Worker provisioning is create-only, private and leaves Invoke to Cloud Shell", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /FunctionNotFound/);
  assert.match(workflow, /POST \/2023-03-30\/functions/);
  assert.match(workflow, /render-v2-spark-worker-function\.mjs/);
  assert.match(workflow, /\{reservedConcurrency:1\}/);
  assert.match(workflow, /minInstances:0/);
  assert.match(workflow, /verify-v2-spark-worker-function\.mjs/);
  assert.match(workflow, /PRIVATE_SPARK_SMOKE_V1/);
  assert.match(workflow, /create-error\.txt/);
  assert.match(workflow, /concurrency-error\.txt/);
  assert.match(workflow, /scaling-error\.txt/);
  assert.match(workflow, /extract-aliyun-error-code\.mjs/);
  assert.doesNotMatch(workflow, /UpdateFunction|DeleteFunction|DeleteObject|ossutil rm/);
  assert.doesNotMatch(workflow, /fc:InvokeFunction|\/invocations/);
});
