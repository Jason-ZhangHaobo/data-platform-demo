import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Data Agent is the independent default workspace rather than a module sidebar", async () => {
  const main = await readFile(new URL("../../web/src/main.tsx", import.meta.url), "utf8"),
    workspace = await readFile(new URL("../../web/src/AgentCenter.tsx", import.meta.url), "utf8"),
    styles = await readFile(new URL("../../web/src/styles.css", import.meta.url), "utf8");
  assert.match(main, /\?\?\s*"agent-center"/);
  assert.match(workspace, /INDEPENDENT AGENT WORKSPACE/);
  assert.match(workspace, /从目标出发，不从模块出发/);
  assert.match(workspace, /任务历史/);
  assert.match(workspace, /执行计划/);
  assert.match(workspace, /能力与上下文/);
  assert.match(workspace, /PLAN_ONLY/);
  assert.match(workspace, /REQUEST_APPROVAL/);
  assert.match(styles, /grid-template-columns: 224px minmax\(420px, 1fr\) 272px/);
});

test("independent workspace can start every specialist domain without mandatory navigation", async () => {
  const workspace = await readFile(
    new URL("../../web/src/AgentCenter.tsx", import.meta.url),
    "utf8",
  );
  for (const path of [
    "/sync/agent/plans",
    "/streams/agent/plans",
    "/agent/tasks",
    "/agent/deliveries/",
    "/assets/agent/tasks",
    "/quality/agent/plans",
    "/security/agent/plans",
    "/data-services/agent/plans",
    "/reports/agent/plans",
    "/operations/agent/diagnoses",
  ])
    assert.ok(workspace.includes(path), `missing specialist path ${path}`);
  assert.match(workspace, /批准并执行此步骤/);
  assert.match(workspace, /应用为草稿/);
  assert.match(workspace, /记录接管并打开工作台/);
  assert.match(workspace, /openProfessionalWorkspace/);
  assert.match(workspace, /specialistTaskId/);
  assert.match(workspace, /\/agent\/intents\/\$\{task\.id\}\/approvals/);
  assert.match(workspace, /approvalId/);
  assert.match(workspace, /批准并执行此步骤/);
  assert.match(workspace, /本次批准已绑定专业任务/);
  assert.match(workspace, /linkPending/);
  assert.match(workspace, /\/agent\/intents\/\$\{selected\.id\}\/graph/);
  assert.match(workspace, /持久任务图/);
  assert.match(workspace, /nextGraph\.steps/);
  assert.match(workspace, /停止后续编排/);
  assert.match(workspace, /INTENT_CANCELLED/);
  assert.match(workspace, /取消专业子任务/);
  assert.match(workspace, /SPECIALIST_CANCELLED/);
  assert.match(workspace, /服务重启后专业任务已中断/);
  assert.match(workspace, /原始需求未持久化，请新建任务并重新描述目标/);
  assert.match(workspace, /retryable/);
  assert.match(workspace, /api<AgentToolCatalog>\("\/agent\/tools"\)/);
  assert.match(workspace, /toolCatalog\?\.version/);
});
