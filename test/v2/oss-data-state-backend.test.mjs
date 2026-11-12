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

const baseUrl = `https://${config.bucket}.${config.endpoint}/${config.key}`;
const slotUrl = revision => `${baseUrl}.revisions/${revision}.json`;

async function seedRevisions(count, legacyRevision = 0) {
  const remote = fakeOss(), writer = new OssDataStateBackend(config, remote.fetch),
    payload = emptyDataState(PROJECT);
  if (legacyRevision)
    remote.objects.set(baseUrl, JSON.stringify({
      format: "shuduo-data-state-envelope/v1", revision: legacyRevision, payload,
    }));
  await writer.load(PROJECT);
  for (let revision = legacyRevision; revision < legacyRevision + count; revision++)
    await writer.compareAndSwap(PROJECT, revision, payload);
  remote.requests.length = 0;
  return remote;
}

test("OSS cold restore overlaps successor reads after nine verified slots and keeps warm reads single", { timeout: 3000 }, async t => {
  const remote = await seedRevisions(16);
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  t.after(() => first.resolve());
  const reader = new OssDataStateBackend(config, async (url, options) => {
    if (url === slotUrl(10)) {
      assert.equal(options.signal, undefined);
      await first.promise;
    }
    if (url === slotUrl(11)) {
      assert.ok(options.signal);
      second.resolve();
    }
    return remote.fetch(url, options);
  });
  const restoring = reader.load(PROJECT);
  await Promise.race([second.promise, restoring]);
  first.resolve();
  assert.equal((await restoring).revision, 16);
  assert.equal(remote.requests.length, 19);
  remote.requests.length = 0;
  assert.equal((await reader.load(PROJECT)).revision, 16);
  assert.deepEqual(remote.requests.map(request => request.url), [slotUrl(17)]);
});

test("OSS short chains from a legacy snapshot keep ordered reads with no lookahead", async () => {
  const remote = await seedRevisions(8, 500);
  assert.equal((await new OssDataStateBackend(config, remote.fetch).load(PROJECT)).revision, 508);
  assert.equal(remote.requests.length, 10);
  assert.equal(remote.requests.some(request => request.options.signal), false);
});

test("OSS stops at the first missing slot and aborts an unused lookahead without retry", async () => {
  const remote = await seedRevisions(12);
  remote.objects.delete(slotUrl(10));
  let cancelled = false, speculativeReads = 0, signal;
  const reader = new OssDataStateBackend(config, (url, options) => {
    if (url !== slotUrl(11)) return remote.fetch(url, options);
    speculativeReads++;
    signal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  }, { sleep: async () => assert.fail("an unused read must not retry") });
  assert.equal((await reader.load(PROJECT)).revision, 9);
  assert.equal(speculativeReads, 1);
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test("OSS confirms an early lookahead miss after its predecessor and sees the intervening append", async () => {
  const remote = await seedRevisions(14), attempts = [];
  const reader = new OssDataStateBackend(config, (url, options) => {
    attempts.push({ url, speculative: Boolean(options.signal) });
    if (url === slotUrl(11) && options.signal) return new Response(null, { status: 404 });
    return remote.fetch(url, options);
  });
  assert.equal((await reader.load(PROJECT)).revision, 14);
  assert.deepEqual(attempts.filter(attempt => attempt.url === slotUrl(11)).map(a => a.speculative), [true, false]);
  assert.equal(attempts.filter(attempt => attempt.speculative).length, 1);
});

test("OSS retries a needed speculative transient response within the existing request budget", async () => {
  const remote = await seedRevisions(11);
  const attempts = [], delays = [];
  let discarded = false;
  const reader = new OssDataStateBackend(config, (url, options) => {
    if (url === slotUrl(11)) {
      attempts.push(Boolean(options.signal));
      if (options.signal)
        return new Response(new ReadableStream({ cancel() { discarded = true; } }), { status: 503 });
    }
    return remote.fetch(url, options);
  }, { attempts: 2, delayMs: 100, sleep: async delay => delays.push(delay) });
  assert.equal((await reader.load(PROJECT)).revision, 11);
  assert.deepEqual(attempts, [true, false]);
  assert.deepEqual(delays, [100]);
  assert.equal(discarded, true);
});

test("OSS still rejects a broken parent inside a prefetched pair", async () => {
  const remote = await seedRevisions(12);
  const corrupt = JSON.parse(remote.objects.get(slotUrl(11)));
  remote.objects.set(slotUrl(11), JSON.stringify({ ...corrupt, previousHash: "0".repeat(64) }));
  const reader = new OssDataStateBackend(config, remote.fetch);
  await assert.rejects(reader.load(PROJECT), { code: "CLOUD_DATA_STATE_INVALID_CHAIN" });
  assert.ok(remote.requests.find(request => request.url === slotUrl(11)).options.signal);
  assert.equal(remote.requests.some(request => request.url === slotUrl(12)), false);
});

test("OSS preserves the maximum number of revision slots and reads none beyond it", async () => {
  const remote = await seedRevisions(1024, 200);
  const reader = new OssDataStateBackend(config, remote.fetch);
  await assert.rejects(reader.load(PROJECT), { code: "CLOUD_DATA_STATE_REVISION_LIMIT" });
  assert.equal(remote.requests.length, 1025);
  assert.equal(new Set(remote.requests.map(request => request.url)).size, 1025);
  assert.equal(remote.requests.some(request => request.url === slotUrl(1225)), false);
});

test("OSS avoids reading ahead after a large snapshot and caps undeclared bodies while streaming", async () => {
  const remote = await seedRevisions(9);
  remote.objects.set(slotUrl(9), remote.objects.get(slotUrl(9)) + " ".repeat(1024 * 1024));
  const reader = new OssDataStateBackend({ ...config, maxBytes: 2 * 1024 * 1024 }, remote.fetch);
  assert.equal((await reader.load(PROJECT)).revision, 9);
  assert.equal(remote.requests.some(request => request.options.signal), false);
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(768));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const oversize = new OssDataStateBackend({ ...config, maxBytes: 1024 }, async () => new Response(body));
  await assert.rejects(oversize.load(PROJECT), { code: "CLOUD_DATA_STATE_TOO_LARGE" });
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});
