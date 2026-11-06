import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the real workbench and its child components; no API or effect runs
// during SSR. Async read/retry behavior is verified in the browser fixture.
const compiled = new Map();
async function component(file) {
  if (compiled.has(file)) return compiled.get(file);
  let code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const match of [...code.matchAll(/from (["'])([^"']+)\1/g)]) {
    const name = match[2];
    let url;
    if (name.startsWith(".")) {
      const target = resolve(dirname(file), name);
      const path = [target, target + ".tsx", target + ".ts"].find(existsSync);
      assert.ok(path, name);
      url = path.endsWith(".tsx") ? await component(path) : pathToFileURL(path).href;
    } else url = import.meta.resolve(name);
    code = code.replaceAll(match[0], `from ${JSON.stringify(url)}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  compiled.set(file, url);
  return url;
}
const { DataServicesWorkbench } = await import(await component(resolve("web/src/DataServicesWorkbench.tsx")));
const api = () => assert.fail("render must not fetch, create, invoke a model or run Spark");

test("unknown catalog is not presented as empty, even to a user with write permission", () => {
  for (const canWrite of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(DataServicesWorkbench, { api, canWrite, privateCloud: true, runtimeMode: "PUBLIC_INVITATION" }));
    assert.match(html, /当前范围统计尚未确认/);
    assert.equal((html.match(/<strong>—<\/strong>/g) ?? []).length, 3);
    assert.match(html, /正在读取当前范围的服务目录/);
    assert.match(html, /未读取成功不代表没有数据/);
    assert.doesNotMatch(html, /<strong>0<\/strong>|从真实发布批次创建第一个DAPI|暂无可用批次|0个应用|0条当前服务调用/);
    assert.doesNotMatch(html, /创建DAPI草稿|创建持仓\+现金XAPI|撤销凭证/);
  }
});

test("unconfirmed catalog does not hide the independent private planning recovery workspace", () => {
  const html = renderToStaticMarkup(React.createElement(DataServicesWorkbench, {
    api, canWrite: false, privateCloud: true, runtimeMode: "PUBLIC_INVITATION", durableServiceAgentReadEnabled: true,
    sourceBinding: { taskId: "00000000-0000-4000-8000-000000000001", releaseId: "00000000-0000-4000-8000-000000000002", packageDigest: "a".repeat(64), sourceKind: "AGENT", scope: "PRIVATE_CLOUD_TEST" },
  }));
  assert.match(html, /当前范围统计尚未确认/);
  assert.match(html, /持久私有服务规划/);
  assert.match(html, /原任务/);
  assert.doesNotMatch(html, /创建DAPI草稿/);
});
