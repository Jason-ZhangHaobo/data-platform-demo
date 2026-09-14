import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { runSpark, runtimeConfig } from "./spark.mjs";
import {
  remoteSparkProtocol,
  verifySparkRequest,
} from "./remote-spark.mjs";

const PROJECT = "project-securities-lab";
const allowedTables = new Set(["accounts", "positions", "cash"]);

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });

const integer = (value, fallback, min, max, name) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`${name}配置不合法`);
  return result;
};

const validateSecret = (value) => {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 512 ||
    /\s/.test(value)
  )
    throw new Error("Spark Worker共享密钥必须是32—512字符且不含空白");
  return value;
};

const validateContext = (context) => {
  if (
    !context ||
    typeof context !== "object" ||
    typeof context.id !== "string" ||
    context.id.length > 120 ||
    !Array.isArray(context.tables) ||
    context.tables.length < 1 ||
    context.tables.length > 4 ||
    !Array.isArray(context.expected) ||
    context.expected.length > 1000
  )
    throw fail(422, "Spark上下文结构不合法", "INVALID_SPARK_CONTEXT");
  for (const table of context.tables) {
    if (
      !table ||
      !allowedTables.has(table.name) ||
      !Array.isArray(table.columns) ||
      table.columns.length < 1 ||
      table.columns.length > 50 ||
      !Array.isArray(table.rows) ||
      table.rows.length > 1000 ||
      table.rows.some(
        (row) => !Array.isArray(row) || row.length !== table.columns.length,
      )
    )
      throw fail(422, "Spark表上下文不在许可范围", "INVALID_SPARK_TABLE");
  }
  return context;
};

const validatePayload = (value) => {
  const keys = Object.keys(value ?? {}),
    allowed = new Set([
      "protocol",
      "requestId",
      "submittedAt",
      "sql",
      "context",
      "validationContexts",
      "testSql",
    ]);
  if (
    !value ||
    typeof value !== "object" ||
    keys.some((key) => !allowed.has(key)) ||
    value.protocol !== remoteSparkProtocol ||
    !/^[a-f0-9-]{36}$/.test(String(value.requestId)) ||
    Number.isNaN(Date.parse(value.submittedAt)) ||
    typeof value.sql !== "string" ||
    value.sql.length < 1 ||
    value.sql.length > 100_000 ||
    (value.testSql !== undefined &&
      (typeof value.testSql !== "string" || value.testSql.length > 100_000)) ||
    !Array.isArray(value.validationContexts) ||
    value.validationContexts.length > 5
  )
    throw fail(422, "Spark执行请求格式不合法", "INVALID_SPARK_REQUEST");
  validateContext(value.context);
  value.validationContexts.forEach(validateContext);
  return value;
};

const response = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
};

export function createRemoteSparkWorker(options = {}) {
  const env = options.env ?? process.env,
    sharedSecret = validateSecret(env.V2_SPARK_WORKER_SECRET),
    maxBodyBytes = integer(
      env.V2_SPARK_WORKER_MAX_BODY_BYTES,
      2 * 1024 * 1024,
      1024,
      8 * 1024 * 1024,
      "Spark Worker请求上限",
    ),
    maxSkewMs = integer(
      env.V2_SPARK_WORKER_MAX_SKEW_MS,
      60_000,
      5_000,
      300_000,
      "Spark Worker签名时钟偏差",
    ),
    now = options.now ?? Date.now,
    runtime = options.runtime ?? runtimeConfig(env),
    runner = options.runner ?? ((input) => runSpark(input, runtime)),
    nonces = new Map();
  let active = 0;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health")
        return response(res, 200, {
          status: "ok",
          engine: "Apache Spark",
          isolation: "FUNCTION_PROCESS",
          runtimeAvailable: options.runner ? true : runtime.available,
          active,
        });
      if (req.method !== "POST" || req.url !== "/v1/execute")
        throw fail(404, "接口不存在", "SPARK_WORKER_NOT_FOUND");
      if (!String(req.headers["content-type"]).startsWith("application/json"))
        throw fail(415, "Spark Worker只接受JSON", "SPARK_WORKER_JSON_REQUIRED");
      if (req.headers["x-project-id"] !== PROJECT)
        throw fail(403, "Spark项目不匹配", "SPARK_PROJECT_FORBIDDEN");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > maxBodyBytes)
          throw fail(413, "Spark请求超过大小上限", "SPARK_REQUEST_TOO_LARGE");
      }
      const timestamp = req.headers["x-shuzhan-timestamp"],
        nonce = req.headers["x-shuzhan-nonce"],
        signature = req.headers["x-shuzhan-signature"],
        current = now();
      for (const [key, expiresAt] of nonces)
        if (expiresAt <= current) nonces.delete(key);
      if (
        !verifySparkRequest({
          sharedSecret,
          timestamp,
          nonce,
          body,
          signature,
          now: current,
          maxSkewMs,
        })
      )
        throw fail(401, "Spark请求签名无效", "SPARK_SIGNATURE_INVALID");
      if (nonces.has(nonce))
        throw fail(409, "Spark请求随机数已使用", "SPARK_NONCE_REPLAYED");
      nonces.set(nonce, current + maxSkewMs);
      if (active >= 1)
        throw fail(429, "Spark Worker当前已有运行任务", "SPARK_WORKER_BUSY");
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw fail(400, "Spark请求JSON不合法", "INVALID_SPARK_JSON");
      }
      const input = validatePayload(parsed),
        controller = new AbortController(),
        cancel = () => {
          if (!res.writableEnded) controller.abort();
        };
      res.on("close", cancel);
      active++;
      try {
        const output = await runner({
            sql: input.sql,
            context: input.context,
            validationContexts: input.validationContexts,
            testSql: input.testSql,
            timeoutMs: integer(
              env.V2_SPARK_WORKER_RUN_TIMEOUT_MS,
              120_000,
              1000,
              300_000,
              "Spark Worker运行超时",
            ),
            signal: controller.signal,
          }),
          { directory: _privateDirectory, ...safe } = output;
        if (!res.writableEnded)
          return response(res, 200, {
            ...safe,
            requestId: input.requestId,
            isolation: "FUNCTION_PROCESS",
          });
      } finally {
        active--;
        res.off("close", cancel);
      }
    } catch (error) {
      if (!res.writableEnded)
        return response(res, error.status ?? 500, {
          message: error.status ? error.message : "Spark Worker执行失败",
          ...(typeof error.code === "string" ? { code: error.code } : {}),
        });
    }
  });
  return { server, runtime, nonces, status: () => ({ active }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createRemoteSparkWorker(),
    port = Number(process.env.FC_CUSTOM_LISTEN_PORT ?? process.env.PORT ?? 9000),
    host = process.env.HOST ?? "0.0.0.0";
  app.server.listen(port, host, () =>
    process.stdout.write(`Shuzhan isolated Spark worker ready on ${host}:${port}\n`),
  );
  const close = () => app.server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
