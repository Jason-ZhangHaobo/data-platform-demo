import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Optional integration test against the checksum-verified, official ossutil 2.4.0.
// Uses only loopback, synthetic credentials and synthetic ZIP-like bytes.
test("real ossutil preserves JSON and binary bytes in the immutable upload workflow", {
  skip: !process.env.V2_OSSUTIL_TEST_BINARY,
  timeout: 30000,
}, async () => {
  const binary = process.env.V2_OSSUTIL_TEST_BINARY;
  const payload = Buffer.from([80, 75, 3, 4, 0, 255, 128, 12, 15]);
  const digest = createHash("sha256").update(payload).digest("hex");
  const workflow = await readFile(new URL("../../.github/workflows/upload-v2-spark-worker.yml", import.meta.url), "utf8");
  const shell = workflow.split("      - name: Upload only when the exact object is absent, then verify content")[1]
    .split("        run: |\n")[1].split("\n      - name:")[0].replace(/^          /gm, "");
  for (const scenario of ["missing", "existing", "denied"]) {
    let stored = scenario === "existing";
    const calls = [], puts = [];
    const server = http.createServer(async (req, res) => {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      calls.push(req.method);
      if (scenario === "denied" || (!stored && req.method !== "PUT")) {
        const code = scenario === "denied" ? "AccessDenied" : "NoSuchKey";
        const xml = `<Error><Code>${code}</Code><Message>synthetic-private-diagnostic</Message><RequestId>synthetic</RequestId></Error>`;
        res.writeHead(scenario === "denied" ? 403 : 404, {
          "x-oss-err": Buffer.from(xml).toString("base64"), "x-oss-request-id": "synthetic",
        });
        res.end();
      } else if (req.method === "PUT") {
        puts.push({ body: Buffer.concat(body), overwrite: req.headers["x-oss-forbid-overwrite"], acl: req.headers["x-oss-object-acl"] });
        stored = true;
        res.writeHead(200, { ETag: '"0123456789abcdef0123456789abcdef"' });
        res.end();
      } else {
        res.writeHead(200, {
          "content-length": payload.length, "content-type": "application/octet-stream",
          ETag: '"0123456789abcdef0123456789abcdef"', "x-oss-meta-shuduo-sha256": digest,
        });
        res.end(req.method === "HEAD" ? undefined : payload);
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const directory = await mkdtemp(join(tmpdir(), "ossutil-workflow-"));
    try {
      await mkdir(join(directory, "scripts"));
      for (const name of ["extract-aliyun-error-code.mjs", "verify-v2-spark-worker-oss-object.mjs"])
        await copyFile(new URL(`../../scripts/${name}`, import.meta.url), join(directory, "scripts", name));
      await writeFile(join(directory, "v2-spark-worker.zip"), payload);
      await writeFile(join(directory, "oss-config"), "[default]\n");
      const result = await new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", shell], {
          cwd: directory,
          env: {
            ...process.env, PATH: `${dirname(binary)}:${process.env.PATH}`,
            OSS_ACCESS_KEY_ID: "synthetic", OSS_ACCESS_KEY_SECRET: "synthetic", OSS_SESSION_TOKEN: "synthetic",
            OSSUTIL_CONFIG_FILE: join(directory, "oss-config"), OSS_REGION: "cn-hangzhou",
            OSS_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
            V2_OSS_BUCKET: "synthetic-bucket", V2_SPARK_WORKER_CODE_OBJECT: `data-platform-demo/v2/spark-worker/${digest}.zip`,
            V2_SPARK_WORKER_PACKAGE_SHA256: digest, V2_SPARK_WORKER_PACKAGE_BYTES: String(payload.length),
          },
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", reject);
        child.on("close", status => resolve({ status, stdout, stderr }));
      });
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-diagnostic/);
      if (scenario === "denied") {
        assert.notEqual(result.status, 0);
        assert.deepEqual(calls, ["HEAD"]);
        assert.match(result.stdout, /phase=HEAD_OBJECT.*code=AccessDenied/);
      } else {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(calls, scenario === "missing" ? ["HEAD", "PUT", "HEAD", "GET"] : ["HEAD", "GET"]);
        if (puts.length) {
          assert.deepEqual(puts[0].body, payload);
          assert.equal(puts[0].overwrite, "true");
          assert.equal(puts[0].acl, "private");
        }
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
});
