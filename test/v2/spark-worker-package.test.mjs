import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Spark Worker package builder normalizes timestamps and ZIP metadata", async () => {
  const script = await readFile(
    new URL("../../scripts/build-v2-spark-worker-package.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /touch -h -t 198001010000/);
  assert.match(script, /LC_ALL=C find .* -type f -print \| LC_ALL=C sort/);
  assert.match(script, /zip -X -q/);
  assert.match(script, /sqlglot-27\.14\.0\.dist-info/);
  assert.match(script, /stage-v2-spark-worker-sources\.sh/);
  assert.doesNotMatch(script, /zip -qr/);
  const workflow = await readFile(
    new URL("../../.github/workflows/build-v2-spark-worker.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /sha256sum v2-spark-worker\.zip/);
  assert.match(workflow, /Spark Worker inner SHA-256/);
  assert.match(workflow, /actions\/setup-java@v5/);
  assert.match(workflow, /smoke-v2-spark-worker-package\.mjs/);
  assert.match(workflow, /smoke-v2-spark-worker-fund\.mjs "\$worker_root"/);
  assert.match(workflow, /sqlglot-27\.14\.0\.dist-info/);
  assert.match(workflow, /spark-worker-private-smoke\.mjs/);
  const requirements = await readFile(
    new URL("../../deploy/spark-worker/requirements.txt", import.meta.url),
    "utf8",
  );
  assert.match(
    requirements,
    /sqlglot==27\.14\.0 --hash=sha256:a5adc68abc85ccd249258ae0f3aff3c1869bb5b086e360375e16518858ce8a7a/,
  );
  assert.match(workflow, /Synthetic Spark Worker diagnostics/);
  const spark = await readFile(
    new URL("../../src/v2/spark.mjs", import.meta.url),
    "utf8",
  );
  assert.match(spark, /pythonPath: env\.PYTHONPATH/);
  assert.match(spark, /PYTHONPATH: config\.pythonPath/);
});

test("the Worker staging directory contains both registered fund dates and their independent validator", async t => {
  const root = await mkdtemp(join(tmpdir(), "shuduo-worker-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = new URL("../../", import.meta.url);
  const stage = fileURLToPath(new URL("scripts/stage-v2-spark-worker-sources.sh", repo));
  execFileSync("bash", [stage, root]);
  const stagedCases = JSON.parse(await readFile(join(root, "fixtures/fund-lookthrough/cases.json"), "utf8"));
  assert.ok(stagedCases.length >= 2);
  const fundFiles = ["contract.json", "cases.json", ...stagedCases.map(item => item.file)];
  assert.deepEqual((await readdir(join(root, "fixtures/fund-lookthrough"))).sort(), [...fundFiles].sort());
  for (const file of [
    "src/v2/spark-worker-private-smoke.mjs",
    "src/v2/output_contracts.py",
    "src/v2/output-contracts.json",
    "src/v2/output-contract-metadata.json",
    "src/v2/fund_lookthrough.py",
    ...fundFiles.map(file => "fixtures/fund-lookthrough/" + file),
  ]) assert.deepEqual(await readFile(join(root, file)), await readFile(new URL(file, repo)));
});
