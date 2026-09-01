import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApiController } from "../src/server/api-controller.mjs";
import { MemoryTaskStore } from "../src/server/repositories/memory-store.mjs";
import { createSeedState } from "../src/server/repositories/store.mjs";
import { ValidationError } from "../src/shared/validation.mjs";
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

  test("simulates a task run and records success", async () => {
    const { handle, store } = setup(createSeedState(), 0);
    const task = (await store.listTasks()).find((item) => item.enabled);
    const started = await handle({ method: "POST", pathname: `/api/tasks/${task.id}/run` });
    assert.equal(started.status, 200);
    assert.equal((await store.getTask(task.id)).status, "SUCCESS");
    assert.equal((await store.listRuns(task.id))[0].status, "SUCCESS");
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
    const handle = createApiController({ store, accessToken: "demo-secret", environment: "staging" });
    const denied = await handle({ method: "GET", pathname: "/api/tasks" });
    const allowed = await handle({ method: "GET", pathname: "/api/tasks", headers: { authorization: "Bearer demo-secret" } });
    const health = await handle({ method: "GET", pathname: "/api/health" });
    assert.equal(denied.status, 401);
    assert.equal(allowed.status, 200);
    assert.equal(health.status, 200);
  });
});
