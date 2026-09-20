import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL(
  "../../.github/workflows/upload-v2-spark-worker.yml",
  import.meta.url,
);

test("W2 upload workflow is OIDC-only, exact-object and overwrite-safe", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /configure-aliyun-credentials-action@v1/);
  assert.match(workflow, /steps\.aliyun\.outputs\.aliyun-access-key-id/);
  assert.match(workflow, /V2_SPARK_WORKER_PACKAGE_SHA256/);
  assert.match(workflow, /V2_SPARK_WORKER_PACKAGE_BYTES/);
  assert.match(workflow, /sha256sum v2-spark-worker\.zip/);
  assert.match(workflow, /--forbid-overwrite true/);
  assert.match(workflow, /--object-acl private/);
  assert.match(workflow, /--metadata "shuduo-sha256=/);
  assert.match(workflow, /verify-v2-spark-worker-oss-object\.mjs/);
  assert.doesNotMatch(workflow, /DeleteObject|ossutil rm|oss:Delete|oss:List/);
  assert.doesNotMatch(workflow, /fc:InvokeFunction|\/invocations/);
});

test("W2 upload workflow fails closed before a first write", async () => {
  const workflow = await readFile(workflowUrl, "utf8"),
    guard = workflow.indexOf('test "$code" = NoSuchKey || test "$code" = NoSuchObject'),
    upload = workflow.indexOf("ossutil api put-object");
  assert.ok(guard > 0);
  assert.ok(upload > guard);
  assert.match(workflow, /85edf66b2fb7238f5c7e25cab820cf29312319fe4935b7c86a6b8485eb434f3c/);
  assert.match(workflow, /ossutil-2\.4\.0-linux-amd64\.zip/);
  assert.match(workflow, /Cloud Shell privacy gate before FC creation/);
  assert.doesNotMatch(workflow, /CreateFunction|POST \/2023-03-30\/functions/);
});

