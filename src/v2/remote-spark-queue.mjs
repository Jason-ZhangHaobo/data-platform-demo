import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createOssRequest, ossConfigFromEnvironment } from "./oss-client.mjs";
import { requestOssWithRetry } from "./oss-request-retry.mjs";

export const remoteSparkQueueJobSchema = "shuduo-spark-queue-job/v1";
export const remoteSparkQueueResultSchema = "shuduo-spark-queue-result/v1";
export const remoteSparkQueueCancelSchema = "shuduo-spark-queue-cancel/v1";
export const SPARK_QUEUE_PREFIXES = Object.freeze({
  jobs: "data-platform-demo/v2/spark-queue/jobs",
  results: "data-platform-demo/v2/spark-queue/results",
  cancellations: "data-platform-demo/v2/spark-queue/cancellations",
});
const protocol = "shuduo-spark-execution/v1";
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const bodyHash = (body) => createHash("sha256").update(body, "utf8").digest("hex");
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{2,180}$/;
const idPattern = /^[0-9a-f-]{36}$/;

const validSecret = (value) =>
  typeof value === "string" && value.length >= 32 && value.length <= 512 && value.trim() === value && !/\s/.test(value);

const equal = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
};

export function queueConfigFromEnvironment(env = process.env) {
  if (env.V2_SPARK_EXECUTOR_TRANSPORT !== "OSS_QUEUE") return undefined;
  const jobPrefix = env.V2_SPARK_QUEUE_JOB_PREFIX ?? SPARK_QUEUE_PREFIXES.jobs;
  const resultPrefix = env.V2_SPARK_QUEUE_RESULT_PREFIX ?? SPARK_QUEUE_PREFIXES.results;
  const cancellationPrefix = env.V2_SPARK_QUEUE_CANCELLATION_PREFIX ?? SPARK_QUEUE_PREFIXES.cancellations;
  const timeoutMs = Number(env.V2_SPARK_QUEUE_TIMEOUT_MS ?? 180000);
  const pollMs = Number(env.V2_SPARK_QUEUE_POLL_MS ?? 1000);
  const readyJobId = env.V2_SPARK_QUEUE_READY_JOB_ID;
  const readyMaxAgeMs = Number(env.V2_SPARK_QUEUE_READY_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000);
  const prefixes = [jobPrefix, resultPrefix, cancellationPrefix];
  if (prefixes.some((prefix) => !keyPattern.test(prefix) || prefix.endsWith("/")) ||
      prefixes.some((prefix, index) => prefixes.some((other, otherIndex) =>
        index !== otherIndex && (prefix === other || prefix.startsWith(`${other}/`)))))
    throw new Error("Spark OSS队列前缀不合法");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error("Spark OSS队列超时不合法");
  if (!Number.isSafeInteger(pollMs) || pollMs < 200 || pollMs > 5000)
    throw new Error("Spark OSS队列轮询间隔不合法");
  if (readyJobId !== undefined && !idPattern.test(readyJobId))
    throw new Error("Spark OSS队列就绪批次不合法");
  if (!Number.isSafeInteger(readyMaxAgeMs) || readyMaxAgeMs < 60000 || readyMaxAgeMs > 7 * 24 * 60 * 60 * 1000)
    throw new Error("Spark OSS队列就绪证据有效期不合法");
  if (!validSecret(env.V2_SPARK_EXECUTOR_SECRET))
    throw new Error("远程Spark共享密钥必须是32—512字符且不含空白");
  return {
    jobPrefix,
    resultPrefix,
    cancellationPrefix,
    timeoutMs,
    pollMs,
    readyJobId,
    readyMaxAgeMs,
    sharedSecret: env.V2_SPARK_EXECUTOR_SECRET,
    projectId: env.V2_PROJECT_ID ?? "project-securities-lab",
  };
}

const resultSignature = (secret, jobId, body) =>
  "v1=" + createHmac("sha256", secret).update(`result\n${jobId}\n${bodyHash(body)}`, "utf8").digest("hex");

const cancellationSignature = (secret, jobId, cancelledAt, reason) =>
  "v1=" + createHmac("sha256", secret)
    .update(`cancel\n${jobId}\n${cancelledAt}\n${reason}`, "utf8").digest("hex");

export function createQueuedSparkCancellation(jobId, config, now = Date.now(), reason = "USER_CANCELLED") {
  if (!idPattern.test(jobId) || !["USER_CANCELLED", "DEADLINE"].includes(reason))
    throw fail(422, "Spark取消标记格式不合法", "SPARK_QUEUE_CANCEL_INVALID");
  const cancelledAt = new Date(now).toISOString();
  return {
    schema: remoteSparkQueueCancelSchema,
    jobId,
    cancelledAt,
    reason,
    signature: cancellationSignature(config.sharedSecret, jobId, cancelledAt, reason),
  };
}

