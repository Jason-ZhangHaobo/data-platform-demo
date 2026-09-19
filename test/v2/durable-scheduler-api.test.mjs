import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { signSchedulerTick } from "../../src/v2/scheduler-tick.mjs";

const result = {
  status: "SUCCEEDED",
  engine: "Apache Spark",
  engineVersion: "3.5.9",
  mainSqlExecuted: true,
  durationMs: 5,
  testSqlValidation: { passed: true },
  validation: { passed: true, regressions: [] },
  log: "synthetic durable scheduler run",
};

test("signed durable tick executes a due cloud run once and rejects replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-durable-api-")),
    store = new MetadataStore(":memory:"),
    nowMs = Date.parse("2026-09-19T03:00:00.000Z"),
    secret = randomBytes(32).toString("base64url"),
    nonce = randomBytes(24).toString("base64url"),
    body = "{}",
    item = store.create("delivery_package", PROJECT, {
      digest: "c".repeat(64),
    }),
    release = store.create("release", PROJECT, {
      status: "ACTIVE_CLOUD",
      packageId: item.id,
      packageDigest: item.digest,
    }),
    run = store.create("release_run", PROJECT, {
      releaseId: release.id,
      packageId: item.id,
      packageDigest: item.digest,
      status: "SCHEDULED",
      scheduledTriggerAt: "2026-09-19T02:59:00.000Z",
      businessScheduledFor: "2026-09-19T09:00:00+08:00",
      schedulerTriggered: false,
    }),
    app = createV2Server({
      root,
      store,
      now: () => nowMs,
      releaseSchedulerMode: "DURABLE_TICK",
      releaseRunner: async () => result,
      env: {
        V2_LOCAL_DEVELOPMENT: "false",
        V2_HOST: "127.0.0.1",
        V2_ALLOW_INSECURE_PUBLIC_COOKIES: "true",
        V2_RELEASE_SCHEDULER_MODE: "DURABLE_TICK",
        V2_SCHEDULER_TICK_SECRET: secret,
      },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/v2/internal/scheduler/tick`,
    timestamp = String(nowMs),
    signature = signSchedulerTick({
      sharedSecret: secret,
      timestamp,
      nonce,
      body,
    }),
    headers = {
      "Content-Type": "application/json",
      "X-Project-Id": PROJECT,
      "X-Shuduo-Timestamp": timestamp,
      "X-Shuduo-Nonce": nonce,
      "X-Shuduo-Signature": signature,
    };
  try {
    const invalid = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "X-Shuduo-Signature": "v1=" + "0".repeat(64) },
      body,
    });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).code, "SCHEDULER_TICK_SIGNATURE_INVALID");

    const accepted = await fetch(endpoint, { method: "POST", headers, body });
    assert.equal(accepted.status, 200);
    const tick = await accepted.json();
    assert.equal(tick.due, 1);
    assert.deepEqual(tick.executed, [{ id: run.id, status: "SUCCEEDED" }]);
    assert.equal(store.get("release_run", run.id, PROJECT).mode, "CLOUD_DURABLE_SCHEDULE");

    const replay = await fetch(endpoint, { method: "POST", headers, body });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, "SCHEDULER_TICK_REPLAYED");

    const status = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/v2/status`,
    ).then((response) => response.json());
    assert.deepEqual(status.scheduler, {
      mode: "DURABLE_TICK",
      durableTickConfigured: true,
      publicDeployed: false,
    });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});

test("public server fails closed when durable tick mode has no secret", () => {
  const store = new MetadataStore(":memory:");
  try {
    assert.throws(
      () =>
        createV2Server({
        store,
        releaseSchedulerMode: "DURABLE_TICK",
        env: {
          V2_LOCAL_DEVELOPMENT: "false",
          V2_HOST: "127.0.0.1",
          V2_ALLOW_INSECURE_PUBLIC_COOKIES: "true",
          V2_RELEASE_SCHEDULER_MODE: "DURABLE_TICK",
        },
        }),
      /持久调度共享密钥/,
    );
  } finally {
    store.close();
  }
});
