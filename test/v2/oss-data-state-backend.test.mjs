import test from "node:test";
import assert from "node:assert/strict";
import {
  OssDataStateBackend,
} from "../../src/v2/oss-data-state-backend.mjs";
import { emptyDataState } from "../../src/v2/data-state-replica.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const config = {
  bucket: "synthetic-private-bucket",
  endpoint: "oss-cn-hangzhou-internal.aliyuncs.com",
  key: "data-platform-v2/state/test.json",
  maxBytes: 1024 * 1024,
  credentials: {
    accessKeyId: "test-key-id",
    accessKeySecret: "test-key-secret",
    securityToken: "test-security-token",
  },
};

function fakeOss() {
  const objects = new Map(), requests = [];
  return {
    objects, requests,
    async fetch(url, options) {
      requests.push({ url, options });
      const body = objects.get(url);
      if (options.method === "GET")
        return body === undefined ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
      if (options.method !== "PUT") return new Response("", { status: 405 });
      if (options.headers["If-Match"] || options.headers["If-None-Match"])
        return new Response("", { status: 400 });
      if (options.headers["x-oss-forbid-overwrite"] === "true" && body !== undefined)
        return new Response("", { status: 409 });
      objects.set(url, options.body);
      return new Response("", { status: 200 });
    },
  };
}

test("OSS state claims immutable slots and recovers after restart", async () => {
  const remote = fakeOss(), backend = new OssDataStateBackend(config, remote.fetch),
    payload = emptyDataState(PROJECT);
  assert.equal((await backend.load(PROJECT)).revision, 0);
  assert.equal(await backend.compareAndSwap(PROJECT, 0, payload), 1);
  assert.equal(await backend.compareAndSwap(PROJECT, 1, payload), 2);
  const writes = remote.requests.filter(r => r.options.method === "PUT");
  assert.equal(writes.length, 2);
  for (const r of writes) {
    assert.equal(r.options.headers["x-oss-forbid-overwrite"], "true");
    assert.equal(r.options.headers["If-Match"], undefined);
  }
  assert.equal((await new OssDataStateBackend(config, remote.fetch).load(PROJECT)).revision, 2);
});

test("OSS backend rejects a stale create without overwriting the winner", async () => {
  const remote = fakeOss(),
    first = new OssDataStateBackend(config, remote.fetch),
    stale = new OssDataStateBackend(config, remote.fetch),
    payload = emptyDataState(PROJECT);
  await first.load(PROJECT);
  await stale.load(PROJECT);
  await first.compareAndSwap(PROJECT, 0, payload);
  await assert.rejects(stale.compareAndSwap(PROJECT, 0, payload), {
    status: 409,
    code: "CLOUD_DATA_STATE_CONFLICT",
  });
  assert.equal((await stale.load(PROJECT)).revision, 1);
});

test("OSS state CAS reconciles an ambiguous successful write after a lost response", async () => {
  const remote = fakeOss(),
    originalFetch = remote.fetch,
    fetchWithLostResponse = async (url, options) => {
      const response = await originalFetch(url, options);
      if (options.method === "PUT" && response.ok && !fetchWithLostResponse.failed) {
        fetchWithLostResponse.failed = true;
        throw Object.assign(new TypeError("lost response"), { cause: { code: "ECONNRESET" } });
      }
      return response;
    },
    backend = new OssDataStateBackend(config, fetchWithLostResponse, {
      attempts: 2,
      delayMs: 100,
      sleep: async () => undefined,
    }),
    payload = emptyDataState(PROJECT);
  await backend.load(PROJECT);
  assert.equal(await backend.compareAndSwap(PROJECT, 0, payload), 1);
  assert.equal((await backend.load(PROJECT)).revision, 1);
});

test("OSS stale writers cannot overwrite an existing successor", async () => {
  const remote = fakeOss(), a = new OssDataStateBackend(config, remote.fetch),
    b = new OssDataStateBackend(config, remote.fetch), payload = emptyDataState(PROJECT);
  await a.load(PROJECT);
  await a.compareAndSwap(PROJECT, 0, payload);
  await b.load(PROJECT);
  await a.compareAndSwap(PROJECT, 1, payload);
  const before = [...remote.objects.entries()];
  await assert.rejects(b.compareAndSwap(PROJECT, 1, payload), { code: "CLOUD_DATA_STATE_CONFLICT" });
  assert.deepEqual([...remote.objects.entries()], before);
  assert.equal((await b.load(PROJECT)).revision, 2);
});

test("OSS preserves the legacy snapshot and appends a linked successor", async () => {
  const remote = fakeOss(), payload = emptyDataState(PROJECT),
    legacy = JSON.stringify({ format: "shuduo-data-state-envelope/v1", revision: 7, payload }),
    base = `https://${config.bucket}.${config.endpoint}/${config.key}`;
  remote.objects.set(base, legacy);
  const backend = new OssDataStateBackend(config, remote.fetch);
  assert.equal((await backend.load(PROJECT)).revision, 7);
  await backend.compareAndSwap(PROJECT, 7, payload);
  assert.equal(remote.objects.get(base), legacy);
  assert.equal((await new OssDataStateBackend(config, remote.fetch).load(PROJECT)).revision, 8);
});

test("OSS rejects a corrupted parent link after a cold restart", async () => {
  const remote = fakeOss(), backend = new OssDataStateBackend(config, remote.fetch);
  await backend.load(PROJECT);
  await backend.compareAndSwap(PROJECT, 0, emptyDataState(PROJECT));
  const [key, body] = [...remote.objects.entries()][0];
  remote.objects.set(key, JSON.stringify({ ...JSON.parse(body), previousHash: "0".repeat(64) }));
  await assert.rejects(new OssDataStateBackend(config, remote.fetch).load(PROJECT), { code: "CLOUD_DATA_STATE_INVALID_CHAIN" });
});

test("OSS revision writes enforce size limits before network mutation", async () => {
  const remote = fakeOss(), backend = new OssDataStateBackend({ ...config, maxBytes: 10 }, remote.fetch);
  await backend.load(PROJECT);
  await assert.rejects(backend.compareAndSwap(PROJECT, 0, emptyDataState(PROJECT)), { code: "CLOUD_DATA_STATE_TOO_LARGE" });
  assert.equal(remote.objects.size, 0);
});
