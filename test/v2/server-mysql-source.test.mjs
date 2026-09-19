import test from "node:test";
import assert from "node:assert/strict";
import {
  createServerMysqlSourceAdapter,
  mysqlSourceStatus,
} from "../../src/v2/server-mysql-source.mjs";

const env = {
  V2_MYSQL_SOURCE_HOST: "synthetic.internal",
  V2_MYSQL_SOURCE_PORT: "3306",
  V2_MYSQL_SOURCE_USER: "sync_reader",
  V2_MYSQL_SOURCE_PASSWORD: "Synthetic-only-password-42!",
  V2_MYSQL_SOURCE_DATABASE: "business_demo",
  V2_MYSQL_SOURCE_TABLE_ALLOWLIST: "synthetic_positions",
  V2_MYSQL_SOURCE_SYNC_ENABLED: "true",
};

function loaderFor(rows, calls, failure) {
  return async () => ({
    createConnection(config) {
      calls.push(["connect", config]);
      if (failure) throw Object.assign(new Error("must not expose synthetic.internal"), { code: failure });
      return {
        async query(statement) {
          calls.push(["query", statement]);
          if (statement === "SELECT VERSION() AS server_version")
            return [[{ server_version: "8.0.synthetic" }]];
          if (typeof statement === "string" && statement.startsWith("SELECT COUNT"))
            return [[{ row_count: rows.length }]];
          if (typeof statement === "object" && statement.sql.startsWith("SELECT *"))
            return [structuredClone(rows)];
          throw new Error("unexpected query");
        },
        async execute(statement, values) {
          calls.push(["execute", statement, values]);
          return [[
            { name: "position_id", type: "varchar", nullable: "NO", ordinal: 1 },
            { name: "market_value", type: "decimal", nullable: "NO", ordinal: 2 },
          ]];
        },
        async end() {
          calls.push(["end"]);
        },
      };
    },
  });
}

test("server MySQL source is enabled only by complete server configuration and explicit sync flag", () => {
  assert.equal(mysqlSourceStatus(env).supportsOfflineSync, true);
  assert.equal(mysqlSourceStatus({ ...env, V2_MYSQL_SOURCE_SYNC_ENABLED: "false" }).supportsOfflineSync, false);
  assert.equal(mysqlSourceStatus({ ...env, V2_MYSQL_SOURCE_PASSWORD: "" }).configured, false);
});

test("server MySQL source probes, scans schema and reads bounded rows through an allowlist", async () => {
  const calls = [],
    rows = [
      { position_id: "POS-001", market_value: "1000.00" },
      { position_id: "POS-002", market_value: "500.00" },
    ],
    adapter = createServerMysqlSourceAdapter(env, {
      loader: loaderFor(rows, calls),
    });
  assert.equal((await adapter.probe("synthetic_positions")).serverVersion, "8.0.synthetic");
  const metadata = await adapter.describe("synthetic_positions"),
    snapshot = await adapter.readRows("synthetic_positions");
  assert.equal(metadata.rowCount, 2);
  assert.equal(metadata.columns[1].type, "DECIMAL");
  assert.deepEqual(snapshot.rows, rows);
  assert.equal(snapshot.contentHash.length, 64);
  assert.equal(snapshot.strategy, "BOUNDED_SNAPSHOT");
  assert.equal(calls.filter(([kind]) => kind === "end").length, 3);
  assert.equal(JSON.stringify(mysqlSourceStatus(env)).includes(env.V2_MYSQL_SOURCE_PASSWORD), false);
  await assert.rejects(adapter.readRows("unlisted_table"), { code: "MYSQL_TABLE_NOT_ALLOWED" });
});

test("server MySQL source enforces row limits and sanitizes connection failures", async () => {
  const rows = [
      { position_id: "POS-001" },
      { position_id: "POS-002" },
    ],
    limited = createServerMysqlSourceAdapter(
      { ...env, V2_MYSQL_SOURCE_MAX_ROWS: "1" },
      { loader: loaderFor(rows, []) },
    );
  await assert.rejects(limited.readRows("synthetic_positions"), {
    status: 413,
    code: "MYSQL_SOURCE_ROW_LIMIT",
  });
  const failed = createServerMysqlSourceAdapter(env, {
    loader: loaderFor([], [], "ER_ACCESS_DENIED_ERROR"),
  });
  await assert.rejects(failed.probe("synthetic_positions"), (error) => {
    assert.equal(error.code, "ER_ACCESS_DENIED_ERROR");
    assert.equal(error.message.includes(env.V2_MYSQL_SOURCE_HOST), false);
    return true;
  });
});

test("server MySQL source rejects oversized or unsupported row values", async () => {
  const oversized = createServerMysqlSourceAdapter(
    { ...env, V2_MYSQL_SOURCE_MAX_BYTES: "1024" },
    { loader: loaderFor([{ position_id: "P".repeat(1500) }], []) },
  );
  await assert.rejects(oversized.readRows("synthetic_positions"), {
    status: 413,
    code: "MYSQL_SOURCE_BYTE_LIMIT",
  });
  const binary = createServerMysqlSourceAdapter(env, {
    loader: loaderFor([{ position_id: Buffer.from("binary") }], []),
  });
  await assert.rejects(binary.readRows("synthetic_positions"), {
    status: 422,
    code: "MYSQL_SOURCE_VALUE_UNSUPPORTED",
  });
});

test("server MySQL source rejects invalid bounded runtime settings before connecting", () => {
  for (const invalid of [
    { V2_MYSQL_SOURCE_PORT: "70000" },
    { V2_MYSQL_SOURCE_MAX_ROWS: "0" },
    { V2_MYSQL_SOURCE_MAX_BYTES: "999" },
    { V2_MYSQL_SOURCE_QUERY_TIMEOUT_MS: "999" },
  ])
    assert.throws(() =>
      createServerMysqlSourceAdapter(
        { ...env, ...invalid },
        { loader: async () => assert.fail("must not load mysql") },
      ),
    );
});
