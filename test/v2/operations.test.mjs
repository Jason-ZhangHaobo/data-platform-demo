import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { OperationsManager } from "../../src/v2/operations.mjs";
import { generateOpsDiagnosis } from "../../src/v2/model.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-ops-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    operations = new OperationsManager({ store, project: PROJECT });
  return { store, operations, close: () => store.close() };
}

test("operations refresh correlates real failures and automatic recovery evidence", () => {
  const app = setup();
  try {
    const streamFailure = app.store.create("stream_run", PROJECT, {
        jobId: "stream-job-1",
        status: "FAILED",
        errorCode: "INVALID_QUOTE_PRICE",
        error: "行情价格不合法",
        actualExecution: true,
      }),
      streamRecovery = app.store.create("stream_run", PROJECT, {
        jobId: "stream-job-1",
        status: "SUCCEEDED",
        actualExecution: true,
      });
    app.store.create("stream_alert", PROJECT, {
      jobId: "stream-job-1",
      runId: streamFailure.id,
      status: "RESOLVED",
      recoveryRunId: streamRecovery.id,
      resolvedAt: "2026-09-15T00:00:02.000Z",
    });
    const offlineFailure = app.store.create("offline_sync_run", PROJECT, {
      taskId: "sync-task-1",
      status: "FAILED",
      errorCode: "SOURCE_REVISION_STALE",
      error: "源版本已变化",
      actualExecution: true,
    });
    const refreshed = app.operations.refresh();
    assert.equal(refreshed.created.length, 2);
    const incidents = app.operations.listIncidents(),
      stream = incidents.find((incident) => incident.sourceId === streamFailure.id),
      offline = incidents.find((incident) => incident.sourceId === offlineFailure.id);
    assert.equal(stream.status, "RESOLVED");
    assert.equal(stream.recoveryId, streamRecovery.id);
    assert.equal(offline.status, "OPEN");
    assert.equal(app.operations.overview().health, "DEGRADED");
    assert.equal(app.operations.overview().counts.resolved, 1);
  } finally {
    app.close();
  }
});

test("incident acknowledgement and resolution require later same-resource evidence", () => {
  const app = setup();
  try {
    const failure = app.store.create("offline_sync_run", PROJECT, {
      taskId: "sync-task-2",
      status: "FAILED",
      errorCode: "SYNC_FAILED",
      error: "受控同步失败",
      actualExecution: true,
    });
    app.store.update("offline_sync_run", failure.id, PROJECT, {
      createdAt: "2026-09-15T00:00:00.000Z",
    });
    app.operations.refresh();
    const incident = app.operations.listIncidents()[0],
      acknowledged = app.operations.acknowledge(incident.id, {
        actor: "local-operator",
        note: "已确认失败，等待新批次证据",
      });
    assert.equal(acknowledged.status, "ACKNOWLEDGED");
    const unrelated = app.store.create("offline_sync_run", PROJECT, {
      taskId: "other-task",
      status: "SUCCEEDED",
      actualExecution: true,
    });
    app.store.update("offline_sync_run", unrelated.id, PROJECT, {
      createdAt: "2026-09-15T00:00:02.000Z",
    });
    assert.throws(
      () =>
        app.operations.resolve(incident.id, {
          evidenceKind: "offline_sync_run",
          evidenceId: unrelated.id,
          actor: "local-operator",
          note: "错误资源不能解除",
        }),
      { status: 409, code: "RECOVERY_EVIDENCE_MISMATCH" },
    );
    const success = app.store.create("offline_sync_run", PROJECT, {
      taskId: "sync-task-2",
      status: "SUCCEEDED",
      actualExecution: true,
    });
    app.store.update("offline_sync_run", success.id, PROJECT, {
      createdAt: "2026-09-15T00:00:03.000Z",
    });
    const resolved = app.operations.resolve(incident.id, {
      evidenceKind: "offline_sync_run",
      evidenceId: success.id,
      actor: "local-operator",
      note: "同任务新批次已经成功",
    });
    assert.equal(resolved.status, "RESOLVED");
    assert.equal(resolved.recoveryId, success.id);
    assert.equal(resolved.acknowledgements.length, 2);
  } finally {
    app.close();
  }
});

test("operations Agent diagnosis can cite only incident evidence", () => {
  const app = setup();
  try {
    const failure = app.store.create("offline_sync_run", PROJECT, {
      taskId: "sync-task-3",
      status: "FAILED",
      errorCode: "SOURCE_REVISION_STALE",
      error: "源版本已变化",
    });
    app.operations.refresh();
    const incident = app.operations.listIncidents()[0],
      diagnosis = app.operations.validateAgentDiagnosis({
        incidentId: incident.id,
        diagnosis: "同步任务仍绑定旧源版本，需要基于新元数据创建新任务。",
        recommendedActions: ["核对当前源版本", "创建并验证新同步任务"],
        evidenceIds: [failure.id],
        confidence: 0.95,
      });
    assert.equal(diagnosis.executable, false);
    assert.equal(diagnosis.requiresHumanApproval, true);
    assert.throws(
      () =>
        app.operations.validateAgentDiagnosis({
          incidentId: incident.id,
          diagnosis: "虚构诊断",
          recommendedActions: ["执行"],
          evidenceIds: ["unknown-evidence"],
          confidence: 1,
        }),
      { status: 422, code: "UNKNOWN_OPS_EVIDENCE" },
    );
  } finally {
    app.close();
  }
});

test("operations model adapter never receives raw logs or business rows", async () => {
  let requestBody;
  const generated = await generateOpsDiagnosis(
    {
      message: "诊断同步事故",
      health: "DEGRADED",
      domainCounts: { 离线同步: { failures: 1, running: 0, succeeded: 0 } },
      incidents: [
        {
          id: "incident-id",
          domain: "离线同步",
          title: "离线同步运行失败",
          status: "OPEN",
          severity: "MEDIUM",
          errorCode: "SOURCE_REVISION_STALE",
          message: "源版本已变化",
          sourceKind: "offline_sync_run",
          sourceId: "failure-id",
          rawLog: "CLIENT-SHOULD-NOT-LEAK",
          rows: [{ client_id: "CLIENT-SHOULD-NOT-LEAK" }],
        },
      ],
    },
    { DASHSCOPE_API_KEY: "sk-test", V2_MODEL: "test-model" },
    async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  incidentId: "incident-1",
                  diagnosis: "任务绑定的源版本已过期。",
                  recommendedActions: ["核对新元数据", "创建新任务"],
                  evidenceIds: ["evidence-1-failure"],
                  confidence: 0.9,
                }),
              },
            },
          ],
          usage: { total_tokens: 220 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const sent = requestBody.messages[1].content;
  assert.match(sent, /SOURCE_REVISION_STALE|incident-1/);
  assert.doesNotMatch(
    sent,
    /CLIENT-SHOULD-NOT-LEAK|incident-id|failure-id|源版本已变化/,
  );
  assert.equal(generated.diagnosis.incidentId, "incident-id");
  assert.deepEqual(generated.diagnosis.evidenceIds, ["failure-id"]);
});
