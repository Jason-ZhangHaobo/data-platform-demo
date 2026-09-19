import test from "node:test";
import assert from "node:assert/strict";
import {
  schedulerTickConfigFromEnvironment,
  verifySchedulerTick,
} from "../../src/v2/scheduler-tick.mjs";
import { createSchedulerTickRequest } from "../../scripts/tick-v2-scheduler.mjs";

const secret = "scheduler-secret-0123456789-abcdef";

test("scheduler tick client creates a domain-separated signed HTTPS request", () => {
  const now = 1_789_774_400_000,
    request = createSchedulerTickRequest(
      {
        publicUrl: "https://demo.example.cn/v2/",
        sharedSecret: secret,
        limit: 2,
      },
      now,
    );
  assert.equal(request.endpoint, "https://demo.example.cn/api/v2/internal/scheduler/tick");
  assert.equal(request.body, '{"limit":2}');
  assert.equal(
    verifySchedulerTick({
      sharedSecret: secret,
      timestamp: request.headers["X-Shuduo-Timestamp"],
      nonce: request.headers["X-Shuduo-Nonce"],
      signature: request.headers["X-Shuduo-Signature"],
      body: request.body,
      now,
    }),
    true,
  );
  assert.equal(
    verifySchedulerTick({
      sharedSecret: secret,
      timestamp: request.headers["X-Shuduo-Timestamp"],
      nonce: request.headers["X-Shuduo-Nonce"],
      signature: request.headers["X-Shuduo-Signature"],
      body: '{"limit":1}',
      now,
    }),
    false,
  );
});

test("scheduler tick configuration fails closed and the workflow defaults disabled", async () => {
  assert.equal(schedulerTickConfigFromEnvironment({}), undefined);
  assert.throws(
    () =>
      schedulerTickConfigFromEnvironment({
        V2_RELEASE_SCHEDULER_MODE: "DURABLE_TICK",
        V2_SCHEDULER_TICK_SECRET: "short",
      }),
    /持久调度共享密钥/,
  );
  const { readFile } = await import("node:fs/promises"),
    workflow = await readFile(
      new URL("../../.github/workflows/tick-v2-scheduler.yml", import.meta.url),
      "utf8",
    );
  assert.match(workflow, /if: vars\.V2_SCHEDULER_ENABLED == 'true'/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /V2_SCHEDULER_TICK_SECRET/);
  assert.doesNotMatch(workflow, /curl .*\$V2_SCHEDULER_TICK_SECRET/);
});
