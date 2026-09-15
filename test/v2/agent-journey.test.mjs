import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { PROJECT, createV2Server } from "../../src/v2/server.mjs";
import { agentEvidenceJourney } from "../../src/v2/agent-journey.mjs";
import { contextIds, referenceSql, validationContractId } from "../../src/v2/context.mjs";
import { createDeliveryPackage, sha256 } from "../../src/v2/delivery.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-agent-journey-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    revision = store.create("revision", PROJECT, {
      sql: referenceSql,
      hash: sha256(referenceSql),
      contextId: "holdings-t1",
      source: "LIVE_MODEL",
    }),
    run = store.create("run", PROJECT, {
      revisionId: revision.id,
      revisionHash: revision.hash,
      contextId: "holdings-t1",
      status: "SUCCEEDED",
      engine: "Apache Spark",
      engineVersion: "3.5.9",
      rows: [{ client_id: "CLIENT-SECRET", total_assets: "1000.00" }],
      error: "SECRET-ERROR-BUSINESS-ROW",
      validation: {
        passed: true,
        contractId: validationContractId,
        issues: [],
        regressions: contextIds.map((contextId) => ({ contextId, passed: true })),
      },
    }),
    task = store.create("agent", PROJECT, {
      message: "完成虚构证券客户T+1资产加工",
      contextId: "holdings-t1",
      status: "SUCCEEDED",
      mode: "LIVE_MODEL",
      completionScope: "SQL_DEVELOPMENT",
      fullLifecycleE2E: false,
      attempts: [{
        attempt: 1,
        runId: run.id,
        revisionId: revision.id,
        status: "SUCCEEDED",
        model: "qwen3-coder-plus",
      }],
    });
  return { store, revision, run, task, root, close: () => store.close() };
}

const statusOf = (value, id) => value.stages.find((item) => item.id === id).status;

test("Agent evidence journey separates model/Spark work from human release steps", () => {
  const app = setup();
  try {
    const initial = agentEvidenceJourney({ store: app.store, project: PROJECT, task: app.task });
    assert.equal(initial.stages.length, 7);
    assert.equal(statusOf(initial, "CODE"), "SUCCEEDED");
    assert.equal(statusOf(initial, "DEBUG"), "SUCCEEDED");
    assert.equal(statusOf(initial, "SCHEDULE_FILE"), "WAITING");
    assert.equal(initial.agentIndependentE2E, false);
    assert.equal(initial.localEvidenceComplete, false);
    const simulated = {
      ...app.task,
      attempts: [{ ...app.task.attempts[0], model: "TEST_DOUBLE" }],
    };
    const simulatedJourney = agentEvidenceJourney({ store: app.store, project: PROJECT, task: simulated });
    assert.equal(statusOf(simulatedJourney, "CODE"), "UNVERIFIED");
    assert.equal(statusOf(simulatedJourney, "DEBUG"), "UNVERIFIED");
    assert.equal(simulatedJourney.localEvidenceComplete, false);

    const bundle = createDeliveryPackage({ run: app.run, revision: app.revision }),
      delivery = app.store.create("delivery_package", PROJECT, {
        ...bundle,
        sourceRunId: app.run.id,
        agentDeliveryTaskId: "synthetic-delivery-task",
        stage: "M2A",
      }),
      rehearsal = app.store.create("delivery_verification", PROJECT, {
        packageId: delivery.id,
        packageDigest: delivery.digest,
        status: "SUCCEEDED",
        mode: "LOCAL_FILE_REHEARSAL",
        engine: "Apache Spark",
        mainSqlExecuted: true,
        testSqlValidation: { passed: true },
        validation: { passed: true },
        agentDeliveryTaskId: "synthetic-delivery-task",
      }),
      approval = app.store.create("release_approval", PROJECT, {
        packageId: delivery.id,
        packageDigest: delivery.digest,
        rehearsalId: rehearsal.id,
        status: "APPROVED",
      }),
      release = app.store.create("release", PROJECT, {
        packageId: delivery.id,
        packageDigest: delivery.digest,
        approvalId: approval.id,
        status: "ACTIVE_LOCAL",
        health: "HEALTHY",
        publicDeployed: false,
      });
    for (let sequence = 1; sequence <= 2; sequence++)
      app.store.create("release_run", PROJECT, {
        releaseId: release.id,
        packageId: delivery.id,
        packageDigest: delivery.digest,
        sequence,
        status: "SUCCEEDED",
        schedulerTriggered: true,
        clockMode: "WALL_CLOCK_TIMER",
        engine: "Apache Spark",
        mainSqlExecuted: true,
        testSqlValidation: { passed: true },
        validation: { passed: true },
      });
    const complete = agentEvidenceJourney({ store: app.store, project: PROJECT, task: app.task });
    assert.equal(complete.localEvidenceComplete, true);
    assert.equal(complete.agentIndependentE2E, false);
    assert.equal(complete.publicDeployed, false);
    assert.equal(complete.evaluatedAsFullLifecycle, false);
    assert.equal(statusOf(complete, "PUBLISH"), "SUCCEEDED");
    assert.equal(
      complete.stages.find((item) => item.id === "SCHEDULE_FILE").actor,
      "AGENT_DELIVERY_ORCHESTRATOR",
    );
    assert.equal(
      complete.stages.find((item) => item.id === "DEPLOY_FILE").actor,
      "AGENT_ORCHESTRATOR_AND_SPARK",
    );
    assert.equal(statusOf(complete, "MONITOR"), "SUCCEEDED");
    assert.equal(complete.stages.find((item) => item.id === "DEPLOY_FILE").evidence.rehearsalId, rehearsal.id);
    const encoded = JSON.stringify(complete);
    for (const forbidden of ["CLIENT-SECRET", "1000.00", "SECRET-ERROR-BUSINESS-ROW", referenceSql])
      assert.equal(encoded.includes(forbidden), false, forbidden.slice(0, 30));

    const alert = app.store.create("monitor_alert", PROJECT, {
      releaseId: release.id,
      status: "OPEN",
    });
    assert.equal(
      statusOf(agentEvidenceJourney({ store: app.store, project: PROJECT, task: app.task }), "MONITOR"),
      "WAITING",
    );
    app.store.update("monitor_alert", alert.id, PROJECT, { status: "RESOLVED" });
    app.store.update("release", release.id, PROJECT, { status: "ROLLED_BACK_LOCAL" });
    assert.equal(
      statusOf(agentEvidenceJourney({ store: app.store, project: PROJECT, task: app.task }), "MONITOR"),
      "HISTORICAL",
    );
  } finally {
    app.close();
  }
});

test("Agent journey API exposes the same read-only evidence scope", async () => {
  const app = setup(),
    server = createV2Server({ store: app.store, env: { V2_LOCAL_DEVELOPMENT: "true" } });
  await new Promise((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.server.address().port}/api/v2/agent/tasks/${app.task.id}/journey`,
      { headers: { "X-Shuzhan-Client": "workbench" } },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.taskId, app.task.id);
    assert.equal(body.stages.length, 7);
    assert.equal(body.agentIndependentE2E, false);
  } finally {
    await new Promise((resolve) => server.server.close(resolve));
    app.close();
  }
});
