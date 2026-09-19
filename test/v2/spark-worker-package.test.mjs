import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Spark Worker package builder normalizes timestamps and ZIP metadata", async () => {
  const script = await readFile(
    new URL("../../scripts/build-v2-spark-worker-package.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /touch -h -t 198001010000/);
  assert.match(script, /LC_ALL=C find .* -type f -print \| LC_ALL=C sort/);
  assert.match(script, /zip -X -q/);
  assert.doesNotMatch(script, /zip -qr/);
  const workflow = await readFile(
    new URL("../../.github/workflows/build-v2-spark-worker.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /sha256sum v2-spark-worker\.zip/);
  assert.match(workflow, /Spark Worker inner SHA-256/);
});
