import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deliverySourceSelection } from "../../web/src/delivery-source.ts";
import { manualDeliveryPackages } from "../../web/src/manual-run-recovery.ts";

const legacyContract = "securities-assets-five-fixtures-2026-09-14", stockContract = "securities-stock-cash-five-fixtures-v1";
const oldRun = { id: "old-run", status: "SUCCEEDED", contextId: "holdings-t1", validationContractId: legacyContract };
const stockRun = { id: "stock-run", status: "SUCCEEDED", contextId: "stock-cash-t1", validationContractId: stockContract };
const runs = [oldRun, stockRun];

test("classic delivery validates each run's known family rather than the legacy status contract", () => {
  const state = deliverySourceSelection(runs, { contractId: legacyContract });
  assert.deepEqual(state.eligible, runs);
  assert.equal(state.source, oldRun.id);
  assert.equal(deliverySourceSelection(runs, { currentSource: stockRun.id, contractId: legacyContract }).source, stockRun.id);
  for (const invalid of [
    { ...stockRun, validationContractId: legacyContract },
    { ...oldRun, validationContractId: stockContract },
    { ...stockRun, validation: { contractId: legacyContract } },
    { ...stockRun, contextId: "unregistered-context" },
    { ...stockRun, contextId: undefined },
    { ...stockRun, status: "VALIDATION_FAILED" },
  ]) assert.deepEqual(deliverySourceSelection([invalid]).eligible, []);
  assert.deepEqual(deliverySourceSelection([{ ...oldRun, contextId: undefined }]).eligible, [{ ...oldRun, contextId: undefined }]);
  assert.deepEqual(deliverySourceSelection([{ ...oldRun, contextId: undefined, validationContractId: undefined }]).eligible, []);
});

test("an explicit source is locked exactly and missing or conflicting sources never fall back", () => {
  const selected = deliverySourceSelection(runs, { sourceRunId: stockRun.id, currentSource: oldRun.id, contractId: legacyContract });
  assert.equal(selected.locked, true); assert.equal(selected.source, stockRun.id);
  assert.deepEqual(selected.eligible, [stockRun]);
  for (const input of [
    { runs, sourceRunId: "missing" }, { runs, sourceRunId: "" },
    { runs: [oldRun, { ...stockRun, validationContractId: legacyContract }], sourceRunId: stockRun.id },
  ]) {
    const state = deliverySourceSelection(input.runs, { sourceRunId: input.sourceRunId, currentSource: oldRun.id });
    assert.equal(state.source, ""); assert.equal(state.locked, true); assert.deepEqual(state.eligible, []);
    assert.match(state.issue, /不会改选其他运行/);
  }
  const bundles = runs.map(run => ({ id: run.id, manifest: { source: { runId: run.id } } }));
  assert.deepEqual(manualDeliveryPackages(bundles, stockRun.id, selected.locked).map(b => b.id), [stockRun.id]);
});

test("Agent manual lock preserves its exact source and explicitly supplied contract boundary", () => {
  assert.equal(deliverySourceSelection(runs, { lockSource: true, sourceRunId: stockRun.id, contractId: stockContract }).source, stockRun.id);
  for (const options of [
    { sourceRunId: stockRun.id, contractId: legacyContract },
    { sourceRunId: stockRun.id }, { contractId: stockContract },
  ]) assert.equal(deliverySourceSelection(runs, { ...options, lockSource: true }).source, "");
  const unavailable = deliverySourceSelection([oldRun], { currentSource: stockRun.id });
  assert.equal(unavailable.source, ""); assert.match(unavailable.issue, /明确重新选择/);
  const relabelledStock = { ...stockRun, validationContractId: legacyContract, validation: { contractId: legacyContract } };
  assert.equal(deliverySourceSelection([oldRun, relabelledStock], { lockSource: true, sourceRunId: stockRun.id, contractId: legacyContract }).source, "");
  for (const contextId of [undefined, "unregistered-context"]) {
    assert.equal(deliverySourceSelection([{ ...stockRun, contextId }], { lockSource: true, sourceRunId: stockRun.id, contractId: stockContract }).source, "");
  }
  assert.equal(deliverySourceSelection([{ ...oldRun, contextId: undefined }], { lockSource: true, sourceRunId: oldRun.id, contractId: legacyContract }).source, oldRun.id);
});

async function component() {
  let source = ts.transpileModule(readFileSync(new URL("../../web/src/DeliveryWorkbench.tsx", import.meta.url), "utf8"),
    { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const dependency of ["react", "react/jsx-runtime", "lucide-react"])
    source = source.replaceAll(`from "${dependency}"`, `from ${JSON.stringify(import.meta.resolve(dependency))}`);
  for (const file of ["manual-run-recovery", "delivery-source"])
    source = source.replaceAll(`from "./${file}"`, `from ${JSON.stringify(new URL(`../../web/src/${file}.ts`, import.meta.url).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).DeliveryWorkbench;
}
const DeliveryWorkbench = await component();
const render = props => renderToStaticMarkup(React.createElement(DeliveryWorkbench, {
  api: () => { throw Error("render must not make requests"); }, runs, canWrite: true, onBack: () => {}, ...props,
}));

test("actual classic markup selects a stock handoff and disables inconsistent source switching", () => {
  const html = render({ sourceRunId: stockRun.id, contractId: legacyContract });
  assert.match(html, /<select[^>]*id="delivery-source"[^>]*disabled=""/);
  assert.match(html, /<option value="stock-run" selected=""/);
  assert.doesNotMatch(html, /<option value="old-run"/);
  assert.doesNotMatch(html, /不会改选其他运行/);
});

test("actual missing-source markup explains non-fallback and disables package creation", () => {
  const html = render({ sourceRunId: "missing" });
  assert.match(html, /不会改选其他运行/);
  assert.doesNotMatch(html, /<option value="old-run"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?生成交付包/);
});

test("classic entry does not pass a global contract while Agent lock remains explicit", () => {
  const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(main.match(/<DeliveryWorkbench[\s\S]*?\/>/)?.[0] ?? "missing", /contractId=/);
  const agent = readFileSync(new URL("../../web/src/AgentDevelopmentWorkbench.tsx", import.meta.url), "utf8");
  assert.match(agent, /contractId=\{run\.validationContractId\} lockSource/);
  const workbench = readFileSync(new URL("../../web/src/DeliveryWorkbench.tsx", import.meta.url), "utf8");
  assert.match(workbench, /const selected = sourceLocked && \(!source \|\| loadedPackage\?\.manifest\.source\.runId !== sourceRunId\) \? undefined : loadedPackage;/,
    "a rejected locked source cannot retain an actionable selected package");
});
