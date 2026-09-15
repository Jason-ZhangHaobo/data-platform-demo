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
    credentialMode: "SERVER_ENV_ONLY",
  };
}

export function createServerMysqlSourceAdapter(env = process.env, options = {}) {
  const status = mysqlSourceStatus(env),
    loader = options.loader ?? (() => import("mysql2/promise"));
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
      port: Number(env.V2_MYSQL_SOURCE_PORT ?? 3306),
      user: env.V2_MYSQL_SOURCE_USER,
      password: env.V2_MYSQL_SOURCE_PASSWORD,
      database: env.V2_MYSQL_SOURCE_DATABASE,
      connectTimeout: 5000,
      ssl: env.V2_MYSQL_SOURCE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    });
  };
  return {
    ...status,
    async probe(tableName) {
      assertTable(tableName);
      const connection = await connect();
      try {
        const [versionRows] = await connection.query("SELECT VERSION() AS server_version");
        return { status: "CONNECTED", serverVersion: String(versionRows?.[0]?.server_version ?? "unknown") };
      } finally {
        await connection.end();
      }
    },
    async describe(tableName) {
      assertTable(tableName);
      const connection = await connect();
      try {
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
      } finally {
        await connection.end();
      }
    },
  };
}
