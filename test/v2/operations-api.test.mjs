import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

async function request(base, path, body, key = "ops-api") {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuduo-Client": "workbench",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function waitForDiagnosis(base, id) {
  for (let index = 0; index < 100; index++) {
    const response = await request(base, `/operations/agent/diagnoses/${id}`);
    if (!["QUEUED", "RUNNING"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("运维Agent诊断未完成");
}

test("V2 operations API correlates incidents, verifies recovery and grounds Agent diagnosis", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-ops-api-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    failure = store.create("offline_sync_run", "project-securities-lab", {
      taskId: "sync-task-api",
      status: "FAILED",
      errorCode: "SOURCE_REVISION_STALE",
      error: "源版本已变化",
      actualExecution: true,
    });
  store.update("offline_sync_run", failure.id, "project-securities-lab", {
    createdAt: "2026-09-15T00:00:00.000Z",
  });
  let incidentId;
  const app = createV2Server({
    store,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
    opsPlanner: async ({ incidents }) => ({
      diagnosis: {
        incidentId: incidents[0].id,
        diagnosis: "任务绑定旧源版本，需要创建绑定新元数据的同步任务。",
        recommendedActions: ["核对当前源版本", "创建并验证新同步任务"],
        evidenceIds: [incidents[0].sourceId],
        confidence: 0.94,
      },
      model: "TEST_DOUBLE",
      usage: { total_tokens: 130 },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const refreshed = await request(base, "/operations/refresh", {}, "ops-refresh");
    assert.equal(refreshed.body.created.length, 1);
    incidentId = refreshed.body.created[0].id;
    const overview = await request(base, "/operations/overview");
    assert.equal(overview.body.health, "DEGRADED");
    assert.equal(overview.body.counts.open, 1);
    const acknowledged = await request(
      base,
      `/operations/incidents/${incidentId}/acknowledge`,
      { actor: "local-operator", note: "已确认，等待新同步批次" },
      "ops-ack",
    );
    assert.equal(acknowledged.body.status, "ACKNOWLEDGED");

    const started = await request(
        base,
        "/operations/agent/diagnoses",
        { message: "诊断当前离线同步事故并引用证据" },
        "ops-agent",
      ),
      completed = await waitForDiagnosis(base, started.body.id);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.completionScope, "OPS_DIAGNOSIS");
    assert.equal(completed.diagnosis.executable, false);
    assert.equal(completed.diagnosis.incidentId, incidentId);

    const success = store.create("offline_sync_run", "project-securities-lab", {
      taskId: "sync-task-api",
      status: "SUCCEEDED",
      actualExecution: true,
    });
    store.update("offline_sync_run", success.id, "project-securities-lab", {
      createdAt: "2026-09-15T00:00:03.000Z",
    });
    const resolved = await request(
      base,
      `/operations/incidents/${incidentId}/resolve`,
      {
        actor: "local-operator",
        evidenceKind: "offline_sync_run",
        evidenceId: success.id,
        note: "同一任务新批次已成功",
      },
      "ops-resolve",
    );
    assert.equal(resolved.body.status, "RESOLVED");
    assert.equal(resolved.body.recoveryId, success.id);
    assert.equal((await request(base, "/operations/overview")).body.health, "HEALTHY");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("operations context cannot reach an external model without explicit opt-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-ops-privacy-api-")),
    store = new MetadataStore(join(root, "platform.sqlite"));
  store.create("offline_sync_run", "project-securities-lab", {
    taskId: "privacy-task",
    status: "FAILED",
    errorCode: "SOURCE_REVISION_STALE",
    error: "源版本已变化",
  });
  const app = createV2Server({
    store,
    env: {
      V2_LOCAL_DEVELOPMENT: "true",
      DASHSCOPE_API_KEY: "sk-must-not-be-called",
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    await request(base, "/operations/refresh", {}, "privacy-refresh");
    const overview = await request(base, "/operations/overview"),
      diagnosis = await request(
        base,
        "/operations/agent/diagnoses",
        { message: "诊断当前事故" },
        "privacy-diagnosis",
      );
    assert.equal(overview.body.externalModelContextAllowed, false);
    assert.equal(diagnosis.status, 412);
    assert.match(diagnosis.body.message, /默认禁止发送到外部模型/);
    assert.equal(
      store.list("ops_agent_diagnosis", "project-securities-lab").length,
      0,
    );
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
