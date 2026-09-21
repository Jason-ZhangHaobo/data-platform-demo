import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runSpark, runtimeConfig } from "./spark.mjs";
import {
  remoteSparkProtocol,
  signSparkRequest,
  verifySparkRequest,
} from "./remote-spark.mjs";
import { privateSparkSmokePayload } from "./spark-worker-private-smoke.mjs";
import {
  consumeQueuedSparkJob,
  ossSparkQueueTransportFromEnvironment,
  queueConfigFromEnvironment,
} from "./remote-spark-queue.mjs";

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

export function queueJobKeyFromOssEvent(event, config, bucket) {
  const item = event?.events?.[0],
    rawKey = item?.oss?.object?.key;
  if (
    !event || typeof event !== "object" || !Array.isArray(event.events) ||
    event.events.length !== 1 || item?.eventSource !== "acs:oss" ||
    item?.eventName !== "ObjectCreated:PutObject" ||
    item?.region !== "cn-hangzhou" || item?.oss?.bucket?.name !== bucket ||
    typeof rawKey !== "string"
  ) throw fail(422, "Spark队列OSS事件格式不合法", "SPARK_QUEUE_EVENT_INVALID");
  let key;
  try { key = decodeURIComponent(rawKey); } catch { throw fail(422, "Spark队列OSS对象键编码不合法", "SPARK_QUEUE_EVENT_INVALID"); }
  if (!key.startsWith(`${config.jobPrefix}/`) || !key.endsWith(".json") || key.endsWith(".cancel.json"))
    throw fail(422, "Spark队列OSS对象键不在许可范围", "SPARK_QUEUE_EVENT_INVALID");
  return key;
}

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
    privateInvokeEnabled = env.V2_SPARK_WORKER_PRIVATE_SMOKE_ENABLED === "true",
    queueEnabled = env.V2_SPARK_QUEUE_CONSUMER_ENABLED === "true",
    queueConfig = options.queueConfig ?? (queueEnabled
      ? queueConfigFromEnvironment({
          ...env,
          V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE",
          V2_SPARK_EXECUTOR_SECRET: sharedSecret,
        })
      : undefined),
    queueTransport = options.queueTransport ?? (queueConfig
      ? ossSparkQueueTransportFromEnvironment(env)
      : undefined),
    nonces = new Map();
  let active = 0;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/invoke") {
        if (!privateInvokeEnabled && !queueConfig)
          throw fail(404, "接口不存在", "SPARK_WORKER_NOT_FOUND");
        if (
          !String(req.headers["content-type"]).startsWith(
            "application/octet-stream",
          )
        )
          throw fail(
            415,
            "私有Spark烟测只接受二进制事件载荷",
            "SPARK_PRIVATE_EVENT_REQUIRED",
          );
        let eventBody = "";
        for await (const chunk of req) {
          eventBody += chunk;
          if (Buffer.byteLength(eventBody, "utf8") > maxBodyBytes + 4096)
            throw fail(
              413,
              "私有Spark烟测载荷过大",
              "SPARK_PRIVATE_EVENT_TOO_LARGE",
            );
        }
        let event;
        try {
          event = JSON.parse(eventBody || "{}");
        } catch {
          throw fail(
            400,
            "私有Spark烟测事件不是JSON",
            "SPARK_PRIVATE_EVENT_INVALID",
          );
        }
        if (queueConfig && queueTransport && event?.events) {
          const jobKey = queueJobKeyFromOssEvent(
            event,
            queueConfig,
            queueTransport.config.bucket,
          );
          const queued = await consumeQueuedSparkJob({
            jobKey,
            config: queueConfig,
            transport: queueTransport,
            runner,
            now,
          });
          return response(res, 202, {
            protocol: "shuduo-spark-queue-trigger/v1",
            status: queued.status,
            jobId: queued.jobId,
            publicReady: false,
          });
        }
        const keys = Object.keys(event ?? {}),
          allowed = new Set([
            "operation",
            "projectId",
            "timestamp",
            "nonce",
            "signature",
            "body",
          ]);
        if (
          !event ||
          typeof event !== "object" ||
          Array.isArray(event) ||
          keys.some((key) => !allowed.has(key))
        )
          throw fail(
            422,
            "私有Spark烟测事件格式不合法",
            "SPARK_PRIVATE_EVENT_INVALID",
          );
        const address = server.address();
        if (!address || typeof address === "string")
          throw fail(
            503,
            "Spark Worker内部接口尚未就绪",
            "SPARK_PRIVATE_FORWARD_UNAVAILABLE",
          );
        if (event.operation === "PRIVATE_HEALTH_V1") {
          if (keys.length !== 1)
            throw fail(
              422,
              "私有Spark健康事件字段不合法",
              "SPARK_PRIVATE_EVENT_INVALID",
            );
          const healthResponse = await fetch(
              `http://127.0.0.1:${address.port}/health`,
              { signal: AbortSignal.timeout(5000), redirect: "error" },
            ),
            health = await healthResponse.json();
          if (!healthResponse.ok)
            throw fail(
              503,
              "Spark Worker健康检查失败",
              "SPARK_PRIVATE_HEALTH_FAILED",
            );
          return response(res, 200, {
            protocol: "shuduo-spark-private-smoke/v1",
            status: health.status,
            engine: health.engine,
            isolation: health.isolation,
            runtimeAvailable: health.runtimeAvailable === true,
            publicReady: false,
          });
        }
        const fixedSmoke = event.operation === "PRIVATE_SPARK_SMOKE_V1";
        let executionEvent = event;
        if (fixedSmoke && keys.length === 1) {
          const timestamp = String(now()),
            body = JSON.stringify(
              privateSparkSmokePayload({
                requestId: randomUUID(),
                submittedAt: new Date(Number(timestamp)).toISOString(),
              }),
            ),
            nonce = randomBytes(24).toString("base64url");
          executionEvent = {
            operation: "SIGNED_EXECUTE_V1",
            projectId: PROJECT,
            timestamp,
            nonce,
            signature: signSparkRequest({
              sharedSecret,
              timestamp,
              nonce,
              body,
            }),
            body,
          };
        }
        if (
          executionEvent.operation !== "SIGNED_EXECUTE_V1" ||
          Object.keys(executionEvent).length !== 6 ||
          executionEvent.projectId !== PROJECT ||
          typeof executionEvent.timestamp !== "string" ||
          typeof executionEvent.nonce !== "string" ||
          typeof executionEvent.signature !== "string" ||
          typeof executionEvent.body !== "string" ||
          Buffer.byteLength(executionEvent.body, "utf8") > maxBodyBytes
        )
          throw fail(
            422,
            "私有Spark执行事件格式不合法",
            "SPARK_PRIVATE_EVENT_INVALID",
          );
        const controller = new AbortController(),
          cancel = () => controller.abort(),
          timer = setTimeout(
            cancel,
            integer(
              env.V2_SPARK_WORKER_RUN_TIMEOUT_MS,
              120_000,
              1000,
              300_000,
              "Spark Worker运行超时",
            ) + 5000,
          );
        res.on("close", cancel);
        try {
          const forwarded = await fetch(
              `http://127.0.0.1:${address.port}/v1/execute`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Project-Id": executionEvent.projectId,
                  "X-Shuduo-Timestamp": executionEvent.timestamp,
                  "X-Shuduo-Nonce": executionEvent.nonce,
                  "X-Shuduo-Signature": executionEvent.signature,
                },
                body: executionEvent.body,
                signal: controller.signal,
                redirect: "error",
              },
            ),
            forwardedText = await forwarded.text();
          if (Buffer.byteLength(forwardedText, "utf8") > maxBodyBytes)
            throw fail(
              502,
              "私有Spark执行响应过大",
              "SPARK_PRIVATE_RESPONSE_TOO_LARGE",
            );
          let value;
          try {
            value = JSON.parse(forwardedText);
          } catch {
            throw fail(
              502,
              "私有Spark执行响应无法解析",
              "SPARK_PRIVATE_RESPONSE_INVALID",
            );
          }
          if (fixedSmoke && forwarded.ok)
            return response(res, 200, {
              protocol: "shuduo-spark-private-smoke/v1",
              status: value.status,
              engine: value.engine,
              engineVersion: value.engineVersion,
              isolation: value.isolation,
              validationPassed: value.validation?.passed === true,
              testSqlPassed:
                value.testSqlValidation === undefined
                  ? null
                  : value.testSqlValidation?.passed === true,
              regressionCount: value.validation?.regressions?.length ?? 0,
              publicReady: false,
            });
          return response(res, forwarded.status, value);
        } catch (error) {
          if (controller.signal.aborted)
            throw fail(
              504,
              "私有Spark执行超时或已取消",
              "SPARK_PRIVATE_FORWARD_TIMEOUT",
            );
          throw error;
        } finally {
          clearTimeout(timer);
          res.off("close", cancel);
        }
      }
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
      const timestamp = req.headers["x-shuduo-timestamp"],
        nonce = req.headers["x-shuduo-nonce"],
        signature = req.headers["x-shuduo-signature"],
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
      if (env.V2_SPARK_WORKER_DIAGNOSTICS === "true")
        console.error(
          "Spark Worker synthetic diagnostic: " +
            String(error?.message ?? "unknown error").slice(-2000),
        );
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
    process.stdout.write(`Shuduo isolated Spark worker ready on ${host}:${port}\n`),
  );
  const close = () => app.server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
