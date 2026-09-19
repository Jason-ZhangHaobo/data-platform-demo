import mysql from "mysql2/promise";
import { cloudMetadataConflict } from "./metadata-replica.mjs";

const transientConnectionCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
  "ER_SERVER_SHUTDOWN",
]);

function boundedInteger(value, fallback, { name, min, max }) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw Object.assign(new Error(`云端元数据库参数不合法：${name}`), {
      code: "MYSQL_CONFIG_INVALID",
    });
  return parsed;
}

function safeConnectionError(error, exhausted = false) {
  const sourceCode =
    typeof error?.code === "string" && /^[A-Z0-9_]{2,64}$/.test(error.code)
      ? error.code
      : "MYSQL_CONNECT_FAILED";
  return Object.assign(
    new Error(
      exhausted
        ? "云端元数据库暂不可用，已完成有界重试"
        : "云端元数据库连接失败",
    ),
    {
      code: exhausted ? "MYSQL_CONNECT_RETRIES_EXHAUSTED" : sourceCode,
      transient: transientConnectionCodes.has(sourceCode),
    },
  );
}

export class MySqlMetadataBackend {
  static async open(env = process.env, options = {}) {
    const required = [
      "V2_MYSQL_HOST",
      "V2_MYSQL_USER",
      "V2_MYSQL_PASSWORD",
      "V2_MYSQL_DATABASE",
    ];
    const missing = required.filter((name) => !env[name]);
    if (missing.length)
      throw new Error(`云端元数据库配置缺失：${missing.join(", ")}`);
    const port = boundedInteger(env.V2_MYSQL_PORT, 3306, {
        name: "V2_MYSQL_PORT",
        min: 1,
        max: 65535,
      }),
      connectionLimit = boundedInteger(env.V2_MYSQL_POOL_SIZE, 2, {
        name: "V2_MYSQL_POOL_SIZE",
        min: 1,
        max: 8,
      }),
      connectTimeout = boundedInteger(env.V2_MYSQL_CONNECT_TIMEOUT_MS, 5000, {
        name: "V2_MYSQL_CONNECT_TIMEOUT_MS",
        min: 1000,
        max: 30000,
      }),
      attempts = boundedInteger(env.V2_MYSQL_CONNECT_ATTEMPTS, 6, {
        name: "V2_MYSQL_CONNECT_ATTEMPTS",
        min: 1,
        max: 12,
      }),
      retryDelayMs = boundedInteger(env.V2_MYSQL_RETRY_DELAY_MS, 2000, {
        name: "V2_MYSQL_RETRY_DELAY_MS",
        min: 250,
        max: 5000,
      }),
      createPool = options.createPool ?? mysql.createPool,
      sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      poolConfig = {
        host: env.V2_MYSQL_HOST,
        port,
        user: env.V2_MYSQL_USER,
        password: env.V2_MYSQL_PASSWORD,
        database: env.V2_MYSQL_DATABASE,
        waitForConnections: true,
        connectionLimit,
        queueLimit: 20,
        connectTimeout,
        charset: "utf8mb4",
        enableKeepAlive: true,
        ...(env.V2_MYSQL_SSL === "true"
          ? { ssl: { rejectUnauthorized: true } }
          : {}),
      };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const pool = createPool(poolConfig),
        backend = new MySqlMetadataBackend(pool);
      try {
        await pool.query(
          "CREATE TABLE IF NOT EXISTS v2_project_state (project_id VARCHAR(100) PRIMARY KEY, revision BIGINT NOT NULL, payload LONGTEXT NOT NULL, updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)) CHARACTER SET utf8mb4",
        );
        return backend;
      } catch (error) {
        await pool.end().catch(() => undefined);
        const transient = transientConnectionCodes.has(error?.code);
        if (!transient) throw safeConnectionError(error);
        if (attempt === attempts) throw safeConnectionError(error, true);
        await sleep(Math.min(retryDelayMs * attempt, 10000));
      }
    }
    throw safeConnectionError(undefined, true);
  }

  constructor(pool) {
    this.pool = pool;
  }

  async load(project) {
    const empty = JSON.stringify({
      format: "shuduo-metadata-snapshot/v1",
      projectId: project,
      documents: [],
      idempotency: [],
    });
    await this.pool.execute(
      "INSERT IGNORE INTO v2_project_state(project_id,revision,payload) VALUES(?,0,?)",
      [project, empty],
    );
    const [rows] = await this.pool.execute(
      "SELECT revision,payload FROM v2_project_state WHERE project_id=?",
      [project],
    );
    if (rows.length !== 1) throw new Error("云端元数据项目状态不存在");
    return {
      revision: Number(rows[0].revision),
      payload: JSON.parse(rows[0].payload),
    };
  }

  async compareAndSwap(project, expectedRevision, payload) {
    const [result] = await this.pool.execute(
      "UPDATE v2_project_state SET revision=revision+1,payload=? WHERE project_id=? AND revision=?",
      [JSON.stringify(payload), project, expectedRevision],
    );
    if (result.affectedRows !== 1) throw cloudMetadataConflict();
    return expectedRevision + 1;
  }

  async close() {
    await this.pool.end();
  }
}
