import mysql from "mysql2/promise";
import { cloudMetadataConflict } from "./metadata-replica.mjs";

export class MySqlMetadataBackend {
  static async open(env = process.env) {
    const required = [
      "V2_MYSQL_HOST",
      "V2_MYSQL_USER",
      "V2_MYSQL_PASSWORD",
      "V2_MYSQL_DATABASE",
    ];
    const missing = required.filter((name) => !env[name]);
    if (missing.length)
      throw new Error(`云端元数据库配置缺失：${missing.join(", ")}`);
    const backend = new MySqlMetadataBackend(
      mysql.createPool({
        host: env.V2_MYSQL_HOST,
        port: Number(env.V2_MYSQL_PORT ?? 3306),
        user: env.V2_MYSQL_USER,
        password: env.V2_MYSQL_PASSWORD,
        database: env.V2_MYSQL_DATABASE,
        waitForConnections: true,
        connectionLimit: Number(env.V2_MYSQL_POOL_SIZE ?? 2),
        queueLimit: 20,
        connectTimeout: Number(env.V2_MYSQL_CONNECT_TIMEOUT_MS ?? 5000),
        charset: "utf8mb4",
        enableKeepAlive: true,
        ...(env.V2_MYSQL_SSL === "true"
          ? { ssl: { rejectUnauthorized: true } }
          : {}),
      }),
    );
    await backend.pool.query(
      "CREATE TABLE IF NOT EXISTS v2_project_state (project_id VARCHAR(100) PRIMARY KEY, revision BIGINT NOT NULL, payload LONGTEXT NOT NULL, updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)) CHARACTER SET utf8mb4",
    );
    return backend;
  }

  constructor(pool) {
    this.pool = pool;
  }

  async load(project) {
    const empty = JSON.stringify({
      format: "shuzhan-metadata-snapshot/v1",
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
