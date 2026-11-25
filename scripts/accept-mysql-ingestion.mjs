import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import mysql from "mysql2/promise";
import { createV2Server } from "../src/v2/server.mjs";
import { referenceSql } from "../src/v2/context.mjs";

// An explicitly invoked test against a disposable loopback MySQL 8 instance.
// The CI job provisions these two fixture users. The service only gets the reader.
const database = "shuduo_ingestion_test";
const table = "fixture_holdings";
const target = "raw_positions";
const fields = ["position_id", "client_id", "security_code", "asset_class", "industry", "market_value", "trade_date"];
const initial = [
  ["POS-001", "CLIENT-001", "SEC-DEMO-001", "股票", "金融", "1000.00", "2026-09-10"],
  ["POS-002", "CLIENT-002", "SEC-DEMO-002", "债券", "公共事业", "500.00", "2026-09-10"],
];
const expected = [
  ["POS-001", "CLIENT-001", "SEC-DEMO-001", "股票", "金融", "1100.25", "2026-09-11"],
  initial[1],
  ["POS-003", "CLIENT-002", "SEC-DEMO-003", "股票", "金融", "299.75", "2026-09-11"],
];

test("MySQL holdings reach the landing table and an Agent runs Spark on the selected historical snapshot", async t => {
  const port = Number(process.env.SHUDUO_TEST_MYSQL_PORT);
  const readerPassword = process.env.SHUDUO_TEST_MYSQL_READER_PASSWORD;
  const writerPassword = process.env.SHUDUO_TEST_MYSQL_WRITER_PASSWORD;
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && readerPassword && writerPassword &&
    readerPassword !== writerPassword, "Set the three dedicated MySQL fixture variables before running this test");
  const host = "127.0.0.1";
  const writer = await mysql.createConnection({
    host, port, database, user: "shuduo_fixture_writer", password: writerPassword, connectTimeout: 5000,
  });
  t.after(() => writer.end());
  // No IF NOT EXISTS: abort before changing data if the fixture name is already in use.
  await writer.query(`CREATE TABLE fixture_holdings (
    position_id VARCHAR(32) NOT NULL PRIMARY KEY,
    client_id VARCHAR(32) NOT NULL,
    security_code VARCHAR(32) NOT NULL,
    asset_class VARCHAR(32) NOT NULL,
    industry VARCHAR(32) NOT NULL,
    market_value DECIMAL(18,2) NOT NULL,
    trade_date DATE NOT NULL
  ) ENGINE=InnoDB`);
  const insert = `INSERT INTO fixture_holdings (${fields.join(",")}) VALUES (?,?,?,?,?,?,?)`;
  for (const row of initial) await writer.execute(insert, row);

  const root = await mkdtemp(join(tmpdir(), "shuduo-mysql-ingestion-"));
  // The product's normal Spark runner resolves worker.py under the app root;
  // keep only source code linked while databases and execution files stay temporary.
  await symlink(join(process.cwd(), "src"), join(root, "src"), "dir");
  let generations = 0;
  const app = createV2Server({ root, generator: async ({context}) => {
    assert.equal(++generations, 1, "Unexpected repeated generation");
    assert.equal(context.expected, undefined);
    assert.ok(context.tables.every(t => t.rows === undefined));
    return {sql:referenceSql, explanation:"仓库虚构场景的固定 SQL 生成器", usage:{total_tokens:1}};
  }, env: {
    V2_LOCAL_DEVELOPMENT: "true", V2_RELEASE_SCHEDULER_MODE: "DISABLED",
    JAVA_HOME:process.env.JAVA_HOME ?? join(process.cwd(), ".runtime", "java", "Contents", "Home"),
    V2_PYTHON:process.env.V2_PYTHON ?? join(process.cwd(), ".runtime", "python", "bin", "python"),
    V2_RETAIN_SPARK_ARTIFACTS:"false",
    V2_MYSQL_SOURCE_HOST: host, V2_MYSQL_SOURCE_PORT: String(port),
    V2_MYSQL_SOURCE_DATABASE: database, V2_MYSQL_SOURCE_USER: "shuduo_fixture_reader",
    V2_MYSQL_SOURCE_PASSWORD: readerPassword, V2_MYSQL_SOURCE_TABLE_ALLOWLIST: table,
    V2_MYSQL_SOURCE_SYNC_ENABLED: "true",
  }});
  t.after(async () => {
    if (app.server.listening) {
      const closed = once(app.server, "close");
      app.server.close();
      app.server.closeAllConnections();
      await closed;
    }
    app.dispose();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const ready = once(app.server, "listening");
  app.server.listen(0, host);
  await ready;
  const base = `http://${host}:${app.server.address().port}/api/v2`;
  async function api(path, status, body, key) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15000),
      headers: {"Content-Type":"application/json", "X-Shuduo-Client":"cli", ...(key && {"Idempotency-Key":key})},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, status, path + " " + (payload.code ?? ""));
    return payload;
  }
  const source = await api("/sources", 201, {name:"虚构证券持仓", sourceType:"SERVER_MYSQL", tableName:table}, "mysql-source");
  const probe = await api(`/sources/${source.id}/test`, 200, {});
  assert.equal(probe.status, "CONNECTED");
  assert.match(probe.serverVersion, /^8\.\d+\.\d+(?:[-+][a-zA-Z0-9.+~-]+)?$/);
  const metadata = await api(`/sources/${source.id}/metadata`, 200, {});
  assert.equal(metadata.status, "COLLECTED");
  assert.equal(metadata.classification, "SERVER_MYSQL_SCHEMA_SCAN");
  assert.equal(metadata.rowCount, 2);
  assert.deepEqual(metadata.columns.map(c => [c.name,c.type,c.ordinal,c.nullable]), [
    ["position_id","VARCHAR",1,false], ["client_id","VARCHAR",2,false],
    ["security_code","VARCHAR",3,false], ["asset_class","VARCHAR",4,false], ["industry","VARCHAR",5,false],
    ["market_value","DECIMAL(18,2)",6,false], ["trade_date","DATE",7,false],
  ]);

  function task(mode) {
    return api("/sync/tasks", 201, {
      name: mode === "FULL" ? "持仓全量" : "持仓快照增量", mode, sourceId:source.id,
      sourceRevisionId:metadata.revisionId, metadataVersionId:metadata.id, targetTable:target,
      mapping:Object.fromEntries(fields.map(field=>[field,field])), keyFields:["position_id"], watermarkField:"trade_date",
    }, "mysql-task-"+mode);
  }
  const projection = rows => rows.map(row => fields.map(field => row[field]));
  const counts = run => [run.readCount,run.inserted,run.updated,run.unchanged,run.finalCount];
  const targetRows = () => api(`/sync/targets/${target}/rows`, 200);
  const full = await task("FULL");
  const baseline = await api(`/sync/tasks/${full.id}/run`, 200, {}, "mysql-full-run");
  assert.equal(baseline.status, "SUCCEEDED");
  assert.equal(baseline.sourceStrategy, "BOUNDED_FULL_SNAPSHOT");
  assert.deepEqual(counts(baseline), [2,2,0,0,2]);
  assert.equal(baseline.watermark, "2026-09-10");
  assert.deepEqual(projection(await targetRows()), initial);

  await writer.execute("UPDATE fixture_holdings SET market_value=?, trade_date=? WHERE position_id=?",
    [expected[0][5],expected[0][6],expected[0][0]]);
  await writer.execute(insert, expected[2]);
  const delta = await task("INCREMENTAL_UPSERT");
  const path = `/sync/tasks/${delta.id}`, key = "mysql-delta-run";
  const change = await api(path+"/run", 200, {}, key);
  assert.equal(change.status, "SUCCEEDED");
  assert.equal(change.sourceStrategy, "BOUNDED_SNAPSHOT_DIFF_UPSERT");
  assert.deepEqual(counts(change), [3,1,1,1,3]);
  assert.equal(change.watermark, "2026-09-11");
  const lookup = await api(path+"/requests?request_key="+key, 200);
  assert.equal(lookup.state, "SUCCEEDED");
  assert.equal(lookup.run.id, change.id);
  assert.equal(lookup.landingEvidence.receiptHash, change.landingReceiptHash);
  const replay = await api(path+"/run", 200, {}, key);
  assert.equal(replay.replayed, true);
  assert.equal(replay.id, change.id);
  assert.deepEqual((await api(path, 200)).runs.map(run=>run.id), [change.id]);
  const landed = await targetRows();
  assert.deepEqual(projection(landed), expected);
  assert.equal(landed.reduce((cents, row) => cents + BigInt(row.market_value.replace(".", "")), 0n), 190000n);
  const original = await api(`/sync/tasks/${full.id}/runs/${baseline.id}/snapshot`, 200);
  assert.equal(original.status, "VERIFIED");
  assert.equal(original.currentTarget.matchesOriginalRun, false);
  assert.deepEqual(projection(original.rows), initial);

  // Only the source scale changes. A task pinned to the two-decimal metadata
  // must stop before replacing any of the three landed customer positions.
  await writer.query("ALTER TABLE fixture_holdings MODIFY market_value DECIMAL(18,4) NOT NULL");
  const drift = await api(path+"/run", 409, {}, "mysql-after-scale-change");
  assert.equal(drift.code, "SOURCE_CHANGED");
  assert.deepEqual(await targetRows(), landed);
  const newer = await api(`/sources/${source.id}/metadata`, 200, {});
  assert.notEqual(newer.id, metadata.id);
  assert.notEqual(newer.schemaHash, metadata.schemaHash);
  assert.equal(newer.rowCount, 3);
  assert.deepEqual(newer.change, {changed:true, added:[], removed:[], typeChanged:[
    {name:"market_value", from:"DECIMAL(18,2)", to:"DECIMAL(18,4)"},
  ]});

  const catalog = await api("/development/synced-positions/archives", 200);
  const candidate = catalog.candidates.find(item => item.runId === baseline.id);
  assert.equal(candidate?.taskId, full.id);
  assert.equal(candidate.sourceType, "SERVER_MYSQL");
  assert.equal(catalog.candidates.some(item => item.runId === change.id), false);
  const offer = await api(`/development/synced-positions/archives/${full.id}/${baseline.id}`, 200);
  assert.equal(offer.sourceType, "SERVER_MYSQL");
  assert.equal(offer.metadataVersionId, metadata.id);
  assert.equal(offer.selection.landingSnapshotHash, baseline.landingSnapshotHash);
  assert.equal(offer.selection.targetHash, baseline.targetHash);
  const requestId = "original-mysql-holdings-agent";
  const created = await api("/agent/tasks", 202, {
    contextId:"holdings-t1", message:"用原同步批次计算客户持仓市值、可用现金、总资产和证券数量",
    sql:"SELECT 1", syncInput:offer.selection,
  }, requestId);
  const deadline = Date.now() + 130000;
  let taskResult = created;
  while (["QUEUED","RUNNING"].includes(taskResult.status) && Date.now() < deadline) {
    await delay(500);
    taskResult = await api("/agent/tasks/"+created.id, 200);
  }
  assert.equal(taskResult.status, "SUCCEEDED", taskResult.stage);
  assert.equal(taskResult.mode, "SYNTHETIC_MODEL");
  assert.equal(taskResult.attempts.length, 1);
  assert.equal(generations, 1);
  const run = await api("/runs/"+taskResult.runId, 200);
  assert.equal(run.agentTaskId, taskResult.id);
  assert.equal(run.revisionId, taskResult.revisionId);
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.engine, "Apache Spark");
  assert.equal(run.engineVersion, "3.5.9");
  assert.equal(run.mainSqlExecuted, true);
  assert.notEqual(run.testDouble, true);
  assert.equal(run.validation.passed, true);
  assert.equal(run.validation.contractId, "securities-synced-holdings-t1-v1");
  assert.equal(run.validation.regressions.length, 5);
  assert.ok(run.validation.regressions.every(item => item.passed));
  assert.deepEqual(run.syncInput, taskResult.syncInput);
  assert.equal(run.syncInput.runId, baseline.id);
  assert.equal(run.syncInput.metadataVersionId, metadata.id);
  assert.equal(run.syncInput.landingSnapshotHash, baseline.landingSnapshotHash);
  const schema = await api("/runs/"+run.id+"/output-schema", 200);
  assert.equal(schema.inputMetadata.sourceType, "SERVER_MYSQL");
  assert.equal(schema.inputMetadata.frozen.metadataVersionId, metadata.id);
  assert.equal(schema.inputMetadata.current.metadataVersionId, newer.id);
  assert.equal(schema.inputMetadata.frozen.columns.find(c=>c.name==="market_value").type, "decimal(18,2)");
  assert.equal(schema.inputMetadata.current.columns.find(c=>c.name==="market_value").type, "decimal(18,4)");
  assert.deepEqual(run.rows, [
    {client_id:"CLIENT-001", holding_market_value:"1000.00", available_cash:"300.00", total_assets:"1300.00", security_count:1},
    {client_id:"CLIENT-002", holding_market_value:"500.00", available_cash:"200.00", total_assets:"700.00", security_count:1},
  ]);
  const recovered = await api("/agent/requests/"+requestId, 200);
  assert.equal(recovered.id, taskResult.id);
  assert.deepEqual(recovered.syncInput, run.syncInput);
  assert.deepEqual(await targetRows(), landed);
  t.diagnostic(JSON.stringify({engine:"MySQL", version:probe.serverVersion, sourceTable:table, metadataFields:fields.length,
    fullRows:baseline.finalCount, inserted:change.inserted, updated:change.updated, unchanged:change.unchanged,
    finalRows:landed.length, totalMarketValue:"1900.00", watermark:change.watermark, originalRequestRecovered:true,
    sourceScaleChange:drift.code, landedRowsPreserved:true, sqlInput:"MYSQL_FULL_ARCHIVE", originalSnapshotMatched:true,
    generator:"SYNTHETIC_MODEL", sparkVersion:run.engineVersion, sparkRuns:taskResult.attempts.length,
    regressionScenarios:run.validation.regressions.length, archivedCustomerAssets:run.rows.map(row=>row.total_assets),
    originalAndCurrentMetadataMatched:true}));
});
