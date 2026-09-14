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
  let body,
    etag,
    version = 0;
  const requests = [];
  return {
    requests,
    async fetch(url, options) {
      requests.push({ url, options });
      if (options.method === "GET") {
        if (!body) return new Response("", { status: 404 });
        return new Response(body, {
          status: 200,
          headers: { etag, "content-type": "application/json" },
        });
      }
      if (options.method !== "PUT") return new Response("", { status: 405 });
      if (
        (options.headers["If-None-Match"] === "*" && body) ||
        (options.headers["If-Match"] && options.headers["If-Match"] !== etag)
      )
        return new Response("", { status: 412 });
      body = options.body;
      etag = `\"etag-${++version}\"`;
      return new Response("", { status: 200, headers: { etag } });
    },
  };
}

test("OSS backend creates with If-None-Match and updates with ETag CAS", async () => {
  const remote = fakeOss(),
    backend = new OssDataStateBackend(config, remote.fetch),
    initial = await backend.load(PROJECT),
    payload = emptyDataState(PROJECT);
  assert.equal(initial.revision, 0);
  assert.equal(await backend.compareAndSwap(PROJECT, 0, payload), 1);
  assert.equal(await backend.compareAndSwap(PROJECT, 1, payload), 2);
  assert.equal(remote.requests[1].options.headers["If-None-Match"], "*");
  assert.equal(remote.requests[2].options.headers["If-Match"], '"etag-1"');
  assert.equal(remote.requests[1].options.headers.Authorization.includes("test-key-secret"), false);
  assert.equal((await backend.load(PROJECT)).revision, 2);
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
