import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const remoteSparkQueueJobSchema = "shuduo-spark-queue-job/v1";
export const remoteSparkQueueResultSchema = "shuduo-spark-queue-result/v1";
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
  const jobPrefix = env.V2_SPARK_QUEUE_JOB_PREFIX ?? "data-platform-demo/v2/spark-queue/jobs";
  const resultPrefix = env.V2_SPARK_QUEUE_RESULT_PREFIX ?? "data-platform-demo/v2/spark-queue/results";
  const timeoutMs = Number(env.V2_SPARK_QUEUE_TIMEOUT_MS ?? 180000);
  const pollMs = Number(env.V2_SPARK_QUEUE_POLL_MS ?? 1000);
  if (!keyPattern.test(jobPrefix) || !keyPattern.test(resultPrefix) || jobPrefix === resultPrefix)
    throw new Error("Spark OSS队列前缀不合法");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error("Spark OSS队列超时不合法");
  if (!Number.isSafeInteger(pollMs) || pollMs < 200 || pollMs > 5000)
    throw new Error("Spark OSS队列轮询间隔不合法");
  if (!validSecret(env.V2_SPARK_EXECUTOR_SECRET))
    throw new Error("远程Spark共享密钥必须是32—512字符且不含空白");
  return {
    jobPrefix,
    resultPrefix,
    timeoutMs,
    pollMs,
    sharedSecret: env.V2_SPARK_EXECUTOR_SECRET,
    projectId: env.V2_PROJECT_ID ?? "project-securities-lab",
  };
}

const resultSignature = (secret, jobId, body) =>
  "v1=" + createHmac("sha256", secret).update(`result\n${jobId}\n${bodyHash(body)}`, "utf8").digest("hex");

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
    cancelKey: `${config.jobPrefix}/${requestId}.cancel.json`,
  };
}

export function verifyQueuedSparkJob(job, config, now = Date.now()) {
  if (!job || typeof job !== "object" || Array.isArray(job))
    throw fail(422, "Spark队列任务格式不合法", "SPARK_QUEUE_JOB_INVALID");
  if (
    job.schema !== remoteSparkQueueJobSchema || !idPattern.test(job.jobId ?? "") ||
    job.projectId !== config.projectId || !/^\d{13}$/.test(job.timestamp ?? "") ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(job.nonce ?? "") ||
    typeof job.body !== "string" || typeof job.signature !== "string" ||
    Date.parse(job.expiresAt) <= now || Number(job.timestamp) > now + 60000
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

  async execute(input) {
    if (input.signal?.aborted) throw fail(499, "远程Spark队列任务已取消", "REMOTE_SPARK_CANCELLED");
    const queued = createQueuedSparkJob(input, this.config, { now: this.now() });
    await this.transport.create(queued.jobKey, JSON.stringify(queued.job));
    const deadline = this.now() + Math.min(input.timeoutMs ?? this.config.timeoutMs, this.config.timeoutMs);
    while (this.now() < deadline) {
      if (input.signal?.aborted) {
        await this.transport.create(queued.cancelKey, JSON.stringify({ schema: "shuduo-spark-queue-cancel/v1", jobId: queued.job.jobId, cancelledAt: new Date(this.now()).toISOString() }));
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
    throw fail(504, "远程Spark队列执行超时", "REMOTE_SPARK_TIMEOUT");
  }
}
