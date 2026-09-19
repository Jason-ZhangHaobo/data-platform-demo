import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";

const cases = [
  { name: "ingestion", createPath: "/sync/agent/plans", kind: "ingestion_agent_plan", option: "ingestionPlanner" },
  { name: "realtime", createPath: "/streams/agent/plans", kind: "realtime_agent_plan", option: "realtimePlanner" },
  { name: "assets", createPath: "/assets/agent/tasks", kind: "asset_agent_task", option: "assetPlanner" },
  { name: "quality", createPath: "/quality/agent/plans", kind: "quality_agent_plan", option: "qualityPlanner" },
  { name: "security", createPath: "/security/agent/plans", kind: "security_agent_plan", option: "securityPlanner" },
  { name: "reports", createPath: "/reports/agent/plans", kind: "report_agent_plan", option: "reportPlanner" },
  { name: "services", createPath: "/data-services/agent/plans", kind: "service_agent_plan", option: "servicePlanner" },
  { name: "operations", createPath: "/operations/agent/diagnoses", kind: "ops_agent_diagnosis", option: "opsPlanner" },
];

async function waitFor(getValue, predicate) {
  for (let index = 0; index < 80; index += 1) {
    const value = await getValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("specialist task did not reach expected state");
}

async function request(base, path, options = {}) {
  const response = await fetch(base + path, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuduo-Client": "workbench",
      "Idempotency-Key": options.key ?? "specialist-cancel-race",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

test("late specialist model responses cannot overwrite cancellation across all professional domains", async () => {
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), `shuduo-${item.name}-cancel-`)),
      store = new MetadataStore(join(root, "platform.sqlite"));
    if (item.name === "operations")
      store.create("ops_incident", PROJECT, {
        domain: "QUALITY",
        title: "虚构证券质量事故",
        status: "OPEN",
        severity: "MEDIUM",
        errorCode: "SYNTHETIC_FAILURE",
        message: "虚构聚合错误摘要",
        sourceKind: "quality_run",
        sourceId: "synthetic-quality-run",
        resourceType: "quality_rule",
        resourceId: "synthetic-quality-rule",
        sourceCreatedAt: new Date().toISOString(),
      });
    let releasePlanner;
    const gate = new Promise((resolve) => {
        releasePlanner = resolve;
      }),
      planner = async () => {
        await gate;
        return {};
      },
      app = createV2Server({
        root,
        store,
        [item.option]: planner,
        env: {
          V2_LOCAL_DEVELOPMENT: "true",
          V2_ALLOW_EXTERNAL_OPS_CONTEXT: "true",
        },
      });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
    try {
      const created = await request(base, item.createPath, {
        key: `${item.name}-create`,
        body: { message: `为虚构证券数据创建${item.name}专业方案` },
      });
      assert.equal(created.status, 202, item.name);
      const id = created.body.id,
        detailPath = `${item.createPath}/${id}`;
      await waitFor(
        () => request(base, detailPath).then((value) => value.body),
        (value) => value.status === "RUNNING",
      );
      const cancelled = await request(base, `${detailPath}/cancel`, {
        key: `${item.name}-cancel`,
        body: {},
      });
      assert.equal(cancelled.status, 200, item.name);
      assert.equal(cancelled.body.status, "CANCELLED", item.name);
      releasePlanner();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const final = store.get(item.kind, id, PROJECT);
      assert.equal(final.status, "CANCELLED", item.name);
      assert.equal(final.proposal, undefined, item.name);
      assert.equal(final.insight, undefined, item.name);
      assert.equal(final.diagnosis, undefined, item.name);
    } finally {
      releasePlanner?.();
      await new Promise((resolve) => app.server.close(resolve));
      store.close();
    }
  }
});

test("late SQL development model response cannot create code or Spark evidence after cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-development-cancel-")),
    store = new MetadataStore(join(root, "platform.sqlite"));
  let releaseGenerator;
  const gate = new Promise((resolve) => {
      releaseGenerator = resolve;
    }),
    app = createV2Server({
      root,
      store,
      generator: async () => {
        await gate;
        return {
          sql: "SELECT 1",
          model: "LATE_TEST_MODEL",
          usage: { total_tokens: 1 },
        };
      },
      runner: async () => assert.fail("cancelled development must not start Spark"),
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const created = await request(base, "/agent/tasks", {
      key: "development-cancel-create",
      body: {
        message: "为虚构证券资产生成SQL",
        contextId: "holdings-t1",
        sql: "SELECT 1",
      },
    });
    assert.equal(created.status, 202);
    const id = created.body.id;
    await waitFor(
      () => request(base, `/agent/tasks/${id}`).then((value) => value.body),
      (value) => value.status === "RUNNING",
    );
    const cancelled = await request(base, `/agent/tasks/${id}/cancel`, {
      key: "development-cancel-now",
      body: {},
    });
    assert.equal(cancelled.body.status, "CANCELLED");
    releaseGenerator();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const final = store.get("agent", id, PROJECT);
    assert.equal(final.status, "CANCELLED");
    assert.deepEqual(final.attempts, []);
    assert.equal(final.revisionId, undefined);
    assert.equal(store.list("run", PROJECT).length, 0);
  } finally {
    releaseGenerator?.();
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
