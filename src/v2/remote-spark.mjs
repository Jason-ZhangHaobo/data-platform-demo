import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const PROTOCOL = "shuzhan-spark-execution/v1";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });

const boundedInteger = (value, fallback, min, max, name) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`${name}配置不合法`);
  return result;
};

const secureEndpoint = (value, allowInsecure) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("远程Spark执行地址不合法");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(allowInsecure && loopback))
    throw new Error("远程Spark执行必须使用HTTPS；仅测试回环地址可显式使用HTTP");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("远程Spark执行地址不能包含凭证、查询或片段");
  url.pathname = url.pathname.replace(/\/$/, "") + "/v1/execute";
  return url.toString();
};

const secret = (value) => {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 512 ||
    value.trim() !== value ||
    /\s/.test(value)
  )
    throw new Error("远程Spark共享密钥必须是32—512字符且不含空白");
  return value;
};

const bodyHash = (body) =>
  createHash("sha256").update(body, "utf8").digest("hex");

export function signSparkRequest({ sharedSecret, timestamp, nonce, body }) {
  return (
    "v1=" +
    createHmac("sha256", sharedSecret)
      .update(`${timestamp}\n${nonce}\n${bodyHash(body)}`, "utf8")
      .digest("hex")
  );
}

export function verifySparkRequest({
  sharedSecret,
  timestamp,
  nonce,
  body,
  signature,
  now = Date.now(),
  maxSkewMs = 60_000,
}) {
  if (!/^\d{13}$/.test(String(timestamp))) return false;
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(nonce))) return false;
  if (Math.abs(now - Number(timestamp)) > maxSkewMs) return false;
  const expected = signSparkRequest({ sharedSecret, timestamp, nonce, body }),
    actual = String(signature ?? "");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

const validateResult = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    !["SUCCEEDED", "FAILED", "VALIDATION_FAILED"].includes(value.status) ||
    value.engine !== "Apache Spark" ||
    typeof value.engineVersion !== "string" ||
    value.engineVersion.length > 40
  )
    throw fail(502, "远程Spark返回了无效结果", "REMOTE_SPARK_INVALID_RESULT");
  if (value.status === "SUCCEEDED" && !value.validation?.passed)
    throw fail(502, "远程Spark缺少独立断言证据", "REMOTE_SPARK_INVALID_RESULT");
  return value;
};

