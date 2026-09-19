import { createHash } from "node:crypto";

const profileId = "server-mysql-synthetic";
const identifier = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(value);
const configured = (env) =>
  [
    env.V2_MYSQL_SOURCE_HOST,
    env.V2_MYSQL_SOURCE_USER,
    env.V2_MYSQL_SOURCE_PASSWORD,
    env.V2_MYSQL_SOURCE_DATABASE,
  ].every((value) => typeof value === "string" && value.length > 0);

export function mysqlSourceStatus(env = process.env) {
  const allowTables = String(env.V2_MYSQL_SOURCE_TABLE_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(identifier);
  return {
    profileId,
    configured: configured(env) && allowTables.length > 0,
    allowTables,
    supportsOfflineSync:
      configured(env) &&
      allowTables.length > 0 &&
      env.V2_MYSQL_SOURCE_SYNC_ENABLED === "true",
    credentialMode: "SERVER_ENV_ONLY",
  };
}

export function createServerMysqlSourceAdapter(env = process.env, options = {}) {
  const status = mysqlSourceStatus(env),
    loader = options.loader ?? (() => import("mysql2/promise")),
    port = Number(env.V2_MYSQL_SOURCE_PORT ?? 3306),
    maxRows = Number(env.V2_MYSQL_SOURCE_MAX_ROWS ?? 5000),
    maxBytes = Number(env.V2_MYSQL_SOURCE_MAX_BYTES ?? 4 * 1024 * 1024),
    queryTimeoutMs = Number(env.V2_MYSQL_SOURCE_QUERY_TIMEOUT_MS ?? 15000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("服务端MySQL端口不合法");
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000)
    throw new Error("服务端MySQL最大读取行数不合法");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024)
    throw new Error("服务端MySQL最大读取字节数不合法");
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1000 || queryTimeoutMs > 60000)
    throw new Error("服务端MySQL查询超时不合法");
  const safeError = (error, fallback = "MYSQL_SOURCE_FAILED") =>
    Object.assign(new Error("服务端MySQL操作失败"), {
      status: 503,
      code:
        typeof error?.code === "string" && /^[A-Z0-9_]{2,64}$/.test(error.code)
          ? error.code
          : fallback,
    });
  const assertTable = (tableName) => {
    if (!status.configured)
      throw Object.assign(new Error("服务端MySQL数据源尚未配置"), { status: 503, code: "MYSQL_SOURCE_NOT_CONFIGURED" });
    if (!status.allowTables.includes(tableName))
      throw Object.assign(new Error("MySQL数据表不在服务端白名单中"), { status: 422, code: "MYSQL_TABLE_NOT_ALLOWED" });
  };
  const connect = async () => {
    const mysql = await loader();
    return mysql.createConnection({
      host: env.V2_MYSQL_SOURCE_HOST,
      port,
      user: env.V2_MYSQL_SOURCE_USER,
      password: env.V2_MYSQL_SOURCE_PASSWORD,
      database: env.V2_MYSQL_SOURCE_DATABASE,
      connectTimeout: 5000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      ssl: env.V2_MYSQL_SOURCE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    });
  };
  const withConnection = async (action) => {
    let connection;
    try {
      connection = await connect();
      return await action(connection);
    } catch (error) {
      if (Number.isInteger(error?.status) && typeof error?.code === "string")
        throw error;
      throw safeError(error);
    } finally {
      if (connection) await connection.end().catch(() => undefined);
    }
  };
  const normalizeValue = (value) => {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (typeof value === "bigint") return value.toString();
    throw Object.assign(new Error("服务端MySQL字段类型不受同步支持"), {
      status: 422,
      code: "MYSQL_SOURCE_VALUE_UNSUPPORTED",
    });
  };
  return {
    ...status,
    async probe(tableName) {
      assertTable(tableName);
      return withConnection(async (connection) => {
        const [versionRows] = await connection.query("SELECT VERSION() AS server_version");
        return { status: "CONNECTED", serverVersion: String(versionRows?.[0]?.server_version ?? "unknown") };
      });
    },
    async describe(tableName) {
      assertTable(tableName);
      return withConnection(async (connection) => {
        const [columns] = await connection.execute(
          "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, ORDINAL_POSITION AS ordinal FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
          [tableName],
        );
        const [countRows] = await connection.query(`SELECT COUNT(*) AS row_count FROM \`${tableName}\``);
        return {
          tableName,
          rowCount: Number(countRows?.[0]?.row_count ?? 0),
          columns: columns.map((column) => ({
            name: String(column.name),
            ordinal: Number(column.ordinal),
            type: String(column.type).toUpperCase(),
            nullable: String(column.nullable).toUpperCase() === "YES",
          })),
        };
      });
    },
    async readRows(tableName) {
      assertTable(tableName);
      if (!status.supportsOfflineSync)
        throw Object.assign(new Error("服务端MySQL同步尚未启用"), {
          status: 409,
          code: "MYSQL_SYNC_NOT_ENABLED",
        });
      return withConnection(async (connection) => {
        const [rows] = await connection.query({
          sql: `SELECT * FROM \`${tableName}\` LIMIT ${maxRows + 1}`,
          timeout: queryTimeoutMs,
        });
        if (!Array.isArray(rows)) throw safeError(undefined, "MYSQL_SOURCE_ROWS_INVALID");
        if (rows.length > maxRows)
          throw Object.assign(new Error("服务端MySQL读取超过行数上限"), {
            status: 413,
            code: "MYSQL_SOURCE_ROW_LIMIT",
          });
        const normalized = rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
          ),
        );
        const body = JSON.stringify(normalized);
        if (Buffer.byteLength(body, "utf8") > maxBytes)
          throw Object.assign(new Error("服务端MySQL读取超过字节上限"), {
            status: 413,
            code: "MYSQL_SOURCE_BYTE_LIMIT",
          });
        return {
          rows: normalized,
          rowCount: normalized.length,
          contentHash: createHash("sha256").update(body).digest("hex"),
          strategy: "BOUNDED_SNAPSHOT",
        };
      });
    },
  };
}
