import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import {
  LandingStore,
  identityPositionMapping,
} from "../../src/v2/ingestion.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

const header =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n";
const baseline =
  header +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n";
const incremental =
  header +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,550.00,2026-09-10\n" +
  "POS-003,CLIENT-002,SEC-DEMO-003,基金,多元金融,300.00,2026-09-10\n";
const changed =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date,currency\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10,CNY\n";

async function start(options) {
  const app = createV2Server(options);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return {
    app,
    base: `http://127.0.0.1:${app.server.address().port}/api/v2`,
  };
}
async function request(base, path, body, key = "ingestion-api") {
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
async function readySource(base, body, key) {
  const source = await request(base, "/sources", body, `${key}-create`);
  assert.equal(source.status, 201);
  const tested = await request(
    base,
    `/sources/${source.body.id}/test`,
    {},
    `${key}-test`,
  );
  assert.equal(tested.body.status, "CONNECTED");
  const metadata = await request(
    base,
    `/sources/${source.body.id}/metadata`,
    {},
    `${key}-metadata`,
  );
  assert.equal(metadata.body.status, "COLLECTED");
  return { source: source.body, tested: tested.body, metadata: metadata.body };
}
async function waitForAgentPlan(base, id, expected) {
  for (let index = 0; index < 60; index++) {
    const response = await request(base, `/sync/agent/plans/${id}`);
    if (response.body.status === expected) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`同步Agent方案未达到${expected}`);
}

test("V2 API executes CSV metadata, full sync, incremental UPSERT and stale-version failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-ingestion-api-")),
    fixtureRoot = join(root, "fixtures"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite"));
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "baseline.csv"), baseline);
  writeFileSync(join(fixtureRoot, "incremental.csv"), incremental);
  writeFileSync(join(fixtureRoot, "changed.csv"), changed);
  let server = await start({
    store,
    landingStore,
    fixtureRoot,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
  });
  try {
    const baseSource = await readySource(
        server.base,
        {
          name: "证券持仓全量CSV",
          sourceType: "LOCAL_CSV",
          fileName: "baseline.csv",
        },
        "base-source",
      ),
      repeated = await request(
        server.base,
        "/sources",
        {
          name: "证券持仓全量CSV",
          sourceType: "LOCAL_CSV",
          fileName: "baseline.csv",
        },
        "base-source-create",
      );
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.id, baseSource.source.id);
    assert.equal(baseSource.tested.rowCount, 2);
    assert.equal(baseSource.metadata.columns.length, 7);
    assert.equal(baseSource.metadata.classification, "ACTUAL_FILE_SCAN");

    const fullTask = await request(
        server.base,
        "/sync/tasks",
        {
          name: "证券持仓全量同步",
          sourceId: baseSource.source.id,
          targetTable: "raw_positions",
          mode: "FULL",
          mapping: identityPositionMapping,
          keyFields: ["position_id"],
          watermarkField: "trade_date",
        },
        "full-task",
      ),
      fullRun = await request(
        server.base,
        `/sync/tasks/${fullTask.body.id}/run`,
        {},
        "full-run",
      ),
      replay = await request(
        server.base,
        `/sync/tasks/${fullTask.body.id}/run`,
        {},
        "full-run",
      );
    assert.equal(fullTask.status, 201);
    assert.equal(fullRun.body.status, "SUCCEEDED");
    assert.equal(fullRun.body.inserted, 2);
    assert.equal(fullRun.body.finalCount, 2);
    assert.equal(replay.body.id, fullRun.body.id);
    assert.equal(replay.body.replayed, true);

    const deltaSource = await readySource(
        server.base,
        {
          name: "证券持仓增量CSV",
          sourceType: "LOCAL_CSV",
          fileName: "incremental.csv",
        },
        "delta-source",
      ),
      deltaTask = await request(
        server.base,
        "/sync/tasks",
        {
          name: "证券持仓增量合并",
          sourceId: deltaSource.source.id,
          targetTable: "raw_positions",
          mode: "INCREMENTAL_UPSERT",
          mapping: identityPositionMapping,
          keyFields: ["position_id"],
          watermarkField: "trade_date",
        },
        "delta-task",
      ),
      deltaRun = await request(
        server.base,
        `/sync/tasks/${deltaTask.body.id}/run`,
        {},
        "delta-run",
      ),
      rows = await request(
        server.base,
        "/sync/targets/raw_positions/rows",
      );
    assert.equal(deltaRun.body.inserted, 1);
    assert.equal(deltaRun.body.updated, 1);
    assert.equal(deltaRun.body.finalCount, 3);
    assert.equal(rows.body.length, 3);
    assert.equal(
      rows.body.find((row) => row.position_id === "POS-002").market_value,
      "550.00",
    );

    const revision = await request(
      server.base,
      `/sources/${baseSource.source.id}/revisions`,
      { fileName: "changed.csv" },
      "schema-revision",
    );
    assert.equal(revision.body.revisionNumber, 2);
    await request(
      server.base,
      `/sources/${baseSource.source.id}/test`,
      {},
      "schema-test",
    );
    const metadata = await request(
      server.base,
      `/sources/${baseSource.source.id}/metadata`,
      {},
      "schema-metadata",
    );
    assert.deepEqual(metadata.body.change.added, ["currency"]);
    const stale = await request(
      server.base,
      `/sync/tasks/${fullTask.body.id}/run`,
      {},
      "stale-full-run",
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "SOURCE_REVISION_STALE");
    assert.ok(stale.body.runId);
    const taskDetail = await request(
      server.base,
      `/sync/tasks/${fullTask.body.id}`,
    );
    assert.ok(
      taskDetail.body.runs.some(
        (run) => run.id === stale.body.runId && run.status === "FAILED",
      ),
    );
    const status = await request(server.base, "/status");
    assert.equal(status.body.ingestion.sourceCount, 2);
    assert.equal(status.body.ingestion.offlineTaskCount, 2);
    assert.equal(status.body.ingestion.cloudVerified, false);

    await new Promise((resolve) => server.app.server.close(resolve));
    server = await start({
      store,
      landingStore,
      fixtureRoot,
      env: { V2_LOCAL_DEVELOPMENT: "false" },
    });
    assert.equal((await request(server.base, "/sources")).status, 200);
    assert.equal(
      (
        await request(
          server.base,
          "/sources",
          {
            name: "公开模式拒绝",
            sourceType: "LOCAL_CSV",
            fileName: "baseline.csv",
          },
          "public-source",
        )
      ).status,
      401,
    );
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    landingStore.close();
    store.close();
  }
});

