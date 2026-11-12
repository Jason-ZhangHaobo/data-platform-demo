import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { getContext, referenceSql } from "../../src/v2/context.mjs";
import { identityPositionMapping } from "../../src/v2/ingestion.mjs";

test("Agent binds a committed position snapshot across overwrite, retry and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-sync-sql-"));
  const fixtureRoot = join(root, "sources");
  mkdirSync(fixtureRoot);
  const positions = getContext().tables.find(table => table.name === "positions");
  const sample = (name, amount) => {
    const rows = structuredClone(positions.rows);
    rows[0][5] = amount;
    writeFileSync(join(fixtureRoot, name), [positions.columns.map(([name]) => name), ...rows].map(row => row.join(",")).join("\n"));
  };
  sample("first.csv", "1245.07");
  sample("later.csv", "4000.00");
  sample("bad.csv", "0.001");
  let modelCalls = 0, runs = 0, base, app;
  let openModel;
  const modelGate = new Promise(resolve => { openModel = resolve; });
  const runner = async ({ context, validationContexts }) => {
    runs++;
    assert.equal(context.tables.find(table => table.name === "positions").rows[0][5], "1245.07");
    assert.equal(context.expected[0].total_assets, "2045.07");
    assert.equal(validationContexts[0].expected[0].total_assets, "1800.00");
    return { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", testDouble: true,
      rows: context.expected, validation: { passed: true } };
  };
  async function start() {
    app = createV2Server({ root, fixtureRoot, runner, env: { V2_LOCAL_DEVELOPMENT: "true", V2_RELEASE_SCHEDULER_MODE: "DISABLED" },
      generator: async ({ context }) => {
        modelCalls++;
        assert.equal(context.expected, undefined);
        assert.ok(context.tables.every(table => table.rows === undefined));
        await modelGate;
        return { sql: referenceSql, explanation: "虚构测试替身", usage: { total_tokens: 1 } };
      } });
    await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  }
  async function stop() {
    if (!app) return;
    app.releaseScheduler.shutdown();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    app = undefined;
  }
  async function request(path, body, key = "request") {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-Shuduo-Client": "workbench", "Idempotency-Key": key },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }
  async function finished(path) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { status, value } = await request(path);
      assert.equal(status, 200);
      if (!["QUEUED", "RUNNING"].includes(value.status)) return value;
      await pause(10);
    }
    assert.fail("Execution did not settle");
  }
  function sync(fileName) {
    const source = app.ingestion.createSource({ name: "虚构证券源 " + fileName, sourceType: "LOCAL_CSV", fileName });
    app.ingestion.testConnection(source.id);
    const metadata = app.ingestion.collectMetadata(source.id);
    const task = app.ingestion.createTask({ name: "虚构持仓同步 " + fileName, sourceId: source.id, targetTable: "raw_positions",
      mode: "FULL", mapping: identityPositionMapping, keyFields: ["position_id"] });
    return { run: app.ingestion.runTask(task.id), metadata };
  }
  try {
    await start();
    assert.equal((await request("/development/synced-positions")).status, 409);
    const first = sync("first.csv");
    const offer = await request("/development/synced-positions");
    assert.equal(offer.status, 200);
    assert.equal(offer.value.selection.runId, first.run.id);
    assert.equal(offer.value.metadataVersionId, first.metadata.id);
    assert.equal(offer.value.context, undefined);
    const body = { contextId: "holdings-t1", message: "按冻结持仓计算客户总资产", sql: "SELECT 1", syncInput: offer.value.selection };
    const requestId = "freeze-request";
    assert.equal((await request("/agent/tasks", { ...body, contextId: "stock-cash-t1" })).status, 422);
    const task = await request("/agent/tasks", body, requestId);
    assert.equal(task.status, 202);
    assert.equal(task.value.syncInput.rowCount, 4);
    assert.equal(task.value.mode, "SYNTHETIC_MODEL");
    assert.equal(task.value.syncInput.payload, undefined);
    const latest = sync("later.csv");
    assert.notEqual(latest.run.targetHash, first.run.targetHash);
    const replay = await request("/agent/tasks", body, requestId);
    assert.equal(replay.value.id, task.value.id);
    const stale = await request("/agent/tasks", body, "stale-request");
    assert.equal(stale.status, 409);
    assert.equal(stale.value.code, "SYNC_SQL_INPUT_STALE");
    assert.equal((await request("/agent/requests/stale-request")).status, 404);
    openModel();
    const completed = await finished(`/agent/tasks/${task.value.id}`);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.fullLifecycleE2E, false);
    assert.equal((await request(`/agent/tasks/${completed.id}/prepare-delivery`, {})).status, 409);
    const run = await finished(`/runs/${completed.runId}`);
    assert.deepEqual(run.syncInput, completed.syncInput);
    assert.equal(run.rows[0].total_assets, "2045.07");
    assert.equal(modelCalls, 1);
    assert.equal(runs, 1);
    await stop();
    await start();
    const recovered = await request(`/agent/requests/${requestId}`);
    assert.deepEqual(recovered.value.syncInput, completed.syncInput);
    const revision = await request("/revisions", { contextId: "holdings-t1", originAgentTaskId: completed.id, sql: referenceSql }, "manual");
    assert.equal(revision.status, 201);
    assert.deepEqual(revision.value.syncInput, run.syncInput);
    const manual = await request("/runs", { revisionId: revision.value.id }, "manual-run");
    assert.equal(manual.status, 202);
    const checked = await finished(`/runs/${manual.value.id}`);
    assert.equal(checked.rows[0].total_assets, "2045.07");
    assert.deepEqual(checked.syncInput, run.syncInput);
    const record = app.store.get("sync_sql_input", completed.syncInput.snapshotId, PROJECT);
    record.payload.context.expected[0].total_assets = "0.00";
    app.store.update("sync_sql_input", record.id, PROJECT, { payload: record.payload });
    assert.equal((await request("/runs", { revisionId: revision.value.id }, "tampered")).value.code, "SYNC_SQL_INPUT_CHANGED");
    assert.equal(sync("bad.csv").run.status, "SUCCEEDED");
    assert.equal((await request("/development/synced-positions")).status, 422);
    assert.equal(runs, 2);
    assert.equal(modelCalls, 1);
  } finally {
    openModel();
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
