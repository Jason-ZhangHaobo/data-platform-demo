import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("data development exposes SQL and Python as peer work modes", async () => {
  const main = await readFile(
      new URL("../../web/src/main.tsx", import.meta.url),
      "utf8",
    ),
    workbench = await readFile(
      new URL("../../web/src/PythonWorkbench.tsx", import.meta.url),
      "utf8",
    );
  assert.match(main, /数据开发语言/);
  assert.match(main, /Spark SQL/);
  assert.match(main, /<PythonWorkbench/);
  assert.match(workbench, /RESTRICTED PYTHON · LOCAL ACTUAL/);
  assert.match(workbench, /运行并核验/);
  assert.match(workbench, /五套独立断言/);
  assert.match(workbench, /内存上限/);
  assert.match(workbench, /当前宿主未验证/);
  assert.match(workbench, /不是公网Python沙箱/);
});