test("V2 API exposes server MySQL connection and metadata without browser credentials or sync execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-ingestion-mysql-api-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite")),
    server = await start({
      store,
      landingStore,
      fixtureRoot: resolve("fixtures/sources"),
      env: { V2_LOCAL_DEVELOPMENT: "true" },
      serverMysqlAdapter: {
        profileId: "server-mysql-synthetic",
        allowTables: ["synthetic_positions"],
        async probe(tableName) {
          assert.equal(tableName, "synthetic_positions");
          return { status: "CONNECTED", serverVersion: "8.0.synthetic" };
        },
        async describe(tableName) {
          assert.equal(tableName, "synthetic_positions");
          return {
            tableName,
            rowCount: 3,
            columns: [
              { name: "position_id", ordinal: 1, type: "VARCHAR", nullable: false },
              { name: "market_value", ordinal: 2, type: "DECIMAL", nullable: false },
            ],
          };
        },
      },
    });
  try {
    const source = await request(server.base, "/sources", {
        name: "服务端虚构MySQL持仓",
        sourceType: "SERVER_MYSQL",
        tableName: "synthetic_positions",
      }, "mysql-create"),
      leaked = await request(server.base, "/sources", {
        name: "禁止浏览器凭证",
        sourceType: "SERVER_MYSQL",
        tableName: "synthetic_positions",
        password: "forbidden",
      }, "mysql-leak");
    assert.equal(source.status, 201);
    assert.equal("password" in source.body, false);
    assert.equal(leaked.status, 400);
    const tested = await request(server.base, `/sources/${source.body.id}/test`, {}, "mysql-test"),
      metadata = await request(server.base, `/sources/${source.body.id}/metadata`, {}, "mysql-metadata");
    assert.equal(tested.body.serverVersion, "8.0.synthetic");
    assert.equal(metadata.body.classification, "SERVER_MYSQL_METADATA_ONLY");
    assert.equal(metadata.body.columns.length, 2);
    const task = await request(server.base, "/sync/tasks", {
      name: "不应执行MySQL同步",
      sourceId: source.body.id,
      targetTable: "mysql_positions_target",
      mode: "FULL",
      mapping: { position_id: "position_id" },
      keyFields: ["position_id"],
    }, "mysql-sync");
    assert.equal(task.status, 409);
    assert.equal(task.body.code, "MYSQL_SYNC_NOT_ENABLED");
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    landingStore.close();
    store.close();
  }
});

