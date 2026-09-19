import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalArtifactStore,
  OssImmutableArtifactStore,
} from "../../src/v2/artifact-store.mjs";

const digest = "a".repeat(64);
const value = {
  manifest: { format: "shuduo-delivery/v1" },
  files: { "main.sql": "SELECT 1" },
  digest,
};

test("local artifact store is immutable and verifies the exact referenced bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-artifacts-")),
    store = new LocalArtifactStore(root),
    first = await store.put("delivery-package", digest, value),
    replay = await store.put("delivery-package", digest, value);
  assert.equal(first.contentHash, replay.contentHash);
  assert.equal(first.key, `delivery-package/${digest}.json`);
  assert.equal(
    (await store.verify(first, "delivery-package", digest, value)).contentHash,
    first.contentHash,
  );
  await assert.rejects(
    store.put("delivery-package", digest, { ...value, files: {} }),
    { status: 409, code: "ARTIFACT_DIGEST_CONFLICT" },
  );
  const file = join(root, "delivery-package", `${digest}.json`);
  writeFileSync(file, readFileSync(file, "utf8") + " ");
  await assert.rejects(
    store.verify(first, "delivery-package", digest, value),
    { status: 409, code: "ARTIFACT_INTEGRITY_FAILED" },
  );
});

function fakeOss() {
  const objects = new Map(),
    calls = [];
  return {
    calls,
    objects,
    async fetch(url, options) {
      calls.push({ url, options });
      const key = new URL(url).pathname;
      if (options.method === "GET") {
        const item = objects.get(key);
        return item
          ? new Response(item.body, { status: 200, headers: { etag: item.etag } })
          : new Response("", { status: 404 });
      }
      if (options.method === "PUT") {
        if (options.headers["If-None-Match"] === "*" && objects.has(key))
          return new Response("", { status: 412 });
        const item = {
          body: options.body,
          etag: `\"etag-${objects.size + 1}\"`,
        };
        objects.set(key, item);
        return new Response("", { status: 200, headers: { etag: item.etag } });
      }
      return new Response("", { status: 405 });
    },
  };
}

test("OSS artifact store uses create-only objects and verifies an existing replay", async () => {
  const remote = fakeOss(),
    store = new OssImmutableArtifactStore(
      {
        bucket: "synthetic-private-bucket",
        endpoint: "oss-cn-hangzhou-internal.aliyuncs.com",
        prefix: "data-platform-v2/artifacts",
        credentials: {
          accessKeyId: "test-key-id",
          accessKeySecret: "test-key-secret",
          securityToken: "test-security-token",
        },
      },
      remote.fetch,
    ),
    first = await store.put("delivery-package", digest, value),
    replay = await store.put("delivery-package", digest, value);
  assert.equal(first.contentHash, replay.contentHash);
  assert.equal(remote.calls[0].options.headers["If-None-Match"], "*");
  assert.equal(remote.calls[1].options.headers["If-None-Match"], "*");
  assert.equal(remote.calls[2].options.method, "GET");
  const verified = await store.verify(
    replay,
    "delivery-package",
    digest,
    value,
  );
  assert.match(verified.verifiedAt, /^\d{4}-/);
  assert.equal(store.status().cloudVerified, true);
});

test("OSS artifact store never accepts different content under an existing digest", async () => {
  const remote = fakeOss(),
    store = new OssImmutableArtifactStore(
      {
        bucket: "synthetic-private-bucket",
        endpoint: "oss-cn-hangzhou-internal.aliyuncs.com",
        prefix: "data-platform-v2/artifacts",
        credentials: {
          accessKeyId: "test-key-id",
          accessKeySecret: "test-key-secret",
        },
      },
      remote.fetch,
    );
  await store.put("delivery-package", digest, value);
  await assert.rejects(
    store.put("delivery-package", digest, { ...value, files: {} }),
    { status: 409, code: "ARTIFACT_DIGEST_CONFLICT" },
  );
});
