import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import {
  publicAgentIntentDestinations,
  publicAgentToolCatalog,
  publicAgentSpecialistTools,
  validateAgentToolInput,
  validateAgentApprovalMode,
  validateAgentIntentMessage,
  validateAgentIntentRoute,
} from "../../src/v2/agent-router.mjs";

test("specialist tool catalog exposes ten governed versionable capabilities", () => {
  const tools = publicAgentSpecialistTools();
  assert.equal(tools.length, 10);
  assert.equal(new Set(tools.map((tool) => tool.id)).size, 10);
  assert.ok(tools.every((tool) => tool.approvalRequired === true));
  assert.ok(tools.every((tool) => tool.createPath.startsWith("/")));
  assert.ok(tools.every((tool) => tool.detailPath.includes("{id}")));
  assert.ok(tools.every((tool) => tool.childCancelPath.includes("{intentId}")));
  assert.ok(tools.every((tool) => tool.idempotencyKeyRequired === true));
  assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.ok(tools.every((tool) => tool.outputSchema.required.includes("id")));
  assert.equal(tools.find((tool) => tool.id === "schedules").requiresDestination, "development");
  assert.deepEqual(
    tools.find((tool) => tool.id === "development").inputSchema.required,
    ["message", "contextId", "sql"],
  );
  assert.deepEqual(
    tools.find((tool) => tool.id === "schedules").inputSchema.required,
    ["sourceTaskId"],
  );
  assert.equal(tools.find((tool) => tool.id === "security").risk, "HIGH");
  const catalog = publicAgentToolCatalog();
  assert.equal(catalog.version, "shuduo-agent-tools/v1");
  assert.match(catalog.contractDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    validateAgentToolInput(
      "reports",
      { message: "生成虚构证券持仓分析报表" },
      { version: catalog.version, contractDigest: catalog.contractDigest },
    ),
    {
      valid: true,
      toolId: "reports",
      catalogVersion: catalog.version,
      contractDigest: catalog.contractDigest,
      createMode: "MESSAGE",
      execution: "NO_EXECUTION",
    },
  );
  assert.throws(
    () =>
      validateAgentToolInput(
        "reports",
        { message: "生成虚构证券持仓分析报表", unexpected: true },
        { version: catalog.version, contractDigest: catalog.contractDigest },
      ),
    { code: "AGENT_TOOL_INPUT_INVALID" },
  );
});

const waitFor = async (read, done, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待Agent意图任务超时");
};
const publicRequest = async (base, path, { body, cookie, csrf, key = "agent-router-public" } = {}) => {
  const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        Origin: "https://demo.example",
        "X-Shuduo-Client": "workbench",
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": key }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    cookies = response.headers.getSetCookie?.() ?? [];
  return {
    status: response.status,
    body: await response.json(),
    cookie: cookies.map((value) => value.split(";", 1)[0]).join("; "),
  };
};

test("cross-module intent route is whitelist-bound and cannot include execution", () => {
  const route = validateAgentIntentRoute({
    destinationId: "quality",
    summary: "为虚构证券持仓设计市值范围质量规则",
    rationale: "需求要求识别异常市值并形成可审阅规则草稿。",
    confidence: 0.91,
    sql: "DROP TABLE anything",
  });
  assert.equal(route.destination.id, "quality");
  assert.equal(route.execution, "NO_EXECUTION");
  assert.equal(route.requiresHumanReview, true);
  assert.equal(route.steps.length, 1);
  assert.equal("sql" in route, false);
  assert.throws(
    () =>
      validateAgentIntentRoute({
        destinationId: "admin-shell",
        summary: "不安全模块",
        rationale: "不应被允许。",
        confidence: 1,
      }),
    { status: 422 },
  );
  assert.equal(publicAgentIntentDestinations().some((item) => "credentials" in item), false);
});

test("Agent intent input rejects secrets and only returns a safe task envelope", () => {
  assert.equal(validateAgentIntentMessage("理解虚构证券持仓字段并设计报表"), "理解虚构证券持仓字段并设计报表");
  assert.throws(
    () => validateAgentIntentMessage("数据库 password=NotAllowed#2026"),
    { status: 422 },
  );
  assert.throws(
    () => validateAgentIntentMessage("连接 jdbc:mysql://private.example/db"),
    { status: 422 },
  );
});