test("V2 source API rejects credentials and path traversal before persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-ingestion-api-deny-")),
    fixtureRoot = join(root, "fixtures"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(":memory:");
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "baseline.csv"), baseline);
  const server = await start({
    store,
    landingStore,
    fixtureRoot,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
  });
  try {
    const credential = await request(
      server.base,
      "/sources",
      {
        name: "错误凭证",
        sourceType: "LOCAL_CSV",
        fileName: "baseline.csv",
        credentialRef: "secret/demo",
      },
      "credential-source",
    );
    assert.equal(credential.status, 400);
    assert.equal(credential.body.code, "UNEXPECTED_CREDENTIAL");
    const traversal = await request(
      server.base,
      "/sources",
      {
        name: "越界文件",
        sourceType: "LOCAL_CSV",
        fileName: "../outside.csv",
      },
      "traversal-source",
    );
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.code, "INVALID_FILE_NAME");
    assert.equal(store.list("ingestion_source", "project-securities-lab").length, 0);
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    landingStore.close();
    store.close();
  }
});

test("Data Agent creates an offline sync draft only after governed apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-ingestion-agent-api-")),
    fixtureRoot = join(root, "fixtures"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(":memory:");
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "baseline.csv"), baseline);
  const server = await start({
    store,
    landingStore,
    fixtureRoot,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
    ingestionPlanner: async ({ sources }) => ({
      plan: {
        kind: "OFFLINE_SYNC",
        name: "Agent证券持仓同步",
        sourceId: sources[0].id,
        targetTable: "agent_raw_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
        watermarkField: "trade_date",
      },
      explanation: "使用已采集元数据创建全量同步草稿",
      model: "TEST_DOUBLE",
      usage: { total_tokens: 100 },
    }),
  });
  try {
    await readySource(
      server.base,
      {
        name: "Agent可用持仓源",
        sourceType: "LOCAL_CSV",
        fileName: "baseline.csv",
      },
      "agent-source",
    );
    const started = await request(
        server.base,
        "/sync/agent/plans",
        { message: "为当前持仓源创建全量同步草稿" },
        "agent-sync-plan",
      ),
      complete = await waitForAgentPlan(
        server.base,
        started.body.id,
        "SUCCEEDED",
      );
    assert.equal(started.status, 202);
    assert.equal(complete.completionScope, "OFFLINE_SYNC_DESIGN");
    assert.equal(complete.fullLifecycleE2E, false);
    assert.equal(complete.proposal.targetTable, "agent_raw_positions");
    assert.equal(store.list("offline_sync_task", "project-securities-lab").length, 0);
    const applied = await request(
      server.base,
      `/sync/agent/plans/${complete.id}/apply`,
      {},
      "apply-agent-sync-plan",
    );
    assert.equal(applied.status, 201);
    assert.equal(applied.body.status, "READY");
    assert.equal(applied.body.runs.length, 0);
    assert.equal(
      (await request(server.base, `/sync/agent/plans/${complete.id}`)).body
        .status,
      "APPLIED",
    );
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    landingStore.close();
    store.close();
  }
});
