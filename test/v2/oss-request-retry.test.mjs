import test from "node:test";
import assert from "node:assert/strict";
import {
  requestOssWithRetry,
  wasOssRequestRetried,
} from "../../src/v2/oss-request-retry.mjs";

const request = () => ({ url: "https://synthetic.invalid/object", options: { method: "GET" } });

test("OSS request retries bounded transient statuses and regenerates signed requests", async () => {
  const statuses = [503, 429, 200],
    delays = [],
    signed = [];
  const response = await requestOssWithRetry(
    () => {
      signed.push(signed.length + 1);
      return request();
    },
    async () => new Response("", { status: statuses.shift() }),
    { attempts: 3, delayMs: 100, sleep: async (delay) => delays.push(delay) },
  );
  assert.equal(response.status, 200);
  assert.equal(wasOssRequestRetried(response), true);
  assert.deepEqual(signed, [1, 2, 3]);
  assert.deepEqual(delays, [100, 200]);
});

test("OSS request retries network failures but never retries CAS or not-found responses", async () => {
  let calls = 0;
  const recovered = await requestOssWithRetry(
    request,
    async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new TypeError("must not leak endpoint"), {
          cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
        });
      return new Response("", { status: 200 });
    },
    { attempts: 2, delayMs: 100, sleep: async () => undefined },
  );
  assert.equal(recovered.status, 200);
  for (const status of [404, 409, 412]) {
    calls = 0;
    const result = await requestOssWithRetry(
      request,
      async () => {
        calls += 1;
        return new Response("", { status });
      },
      { attempts: 3, delayMs: 100, sleep: async () => assert.fail("must not retry") },
    );
    assert.equal(result.status, status);
    assert.equal(wasOssRequestRetried(result), false);
    assert.equal(calls, 1);
  }
});

test("OSS exhausted and non-transient errors are sanitized", async () => {
  await assert.rejects(
    requestOssWithRetry(
      request,
      async () => {
        throw Object.assign(new TypeError("https://private-bucket.invalid"), {
          cause: { code: "ECONNRESET" },
        });
      },
      { attempts: 2, delayMs: 100, sleep: async () => undefined },
    ),
    (error) => error.code === "OSS_REQUEST_RETRIES_EXHAUSTED" && !error.message.includes("private-bucket"),
  );
  await assert.rejects(
    requestOssWithRetry(request, async () => {
      throw new Error("credential and endpoint details");
    }),
    (error) => error.code === "OSS_REQUEST_FAILED" && !error.message.includes("credential"),
  );
});