test("independent Agent workspace supports explicit approval modes", () => {
  assert.equal(validateAgentApprovalMode(), "REQUEST_APPROVAL");
  assert.equal(validateAgentApprovalMode("PLAN_ONLY"), "PLAN_ONLY");
  assert.equal(
    validateAgentApprovalMode("REQUEST_APPROVAL"),
    "REQUEST_APPROVAL",
  );
  assert.throws(() => validateAgentApprovalMode("YOLO"), { status: 422 });
});

test("cross-module intent can recommend a bounded sequence without auto-execution", () => {
  const route = validateAgentIntentRoute({
    destinationId: "assets",
    summary: "解释持仓字段后设计资产分析报表",
    rationale: "先确认资产口径，再设计依赖该口径的可视化报表。",
    confidence: 0.93,
    steps: [
      { destinationId: "assets", objective: "解释客户持仓字段、血缘和资产统计口径" },
      { destinationId: "reports", objective: "基于已确认口径设计财富顾问资产分析报表草稿" },
    ],
  });
  assert.deepEqual(route.steps.map((step) => step.destinationId), ["assets", "reports"]);
  assert.equal(route.requiresHumanReview, false);
  const completeJourney = validateAgentIntentRoute({
    destinationId: "sources",
    summary: "完成证券数据接入、开发、发布和运维闭环",
    rationale: "任务需要从数据接入开始并贯穿完整交付链路。",
    confidence: 0.95,
    steps: [
      ["sources", "登记数据源并采集元数据"],
      ["development", "生成并验证证券加工代码"],
      ["quality", "配置并运行数据质量检查"],
      ["security", "生成并审阅最小权限和脱敏策略"],
      ["schedules", "生成调度部署文件并受控发布"],
      ["services", "发布受治理的DAPI和XAPI"],
      ["reports", "生成证券资产分析报表"],
      ["ops", "监控批次并验证故障恢复"],
    ].map(([destinationId, objective]) => ({ destinationId, objective })),
  });
  assert.equal(completeJourney.steps.length, 8);
  assert.equal(completeJourney.requiresHumanReview, true);
  assert.throws(
    () => validateAgentIntentRoute({
      destinationId: "assets",
      summary: "重复模块不得通过",
      rationale: "一个跨模块建议不能重复跳转同一模块。",
      confidence: 0.9,
      steps: [
        { destinationId: "assets", objective: "解释资产字段和口径信息" },
        { destinationId: "assets", objective: "再次执行相同的资产解释任务" },
      ],
    }),
    { status: 422 },
  );
});

