import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApiController } from "../src/server/api-controller.mjs";
import { MemoryTaskStore } from "../src/server/repositories/memory-store.mjs";
import { createSeedState } from "../src/server/repositories/store.mjs";
import { ValidationError } from "../src/shared/validation.mjs";

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
    assert.equal(started.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
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
});
