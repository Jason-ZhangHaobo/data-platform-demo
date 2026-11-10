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
    output = output.replaceAll(`from "${name}"`, `from ${JSON.stringify(import.meta.resolve(name))}`).replaceAll(`from '${name}'`, `from ${JSON.stringify(import.meta.resolve(name))}`);
  return output;
}
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const evidenceUrl = moduleUrl(compile(readFileSync(new URL("../../web/src/EvidenceDownload.tsx", import.meta.url), "utf8")));
let privateStudio=compile(readFileSync(new URL('../../web/src/PrivateServiceAgentStudio.tsx',import.meta.url),'utf8'));
for(const name of ['service-plan-source','private-service-plan'])privateStudio=privateStudio.replaceAll(`from './${name}'`,`from ${JSON.stringify(new URL(`../../web/src/${name}.ts`,import.meta.url).href)}`).replaceAll(`from "./${name}"`,`from ${JSON.stringify(new URL(`../../web/src/${name}.ts`,import.meta.url).href)}`);
let compiled = compile(workbenchSource).replaceAll('from "./EvidenceDownload"', `from ${JSON.stringify(evidenceUrl)}`).replaceAll('from "./PrivateServiceAgentStudio"',`from ${JSON.stringify(moduleUrl(privateStudio))}`).replaceAll("from './PrivateServiceAgentStudio'",`from ${JSON.stringify(moduleUrl(privateStudio))}`);
compiled=compiled.replaceAll('from "../../src/v2/output-contract-metadata.mjs"',`from ${JSON.stringify(new URL('../../src/v2/output-contract-metadata.mjs',import.meta.url).href)}`);
for (const name of ["service-composition", "service-consumption-scope", "service-source-binding", "service-plan-source"])
  compiled = compiled.replaceAll(`from "./${name}"`, `from ${JSON.stringify(new URL(`../../web/src/${name}.ts`, import.meta.url).href)}`);
const { DataServicesWorkbench } = await import(moduleUrl(compiled));
const render = (props = {}) => renderToStaticMarkup(React.createElement(DataServicesWorkbench, {
  api: () => { throw new Error("render must not execute an API"); }, canWrite: false, ...props,
}));

test("free DAPI field templates do not describe a scoped result as the customer's full assets", () => {
  const html = render();
  assert.match(html, /当前范围统计尚未确认/);
  assert.doesNotMatch(html, /<option value="cash">|<option value="full">/);
  // The form is only mounted after catalog readback. Preserve its wording
  // contract here; the actual ready form is also checked in the browser.
  const form = workbenchSource.slice(workbenchSource.indexOf('className="service-create-panel"'), workbenchSource.indexOf('className="service-detail-head"'));
  assert.match(form, /<option value="cash">\{sourceContract\?"市值占比（六位小数）":"现金与口径合计"\}<\/option>/);
  assert.match(form, /<option value="full">全部结果字段<\/option>/);
  assert.match(workbenchSource, /结果字段含义继承所选发布口径，不当然等于客户全资产/);
  assert.match(workbenchSource, /选择全部字段不会补入原口径之外的资产/);
  assert.doesNotMatch(form, /现金与总资产|完整客户资产/);
});

test("new-version template keeps the same neutral labels and source-scope notice", () => {
  const versionEditor = workbenchSource.slice(workbenchSource.indexOf("{!consumptionScope&&showVersionEditor"), workbenchSource.indexOf("{selected.versions.map"));
  assert.match(versionEditor, /<option value="cash">\{selectedContract\?"市值占比（六位小数）":"现金与口径合计"\}<\/option>/);
  assert.match(versionEditor, /<option value="full">全部结果字段<\/option>/);
  assert.match(versionEditor, /selected\.serviceType==="DAPI"&&<small>\{selectedContract\?.*:fieldScopeNotice\}<\/small>/);
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
  assert.match(html, /已审阅持仓名称/);
  assert.match(html, /当前范围统计尚未确认/);
  assert.doesNotMatch(html, /创建DAPI草稿/);
  assert.match(workbenchSource, /value=\{plannedDapi\?\.name\?\?dapiName\}[^>]*readOnly=\{Boolean\(consumptionScope\)\}/);
  assert.doesNotMatch(html, /<option value="cash">|<option value="full">|结果字段含义继承所选发布口径/);
  assert.deepEqual(plan, before);
});
