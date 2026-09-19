import {
  createOssRequest,
  ossConfigFromEnvironment,
} from "../server/repositories/oss-store.mjs";
import {
  cloudDataStateConflict,
  emptyDataState,
  validateDataState,
} from "./data-state-replica.mjs";
import {
  requestOssWithRetry,
  wasOssRequestRetried,
} from "./oss-request-retry.mjs";

const ENVELOPE_FORMAT = "shuduo-data-state-envelope/v1";
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

const unavailable = (message, code = "CLOUD_DATA_STATE_UNAVAILABLE") =>
  Object.assign(new Error(message), { status: 503, code });

export class OssDataStateBackend {
  constructor(config, fetchImpl = fetch, retryOptions = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.retryOptions = retryOptions;
    this.cached = new Map();
  }

  async request(method, body, etag, ifNoneMatch) {
    return requestOssWithRetry(
      () =>
        createOssRequest({
          ...this.config,
          method,
          body,
          etag,
          ifNoneMatch,
        }),
      this.fetchImpl,
      this.retryOptions,
    );
  }

  async load(project) {
    const response = await this.request("GET");
    if (response.status === 404) {
      const initial = {
        revision: 0,
        payload: emptyDataState(project),
        etag: undefined,
      };
      this.cached.set(project, initial);
      return structuredClone(initial);
    }
    if (!response.ok)
      throw unavailable(`OSS 业务状态读取失败（${response.status}）`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > this.config.maxBytes)
      throw unavailable("OSS 业务状态快照超过大小上限", "CLOUD_DATA_STATE_TOO_LARGE");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > this.config.maxBytes)
      throw unavailable("OSS 业务状态快照超过大小上限", "CLOUD_DATA_STATE_TOO_LARGE");
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw unavailable("OSS 业务状态快照不是有效 JSON", "CLOUD_DATA_STATE_INVALID");
    }
    if (
      envelope?.format !== ENVELOPE_FORMAT ||
      !Number.isSafeInteger(envelope.revision) ||
      envelope.revision < 1
    )
      throw unavailable("OSS 业务状态信封格式不合法", "CLOUD_DATA_STATE_INVALID");
    validateDataState(envelope.payload, project);
    const etag = response.headers.get("etag");
    if (!etag)
      throw unavailable("OSS 未返回并发控制标识", "CLOUD_DATA_STATE_NO_ETAG");
    const current = {
      revision: envelope.revision,
      payload: envelope.payload,
      etag,
    };
    this.cached.set(project, current);
    return structuredClone(current);
  }

  async compareAndSwap(project, expectedRevision, payload) {
    validateDataState(payload, project);
    const cached = this.cached.get(project);
    if (!cached || cached.revision !== expectedRevision)
      throw cloudDataStateConflict();
    const revision = expectedRevision + 1,
      body = JSON.stringify({
        format: ENVELOPE_FORMAT,
        revision,
        payload,
      });
    if (Buffer.byteLength(body, "utf8") > this.config.maxBytes)
      throw unavailable("OSS 业务状态快照超过大小上限", "CLOUD_DATA_STATE_TOO_LARGE");
    const response = await this.request(
      "PUT",
      body,
      expectedRevision ? cached.etag : undefined,
      expectedRevision ? undefined : "*",
    );
    if ([409, 412].includes(response.status) && wasOssRequestRetried(response)) {
      const verified = await this.load(project);
      if (
        verified.revision === revision &&
        JSON.stringify(verified.payload) === JSON.stringify(payload)
      )
        return revision;
      throw cloudDataStateConflict();
    }
    if ([409, 412].includes(response.status)) throw cloudDataStateConflict();
    if (!response.ok)
      throw unavailable(`OSS 业务状态保存失败（${response.status}）`);
    const etag = response.headers.get("etag");
    if (etag) {
      this.cached.set(project, { revision, payload: structuredClone(payload), etag });
      return revision;
    }
    const verified = await this.load(project);
    if (verified.revision !== revision) throw cloudDataStateConflict();
    return revision;
  }

  async close() {}
}

export function ossDataStateConfigFromEnvironment(env = process.env) {
  const base = ossConfigFromEnvironment(env),
    maxBytes = Number(env.V2_OSS_STATE_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 100 * 1024 * 1024)
    throw new Error("V2 OSS 业务状态大小上限不合法");
  return {
    ...base,
    key:
      env.V2_OSS_STATE_OBJECT_KEY ??
      "data-platform-v2/state/project-securities-lab.json",
    maxBytes,
  };
}
