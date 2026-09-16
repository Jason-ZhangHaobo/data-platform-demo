import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { contextIds, referenceSql, validationContractId } from "../../src/v2/context.mjs";
import { sha256, loadDeliveryDirectory, createDeliveryPackage } from "../../src/v2/delivery.mjs";

async function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-agent-delivery-")),
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
      status: "SUCCEEDED",
      engine: "Apache Spark",
      engineVersion: "3.5.9",
      rows: [{ client_id: "CLIENT-BUSINESS-ROW-SECRET" }],
      validation: {
        passed: true,
        contractId: validationContractId,
        regressions: contextIds.map((contextId) => ({ contextId, passed: true })),
      },
    }),
    agent = store.create("agent", PROJECT, {
      message: "生成虚构证券客户T+1资产加工",
      contextId: "holdings-t1",
      mode: "LIVE_MODEL",
      status: "SUCCEEDED",
      attempts: [{
        attempt: 1,
        runId: run.id,
        revisionId: revision.id,
        status: "SUCCEEDED",
        model: "qwen3-coder-plus",
      }],
    });
  let runnerCalls = 0;
  const app = createV2Server({
    root,
    store,
    env: options.env ?? { V2_LOCAL_DEVELOPMENT: "true" },
    deliveryRunner: async (input) => {
      runnerCalls++;
      if (options.deliveryRunner) return options.deliveryRunner(input);
      const { directory, expectedDigest } = input;
      const { bundle } = loadDeliveryDirectory(directory, expectedDigest);
      return {
        status: "SUCCEEDED",
        mode: "TEST_DOUBLE",
        testDouble: true,
        engine: "Apache Spark",
        engineVersion: "3.5.9",
        mainSqlExecuted: true,
        testSqlValidation: {
          passed: true,
          sqlHash: sha256(bundle.files["tests.sql"]),
        },
        validation: { passed: true },
      };
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  const call = async (path, body, key = crypto.randomUUID()) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuzhan-Client": "workbench",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    app, store, agent, run, revision, call,
    runnerCalls: () => runnerCalls,
    close: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      store.close();
    },
  };
}

const waitFor = async (call, id, status) => {
  for (let index = 0; index < 100; index++) {
    const current = await call(`/agent/deliveries/${id}`);
    if (current.body.status === status) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`交付准备未达到${status}`);
};

test("Agent delivery preparation rejects test-double rehearsal without approval or fake E2E", async () => {
  const app = await setup();
  try {
    const started = await app.call(
      `/agent/tasks/${app.agent.id}/prepare-delivery`,
      {},
      "prepare-once",
    );
    assert.equal(started.status, 202);
    const replay = await app.call(
      `/agent/tasks/${app.agent.id}/prepare-delivery`,
      {},
      "prepare-once",
    );
    assert.equal(replay.body.id, started.body.id);
    const failed = await waitFor(app.call, started.body.id, "FAILED");
    assert.equal(failed.stage, "FILE_REHEARSAL_RUNNING");
    assert.equal(failed.fullLifecycleE2E, false);
    assert.equal(failed.agentIndependentE2E, false);
    assert.equal(failed.publicDeployed, false);
    assert.ok(failed.packageId);
    assert.ok(failed.verificationId);
    assert.equal(app.runnerCalls(), 1);
    assert.equal(
      (await app.call(`/delivery/verifications/${failed.verificationId}`)).body.status,
      "FAILED",
    );
    assert.equal((await app.call("/release/approvals")).body.length, 0);
    assert.equal((await app.call("/releases")).body.length, 0);
    assert.equal(JSON.stringify(failed).includes("CLIENT-BUSINESS-ROW-SECRET"), false);
  } finally {
    await app.close();
  }
});

test("anonymous public caller cannot create an Agent delivery task", async () => {
  const app = await setup({ env: { V2_LOCAL_DEVELOPMENT: "false" } });
  try {
    const denied = await app.call(`/agent/tasks/${app.agent.id}/prepare-delivery`, {});
    assert.equal(denied.status, 401);
    assert.equal((await app.call("/agent/deliveries")).body.length, 0);
  } finally {
    await app.close();
  }
});

test("cancelled file rehearsal retains cancellation and cannot become a success", async () => {
  const app = await setup({
    deliveryRunner: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("controlled cancellation")), { once: true });
      }),
  });
  try {
    const started = await app.call(`/agent/tasks/${app.agent.id}/prepare-delivery`, {});
    let running;
    for (let index = 0; index < 100; index++) {
      running = (await app.call(`/agent/deliveries/${started.body.id}`)).body;
      if (running.stage === "FILE_REHEARSAL_RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(running.stage, "FILE_REHEARSAL_RUNNING");
    const cancelled = await app.call(`/agent/deliveries/${started.body.id}/cancel`, {});
    assert.equal(cancelled.body.status, "CANCELLED");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await app.call(`/agent/deliveries/${started.body.id}`)).body.status, "CANCELLED");
    assert.equal(
      (await app.call(`/delivery/verifications/${running.verificationId}`)).body.status,
      "CANCELLED",
    );
    assert.equal((await app.call("/release/approvals")).body.length, 0);
  } finally {
    await app.close();
  }
});

test("Agent delivery rejects a model stub before creating any work", async () => {
  const app = await setup();
  try {
    const stub = app.store.create("agent", PROJECT, {
      ...app.agent,
      status: "SUCCEEDED",
      attempts: [{ ...app.agent.attempts[0], model: "TEST_DOUBLE" }],
    });
    const rejected = await app.call(`/agent/tasks/${stub.id}/prepare-delivery`, {});
    assert.equal(rejected.status, 409);
    assert.equal((await app.call("/agent/deliveries")).body.length, 0);
    assert.equal((await app.call("/delivery/packages")).body.length, 0);
  } finally {
    await app.close();
  }
});

test("Agent delivery never reuses a package with an existing approval", async () => {
  const app = await setup();
  try {
    const previousBundle = createDeliveryPackage({ run: app.run, revision: app.revision }),
      oldPackage = app.store.create("delivery_package", PROJECT, {
        ...previousBundle,
        sourceRunId: app.run.id,
        stage: "M2A",
        published: false,
      });
    app.store.create("release_approval", PROJECT, {
      packageId: oldPackage.id,
      packageDigest: oldPackage.digest,
      status: "APPROVED",
    });
    const started = await app.call(`/agent/tasks/${app.agent.id}/prepare-delivery`, {});
    const failed = await waitFor(app.call, started.body.id, "FAILED");
    assert.notEqual(failed.packageId, oldPackage.id);
    assert.equal(
      app.store.list("release_approval", PROJECT).filter((item) => item.packageId === failed.packageId).length,
      0,
    );
    assert.equal(app.store.list("release_approval", PROJECT).length, 1);
  } finally {
    await app.close();
  }
});

test("restart makes an unfinished Agent delivery explicit instead of replaying it", async () => {
  const app = await setup();
  try {
    const pending = app.store.create("agent_delivery_task", PROJECT, {
      sourceAgentTaskId: app.agent.id,
      status: "RUNNING",
    });
    app.store.interruptPending(PROJECT);
    assert.equal(app.store.get("agent_delivery_task", pending.id, PROJECT).status, "INTERRUPTED");
  } finally {
    await app.close();
  }
});
