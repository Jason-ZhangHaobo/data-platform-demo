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
import { createHash } from "node:crypto";

const ENVELOPE_FORMAT = "shuduo-data-state-envelope/v1";
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;
const MAX_REVISION_READS = 1024;
const SEQUENTIAL_COLD_READS = 9;
const MAX_LOOKAHEAD_SNAPSHOT_BYTES = 1024 * 1024;
const stateHash = (state) => createHash("sha256")
  .update(`${state.revision}\n${JSON.stringify(state.payload)}`).digest("hex");

const unavailable = (message, code = "CLOUD_DATA_STATE_UNAVAILABLE") =>
  Object.assign(new Error(message), { status: 503, code });

function discardResponse(response) {
  void response?.body?.cancel().catch(() => undefined);
}

export class OssDataStateBackend {
  constructor(config, fetchImpl = fetch, retryOptions = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.retryOptions = retryOptions;
    this.cached = new Map();
  }

  async request(method, body, etag, ifNoneMatch, key = this.config.key, firstAttempt) {
    return requestOssWithRetry(
      () =>
        createOssRequest({
          ...this.config,
          key,
          method,
          body,
          etag,
          ifNoneMatch,
        }),
      firstAttempt
        ? async (url, options) => {
            if (!firstAttempt) return this.fetchImpl(url, options);
            const attempt = firstAttempt;
            firstAttempt = undefined;
            if ("error" in attempt) throw attempt.error;
            return attempt.response;
          }
        : this.fetchImpl,
      this.retryOptions,
    );
  }

  async load(project) {
    const cached = this.cached.get(project);
    let current = cached ?? await this.loadLegacy(project);
    let allowLookahead = !cached, pending, lastSize;
    // Immutable version slots use OSS atomic forbid-overwrite. The legacy
    // snapshot remains read-only. Each successor proves its parent content.
    try {
      for (let reads = 0; reads < MAX_REVISION_READS; reads += 1) {
        const revision = current.revision + 1;
        const key = this.revisionKey(revision);
        let attempt;
        if (pending) {
          attempt = await pending.result;
          pending = undefined;
          // Confirm absence after its predecessor is validated. If a writer
          // filled the slot during restoration, continue with ordered reads.
          if (attempt.response?.status === 404) {
            discardResponse(attempt.response);
            attempt = undefined;
            allowLookahead = false;
          }
        }
        const reading = this.request("GET", undefined, undefined, undefined, key, attempt);
        if (!attempt && allowLookahead && reads >= SEQUENTIAL_COLD_READS &&
            lastSize <= MAX_LOOKAHEAD_SNAPSHOT_BYTES && reads + 1 < MAX_REVISION_READS &&
            Number.isSafeInteger(revision + 1)) {
          pending = this.#prepareRevisionRead(revision + 1);
        }
        const response = await reading;
        if (response.status === 404) {
          discardResponse(response);
          this.cached.set(project, current);
          return structuredClone(current);
        }
        const { envelope: next, bytes } = await this.readEnvelope(response, project);
        if (next.revision !== revision || next.previousHash !== stateHash(current))
          throw unavailable("OSS 状态版本链不连续", "CLOUD_DATA_STATE_INVALID_CHAIN");
        current = { revision: next.revision, payload: next.payload };
        lastSize = bytes;
      }
      throw unavailable("OSS 状态版本读取达到安全上限", "CLOUD_DATA_STATE_REVISION_LIMIT");
    } finally {
      if (pending) {
        pending.abort.abort();
        void pending.result.then(({ response }) => discardResponse(response));
      }
    }
  }

  #prepareRevisionRead(revision) {
    const abort = new AbortController();
    const result = (async () => {
      const { url, options } = createOssRequest({
        ...this.config, key: this.revisionKey(revision), method: "GET",
      });
      return this.fetchImpl(url, { ...options, signal: abort.signal });
    })().then(response => ({ response }), error => ({ error }));
    return { abort, result };
  }

  revisionKey(revision) {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw unavailable("OSS 状态版本号不合法", "CLOUD_DATA_STATE_INVALID");
    return `${this.config.key}.revisions/${revision}.json`;
  }

  async loadLegacy(project) {
    const response = await this.request("GET");
    if (response.status === 404) {
      discardResponse(response);
      const initial = {
        revision: 0,
        payload: emptyDataState(project),
        etag: undefined,
      };
      return initial;
    }
    const { envelope } = await this.readEnvelope(response, project);
    return { revision: envelope.revision, payload: envelope.payload };
  }

  async readEnvelope(response, project) {
    if (!response.ok) {
      discardResponse(response);
      throw unavailable(`OSS 业务状态读取失败（${response.status}）`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > this.config.maxBytes) {
      discardResponse(response);
      throw unavailable("OSS 业务状态快照超过大小上限", "CLOUD_DATA_STATE_TOO_LARGE");
    }
    let text = "", bytes = 0;
    if (response.body) {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > this.config.maxBytes)
            throw unavailable("OSS 业务状态快照超过大小上限", "CLOUD_DATA_STATE_TOO_LARGE");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
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
    return { envelope, bytes };
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
        previousHash: stateHash(cached),
        payload,
      });
    if (Buffer.byteLength(body, "utf8") > this.config.maxBytes)
      throw unavailable("OSS 业务状态快照超过大小上限", "CLOUD_DATA_STATE_TOO_LARGE");
    const response = await this.request(
      "PUT",
      body,
      undefined,
      "*",
      this.revisionKey(revision),
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
    this.cached.set(project, { revision, payload: structuredClone(payload) });
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
