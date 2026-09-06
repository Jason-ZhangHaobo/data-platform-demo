import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CsvMySqlConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CsvMySqlConfigurationError";
    this.status = 503;
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field); field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else field += character;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  if (field !== "" || row.length) { row.push(field); if (row.some((value) => value.trim() !== "")) rows.push(row); }
  if (rows.length < 2) throw new Error("CSV 至少需要一行表头和一行数据");
  const headers = rows[0].map((value) => value.trim());
  if (headers.some((header) => !identifierPattern.test(header))) throw new Error("CSV 表头只能包含字母、数字和下划线，且不能以数字开头");
  if (new Set(headers).size !== headers.length) throw new Error("CSV 表头不能重复");
  return { headers, rows: rows.slice(1).map((values) => headers.map((_header, index) => values[index] ?? "")) };
}

export function parseTargetTable(targetName, database) {
  const parts = String(targetName ?? "").split(".");
  const table = parts.at(-1);
  const targetDatabase = parts.length > 1 ? parts.at(-2) : database;
  if (!identifierPattern.test(table) || !identifierPattern.test(targetDatabase)) throw new Error("目标表名只能包含字母、数字和下划线");
  if (targetDatabase !== database) throw new Error(`目标数据库必须是 ${database}`);
  return table;
}

export function mysqlConfigFromEnvironment(env = process.env) {
  const required = ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new CsvMySqlConfigurationError(`真实同步配置缺失：${missing.join(", ")}`);
  return {
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT ?? 3306),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectTimeout: 8_000,
  };
}

export async function createCsvMySqlSyncService(options = {}) {
  const mysql = options.mysql ?? await import("mysql2/promise");
  const config = options.config ?? mysqlConfigFromEnvironment();
  const clientDirectory = options.clientDirectory ?? resolve(process.cwd(), "src/client");
  return {
    async runTask(task) {
      const filePath = resolve(clientDirectory, "..", "shared", task.sourceName);
      const csv = parseCsv(await readFile(filePath, "utf8"));
      const table = parseTargetTable(task.targetName, config.database);
      const connection = await mysql.createConnection(config);
      try {
        const columns = csv.headers.map((header) => `\`${header}\` TEXT`).join(", ");
        await connection.query(`CREATE TABLE IF NOT EXISTS \`${table}\` (${columns})`);
        if (task.syncMode === "FULL") await connection.query(`TRUNCATE TABLE \`${table}\``);
        const placeholders = csv.headers.map(() => "?").join(", ");
        const columnList = csv.headers.map((header) => `\`${header}\``).join(", ");
        for (const values of csv.rows) await connection.execute(`INSERT INTO \`${table}\` (${columnList}) VALUES (${placeholders})`, values);
        return { rowsRead: csv.rows.length, rowsWritten: csv.rows.length, message: `真实 CSV 已写入 MySQL 表 ${config.database}.${table}。` };
      } finally { await connection.end(); }
    },
  };
}