export function verifyQueuedSparkCancellation(marker, jobId, config, now = Date.now()) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker) ||
      marker.schema !== remoteSparkQueueCancelSchema || marker.jobId !== jobId ||
      !["USER_CANCELLED", "DEADLINE"].includes(marker.reason) ||
      typeof marker.cancelledAt !== "string" ||
      !Number.isFinite(Date.parse(marker.cancelledAt)) ||
      Date.parse(marker.cancelledAt) > now + 60000 ||
      !equal(marker.signature,
        cancellationSignature(config.sharedSecret, jobId, marker.cancelledAt, marker.reason)))
    throw fail(401, "Spark取消标记签名无效", "SPARK_QUEUE_CANCEL_INVALID");
  return marker.reason;
}

export function createQueuedSparkJob(input, config, options = {}) {
  const now = options.now ?? Date.now(),
    requestId = options.requestId ?? randomUUID(),
    nonce = options.nonce ?? randomBytes(24).toString("base64url"),
    submittedAt = new Date(now).toISOString(),
    payload = JSON.stringify({
      protocol,
      requestId,
      submittedAt,
      sql: input.sql,
      context: input.context,
      validationContexts: input.validationContexts ?? [],
      ...(input.testSql === undefined ? {} : { testSql: input.testSql }),
    }),
    timestamp = String(now),
    signature = "v1=" + createHmac("sha256", config.sharedSecret)
      .update(`${timestamp}\n${nonce}\n${bodyHash(payload)}`, "utf8")
      .digest("hex"),
    job = {
      schema: remoteSparkQueueJobSchema,
      jobId: requestId,
      projectId: config.projectId,
      timestamp,
      nonce,
      signature,
      body: payload,
      expiresAt: new Date(now + config.timeoutMs).toISOString(),
    };
  return {
    job,
    jobKey: `${config.jobPrefix}/${requestId}.json`,
    resultKey: `${config.resultPrefix}/${requestId}.json`,
    cancelKey: `${config.cancellationPrefix}/${requestId}.cancel.json`,
  };
}

export function verifyQueuedSparkJob(job, config, now = Date.now(), { allowExpired = false } = {}) {
  if (!job || typeof job !== "object" || Array.isArray(job))
    throw fail(422, "Spark队列任务格式不合法", "SPARK_QUEUE_JOB_INVALID");
  if (
    job.schema !== remoteSparkQueueJobSchema || !idPattern.test(job.jobId ?? "") ||
    job.projectId !== config.projectId || !/^\d{13}$/.test(job.timestamp ?? "") ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(job.nonce ?? "") ||
    typeof job.body !== "string" || typeof job.signature !== "string" ||
    (!allowExpired && Date.parse(job.expiresAt) <= now) || Number(job.timestamp) > now + 60000
  ) throw fail(422, "Spark队列任务字段不合法", "SPARK_QUEUE_JOB_INVALID");
  const expected = "v1=" + createHmac("sha256", config.sharedSecret)
    .update(`${job.timestamp}\n${job.nonce}\n${bodyHash(job.body)}`, "utf8")
    .digest("hex");
  if (!equal(expected, job.signature))
    throw fail(401, "Spark队列任务签名无效", "SPARK_QUEUE_SIGNATURE_INVALID");
  let payload;
  try { payload = JSON.parse(job.body); } catch { throw fail(422, "Spark队列任务正文不合法", "SPARK_QUEUE_JOB_INVALID"); }
  if (payload?.protocol !== protocol || payload.requestId !== job.jobId)
    throw fail(422, "Spark队列任务协议不匹配", "SPARK_QUEUE_JOB_INVALID");
  return payload;
}

export function createQueuedSparkResult(job, result, config, now = Date.now()) {
  const body = JSON.stringify(result);
  return {
    schema: remoteSparkQueueResultSchema,
    jobId: job.jobId,
    completedAt: new Date(now).toISOString(),
    result,
    signature: resultSignature(config.sharedSecret, job.jobId, body),
  };
}

export function verifyQueuedSparkResult(value, expectedJobId, config) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== remoteSparkQueueResultSchema || value.jobId !== expectedJobId || typeof value.completedAt !== "string")
    throw fail(502, "Spark队列结果格式不合法", "SPARK_QUEUE_RESULT_INVALID");
  const body = JSON.stringify(value.result), expected = resultSignature(config.sharedSecret, expectedJobId, body);
  if (!equal(expected, value.signature))
    throw fail(502, "Spark队列结果签名无效", "SPARK_QUEUE_RESULT_INVALID");
  return value.result;
}

