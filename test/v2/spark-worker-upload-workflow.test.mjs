import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
  assert.match(workflow, /ossutil api get-object/);
  assert.match(workflow, /downloaded_sha="\$\(sha256sum/);
  assert.match(workflow, /downloaded_bytes="\$\(wc -c/);
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

test("upload errors identify the phase while suppressing raw cloud details and preserving exit status", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const step = workflow.split("      - name: Upload only when the exact object is absent, then verify content")[1];
  const shell = step.split("        run: |\n")[1].split("\n      - name:")[0].replace(/^          /gm, "");
  for (const headCode of ["AccessDenied", "NoSuchKey", "UNKNOWN"]) {
    const directory = await mkdtemp(join(tmpdir(), "worker-upload-test-"));
    try {
      await mkdir(join(directory, "scripts"));
      await copyFile(fileURLToPath(new URL("../../scripts/extract-aliyun-error-code.mjs", import.meta.url)), join(directory, "scripts/extract-aliyun-error-code.mjs"));
      const fake = `ossutil() {
        printf '%s\\n' "$2" >> calls
        if [ "$2" = head-object ]; then
          printf '%s\\n' 'Error: StatusCode:403, ErrorCode:${headCode}, ErrorMessage: synthetic-private-secret' >&2
        else
          printf '%s\\n' 'Error: StatusCode:403, ErrorCode:AccessDenied, ErrorMessage: synthetic-private-secret' >&2
        fi
        return 2
      }\n`;
      const result = spawnSync("bash", ["-c", fake + shell], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, V2_OSS_BUCKET: "synthetic-bucket", V2_SPARK_WORKER_CODE_OBJECT: "synthetic.zip", V2_SPARK_WORKER_PACKAGE_SHA256: "a".repeat(64) },
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-secret/);
      const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n");
      if (headCode === "NoSuchKey") {
        assert.deepEqual(calls, ["head-object", "put-object"]);
        assert.match(result.stdout, /phase=PUT_OBJECT exit=2 code=AccessDenied/);
      } else {
        assert.deepEqual(calls, ["head-object"]);
        assert.match(result.stdout, /phase=HEAD_OBJECT exit=1 code=/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
