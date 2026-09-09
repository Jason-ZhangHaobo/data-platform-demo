import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApiController } from "../src/server/api-controller.mjs";
import { MemoryTaskStore } from "../src/server/repositories/memory-store.mjs";
import { createSeedState } from "../src/server/repositories/store.mjs";
import { ValidationError, maskValue } from "../src/shared/validation.mjs";
import { OssTaskStore, StorageConflictError, createOssRequest } from "../src/server/repositories/oss-store.mjs";

const setup = (state = createSeedState(), simulationDelayMs = 1_200) => {
  const store = new MemoryTaskStore(state);
  return { store, handle: createApiController({ store, simulationDelayMs, environment: "test" }) };
};

describe("data platform API controller", () => {
  test("returns seeded tasks and summary", async () => {
    const { handle } = setup();
    const tasks = await handle({ method: "GET", pathname: "/api/tasks" });
    const summary = await handle({ method: "GET", pathname: "/api/summary" });
    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.length, 3);
    assert.equal(summary.body.totalTasks, 3);
    assert.equal(summary.body.enabledTasks, 2);
  });

  test("creates and validates a sync task", async () => {
    const { handle } = setup({ tasks: [], runs: [] });
    const task = { name: "会员增量同步", description: "测试任务", sourceType: "MySQL", sourceName: "demo.member", targetType: "PostgreSQL", targetName: "demo_dw.dim_member", syncMode: "INCREMENTAL", schedule: "每小时", owner: "产品体验组", enabled: true };
    const created = await handle({ method: "POST", pathname: "/api/tasks", body: task });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "READY");
    await assert.rejects(() => handle({ method: "POST", pathname: "/api/tasks", body: { ...task, name: "" } }), ValidationError);
  });

  test("creates, validates, and simulates a data development job", async () => {
    const { handle } = setup();
    const created = await handle({ method: "POST", pathname: "/api/dev/jobs", body: { name: "会员画像 SQL", description: "聚合演示会员数据", jobType: "SQL", sql: "SELECT city, COUNT(*) FROM business_demo.customer_profile GROUP BY city LIMIT 1000;", schedule: "手动", owner: "数据开发组", enabled: true } });
    assert.equal(created.status, 201);
    const validated = await handle({ method: "POST", pathname: `/api/dev/jobs/${created.body.id}/validate` });
    assert.equal(validated.status, 200);
    assert.equal(validated.body.valid, true);
    const run = await handle({ method: "POST", pathname: `/api/dev/jobs/${created.body.id}/run` });
    assert.equal(run.status, 200);
    assert.equal(run.body.status, "SUCCESS");
    assert.equal(run.body.rowsAffected, 128);
  });

  test("warns on dangerous or unbounded SQL", async () => {
    const { handle } = setup();
    const created = await handle({ method: "POST", pathname: "/api/dev/jobs", body: { name: "危险 SQL", description: "", jobType: "SQL", sql: "DELETE FROM business_demo.customer_profile", schedule: "手动", owner: "测试组", enabled: true } });
    const validated = await handle({ method: "POST", pathname: `/api/dev/jobs/${created.body.id}/validate` });
    assert.equal(validated.status, 200);
    assert.match(validated.body.warnings.join(" "), /WHERE/);
  });

  test("manages securities masking rules and records previews", async () => {
    const { handle } = setup();
    const rules = await handle({ method: "GET", pathname: "/api/masking/rules" });
    assert.equal(rules.status, 200);
    assert.equal(rules.body.length, 3);
    const phoneRule = rules.body.find((rule) => rule.strategy === "PHONE");
    const preview = await handle({ method: "POST", pathname: `/api/masking/rules/${phoneRule.id}/preview`, body: { value: "13812348000", operator: "测试用户" } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.output, "138****8000");
    assert.equal(preview.body.operator, "测试用户");
    const history = await handle({ method: "GET", pathname: `/api/masking/rules/${phoneRule.id}/preview` });
    assert.equal(history.body.length, 1);
    const disabled = await handle({ method: "POST", pathname: `/api/masking/rules/${phoneRule.id}/toggle` });
    assert.equal(disabled.body.enabled, false);
    const disabledPreview = await handle({ method: "POST", pathname: `/api/masking/rules/${phoneRule.id}/preview`, body: { value: "13812348000" } });
    assert.equal(disabledPreview.body.output, "13812348000");
    assert.equal(maskValue("SECURITY_ACCOUNT", "SEC-DEMO-0001234"), "SEC*********1234");
    await assert.rejects(() => handle({ method: "POST", pathname: "/api/masking/rules", body: { name: "非法规则", description: "", fieldName: "x", strategy: "RAW", sampleValue: "demo", owner: "测试组", enabled: true } }), ValidationError);
  });

  test("searches securities assets and returns field lineage context", async () => {
    const { handle } = setup();
    const assets = await handle({ method: "GET", pathname: "/api/assets" });
    assert.equal(assets.status, 200);
    assert.equal(assets.body.length, 5);
    const search = await handle({ method: "GET", pathname: "/api/assets", query: new URLSearchParams("q=持仓") });
    assert.equal(search.body.length, 1);
    assert.equal(search.body[0].physicalName, "dws_position_snapshot");
    const detail = await handle({ method: "GET", pathname: `/api/assets/${search.body[0].id}` });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.fields.some((field) => field.name === "market_value"), true);
    assert.equal(detail.body.upstream.includes("dwd_order_trade"), true);
    await assert.rejects(() => handle({ method: "POST", pathname: "/api/assets", body: { name: "无效资产", physicalName: "demo_invalid", assetType: "TABLE", layer: "ODS", domain: "交易", owner: "测试组", sensitivity: "PUBLIC", description: "", tags: [], fields: [], upstream: [] } }), ValidationError);
  });

  test("checks securities access and records allow or deny audit", async () => {
    const { handle } = setup();
    const users = await handle({ method: "GET", pathname: "/api/security/users" });
    const analyst = users.body.find((user) => user.id === "user-investor-analyst");
    const denied = await handle({ method: "POST", pathname: "/api/security/access-check", body: { userId: analyst.id, permission: "asset.restricted.read", sensitivity: "RESTRICTED", resourceType: "asset" } });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.allowed, false);
    const engineer = users.body.find((user) => user.id === "user-data-engineer");
    const allowed = await handle({ method: "POST", pathname: "/api/security/access-check", body: { userId: engineer.id, permission: "asset.sensitive.read", sensitivity: "SENSITIVE", resourceType: "asset" } });
    assert.equal(allowed.body.allowed, true);
    const audit = await handle({ method: "GET", pathname: "/api/security/audit", query: new URLSearchParams("result=DENY") });
    assert.equal(audit.body.some((item) => item.actorId === analyst.id), true);
    await assert.rejects(() => handle({ method: "POST", pathname: "/api/security/access-check", body: { userId: analyst.id, permission: "root", sensitivity: "RESTRICTED" } }), ValidationError);
  });

  test("plans and confirms Data Agent cross-module actions", async () => {
    const { handle } = setup();
    const planned = await handle({ method: "POST", pathname: "/api/agent/plan", body: { userId: "user-platform-admin", message: "帮我把虚构投资者持仓 CSV 增量同步到 MySQL 持仓表，每个工作日凌晨 2 点执行。" } });
    assert.equal(planned.status, 201);
    assert.equal(planned.body.intent, "SYNC_TASK");
    assert.equal(planned.body.questions.length, 0);
    const confirmed = await handle({ method: "POST", pathname: `/api/agent/plans/${planned.body.id}/confirm`, body: { planId: planned.body.id, userId: "user-platform-admin" } });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, "COMPLETED");
    assert.equal(confirmed.body.execution.name, "投资者持仓同步");
    const assetPlan = await handle({ method: "POST", pathname: "/api/agent/plan", body: { userId: "user-investor-analyst", message: "帮我找出投资者持仓相关的数据资产" } });
    assert.equal(assetPlan.body.intent, "ASSET_SEARCH");
    const assetResult = await handle({ method: "POST", pathname: `/api/agent/plans/${assetPlan.body.id}/confirm`, body: { planId: assetPlan.body.id, userId: "user-investor-analyst" } });
    assert.equal(assetResult.body.execution.length, 1);
    const unknown = await handle({ method: "POST", pathname: "/api/agent/plan", body: { userId: "user-platform-admin", message: "帮我做一个事情" } });
    assert.equal(unknown.body.intent, "UNKNOWN");
    const blocked = await handle({ method: "POST", pathname: `/api/agent/plans/${unknown.body.id}/confirm`, body: { planId: unknown.body.id, userId: "user-platform-admin" } });
    assert.equal(blocked.status, 409);
  });

  test("plans a wealth advisor holdings report with Spark SQL artifacts", async () => {
    const { handle } = setup();
    const planned = await handle({ method: "POST", pathname: "/api/agent/plan", body: { userId: "user-platform-admin", message: "财富顾问查询客户持仓，生成客户总资产、持仓市值、证券数量、资产类别和行业分布报表。" } });
    assert.equal(planned.body.intent, "HOLDINGS_REPORT");
    assert.equal(planned.body.draft.engine, "SPARK_SQL");
    assert.equal(planned.body.draft.permissionScope, "OWN_CLIENTS_ONLY");
    assert.match(planned.body.draft.sql, /dws_position_snapshot/);
    assert.equal(planned.body.draft.reportSpec.metrics.length, 5);
    const confirmed = await handle({ method: "POST", pathname: `/api/agent/plans/${planned.body.id}/confirm`, body: { planId: planned.body.id, userId: "user-platform-admin", draft: { sql: planned.body.draft.sql } } });
    assert.equal(confirmed.body.status, "COMPLETED");
    assert.equal(confirmed.body.execution.type, "HOLDINGS_REPORT");
    assert.equal(confirmed.body.execution.devJob.enabled, false);
    assert.equal(confirmed.body.execution.artifacts.deploymentConfig.platform, "aliyun-dataworks-emr");
  });

  test("runs securities data quality rules and returns operations history", async () => {
    const { handle } = setup();
    const rules = await handle({ method: "GET", pathname: "/api/quality/rules" });
    assert.equal(rules.status, 200);
    assert.equal(rules.body.length, 3);
    const freshness = rules.body.find((rule) => rule.ruleType === "FRESHNESS");
    const run = await handle({ method: "POST", pathname: `/api/quality/rules/${freshness.id}/run` });
    assert.equal(run.status, 200);
    assert.equal(run.body.status, "WARN");
    assert.equal(run.body.score, 92);
    const history = await handle({ method: "GET", pathname: `/api/quality/rules/${freshness.id}/runs` });
    assert.equal(history.body.length, 1);
    const summary = await handle({ method: "GET", pathname: "/api/quality/summary" });
    assert.equal(summary.body.warnRules, 1);
  });

  test("returns a scoped holdings report preview", async () => {
    const { handle } = setup();
    const report = await handle({ method: "GET", pathname: "/api/reports/holdings" });
    assert.equal(report.status, 200);
    assert.equal(report.body.scope, "OWN_CLIENTS_ONLY");
    assert.equal(report.body.metrics.securityCount, 8);
    assert.equal(report.body.assetClassDistribution.length, 3);
    assert.equal(report.body.industryDistribution.length, 4);
  });

  test("backfills data development state for legacy stores", async () => {
    const seed = createSeedState();
    const store = new MemoryTaskStore({ tasks: seed.tasks, runs: seed.runs });
    assert.equal((await store.listDevJobs()).length, 1);
    assert.deepEqual(await store.listDevRuns(), []);
  });

  test("simulates a task run and records success", async () => {
    const { handle, store } = setup(createSeedState(), 0);
    const task = (await store.listTasks()).find((item) => item.enabled);
    const started = await handle({ method: "POST", pathname: `/api/tasks/${task.id}/run` });
    assert.equal(started.status, 200);
    assert.equal((await store.getTask(task.id)).status, "SUCCESS");
    assert.equal((await store.listRuns(task.id))[0].status, "SUCCESS");
  });

  test("runs a CSV to MySQL task through the real sync service when enabled", async () => {
    const state = createSeedState();
    const task = state.tasks.find((item) => item.sourceType === "CSV");
    task.enabled = true;
    task.status = "READY";
    const store = new MemoryTaskStore(state);
    const handle = createApiController({
      store,
      realSyncEnabled: true,
      syncService: { runTask: async () => ({ rowsRead: 2, rowsWritten: 2, message: "真实 CSV 已写入 MySQL 表 business_demo.demo_supplier。" }) },
      environment: "test",
    });
    const response = await handle({ method: "POST", pathname: `/api/tasks/${task.id}/run` });
    assert.equal(response.status, 200);
    assert.equal(response.body.rowsWritten, 2);
    assert.equal(response.body.status, "SUCCESS");
  });

  test("rejects a run for a disabled task", async () => {
    const { handle, store } = setup();
    const task = (await store.listTasks()).find((item) => !item.enabled);
    const response = await handle({ method: "POST", pathname: `/api/tasks/${task.id}/run` });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /启用/);
  });

  test("persists task state through the OSS adapter", async () => {
    let stored;
    let authorization;
    let etag = '"version-0"';
    const fakeFetch = async (_url, options) => {
      authorization = options.headers.Authorization;
      if (options.method === "GET" && stored === undefined) return new Response("", { status: 404 });
      if (options.method === "GET") return Response.json(JSON.parse(stored), { headers: { ETag: etag } });
      if (options.headers["If-Match"] && options.headers["If-Match"] !== etag) return new Response("", { status: 412 });
      stored = options.body;
      etag = `"version-${Number(etag.match(/\d+/)?.[0] ?? 0) + 1}"`;
      return new Response("", { status: 200, headers: { ETag: etag } });
    };
    const config = {
      bucket: "demo-bucket",
      endpoint: "oss-cn-hangzhou-internal.aliyuncs.com",
      key: "staging/store.json",
      credentials: { accessKeyId: "temporary-id", accessKeySecret: "temporary-secret", securityToken: "temporary-token" },
    };
    const store = await OssTaskStore.open(config, fakeFetch);
    await store.createTask({ name: "OSS 持久化测试", description: "", sourceType: "CSV", sourceName: "demo.csv", targetType: "MySQL", targetName: "demo.target", syncMode: "FULL", schedule: "手动", owner: "测试组", enabled: true });
    const reopened = await OssTaskStore.open(config, fakeFetch);
    assert.equal((await reopened.listTasks()).length, 4);
    assert.match(authorization, /^OSS temporary-id:/);
    const signed = createOssRequest({ ...config, method: "GET" });
    assert.match(signed.stringToSign, /x-oss-security-token:temporary-token/);
  });

  test("rejects a stale OSS write instead of overwriting newer data", async () => {
    let stored = JSON.stringify(createSeedState());
    let etag = '"version-1"';
    const fakeFetch = async (_url, options) => {
      if (options.method === "GET") return Response.json(JSON.parse(stored), { headers: { ETag: etag } });
      if (options.headers["If-Match"] !== etag) return new Response("", { status: 412 });
      stored = options.body;
      etag = '"version-2"';
      return new Response("", { status: 200, headers: { ETag: etag } });
    };
    const config = { bucket: "demo-bucket", endpoint: "oss-cn-hangzhou-internal.aliyuncs.com", key: "store.json", credentials: { accessKeyId: "id", accessKeySecret: "secret", securityToken: "token" } };
    const first = await OssTaskStore.open(config, fakeFetch);
    const stale = await OssTaskStore.open(config, fakeFetch);
    await first.createTask({ name: "第一次更新", description: "", sourceType: "CSV", sourceName: "a.csv", targetType: "MySQL", targetName: "demo.a", syncMode: "FULL", schedule: "手动", owner: "测试组", enabled: true });
    await assert.rejects(() => stale.persist(), StorageConflictError);
  });

  test("protects cloud APIs with an access token", async () => {
    const store = new MemoryTaskStore(createSeedState());
    const handle = createApiController({ store, accessToken: "demo-secret", requireAccessToken: true, environment: "staging" });
    const denied = await handle({ method: "GET", pathname: "/api/tasks" });
    const allowed = await handle({ method: "GET", pathname: "/api/tasks", headers: { authorization: "Bearer demo-secret" } });
    const health = await handle({ method: "GET", pathname: "/api/health" });
    assert.equal(denied.status, 401);
    assert.equal(allowed.status, 200);
    assert.equal(health.status, 200);
  });

  test("allows cloud APIs when access-token enforcement is disabled", async () => {
    const store = new MemoryTaskStore(createSeedState());
    const handle = createApiController({ store, accessToken: "demo-secret", requireAccessToken: false, environment: "staging" });
    const response = await handle({ method: "GET", pathname: "/api/tasks" });
    assert.equal(response.status, 200);
  });

  test("fails closed when staging requires a token but none is configured", async () => {
    const store = new MemoryTaskStore(createSeedState());
    const handle = createApiController({ store, environment: "staging", requireAccessToken: true });
    const response = await handle({ method: "GET", pathname: "/api/tasks" });
    const health = await handle({ method: "GET", pathname: "/api/health" });
    assert.equal(response.status, 503);
    assert.equal(health.status, 200);
  });
});