export class RemoteSparkQueueClient {
  constructor(config, transport, options = {}) {
    this.config = config;
    this.transport = transport;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async health() {
    if (!this.config.readyJobId)
      throw fail(503, "Spark队列缺少真实Worker执行证据", "REMOTE_SPARK_NOT_READY");
    const raw = await this.transport.read(`${this.config.resultPrefix}/${this.config.readyJobId}.json`);
    if (raw === undefined)
      throw fail(503, "Spark队列尚无真实Worker执行结果", "REMOTE_SPARK_NOT_READY");
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch { throw fail(502, "Spark队列就绪结果不是JSON", "SPARK_QUEUE_RESULT_INVALID"); }
    const result = verifyQueuedSparkResult(envelope, this.config.readyJobId, this.config);
    const completedAt = Date.parse(envelope.completedAt), now = this.now();
    if (!Number.isFinite(completedAt) || completedAt > now + 60000 || now - completedAt > this.config.readyMaxAgeMs ||
        result?.status !== "SUCCEEDED" || result.engine !== "Apache Spark" ||
        result.engineVersion !== "3.5.9" || result.validation?.passed !== true ||
        result.mainSqlExecuted !== true)
      throw fail(503, "Spark队列就绪证据未通过", "REMOTE_SPARK_NOT_READY");
    return {
      status: "ok",
      engine: "Apache Spark",
      isolation: "FUNCTION_PROCESS",
      runtimeAvailable: true,
      verifiedAt: envelope.completedAt,
    };
  }

  async execute(input) {
    if (input.signal?.aborted) throw fail(499, "远程Spark队列任务已取消", "REMOTE_SPARK_CANCELLED");
    const queued = createQueuedSparkJob(input, this.config, { now: this.now() });
    await this.transport.create(queued.jobKey, JSON.stringify(queued.job));
    const deadline = this.now() + Math.min(input.timeoutMs ?? this.config.timeoutMs, this.config.timeoutMs);
    while (this.now() < deadline) {
      if (input.signal?.aborted) {
        await this.transport.create(queued.cancelKey,
          JSON.stringify(createQueuedSparkCancellation(queued.job.jobId, this.config, this.now())));
        throw fail(499, "远程Spark队列任务已取消", "REMOTE_SPARK_CANCELLED");
      }
      const raw = await this.transport.read(queued.resultKey);
      if (raw !== undefined) {
        let result;
        try { result = JSON.parse(raw); } catch { throw fail(502, "Spark队列结果不是JSON", "SPARK_QUEUE_RESULT_INVALID"); }
        return verifyQueuedSparkResult(result, queued.job.jobId, this.config);
      }
      await this.wait(this.config.pollMs);
    }
    await this.transport.create(queued.cancelKey,
      JSON.stringify(createQueuedSparkCancellation(queued.job.jobId, this.config, this.now(), "DEADLINE")));
    throw fail(504, "远程Spark队列执行超时", "REMOTE_SPARK_TIMEOUT");
  }
}

export class OssSparkQueueTransport {
  constructor(config, fetchImpl = fetch, retryOptions = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.retryOptions = retryOptions;
  }

  async #request(method, key, body, ifNoneMatch) {
    return requestOssWithRetry(
      () => {
        const request = createOssRequest({
          ...this.config,
          method,
          key,
          body,
          ifNoneMatch,
        });
        return { ...request, options: { ...request.options, redirect: "error" } };
      },
      this.fetchImpl,
      this.retryOptions,
    );
  }

  async read(key) {
    const response = await this.#request("GET", key);
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw fail(503, "Spark队列对象读取失败", "SPARK_QUEUE_STORE_UNAVAILABLE");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024)
      throw fail(413, "Spark队列对象超过上限", "SPARK_QUEUE_OBJECT_TOO_LARGE");
    return body;
  }

  async create(key, body) {
    if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024)
      throw fail(413, "Spark队列对象超过上限", "SPARK_QUEUE_OBJECT_TOO_LARGE");
    const response = await this.#request("PUT", key, body, "*");
    if ([409, 412].includes(response.status)) {
      const existing = await this.read(key);
      if (existing === body) return { created: false };
      throw fail(409, "Spark队列对象冲突", "SPARK_QUEUE_OBJECT_CONFLICT");
    }
    if (!response.ok)
      throw fail(503, "Spark队列对象保存失败", "SPARK_QUEUE_STORE_UNAVAILABLE");
    return { created: true };
  }
}

