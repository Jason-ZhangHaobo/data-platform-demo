import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import {
  IngestionManager,
  LandingStore,
  identityPositionMapping,
  inferCsvSchema,
  parseCsv,
} from "../../src/v2/ingestion.mjs";
import { PROJECT } from "../../src/v2/server.mjs";
import { generateIngestionPlan } from "../../src/v2/model.mjs";

const header =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n";
const baseline =
  header +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n" +
  "POS-003,CLIENT-002,SEC-DEMO-001,股票,金融,750.00,2026-09-10\n" +
  "POS-004,CLIENT-003,SEC-DEMO-003,股票,信息技术,9000.00,2026-09-10\n";
const incremental =
  header +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,550.00,2026-09-10\n" +
  "POS-005,CLIENT-002,SEC-DEMO-004,基金,多元金融,300.00,2026-09-10\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-ingestion-")),
    fixtureRoot = join(root, "fixtures"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite"));
  writeFileSync(join(root, "placeholder"), "");
  // MetadataStore creates root; fixture files remain isolated per test.
  const fs = {
    write(name, content) {
      writeFileSync(join(fixtureRoot, name), content);
    },
  };
  mkdirSync(fixtureRoot, { recursive: true });
  fs.write("baseline.csv", baseline);
  fs.write("incremental.csv", incremental);
  const manager = new IngestionManager({
    store,
    landingStore,
    project: PROJECT,
    fixtureRoot,
  });
  return {
    root,
    fixtureRoot,
    fs,
    store,
    landingStore,
    manager,
    close() {
      landingStore.close();
      store.close();
    },
  };
}

function readySource(manager, input) {
  const source = manager.createSource({ sourceType: "LOCAL_CSV", ...input }),
    connection = manager.testConnection(source.id),
    metadata = manager.collectMetadata(source.id);
  return { source: manager.sourceDetail(source.id), connection, metadata };
}

test("CSV parser handles quotes and infers actual field types", () => {
  const parsed = parseCsv(
      "id,name,amount,trade_date,note\r\n1,\"证券,客户\",12.30,2026-09-10,\"a\"\"b\"\r\n",
    ),
    schema = inferCsvSchema(parsed);
  assert.equal(parsed.rows[0].name, "证券,客户");
  assert.equal(parsed.rows[0].note, 'a"b');
  assert.equal(schema.find((column) => column.name === "id").type, "INTEGER");
  assert.equal(
    schema.find((column) => column.name === "amount").type,
    "DECIMAL(18,2)",
  );
  assert.equal(
    schema.find((column) => column.name === "trade_date").type,
    "DATE",
  );
});

test("repository securities CSV fixtures are synthetic and structurally valid", () => {
  const root = resolve("fixtures/sources"),
    base = parseCsv(readFileSync(join(root, "positions_baseline.csv"), "utf8")),
    delta = parseCsv(
      readFileSync(join(root, "positions_incremental.csv"), "utf8"),
    ),
    changed = parseCsv(
      readFileSync(join(root, "positions_schema_change.csv"), "utf8"),
    );
  assert.equal(base.rows.length, 4);
  assert.equal(delta.rows.length, 2);
  assert.ok(base.rows.every((row) => row.client_id.startsWith("CLIENT-")));
  assert.equal(changed.headers.at(-1), "currency");
});

test("source test and metadata scan record real file evidence and schema change", () => {
  const app = setup();
  try {
    const { source, connection, metadata } = readySource(app.manager, {
      name: "证券持仓CSV",
      fileName: "baseline.csv",
    });
    assert.equal(connection.status, "CONNECTED");
    assert.equal(connection.rowCount, 4);
    assert.equal(connection.fileHash.length, 64);
    assert.equal(metadata.classification, "ACTUAL_FILE_SCAN");
    assert.equal(metadata.rowCount, 4);
    assert.equal(metadata.columns.length, 7);
    assert.equal(
      metadata.columns.find((column) => column.name === "market_value").type,
      "DECIMAL(18,2)",
    );
    assert.equal(source.status, "READY");

    app.fs.write(
      "changed.csv",
      baseline.replace("trade_date\n", "trade_date,currency\n").replaceAll(
        "2026-09-10\n",
        "2026-09-10,CNY\n",
      ),
    );
    const revision = app.manager.createSourceRevision(source.id, {
      fileName: "changed.csv",
    });
    app.manager.testConnection(source.id);
    const next = app.manager.collectMetadata(source.id),
      detail = app.manager.sourceDetail(source.id);
    assert.equal(revision.revisionNumber, 2);
    assert.equal(next.change.changed, true);
    assert.deepEqual(next.change.added, ["currency"]);
    assert.equal(detail.status, "SCHEMA_CHANGED");
    assert.equal(detail.metadataVersions.length, 2);
  } finally {
    app.close();
  }
});

