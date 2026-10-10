import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("development workspace declares bounded scope and preserves explicit recovery boundaries", () => {
  const ui = readFileSync("web/src/AgentDevelopmentWorkbench.tsx", "utf8");
  for (const label of ["任务历史", "本次数据与业务口径", "按此口径生成并验证", "查看代码差异", "保存并运行我的代码", "刷新 / 恢复", "确认重试", "不是永久云调度", "未知结果含预留", "未保存的编辑已保留"])
    assert.ok(ui.includes(label), label);
  assert.match(ui, /expectedVersion: current\.version/);
  assert.match(ui, /MODEL_OUTCOME_UNKNOWN" && !confirmRetry/);
  assert.match(ui, /confirmModelRetry: true/);
  assert.match(ui, /idempotencyKey: pendingSubmission\.current\.key/);
  assert.match(ui, /beforeunload/);
  assert.match(ui, /token !== epoch\.current/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
  assert.doesNotMatch(ui, /\/prepare-delivery|\/releases|PRIVATE_AGENT_TICK/);
});

test("workspace is lazy loaded, identity scoped and private preview is opt-in", () => {
  const main = readFileSync("web/src/main.tsx", "utf8");
  assert.match(main, /const AgentDevelopmentWorkbench = lazy/);
  assert.match(main, /key=\{session\.user\?\.id \?\? "anonymous"\}/);
  assert.match(main, /shuduo-agent-development/);
  assert.match(main, /idempotencyKey \?\? crypto\.randomUUID/);
  const css = readFileSync("web/src/agent-development.css", "utf8");
  assert.match(css, /max-width:1250px/); assert.match(css, /max-width:850px/);
  assert.match(css, /minmax\(0,1fr\)/);
});