export function ossSparkQueueTransportFromEnvironment(env = process.env, fetchImpl = fetch, retryOptions = {}) {
  return new OssSparkQueueTransport(ossConfigFromEnvironment(env), fetchImpl, retryOptions);
}

const queueKeys = (config, jobId) => ({
  jobKey: `${config.jobPrefix}/${jobId}.json`,
  resultKey: `${config.resultPrefix}/${jobId}.json`,
  cancelKey: `${config.cancellationPrefix}/${jobId}.cancel.json`,
});

async function queuedCancellationReason(transport, key, jobId, config, now) {
  const raw = await transport.read(key);
  if (raw === undefined) return undefined;
  let marker;
  try { marker = JSON.parse(raw); }
  catch { throw fail(422, "Spark取消标记不是JSON", "SPARK_QUEUE_CANCEL_INVALID"); }
  return verifyQueuedSparkCancellation(marker, jobId, config, now);
}

export async function consumeQueuedSparkJob({ jobKey, config, transport, runner, now = Date.now }) {
  if (typeof jobKey !== "string" || !jobKey.startsWith(`${config.jobPrefix}/`) || !jobKey.endsWith(".json") || jobKey.endsWith(".cancel.json"))
    throw fail(422, "Spark队列任务对象键不合法", "SPARK_QUEUE_JOB_KEY_INVALID");
  const raw = await transport.read(jobKey);
  if (raw === undefined)
    throw fail(404, "Spark队列任务不存在", "SPARK_QUEUE_JOB_NOT_FOUND");
  let job;
  try { job = JSON.parse(raw); } catch { throw fail(422, "Spark队列任务不是JSON", "SPARK_QUEUE_JOB_INVALID"); }
  if (!idPattern.test(job?.jobId ?? ""))
    throw fail(422, "Spark队列任务字段不合法", "SPARK_QUEUE_JOB_INVALID");
  const keys = queueKeys(config, job.jobId);
  if (jobKey !== keys.jobKey)
    throw fail(422, "Spark队列任务对象键与任务不符", "SPARK_QUEUE_JOB_KEY_INVALID");
  const previous = await transport.read(keys.resultKey);
  const payload = verifyQueuedSparkJob(job, config, now(), { allowExpired: previous !== undefined });
  if (previous !== undefined) {
    let envelope;
    try { envelope = JSON.parse(previous); }
    catch { throw fail(502, "Spark队列结果不是JSON", "SPARK_QUEUE_RESULT_INVALID"); }
    const trusted = verifyQueuedSparkResult(envelope, job.jobId, config);
    return {
      jobId: job.jobId,
      resultKey: keys.resultKey,
      status: trusted.status,
      containsSecret: false,
      replayed: true,
    };
  }
  const cancelled = await queuedCancellationReason(transport, keys.cancelKey, job.jobId, config, now());
  let result;
  if (cancelled)
    result = { status: "CANCELLED", code: cancelled === "DEADLINE" ? "REMOTE_SPARK_TIMEOUT" : "REMOTE_SPARK_CANCELLED" };
  if (!result) {
    const controller = new AbortController();
    let pendingCheck, checkError, cancellationReason;
    const checkCancellation = () => {
      if (pendingCheck) return pendingCheck;
      pendingCheck = queuedCancellationReason(transport, keys.cancelKey, job.jobId, config, now())
        .then((reason) => {
          if (reason) { cancellationReason = reason; controller.abort(); }
        })
        .catch((error) => { checkError = error; controller.abort(); })
        .finally(() => { pendingCheck = undefined; });
      return pendingCheck;
    };
    const timer = setInterval(() => { void checkCancellation(); }, config.pollMs);
    let runnerError;
    try {
      result = await runner({
        sql: payload.sql,
        context: payload.context,
        validationContexts: payload.validationContexts ?? [],
        testSql: payload.testSql,
        timeoutMs: config.timeoutMs,
        signal: controller.signal,
      });
    } catch (error) { runnerError = error; }
    finally { clearInterval(timer); }
    await checkCancellation();
    if (checkError) throw checkError;
    if (cancellationReason)
      result = { status: "CANCELLED", code: cancellationReason === "DEADLINE" ? "REMOTE_SPARK_TIMEOUT" : "REMOTE_SPARK_CANCELLED" };
    else if (runnerError) throw runnerError;
  }
  const envelope = createQueuedSparkResult(job, result, config, now());
  await transport.create(keys.resultKey, JSON.stringify(envelope));
  return {
    jobId: job.jobId,
    resultKey: keys.resultKey,
    status: result.status,
    containsSecret: false,
  };
}
