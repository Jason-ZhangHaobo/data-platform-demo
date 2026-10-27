import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Real component markup, not a browser/visual acceptance claim.
let source = ts.transpileModule(readFileSync(new URL("../../web/src/AuthDialog.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const dependency of ["react", "react/jsx-runtime", "lucide-react"])
  source = source.replaceAll(`from "${dependency}"`, `from ${JSON.stringify(import.meta.resolve(dependency))}`);
const { AuthDialog } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("read-only login explains its scope and disables invite redemption", () => {
  const html = renderToStaticMarkup(React.createElement(AuthDialog, {
    readOnly: true, api: () => { throw Error("render cannot authenticate"); }, onClose() {}, onAuthenticated() {},
  }));
  assert.match(html, /当前为只读验收/);
  assert.match(html, /创建、运行、发布及新邀请尚未开放/);
  assert.match(html, /<button disabled=""[^>]*title="当前入口仅支持已有账号登录"/);
  assert.match(html, /autoComplete="current-password"/);
});

test("workbench retains read-only status after logout and hides account mutation panels", () => {
  const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /setSession\(\{ authenticated: false, readOnly: session.readOnly \}\)/);
  assert.match(main, /!session.readOnly && !session.developmentOnly &&\s+session.role === "ADMIN" && <InvitationPanel/);
  assert.match(main, /!session.readOnly && !session.developmentOnly &&\s+session.authenticated && \(\s+<ChangePasswordPanel/);
  assert.match(main, /allowRedeem=\{!privatePreview && !session.readOnly && !session.developmentOnly\}/);
  assert.match(main, /受邀开发试点 · 仅限一条新 Agent 任务/);
  assert.match(main, /只读验收入口 · 已有账号可登录查看已保存结果/);
  const workbench = readFileSync(new URL("../../web/src/AgentDevelopmentWorkbench.tsx", import.meta.url), "utf8");
  assert.match(main, /backgroundAvailable=\{Boolean\(status\?\.agentDevelopment\?\.eventBackgroundAvailable\)\} readOnly=\{session.readOnly\}/);
  assert.match(workbench, /if \(readOnly \|\| !originalCanWrite\) return/);
  assert.match(workbench, /本页不会推进任务或提交计算/);
  assert.match(workbench, /代码只读；编辑与执行尚未开放/);
});