test("intent API persists a live-model routing result without executing a downstream module", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-router-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      env: { V2_LOCAL_DEVELOPMENT: "true" },
      intentPlanner: async ({ destinations }) => ({
        route: {
          destinationId: destinations.find((item) => item.id === "reports").id,
          summary: "设计财富顾问持仓分布报表草稿",
          rationale: "需求是解释字段并生成资产分析报表，应先进入受治理报表设计。",
          confidence: 0.88,
        },
        model: "TEST_ROUTER_MODEL",
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const catalog = await fetch(base + "/agent/tools").then((value) => value.json());
    assert.equal(catalog.version, "shuduo-agent-tools/v1");
    assert.match(catalog.contractDigest, /^[a-f0-9]{64}$/);
    assert.equal(catalog.tools.length, 10);
    assert.equal(JSON.stringify(catalog).includes("credential"), false);
    const validToolResponse = await fetch(
        base + "/agent/tools/reports/validate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shuduo-Client": "workbench",
            "Idempotency-Key": "agent-tool-validation",
          },
          body: JSON.stringify({
            catalogVersion: catalog.version,
            contractDigest: catalog.contractDigest,
            input: { message: "生成虚构证券持仓分析报表" },
          }),
        },
      ),
      validTool = await validToolResponse.json();
    assert.equal(validToolResponse.status, 200);
    assert.equal(validTool.valid, true);
    assert.equal(validTool.execution, "NO_EXECUTION");
    const staleToolResponse = await fetch(
      base + "/agent/tools/reports/validate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "agent-tool-stale-validation",
        },
        body: JSON.stringify({
          catalogVersion: catalog.version,
          contractDigest: "0".repeat(64),
          input: { message: "生成虚构证券持仓分析报表" },
        }),
      },
    );
    assert.equal(staleToolResponse.status, 422);
    assert.equal(
      (await staleToolResponse.json()).code,
      "AGENT_TOOL_CATALOG_DIGEST_MISMATCH",
    );
    const createdResponse = await fetch(base + "/agent/intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "agent-router-test",
        },
        body: JSON.stringify({
          message: "理解持仓字段后生成财富分析报表",
          approvalMode: "PLAN_ONLY",
        }),
      }),
      created = await createdResponse.json();
    assert.equal(createdResponse.status, 202);
    const completed = await waitFor(
      async () => (await fetch(base + `/agent/intents`).then((value) => value.json()))[0],
      (value) => value.status === "SUCCEEDED",
    );
    assert.equal(completed.id, created.id);
    assert.equal(completed.route.destinationId, "reports");
    assert.equal(completed.route.execution, "NO_EXECUTION");
    assert.equal(completed.approvalMode, "PLAN_ONLY");
    assert.equal(completed.fullLifecycleE2E, false);
    assert.equal(completed.message, undefined);
    assert.equal(typeof completed.messageHash, "string");
    assert.equal(store.get("agent_intent", created.id, PROJECT).message, undefined);
    assert.equal(store.list("report_agent_plan", PROJECT).length, 0);
    assert.equal(store.list("report", PROJECT).length, 0);
    const specialist = store.create("report_agent_plan", PROJECT, {
      status: "SUCCEEDED",
      completionScope: "REPORT_DESIGN",
    });
    const linkedResponse = await fetch(
      base + `/agent/intents/${completed.id}/handoffs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "agent-router-linked-specialist",
        },
        body: JSON.stringify({
          destinationId: "reports",
          specialistTaskId: specialist.id,
        }),
      },
    );
    assert.equal(linkedResponse.status, 409);
    const linked = await linkedResponse.json();
    assert.equal(linked.code, "PLAN_ONLY_EXECUTION_DENIED");
    const missingReference = await fetch(
      base + `/agent/intents/${completed.id}/handoffs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "agent-router-missing-specialist",
        },
        body: JSON.stringify({
          destinationId: "reports",
          specialistTaskId: "missing-specialist",
        }),
      },
    );
    assert.equal(missingReference.status, 409);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("request-approval intent persists and binds an exact step approval before specialist execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-approval-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      intentPlanner: async () => ({
        route: {
          destinationId: "reports",
          summary: "设计虚构证券资产报表",
          rationale: "先由报表专业Agent形成受治理草稿。",
          confidence: 0.9,
          steps: [
            {
              destinationId: "reports",
              objective: "基于已登记资产设计类别与行业分布报表",
            },
          ],
        },
        model: "TEST_ROUTER_MODEL",
        usage: { total_tokens: 1 },
      }),
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const created = await fetch(base + "/agent/intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        "Idempotency-Key": "approval-intent",
      },
      body: JSON.stringify({
        message: "根据虚构证券资产设计类别与行业报表",
        approvalMode: "REQUEST_APPROVAL",
      }),
    }).then((response) => response.json());
    const completed = await waitFor(
      async () => (await fetch(base + "/agent/intents").then((value) => value.json()))[0],
      (value) => value.id === created.id && value.status === "SUCCEEDED",
    );
    const specialist = store.create("report_agent_plan", PROJECT, {
      status: "SUCCEEDED",
      completionScope: "REPORT_DESIGN",
    });
    const withoutApproval = await fetch(
      base + `/agent/intents/${completed.id}/handoffs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "approval-missing",
        },
        body: JSON.stringify({
          destinationId: "reports",
          specialistTaskId: specialist.id,
        }),
      },
    );
    assert.equal(withoutApproval.status, 409);
    assert.equal((await withoutApproval.json()).code, "AGENT_STEP_APPROVAL_REQUIRED");
    const approvalResponse = await fetch(
        base + `/agent/intents/${completed.id}/approvals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shuduo-Client": "workbench",
            "Idempotency-Key": "approve-reports-step",
          },
          body: JSON.stringify({ destinationId: "reports" }),
        },
      ),
      approval = await approvalResponse.json();
    assert.equal(approvalResponse.status, 201);
    assert.equal(approval.status, "APPROVED");
    assert.equal(approval.submittedBy, undefined);
    assert.equal(typeof approval.objectiveHash, "string");
    const approvalReplayResponse = await fetch(
        base + `/agent/intents/${completed.id}/approvals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shuduo-Client": "workbench",
            "Idempotency-Key": "approve-reports-step-retry",
          },
          body: JSON.stringify({ destinationId: "reports" }),
        },
      ),
      approvalReplay = await approvalReplayResponse.json();
    assert.equal(approvalReplayResponse.status, 200);
    assert.equal(approvalReplay.id, approval.id);
    assert.equal(store.list("agent_intent_approval", PROJECT).length, 1);
    const handoffResponse = await fetch(
        base + `/agent/intents/${completed.id}/handoffs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shuduo-Client": "workbench",
            "Idempotency-Key": "bind-approved-specialist",
          },
          body: JSON.stringify({
            destinationId: "reports",
            specialistTaskId: specialist.id,
            approvalId: approval.id,
          }),
        },
      ),
      handoff = await handoffResponse.json();
    assert.equal(handoffResponse.status, 201);
    assert.equal(handoff.approvalId, approval.id);
    const approvals = await fetch(
      base + `/agent/intents/${completed.id}/approvals`,
    ).then((response) => response.json());
    assert.equal(approvals[0].status, "BOUND");
    assert.equal(approvals[0].specialistTaskId, specialist.id);
    assert.equal(approvals[0].submittedBy, undefined);
    const trace = await fetch(base + `/agent/intents/${completed.id}/trace`).then(
      (response) => response.json(),
    );
    assert.deepEqual(trace.map((item) => item.kind), [
      "MODEL_ROUTE",
      "STEP_APPROVAL",
      "SPECIALIST_HANDOFF",
    ]);
    const graph = await fetch(base + `/agent/intents/${completed.id}/graph`).then(
      (response) => response.json(),
    );
    assert.equal(graph.completionScope, "AGENT_ORCHESTRATION_GRAPH");
    assert.equal(graph.completedCount, 1);
    assert.equal(graph.totalCount, 1);
    assert.equal(graph.steps[0].status, "SUCCEEDED");
    assert.equal(graph.steps[0].approvalStatus, "BOUND");
    assert.equal(graph.steps[0].specialistTaskId, specialist.id);
    assert.equal(graph.steps[0].executionEvidence, "SPECIALIST_TASK_LINKED");
    assert.equal(graph.agentIndependentE2E, false);
    assert.equal(JSON.stringify(graph).includes("基于已登记资产设计"), false);
    const parentCancel = await fetch(
      base + `/agent/intents/${completed.id}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "cancel-parent-with-child",
        },
        body: "{}",
      },
    );
    assert.equal(parentCancel.status, 409);
    assert.equal(
      (await parentCancel.json()).code,
      "AGENT_CHILD_TASKS_REQUIRE_SEPARATE_CONTROL",
    );
    const completedChildCancel = await fetch(
      base + `/agent/intents/${completed.id}/children/reports/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "cancel-completed-child",
        },
        body: "{}",
      },
    );
    assert.equal(completedChildCancel.status, 409);
    assert.equal(
      (await completedChildCancel.json()).code,
      "AGENT_CHILD_TASK_NOT_CANCELLABLE",
    );
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("parent task graph cancels one running specialist child without cancelling the parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-child-cancel-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      intentPlanner: async () => ({
        route: {
          destinationId: "quality",
          summary: "设计虚构证券质量规则",
          rationale: "由质量专业Agent形成规则草稿。",
          confidence: 0.9,
        },
        model: "TEST_ROUTER_MODEL",
        usage: { total_tokens: 1 },
      }),
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const created = await fetch(base + "/agent/intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        "Idempotency-Key": "child-cancel-intent",
      },
      body: JSON.stringify({
        message: "为虚构证券数据设计质量规则",
        approvalMode: "REQUEST_APPROVAL",
      }),
    }).then((response) => response.json());
    const completed = await waitFor(
      async () => (await fetch(base + "/agent/intents").then((value) => value.json()))[0],
      (value) => value.id === created.id && value.status === "SUCCEEDED",
    );
    const approval = await fetch(
      base + `/agent/intents/${completed.id}/approvals`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "child-cancel-approval",
        },
        body: JSON.stringify({ destinationId: "quality" }),
      },
    ).then((response) => response.json());
    const child = store.create("quality_agent_plan", PROJECT, {
      status: "RUNNING",
      completionScope: "QUALITY_RULE_DESIGN",
    });
    const handoff = await fetch(
      base + `/agent/intents/${completed.id}/handoffs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "child-cancel-handoff",
        },
        body: JSON.stringify({
          destinationId: "quality",
          specialistTaskId: child.id,
          approvalId: approval.id,
        }),
      },
    );
    assert.equal(handoff.status, 201);
    const cancelledResponse = await fetch(
        base + `/agent/intents/${completed.id}/children/quality/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shuduo-Client": "workbench",
            "Idempotency-Key": "child-cancel-now",
          },
          body: "{}",
        },
      ),
      cancelled = await cancelledResponse.json();
    assert.equal(cancelledResponse.status, 200);
    assert.equal(cancelled.child.id, child.id);
    assert.equal(cancelled.child.status, "CANCELLED");
    assert.equal(cancelled.graph.status, "SUCCEEDED");
    assert.equal(cancelled.graph.steps[0].specialistStatus, "CANCELLED");
    assert.equal(store.get("agent_intent", completed.id, PROJECT).status, "SUCCEEDED");
    const trace = await fetch(base + `/agent/intents/${completed.id}/trace`).then(
      (response) => response.json(),
    );
    assert.deepEqual(trace.map((item) => item.kind), [
      "MODEL_ROUTE",
      "STEP_APPROVAL",
      "SPECIALIST_HANDOFF",
      "SPECIALIST_CANCELLED",
    ]);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("cancelling an unbound Agent intent revokes approvals and blocks later execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-cancel-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      intentPlanner: async () => ({
        route: {
          destinationId: "quality",
          summary: "设计虚构证券质量规则",
          rationale: "先形成质量规则草稿。",
          confidence: 0.9,
        },
        model: "TEST_ROUTER_MODEL",
        usage: { total_tokens: 1 },
      }),
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const intent = await fetch(base + "/agent/intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        "Idempotency-Key": "cancel-intent-create",
      },
      body: JSON.stringify({
        message: "为虚构证券持仓设计质量规则",
        approvalMode: "REQUEST_APPROVAL",
      }),
    }).then((response) => response.json());
    const completed = await waitFor(
      async () => (await fetch(base + "/agent/intents").then((value) => value.json()))[0],
      (value) => value.id === intent.id && value.status === "SUCCEEDED",
    );
    const approval = await fetch(
      base + `/agent/intents/${completed.id}/approvals`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "cancel-intent-approval",
        },
        body: JSON.stringify({ destinationId: "quality" }),
      },
    ).then((response) => response.json());
    assert.equal(approval.status, "APPROVED");
    const cancelledResponse = await fetch(
        base + `/agent/intents/${completed.id}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shuduo-Client": "workbench",
            "Idempotency-Key": "cancel-intent-now",
          },
          body: "{}",
        },
      ),
      cancelled = await cancelledResponse.json();
    assert.equal(cancelledResponse.status, 200);
    assert.equal(cancelled.status, "CANCELLED");
    const approvals = await fetch(
      base + `/agent/intents/${completed.id}/approvals`,
    ).then((response) => response.json());
    assert.equal(approvals[0].status, "REVOKED");
    const graph = await fetch(base + `/agent/intents/${completed.id}/graph`).then(
      (response) => response.json(),
    );
    assert.equal(graph.status, "CANCELLED");
    assert.equal(graph.completedCount, 0);
    assert.equal(graph.steps[0].approvalStatus, "REVOKED");
    const blockedApproval = await fetch(
      base + `/agent/intents/${completed.id}/approvals`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "cancelled-reapprove",
        },
        body: JSON.stringify({ destinationId: "quality" }),
      },
    );
    assert.equal(blockedApproval.status, 409);
    const trace = await fetch(base + `/agent/intents/${completed.id}/trace`).then(
      (response) => response.json(),
    );
    assert.deepEqual(trace.map((item) => item.kind), [
      "MODEL_ROUTE",
      "STEP_APPROVAL",
      "INTENT_CANCELLED",
    ]);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("late model completion cannot overwrite a cancelled running Agent intent", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-cancel-race-")),
    store = new MetadataStore(join(root, "platform.sqlite"));
  let releasePlanner;
  const plannerGate = new Promise((resolve) => {
      releasePlanner = resolve;
    }),
    app = createV2Server({
      root,
      store,
      intentPlanner: async () => {
        await plannerGate;
        return {
          route: {
            destinationId: "assets",
            summary: "解释虚构证券资产",
            rationale: "任务属于资产理解。",
            confidence: 0.9,
          },
          model: "LATE_TEST_MODEL",
          usage: { total_tokens: 1 },
        };
      },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const created = await fetch(base + "/agent/intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        "Idempotency-Key": "cancel-race-create",
      },
      body: JSON.stringify({
        message: "解释虚构证券资产口径",
        approvalMode: "REQUEST_APPROVAL",
      }),
    }).then((response) => response.json());
    await waitFor(
      async () => (await fetch(base + "/agent/intents").then((value) => value.json()))[0],
      (value) => value.id === created.id && value.status === "RUNNING",
    );
    const cancelled = await fetch(base + `/agent/intents/${created.id}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        "Idempotency-Key": "cancel-race-now",
      },
      body: "{}",
    }).then((response) => response.json());
    assert.equal(cancelled.status, "CANCELLED");
    releasePlanner();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const final = store.get("agent_intent", created.id, PROJECT);
    assert.equal(final.status, "CANCELLED");
    assert.equal(final.route, undefined);
    assert.deepEqual(
      store
        .list("agent_intent_trace", PROJECT)
        .filter((item) => item.intentId === created.id)
        .map((item) => item.kind),
      ["INTENT_CANCELLED"],
    );
  } finally {
    releasePlanner?.();
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("public anonymous callers cannot read cross-module intent history", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-router-public-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      env: { V2_LOCAL_DEVELOPMENT: "false" },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/v2/agent/intents`,
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "AUTHENTICATION_REQUIRED");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("public Agent intent history is isolated per member and viewer cannot submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-router-roles-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      env: {
        V2_LOCAL_DEVELOPMENT: "false",
        V2_PUBLIC_ORIGIN: "https://demo.example",
        V2_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
        V2_BOOTSTRAP_ADMIN_PASSWORD: "StrongAdmin#2026",
        V2_BOOTSTRAP_ADMIN_NAME: "虚构管理员",
      },
      intentPlanner: async () => ({
        route: { destinationId: "reports", summary: "设计虚构证券资产报表", rationale: "请求属于报表设计。", confidence: 0.9 },
        model: "TEST_ROUTER_MODEL",
        usage: { total_tokens: 1 },
      }),
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const admin = await publicRequest(base, "/auth/login", { body: { email: "admin@example.test", password: "StrongAdmin#2026" }, key: "admin-login" });
    const invite = async (email, role, key) => publicRequest(base, "/auth/invitations", { body: { email, role }, cookie: admin.cookie, csrf: admin.body.csrfToken, key });
    const pmInvite = await invite("pm@example.test", "PRODUCT_MANAGER", "pm-invite"),
      viewerInvite = await invite("viewer@example.test", "VIEWER", "viewer-invite"),
      pm = await publicRequest(base, "/auth/redeem", { body: { inviteCode: pmInvite.body.inviteCode, displayName: "虚构产品经理", password: "Product#Pass2026" }, key: "pm-redeem" }),
      viewer = await publicRequest(base, "/auth/redeem", { body: { inviteCode: viewerInvite.body.inviteCode, displayName: "虚构查看者", password: "Viewer#Pass2026" }, key: "viewer-redeem" });
    const created = await publicRequest(base, "/agent/intents", { body: { message: "理解虚构持仓并设计报表" }, cookie: pm.cookie, csrf: pm.body.csrfToken, key: "pm-intent" });
    assert.equal(created.status, 202);
    const pmTasks = await waitFor(
      () => publicRequest(base, "/agent/intents", { cookie: pm.cookie }).then((value) => value.body),
      (value) => value.length === 1 && value[0].status === "SUCCEEDED",
    );
    assert.equal(pmTasks[0].submittedBy, undefined);
    assert.equal(pmTasks[0].message, undefined);
    const handoff = await publicRequest(
      base,
      `/agent/intents/${pmTasks[0].id}/handoffs`,
      { body: { destinationId: "reports" }, cookie: pm.cookie, csrf: pm.body.csrfToken, key: "pm-handoff" },
    );
    assert.equal(handoff.status, 201);
    assert.equal(handoff.body.execution, "NO_EXECUTION");
    assert.equal(handoff.body.submittedBy, undefined);
    const handoffReplay = await publicRequest(
      base,
      `/agent/intents/${pmTasks[0].id}/handoffs`,
      { body: { destinationId: "reports" }, cookie: pm.cookie, csrf: pm.body.csrfToken, key: "pm-handoff-retry" },
    );
    assert.equal(handoffReplay.status, 200);
    assert.equal(handoffReplay.body.id, handoff.body.id);
    assert.equal(store.list("report_agent_plan", PROJECT).length, 0);
    assert.equal(
      (await publicRequest(base, `/agent/intents/${pmTasks[0].id}/handoffs`, { cookie: pm.cookie })).body.length,
      1,
    );
    const trace = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/trace`, { cookie: pm.cookie });
    assert.equal(trace.status, 200);
    assert.deepEqual(trace.body.map((item) => item.kind), ["MODEL_ROUTE", "SPECIALIST_HANDOFF"]);
    assert.equal(JSON.stringify(trace.body).includes("理解虚构持仓并设计报表"), false);
    assert.deepEqual(
      (await publicRequest(base, `/agent/intents/${pmTasks[0].id}/approvals`, { cookie: pm.cookie })).body,
      [],
    );
    assert.deepEqual((await publicRequest(base, "/agent/intents", { cookie: viewer.cookie })).body, []);
    const forbiddenHandoffRead = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/handoffs`, { cookie: viewer.cookie });
    assert.equal(forbiddenHandoffRead.status, 403);
    const forbiddenTraceRead = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/trace`, { cookie: viewer.cookie });
    assert.equal(forbiddenTraceRead.status, 403);
    const forbiddenApprovalRead = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/approvals`, { cookie: viewer.cookie });
    assert.equal(forbiddenApprovalRead.status, 403);
    const forbiddenGraphRead = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/graph`, { cookie: viewer.cookie });
    assert.equal(forbiddenGraphRead.status, 403);
    const forbiddenCancel = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/cancel`, { body: {}, cookie: viewer.cookie, csrf: viewer.body.csrfToken, key: "viewer-cancel-intent" });
    assert.equal(forbiddenCancel.status, 403);
    const forbidden = await publicRequest(base, "/agent/intents", { body: { message: "查看者不能调用模型" }, cookie: viewer.cookie, csrf: viewer.body.csrfToken, key: "viewer-intent" });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, "PROJECT_PERMISSION_DENIED");
    assert.equal((await publicRequest(base, "/agent/intents", { cookie: admin.cookie })).body.length, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
