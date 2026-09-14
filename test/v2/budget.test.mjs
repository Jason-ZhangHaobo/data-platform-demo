import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BudgetManager } from "../../src/v2/budget.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { referenceSql } from "../../src/v2/context.mjs";
import { runV2Cli } from "../../bin/shuzhan.mjs";

const fixedNow = Date.parse("2026-09-15T04:00:00.000Z");

function setup(env = {}) {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-budget-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    budget = new BudgetManager({
      store,
      project: PROJECT,
      env,
      now: () => fixedNow,
    });
  return { root, store, budget, close: () => store.close() };
}

function current(store, kind, data) {
  const item = store.create(kind, PROJECT, data);
  return store.update(kind, item.id, PROJECT, {
    createdAt: "2026-09-15T01:00:00.000Z",
  });
}

test("monthly model estimate uses reported input/output tokens and conservative fallback", () => {
  const app = setup();
  try {
    current(app.store, "service_agent_plan", {
      mode: "LIVE_MODEL",
      model: "qwen3-coder-plus",
      usage: {
        prompt_tokens: 30_000,
        completion_tokens: 1_000,
        total_tokens: 31_000,
      },
    });
    current(app.store, "quality_agent_plan", {
      mode: "LIVE_MODEL",
      model: "qwen3-coder-plus",
      usage: {},
    });
    const status = app.budget.overview();
    assert.equal(status.month, "2026-09");
    assert.equal(status.model.recordedCalls, 2);
    assert.equal(status.model.estimatedCostCny, 0.648);
    assert.equal(status.account.source, "NOT_CONNECTED");
    assert.match(status.scope, /不能证明全站费用/);
  } finally {
    app.close();
  }
});

test("model and account budget guards fail before another paid request", () => {
  const model = setup({ V2_MODEL_MONTHLY_BUDGET_CNY: "0.6" });
  try {
    current(model.store, "report_agent_plan", {
      mode: "LIVE_MODEL",
      model: "qwen3-coder-plus",
      usage: { total_tokens: 10_000 },
    });
    assert.throws(() => model.budget.assertCanStartModel(), {
      status: 429,
      code: "MONTHLY_MODEL_BUDGET_EXCEEDED",
    });
  } finally {
    model.close();
  }
  const account = setup({ V2_ACCOUNT_MONTHLY_SPEND_CNY: "200" });
  try {
    assert.throws(() => account.budget.assertCanStartModel(), {
      status: 429,
      code: "MONTHLY_HARD_BUDGET_EXCEEDED",
    });
  } finally {
    account.close();
  }
});

test("remote Spark guard uses both run count and actual seconds plus reservation", () => {
  const app = setup({
    V2_MONTHLY_REMOTE_SPARK_SECONDS_LIMIT: "45",
    V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: "5",
    V2_REMOTE_SPARK_RESERVATION_SECONDS: "30",
  });
  try {
    current(app.store, "run", {
      status: "SUCCEEDED",
      isolation: "FUNCTION_PROCESS",
      durationMs: 20_000,
    });
    const status = app.budget.overview();
    assert.equal(status.remoteSpark.runCount, 1);
    assert.equal(status.remoteSpark.seconds, 20);
    assert.throws(() => app.budget.assertCanStartRemoteSpark(), {
      status: 429,
      code: "MONTHLY_SPARK_BUDGET_EXCEEDED",
    });
  } finally {
    app.close();
  }
});

test("API rejects an Agent task before creation when the monthly model guard is closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-budget-api-")),
    store = new MetadataStore(join(root, "platform.sqlite"));
  current(store, "service_agent_plan", {
    mode: "LIVE_MODEL",
    model: "qwen3-coder-plus",
    usage: { total_tokens: 10_000 },
  });
  let generatorCalls = 0;
  const app = createV2Server({
    root,
    store,
    env: {
      V2_LOCAL_DEVELOPMENT: "true",
      V2_MODEL_MONTHLY_BUDGET_CNY: "0.6",
    },
    generator: async () => {
      generatorCalls++;
      throw new Error("不应调用模型");
    },
    runner: async () => {
      throw new Error("不应运行Spark");
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const status = await fetch(base + "/budget").then((response) => response.json());
    assert.equal(status.model.recordedCalls, 1);
    const cliRequests = [];
    assert.equal(
      await runV2Cli(["budget"], {}, {
        client: {
          request: async (path) => {
            cliRequests.push(path);
            return status;
          },
        },
        output: () => {},
        error: () => {},
      }),
      0,
    );
    assert.deepEqual(cliRequests, ["/budget"]);
    const response = await fetch(base + "/agent/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuzhan-Client": "workbench",
        "Idempotency-Key": "budget-blocked-agent",
      },
      body: JSON.stringify({
        message: "生成虚构客户资产任务",
        sql: referenceSql,
        contextId: "holdings-t1",
      }),
    });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "MONTHLY_MODEL_BUDGET_EXCEEDED");
    assert.equal(generatorCalls, 0);
    assert.equal(store.list("agent", PROJECT).length, 0);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
