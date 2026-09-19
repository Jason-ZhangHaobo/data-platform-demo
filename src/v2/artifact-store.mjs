import { createHash } from "node:crypto";
import {
  existsSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createOssRequest,
  ossConfigFromEnvironment,
} from "../server/repositories/oss-store.mjs";
import { requestOssWithRetry } from "./oss-request-retry.mjs";

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const allowedKinds = new Set(["delivery-package"]);

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });

const validateKind = (kind) => {
  if (!allowedKinds.has(kind))
    throw fail(400, "产物类型不受支持", "INVALID_ARTIFACT_KIND");
  return kind;
};

const validateDigest = (digest) => {
  if (!/^[a-f0-9]{64}$/.test(String(digest)))
    throw fail(400, "产物摘要不合法", "INVALID_ARTIFACT_DIGEST");
  return digest;
};

const encode = (value) => {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > MAX_ARTIFACT_BYTES)
    throw fail(413, "版本化产物超过1MiB上限", "ARTIFACT_TOO_LARGE");
  return body;
};

const sha256 = (body) =>
  createHash("sha256").update(body, "utf8").digest("hex");

const descriptor = ({ driver, kind, digest, body, key, etag }) => ({
  driver,
  kind,
  digest,
  key,
  contentHash: sha256(body),
  bytes: Buffer.byteLength(body, "utf8"),
  ...(etag ? { etag } : {}),
});

const validateReference = (reference, kind, digest) => {
  if (
    !reference ||
    reference.kind !== kind ||
    reference.digest !== digest ||
    !/^[a-f0-9]{64}$/.test(String(reference.contentHash)) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 1 ||
    reference.bytes > MAX_ARTIFACT_BYTES
  )
    throw fail(409, "版本化产物引用不合法", "INVALID_ARTIFACT_REFERENCE");
};

export class LocalArtifactStore {
  constructor(root) {
    const requested = resolve(root);
    mkdirSync(requested, { recursive: true });
    if (
      lstatSync(requested).isSymbolicLink() ||
      !lstatSync(requested).isDirectory()
    )
      throw fail(409, "本地产物根目录不安全", "ARTIFACT_ROOT_UNSAFE");
    this.root = realpathSync(requested);
    this.lastVerifiedAt = undefined;
  }

  path(kind, digest) {
    return join(this.root, validateKind(kind), `${validateDigest(digest)}.json`);
  }

  async put(kind, digest, value) {
    const body = encode(value),
      file = this.path(kind, digest);
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true });
    if (
      lstatSync(directory).isSymbolicLink() ||
      realpathSync(directory) !== directory
    )
      throw fail(409, "本地产物目录不安全", "ARTIFACT_PATH_UNSAFE");
    if (existsSync(file)) {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
        throw fail(409, "本地产物路径不是普通文件", "ARTIFACT_PATH_UNSAFE");
      if (readFileSync(file, "utf8") !== body)
        throw fail(409, "相同摘要对应不同产物", "ARTIFACT_DIGEST_CONFLICT");
    } else writeFileSync(file, body, { flag: "wx", mode: 0o600 });
    this.lastVerifiedAt = new Date().toISOString();
    return descriptor({
      driver: "local-immutable-file",
      kind,
      digest,
      body,
      key: `${kind}/${digest}.json`,
    });
  }

  async verify(reference, kind, digest, expectedValue) {
    validateReference(reference, kind, digest);
    if (
      reference.driver !== "local-immutable-file" ||
      reference.key !== `${kind}/${digest}.json`
    )
      throw fail(409, "本地产物引用不匹配", "INVALID_ARTIFACT_REFERENCE");
    const file = this.path(kind, digest);
    if (
      !existsSync(file) ||
      !lstatSync(file).isFile() ||
      lstatSync(file).isSymbolicLink()
    )
      throw fail(409, "版本化产物不存在", "ARTIFACT_NOT_FOUND");
    const body = readFileSync(file, "utf8"),
      expected = encode(expectedValue);
    if (
      body !== expected ||
      sha256(body) !== reference.contentHash ||
      Buffer.byteLength(body, "utf8") !== reference.bytes
    )
      throw fail(409, "版本化产物内容与引用不一致", "ARTIFACT_INTEGRITY_FAILED");
    this.lastVerifiedAt = new Date().toISOString();
    return { ...reference, verifiedAt: this.lastVerifiedAt };
  }

  status() {
    return {
      driver: "local-immutable-file",
      durable: true,
      cloudVerified: false,
      lastVerifiedAt: this.lastVerifiedAt,
    };
  }
}