test("full and incremental UPSERT perform real atomic landing writes", () => {
  const app = setup();
  try {
    const base = readySource(app.manager, {
        name: "持仓全量源",
        fileName: "baseline.csv",
      }),
      fullTask = app.manager.createTask({
        name: "证券持仓全量入湖",
        sourceId: base.source.id,
        targetTable: "raw_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
        watermarkField: "trade_date",
      }),
      fullRun = app.manager.runTask(fullTask.id);
    assert.equal(fullRun.actualExecution, true);
    assert.equal(fullRun.readCount, 4);
    assert.equal(fullRun.inserted, 4);
    assert.equal(fullRun.finalCount, 4);
    assert.equal(fullRun.watermark, "2026-09-10");
    assert.equal(fullRun.targetHash.length, 64);

    const delta = readySource(app.manager, {
        name: "持仓增量源",
        fileName: "incremental.csv",
      }),
      deltaTask = app.manager.createTask({
        name: "证券持仓增量合并",
        sourceId: delta.source.id,
        targetTable: "raw_positions",
        mode: "INCREMENTAL_UPSERT",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
        watermarkField: "trade_date",
      }),
      deltaRun = app.manager.runTask(deltaTask.id),
      rows = app.manager.previewTarget("raw_positions");
    assert.equal(deltaRun.readCount, 2);
    assert.equal(deltaRun.inserted, 1);
    assert.equal(deltaRun.updated, 1);
    assert.equal(deltaRun.finalCount, 5);
    assert.equal(
      rows.find((row) => row.position_id === "POS-002").market_value,
      "550.00",
    );
    assert.equal(
      rows.find((row) => row.position_id === "POS-005").asset_class,
      "基金",
    );
    const replay = app.manager.runTask(deltaTask.id);
    assert.equal(replay.inserted, 0);
    assert.equal(replay.updated, 0);
    assert.equal(replay.unchanged, 2);
    assert.equal(replay.targetHash, deltaRun.targetHash);
  } finally {
    app.close();
  }
});

test("duplicate incremental keys rollback without changing the existing target", () => {
  const app = setup();
  try {
    const base = readySource(app.manager, {
        name: "稳定全量源",
        fileName: "baseline.csv",
      }),
      fullTask = app.manager.createTask({
        name: "稳定全量任务",
        sourceId: base.source.id,
        targetTable: "raw_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
      });
    app.manager.runTask(fullTask.id);
    const before = app.manager.previewTarget("raw_positions");
    app.fs.write(
      "duplicate.csv",
      header +
        "POS-005,CLIENT-002,SEC-DEMO-004,基金,多元金融,300.00,2026-09-10\n" +
        "POS-005,CLIENT-002,SEC-DEMO-004,基金,多元金融,350.00,2026-09-10\n",
    );
    const source = readySource(app.manager, {
        name: "重复主键增量源",
        fileName: "duplicate.csv",
      }),
      task = app.manager.createTask({
        name: "重复主键失败任务",
        sourceId: source.source.id,
        targetTable: "raw_positions",
        mode: "INCREMENTAL_UPSERT",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
      });
    assert.throws(() => app.manager.runTask(task.id), {
      status: 422,
      code: "DUPLICATE_SYNC_KEY",
    });
    assert.deepEqual(app.manager.previewTarget("raw_positions"), before);
    const detail = app.manager.taskDetail(task.id);
    assert.equal(detail.status, "FAILED");
    assert.equal(detail.runs[0].status, "FAILED");
    assert.equal(detail.runs[0].actualExecution, true);
  } finally {
    app.close();
  }
});

test("source revision invalidates old sync configuration and records the failure", () => {
  const app = setup();
  try {
    const source = readySource(app.manager, {
        name: "版本变化源",
        fileName: "baseline.csv",
      }),
      task = app.manager.createTask({
        name: "绑定旧版本任务",
        sourceId: source.source.id,
        targetTable: "raw_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
      });
    app.manager.createSourceRevision(source.source.id, {
      fileName: "incremental.csv",
    });
    assert.throws(() => app.manager.runTask(task.id), {
      status: 409,
      code: "SOURCE_REVISION_STALE",
    });
    assert.equal(app.manager.taskDetail(task.id).runs[0].status, "FAILED");
  } finally {
    app.close();
  }
});

