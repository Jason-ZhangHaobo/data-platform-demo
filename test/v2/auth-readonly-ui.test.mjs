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
  assert.match(main, /setSession\(\{ authenticated: false, readOnly: session.readOnly, developmentOnly: session.developmentOnly, publicationOnly: session.publicationOnly \}\)/);
  assert.match(main, /!session.readOnly && !session.developmentOnly && !session.publicationOnly &&\s+session.role === "ADMIN" && <InvitationPanel/);
  assert.match(main, /!session.readOnly && !session.developmentOnly && !session.publicationOnly &&\s+session.authenticated && \(\s+<ChangePasswordPanel/);
  assert.match(main, /allowRedeem=\{!privatePreview && !session.readOnly && !session.developmentOnly && !session.publicationOnly\}/);
  assert.match(main, /受邀开发试点 · 仅限一条新 Agent 任务/);
  assert.match(main, /只读验收入口 · 已有账号可登录查看已保存结果/);
  const workbench = readFileSync(new URL("../../web/src/AgentDevelopmentWorkbench.tsx", import.meta.url), "utf8");
  assert.match(main, /backgroundAvailable=\{Boolean\(status\?\.agentDevelopment\?\.eventBackgroundAvailable\)\} readOnly=\{session.readOnly \|\| session.publicationOnly\}/);
  assert.match(workbench, /if \(readOnly \|\| !originalCanWrite\) return/);
  assert.match(workbench, /本页不会推进任务或提交计算/);
  assert.match(workbench, /代码只读；编辑与执行尚未开放/);
});

test("publication-only login has no redemption control or automatic action", () => {
  const html = renderToStaticMarkup(React.createElement(AuthDialog, {
    publicationOnly: true, allowRedeem: false, api: () => { throw Error("render cannot authenticate"); }, onClose() {}, onAuthenticated() {},
  }));
  assert.match(html, /受邀发布试点/);
  assert.match(html, /不开放代码开发、新邀请或账号管理/);
  assert.doesNotMatch(html, /首次受邀|兑换邀请|一次性邀请码|创建账号并登录/);
  assert.match(html, /autoComplete="current-password"/);
});

test("publication permission cannot enable development or other module writes", () => {
  const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /canWrite = Boolean\(\s+!session.readOnly && !session.publicationOnly/);
  assert.match(main, /const canPublish = session.publicationOnly\s+\? Boolean\(session.authenticated && !session.readOnly && !session.developmentOnly && session.permissions\?\.includes\("DELIVERY"\) && publicationWindowOpen\)/);
  assert.match(main, /const servicesCanWrite = !session.readOnly && !session.publicationOnly/);
  assert.match(main, /canWrite=\{canWrite\} canPublish=\{canPublish\} publicationTarget=\{publicationTarget\}/);
  assert.match(main, /encodeURIComponent\(session.publicationTaskId\)/);
  assert.match(main, /setInterval\(\(\) => setPublicationClock\(Date.now\(\)\), 1000\)/);
  assert.match(main, /publicationClock < Date.parse\(publicationTarget.expiresAt\)/);
  assert.match(main, /同一冻结业务日期运行两批，不代表两个交易日或生产调度/);
  const workbench = readFileSync(new URL("../../web/src/AgentDevelopmentWorkbench.tsx", import.meta.url), "utf8");
  assert.match(workbench, /canWrite=originalCanWrite&&!readOnly&&!publicationTarget/);
  assert.match(workbench, /readOnly=\{readOnly\|\|Boolean\(publicationTarget\)\|\|working\}/);
  assert.match(workbench, /canPublish=\{canPublish\} publicationTarget=\{publicationTarget\}/);
  const panel = readFileSync(new URL("../../web/src/AgentDeliveryPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /publicationTargetMatches\(publicationTarget, \{ taskId, packageDigest: workflow\?\.package\?\.digest, verificationId: workflow\?\.verification\?\.id \}/);
  assert.match(panel, /delivery\?\.verificationId === publicationTarget.verificationId/);
  assert.match(panel, /if \(!publicationWritable \|\| working/);
  assert.match(panel, /if \(!cancellationWritable\) return/);
  assert.match(panel, /taskId:release.sourceAgentTaskId \?\? "",packageDigest:release.packageDigest,verificationId:release.verificationId/);
  assert.match(panel, /if \(!canWrite \|\| publicationTarget\) return/);
});
