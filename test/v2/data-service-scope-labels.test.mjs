import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Actual initial TSX rendering, without effects, a browser or network. This
// checks scope wording, not visual/click acceptance or real service execution.
const workbenchSource = readFileSync(new URL("../../web/src/DataServicesWorkbench.tsx", import.meta.url), "utf8");
function compile(source) {
  let output = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  for (const name of ["react", "react/jsx-runtime", "lucide-react"])
    output = output.replaceAll(`from "${name}"`, `from ${JSON.stringify(import.meta.resolve(name))}`);
  return output;
}
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const evidenceUrl = moduleUrl(compile(readFileSync(new URL("../../web/src/EvidenceDownload.tsx", import.meta.url), "utf8")));
let compiled = compile(workbenchSource).replaceAll('from "./EvidenceDownload"', `from ${JSON.stringify(evidenceUrl)}`);
for (const name of ["service-composition", "service-consumption-scope"])
  compiled = compiled.replaceAll(`from "./${name}"`, `from ${JSON.stringify(new URL(`../../web/src/${name}.ts`, import.meta.url).href)}`);
const { DataServicesWorkbench } = await import(moduleUrl(compiled));
const render = (props = {}) => renderToStaticMarkup(React.createElement(DataServicesWorkbench, {
  api: () => { throw new Error("render must not execute an API"); }, canWrite: false, ...props,
}));

test("free DAPI field templates do not describe a scoped result as the customer's full assets", () => {
  const html = render();
  assert.match(html, /<option value="cash">现金与口径合计<\/option>/);
  assert.match(html, /<option value="full">全部结果字段<\/option>/);
  assert.match(html, /结果字段含义继承所选发布口径，不当然等于客户全资产/);
  assert.match(html, /选择全部字段不会补入原口径之外的资产/);
  assert.doesNotMatch(html, /现金与总资产|完整客户资产/);
});

test("new-version template keeps the same neutral labels and source-scope notice", () => {
  const versionEditor = workbenchSource.slice(workbenchSource.indexOf("{!consumptionScope&&showVersionEditor"), workbenchSource.indexOf("{selected.versions.map"));
  assert.match(versionEditor, /<option value="cash">现金与口径合计<\/option>/);
  assert.match(versionEditor, /<option value="full">全部结果字段<\/option>/);
  assert.match(versionEditor, /selected\.serviceType==="DAPI"&&<small>\{fieldScopeNotice\}<\/small>/);
  assert.doesNotMatch(versionEditor, /现金与总资产|完整客户资产/);
});

test("invited consumption continues to display the fixed reviewed name and fields without free templates", () => {
  const now = Date.now();
  const plan = {
    taskId: "synthetic-task", packageDigest: "synthetic-package", sourceReleaseRunId: "synthetic-release",
    dapis: [
      { name: "已审阅持仓名称", slug: "reviewed-holdings", fields: ["client_id", "holding_market_value", "security_count"], timeoutMs: 1500, rateLimitPerMinute: 10 },
      { name: "已审阅现金名称", slug: "reviewed-cash", fields: ["client_id", "available_cash", "total_assets"], timeoutMs: 1500, rateLimitPerMinute: 10 },
    ],
    xapi: { name: "已审阅组合名称", slug: "reviewed-combined", timeoutMs: 2500, rateLimitPerMinute: 5,
      steps: [{ alias: "holdings", dapiSlug: "reviewed-holdings" }, { alias: "cash", dapiSlug: "reviewed-cash" }] },
    applicationName: "已审阅测试应用",
  };
  const before = structuredClone(plan);
  const html = render({ privateCloud: true, consumptionScope: {
    pilotId: "synthetic-pilot", taskId: plan.taskId, plan,
    startsAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
  } });
  assert.match(html, /readonly=""[^>]*value="已审阅持仓名称"/i);
  assert.match(html, /<code>client_id, holding_market_value, security_count<\/code>/);
  assert.doesNotMatch(html, /<option value="cash">|<option value="full">|结果字段含义继承所选发布口径/);
  assert.deepEqual(plan, before);
});
