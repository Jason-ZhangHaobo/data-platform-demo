import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import {
  publicAgentIntentDestinations,
  validateAgentIntentMessage,
  validateAgentIntentRoute,
} from "../../src/v2/agent-router.mjs";

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
    const createdResponse = await fetch(base + "/agent/intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": "agent-router-test",
        },
        body: JSON.stringify({ message: "理解持仓字段后生成财富分析报表" }),
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
    assert.equal(completed.fullLifecycleE2E, false);
    assert.equal(completed.message, undefined);
    assert.equal(typeof completed.messageHash, "string");
    assert.equal(store.get("agent_intent", created.id, PROJECT).message, undefined);
    assert.equal(store.list("report_agent_plan", PROJECT).length, 0);
    assert.equal(store.list("report", PROJECT).length, 0);
  } finally {
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
    assert.equal(store.list("report_agent_plan", PROJECT).length, 0);
    assert.equal(
      (await publicRequest(base, `/agent/intents/${pmTasks[0].id}/handoffs`, { cookie: pm.cookie })).body.length,
      1,
    );
    const trace = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/trace`, { cookie: pm.cookie });
    assert.equal(trace.status, 200);
    assert.deepEqual(trace.body.map((item) => item.kind), ["MODEL_ROUTE", "SPECIALIST_HANDOFF"]);
    assert.equal(JSON.stringify(trace.body).includes("理解虚构持仓并设计报表"), false);
    assert.deepEqual((await publicRequest(base, "/agent/intents", { cookie: viewer.cookie })).body, []);
    const forbiddenHandoffRead = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/handoffs`, { cookie: viewer.cookie });
    assert.equal(forbiddenHandoffRead.status, 403);
    const forbiddenTraceRead = await publicRequest(base, `/agent/intents/${pmTasks[0].id}/trace`, { cookie: viewer.cookie });
    assert.equal(forbiddenTraceRead.status, 403);
    const forbidden = await publicRequest(base, "/agent/intents", { body: { message: "查看者不能调用模型" }, cookie: viewer.cookie, csrf: viewer.body.csrfToken, key: "viewer-intent" });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, "PROJECT_PERMISSION_DENIED");
    assert.equal((await publicRequest(base, "/agent/intents", { cookie: admin.cookie })).body.length, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
