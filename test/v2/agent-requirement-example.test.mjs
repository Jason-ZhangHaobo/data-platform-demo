import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let source = ts.transpileModule(readFileSync("web/src/AgentRequirementExample.tsx", "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const dependency of ["react/jsx-runtime", "lucide-react"])
  source = source.replaceAll(`from "${dependency}"`, `from ${JSON.stringify(import.meta.resolve(dependency))}`);
const { AgentRequirementExample } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const example = "请按股票持仓＋可用现金口径编写 SQL，不代表客户全资产。";

test("read-only examples are disclosures, without a draft-writing action", () => {
  for (const disabled of [true, false]) {
    const tree = AgentRequirementExample({ readOnly: true, disabled, scoped: true, example, onFill() { assert.fail("read-only example cannot fill a draft"); } });
    const html = renderToStaticMarkup(tree);
    assert.equal(tree.type, "details");
    assert.equal(tree.props.onClick, undefined);
    assert.match(html, /<summary>查看需求示例<\/summary>/);
    assert.match(html, /不代表客户全资产/);
    assert.match(html, /不创建任务或执行计算/);
    assert.doesNotMatch(html, /<button|<textarea|<input| open=/);
  }
});

test("editable examples only fill the current requirement after an explicit click", () => {
  const messages = [];
  const props = { readOnly: false, disabled: false, scoped: true, example, onFill: message => messages.push(message) };
  const tree = AgentRequirementExample(props);
  assert.deepEqual(messages, []);
  assert.equal(tree.type, "button");
  assert.equal(tree.props.type, "button");
  tree.props.onClick();
  assert.deepEqual(messages, [example]);
  const disabled = AgentRequirementExample({ ...props, disabled: true });
  disabled.props.onClick();
  assert.deepEqual(messages, [example]);
  assert.match(renderToStaticMarkup(disabled), /disabled=""/);
});

test("workbench uses the same read-only example for publication and frozen-source views", () => {
  const workbench = readFileSync("web/src/AgentDevelopmentWorkbench.tsx", "utf8");
  assert.match(workbench, /readOnly=requestedReadOnly\|\|sourceReturnActive/);
  assert.match(workbench, /AgentRequirementExample readOnly=\{readOnly\|\|Boolean\(publicationTarget\)\}/);
  // Preserve protection for genuine edits and unknown submissions.
  assert.match(workbench, /onDirtyChange\(dirty \|\| Boolean\(message.trim\(\)\) \|\| manualUnconfirmed/);
});