test("sync run idempotency replays terminal evidence and rejects ambiguous reuse", () => {
  const app = setup();
  try {
    const source = readySource(app.manager, {
        name: "幂等全量源",
        fileName: "baseline.csv",
      }),
      task = app.manager.createTask({
        name: "幂等全量任务",
        sourceId: source.source.id,
        targetTable: "raw_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
      }),
      first = app.manager.runTask(task.id, {
        requestKey: "same-sync-request",
        requestSignature: "same-signature",
      }),
      replay = app.manager.runTask(task.id, {
        requestKey: "same-sync-request",
        requestSignature: "same-signature",
      });
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    assert.equal(app.manager.taskDetail(task.id).runs.length, 1);
    assert.throws(
      () =>
        app.manager.runTask(task.id, {
          requestKey: "same-sync-request",
          requestSignature: "different-signature",
        }),
      { status: 409, code: "SYNC_IDEMPOTENCY_CONFLICT" },
    );
  } finally {
    app.close();
  }
});

test("source paths, symlinks and credentials fail closed", () => {
  const app = setup();
  try {
    assert.throws(
      () =>
        app.manager.createSource({
          name: "越界路径",
          sourceType: "LOCAL_CSV",
          fileName: "../outside.csv",
        }),
      { status: 400, code: "INVALID_FILE_NAME" },
    );
    assert.throws(
      () =>
        app.manager.createSource({
          name: "错误凭证",
          sourceType: "LOCAL_CSV",
          fileName: "baseline.csv",
          credentialRef: "secret/demo",
        }),
      { status: 400, code: "UNEXPECTED_CREDENTIAL" },
    );
    symlinkSync(join(app.fixtureRoot, "baseline.csv"), join(app.fixtureRoot, "linked.csv"));
    assert.throws(
      () =>
        app.manager.createSource({
          name: "符号链接",
          sourceType: "LOCAL_CSV",
          fileName: "linked.csv",
        }),
      { status: 422, code: "SOURCE_SYMLINK_FORBIDDEN" },
    );
  } finally {
    app.close();
  }
});

test("metadata collection detects a file changed after connection test", () => {
  const app = setup();
  try {
    const source = app.manager.createSource({
      name: "测试后变化源",
      sourceType: "LOCAL_CSV",
      fileName: "baseline.csv",
    });
    app.manager.testConnection(source.id);
    app.fs.write("baseline.csv", incremental);
    assert.throws(() => app.manager.collectMetadata(source.id), {
      status: 409,
      code: "SOURCE_CHANGED",
    });
  } finally {
    app.close();
  }
});

test("ingestion model adapter receives metadata but never CSV row contents", async () => {
  let request;
  const generated = await generateIngestionPlan(
    {
      message: "生成增量持仓同步",
      sources: [
        {
          id: "source-demo",
          name: "证券持仓源",
          sourceType: "LOCAL_CSV",
          status: "READY",
          currentRevisionId: "revision-demo",
          currentMetadataId: "metadata-demo",
          metadataVersions: [
            {
              id: "metadata-demo",
              columns: [
                { name: "position_id", type: "STRING", nullable: false },
                { name: "trade_date", type: "DATE", nullable: false },
              ],
              rows: [{ secret: "CSV_ROW_NOT_SENT" }],
            },
          ],
        },
      ],
    },
    { DASHSCOPE_API_KEY: "TEST_ONLY" },
    async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "OFFLINE_SYNC",
                  name: "持仓增量同步",
                  sourceId: "source-demo",
                  targetTable: "raw_positions",
                  mode: "INCREMENTAL_UPSERT",
                  mapping: {
                    position_id: "position_id",
                    trade_date: "trade_date",
                  },
                  keyFields: ["position_id"],
                  watermarkField: "trade_date",
                  explanation: "使用持仓主键合并",
                }),
              },
            },
          ],
          usage: { total_tokens: 100 },
        }),
      );
    },
  );
  const payload = JSON.parse(request.options.body),
    prompt = payload.messages[1].content;
  assert.equal(request.options.headers.Authorization, "Bearer TEST_ONLY");
  assert.equal(prompt.includes("CSV_ROW_NOT_SENT"), false);
  assert.equal(generated.plan.kind, "OFFLINE_SYNC");
  assert.equal(generated.explanation, "使用持仓主键合并");
  assert.equal("explanation" in generated.plan, false);
});