export class RemoteSparkClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async health() {
    const endpoint = new URL(this.config.endpoint);
    endpoint.pathname = endpoint.pathname.replace(/\/v1\/execute$/, "/health");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort("timeout"), 5000);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: { "X-Project-Id": this.config.projectId },
        signal: controller.signal,
        redirect: "error",
        }),
        value = await response.json();
      if (
        !response.ok ||
        value?.status !== "ok" ||
        value?.engine !== "Apache Spark" ||
        value?.runtimeAvailable !== true ||
        value?.isolation !== "FUNCTION_PROCESS"
      )
        throw fail(503, "隔离Spark Worker尚未就绪", "REMOTE_SPARK_NOT_READY");
      return value;
    } catch (error) {
      if (controller.signal.aborted)
        throw fail(504, "隔离Spark Worker健康检查超时", "REMOTE_SPARK_HEALTH_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(input) {
    if (input.signal?.aborted)
      throw fail(499, "运行已取消", "REMOTE_SPARK_CANCELLED");
    const requestId = randomUUID(),
      submittedAt = new Date().toISOString(),
      body = JSON.stringify({
        protocol: PROTOCOL,
        requestId,
        submittedAt,
        sql: input.sql,
        context: input.context,
        validationContexts: input.validationContexts ?? [],
        ...(input.testSql === undefined ? {} : { testSql: input.testSql }),
      });
    if (Buffer.byteLength(body, "utf8") > this.config.maxRequestBytes)
      throw fail(413, "远程Spark请求超过大小上限", "REMOTE_SPARK_REQUEST_TOO_LARGE");
    const timestamp = String(Date.now()),
      nonce = randomBytes(24).toString("base64url"),
      signature = signSparkRequest({
        sharedSecret: this.config.sharedSecret,
        timestamp,
        nonce,
        body,
      }),
      controller = new AbortController(),
      onAbort = () => controller.abort(input.signal?.reason),
      timeoutMs = Math.min(
        input.timeoutMs ?? this.config.timeoutMs,
        this.config.timeoutMs,
      ),
      timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Project-Id": this.config.projectId,
          "X-Shuzhan-Timestamp": timestamp,
          "X-Shuzhan-Nonce": nonce,
          "X-Shuzhan-Signature": signature,
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > this.config.maxResponseBytes)
        throw fail(502, "远程Spark响应超过大小上限", "REMOTE_SPARK_RESPONSE_TOO_LARGE");
      const responseText = await response.text();
      if (Buffer.byteLength(responseText, "utf8") > this.config.maxResponseBytes)
        throw fail(502, "远程Spark响应超过大小上限", "REMOTE_SPARK_RESPONSE_TOO_LARGE");
      let value;
      try {
        value = JSON.parse(responseText);
      } catch {
        throw fail(502, "远程Spark响应不是有效JSON", "REMOTE_SPARK_INVALID_RESPONSE");
      }
      if (!response.ok)
        throw fail(
          response.status,
          typeof value.message === "string" ? value.message : "远程Spark执行失败",
          typeof value.code === "string" ? value.code : "REMOTE_SPARK_FAILED",
        );
      return validateResult(value);
    } catch (error) {
      if (controller.signal.aborted) {
        if (input.signal?.aborted)
          throw fail(499, "运行已取消", "REMOTE_SPARK_CANCELLED");
        throw fail(504, "远程Spark执行超时", "REMOTE_SPARK_TIMEOUT");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function remoteSparkConfigFromEnvironment(env = process.env) {
  if (!env.V2_SPARK_EXECUTOR_URL) return undefined;
  return {
    endpoint: secureEndpoint(
      env.V2_SPARK_EXECUTOR_URL,
      env.V2_ALLOW_INSECURE_SPARK_EXECUTOR === "true",
    ),
    sharedSecret: secret(env.V2_SPARK_EXECUTOR_SECRET),
    projectId: env.V2_PROJECT_ID ?? "project-securities-lab",
    timeoutMs: boundedInteger(
      env.V2_SPARK_EXECUTOR_TIMEOUT_MS,
      120_000,
      1000,
      300_000,
      "远程Spark超时",
    ),
    maxRequestBytes: boundedInteger(
      env.V2_SPARK_EXECUTOR_MAX_REQUEST_BYTES,
      DEFAULT_MAX_BYTES,
      1024,
      8 * 1024 * 1024,
      "远程Spark请求上限",
    ),
    maxResponseBytes: boundedInteger(
      env.V2_SPARK_EXECUTOR_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_BYTES,
      1024,
      8 * 1024 * 1024,
      "远程Spark响应上限",
    ),
  };
}

export function createRemoteSparkRunner(env = process.env, fetchImpl = fetch) {
  const config = remoteSparkConfigFromEnvironment(env);
  if (!config) return undefined;
  const client = new RemoteSparkClient(config, fetchImpl),
    runner = (input) => client.execute(input);
  runner.descriptor = {
    engine: "Apache Spark",
    isolation: "REMOTE_FUNCTION",
    endpointConfigured: true,
    healthVerified: false,
    publicWriteEnabled: false,
  };
  runner.verify = async () => {
    const status = await client.health();
    runner.descriptor.healthVerified = true;
    runner.descriptor.publicWriteEnabled = true;
    runner.descriptor.verifiedAt = new Date().toISOString();
    return status;
  };
  return runner;
}

export const remoteSparkProtocol = PROTOCOL;