export class OssImmutableArtifactStore {
  constructor(config, fetchImpl = fetch, retryOptions = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.retryOptions = retryOptions;
    this.lastVerifiedAt = undefined;
  }

  key(kind, digest) {
    return `${this.config.prefix}/${validateKind(kind)}/${validateDigest(digest)}.json`;
  }

  async request(method, key, body, ifNoneMatch) {
    return requestOssWithRetry(
      () => {
        const request = createOssRequest({
          ...this.config,
          key,
          method,
          body,
          ifNoneMatch,
        });
        return {
          ...request,
          options: { ...request.options, redirect: "error" },
        };
      },
      this.fetchImpl,
      this.retryOptions,
    );
  }

  async read(key) {
    const response = await this.request("GET", key);
    if (response.status === 404)
      throw fail(409, "OSS版本化产物不存在", "ARTIFACT_NOT_FOUND");
    if (!response.ok)
      throw fail(503, `OSS版本化产物读取失败（${response.status}）`, "ARTIFACT_STORE_UNAVAILABLE");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_ARTIFACT_BYTES)
      throw fail(409, "OSS版本化产物超过上限", "ARTIFACT_TOO_LARGE");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_ARTIFACT_BYTES)
      throw fail(409, "OSS版本化产物超过上限", "ARTIFACT_TOO_LARGE");
    return { body, etag: response.headers.get("etag") ?? undefined };
  }

  async put(kind, digest, value) {
    const body = encode(value),
      key = this.key(kind, digest),
      response = await this.request("PUT", key, body, "*");
    if ([409, 412].includes(response.status)) {
      const existing = await this.read(key);
      if (existing.body !== body)
        throw fail(409, "相同摘要对应不同OSS产物", "ARTIFACT_DIGEST_CONFLICT");
      this.lastVerifiedAt = new Date().toISOString();
      return descriptor({
        driver: "oss-immutable-object",
        kind,
        digest,
        body,
        key,
        etag: existing.etag,
      });
    }
    if (!response.ok)
      throw fail(503, `OSS版本化产物保存失败（${response.status}）`, "ARTIFACT_STORE_UNAVAILABLE");
    this.lastVerifiedAt = new Date().toISOString();
    return descriptor({
      driver: "oss-immutable-object",
      kind,
      digest,
      body,
      key,
      etag: response.headers.get("etag") ?? undefined,
    });
  }

  async verify(reference, kind, digest, expectedValue) {
    validateReference(reference, kind, digest);
    if (
      reference.driver !== "oss-immutable-object" ||
      reference.key !== this.key(kind, digest)
    )
      throw fail(409, "OSS产物对象路径不一致", "INVALID_ARTIFACT_REFERENCE");
    const { body, etag } = await this.read(reference.key),
      expected = encode(expectedValue);
    if (
      body !== expected ||
      sha256(body) !== reference.contentHash ||
      Buffer.byteLength(body, "utf8") !== reference.bytes
    )
      throw fail(409, "OSS版本化产物完整性校验失败", "ARTIFACT_INTEGRITY_FAILED");
    this.lastVerifiedAt = new Date().toISOString();
    return { ...reference, ...(etag ? { etag } : {}), verifiedAt: this.lastVerifiedAt };
  }

  status() {
    return {
      driver: "oss-immutable-object",
      durable: true,
      cloudVerified: Boolean(this.lastVerifiedAt),
      lastVerifiedAt: this.lastVerifiedAt,
    };
  }
}

export function ossArtifactConfigFromEnvironment(env = process.env) {
  const base = ossConfigFromEnvironment(env),
    prefix = env.V2_OSS_ARTIFACT_PREFIX ?? "data-platform-v2/artifacts";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{2,180}$/.test(prefix) || prefix.includes(".."))
    throw new Error("V2 OSS产物前缀不合法");
  return { ...base, prefix: prefix.replace(/\/$/, "") };
}

export function deliveryArtifactValue(item) {
  return {
    manifest: item.manifest,
    files: item.files,
    digest: item.digest,
  };
}
