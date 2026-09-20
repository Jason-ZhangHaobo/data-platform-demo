import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("delivery workbench explains SQL and Python release evidence without overclaiming", async () => {
  const source = await readFile(
    new URL("../../web/src/DeliveryWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /shuduo-python-delivery\/v1/);
  assert.match(source, /main\.py/);
  assert.match(source, /受限CPython/);
  assert.match(source, /Python代码与五场景断言已实际执行/);
  assert.match(source, /不代表公网或生产上线/);
  assert.match(source, /source\.codeHash \?\? selected\?\.manifest\.source\.sqlHash/);
});

