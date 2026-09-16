import test from "node:test";
import assert from "node:assert/strict";
import {
  createRemoteSparkRunner,
  RemoteSparkClient,
  remoteSparkConfigFromEnvironment,
  remoteSparkProtocol,
  signSparkRequest,
  verifySparkRequest,
} from "../../src/v2/remote-spark.mjs";
import { createRemoteSparkWorker } from "../../src/v2/remote-spark-worker.mjs";
import { getContext } from "../../src/v2/context.mjs";

const sharedSecret = "synthetic-test-secret-32-characters-long";
const success = {
  status: "SUCCEEDED",
  engine: "Apache Spark",
  engineVersion: "3.5.9",
  rows: [{ client_id: "CLIENT-001", total_assets: "1800.00" }],
  validation: { passed: true, regressions: [] },
  mainSqlExecuted: true,
};

test("remote Spark signatures bind timestamp, nonce and exact body", () => {
  const timestamp = "1789400000000",
    nonce = "nonce_for_synthetic_test_001",
    body = JSON.stringify({ request: "synthetic" }),
    signature = signSparkRequest({ sharedSecret, timestamp, nonce, body });
  assert.equal(
    verifySparkRequest({
      sharedSecret,
      timestamp,
      nonce,
      body,
      signature,
      now: Number(timestamp),
    }),
    true,
  );
  assert.equal(
    verifySparkRequest({
      sharedSecret,
      timestamp,
      nonce,
      body: body + " ",
      signature,
      now: Number(timestamp),
    }),
    false,
  );
  assert.equal(
    verifySparkRequest({
      sharedSecret,
      timestamp,
      nonce,
      body,
      signature,
      now: Number(timestamp) + 60_001,
    }),
    false,
  );
});

test("remote Spark client sends a signed bounded request and validates evidence", async () => {
  let captured;
  const client = new RemoteSparkClient(
      {
        endpoint: "https://spark.example.test/v1/execute",
        sharedSecret,
        projectId: "project-securities-lab",
        timeoutMs: 1000,
        maxRequestBytes: 2 * 1024 * 1024,
        maxResponseBytes: 2 * 1024 * 1024,
      },
      async (url, options) => {
        captured = { url, options };
        return new Response(JSON.stringify(success), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ),
    result = await client.execute({
      sql: "SELECT client_id FROM accounts",
      context: getContext("holdings-t1"),
      validationContexts: [],
    });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(captured.url, "https://spark.example.test/v1/execute");
  assert.equal(captured.options.headers["X-Project-Id"], "project-securities-lab");
  assert.equal(
    verifySparkRequest({
      sharedSecret,
      timestamp: captured.options.headers["X-Shuzhan-Timestamp"],
      nonce: captured.options.headers["X-Shuzhan-Nonce"],
      body: captured.options.body,
      signature: captured.options.headers["X-Shuzhan-Signature"],
      now: Number(captured.options.headers["X-Shuzhan-Timestamp"]),
    }),
    true,
  );
  assert.equal(JSON.parse(captured.options.body).protocol, remoteSparkProtocol);
});

test("remote Spark configuration requires HTTPS and a nontrivial secret", () => {
  assert.throws(
    () =>
      remoteSparkConfigFromEnvironment({
        V2_SPARK_EXECUTOR_URL: "http://spark.example.test",
        V2_SPARK_EXECUTOR_SECRET: sharedSecret,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      remoteSparkConfigFromEnvironment({
        V2_SPARK_EXECUTOR_URL: "https://spark.example.test",
        V2_SPARK_EXECUTOR_SECRET: "short",
      }),
    /32—512/,
  );
  const runner = createRemoteSparkRunner({
    V2_SPARK_EXECUTOR_URL: "https://spark.example.test/",
    V2_SPARK_EXECUTOR_SECRET: sharedSecret,
  });
  assert.equal(runner.descriptor.isolation, "REMOTE_FUNCTION");
});

test("remote Spark client rejects a success without independent validation", async () => {
  const client = new RemoteSparkClient(
    {
      endpoint: "https://spark.example.test/v1/execute",
      sharedSecret,
      projectId: "project-securities-lab",
      timeoutMs: 1000,
      maxRequestBytes: 2 * 1024 * 1024,
      maxResponseBytes: 2 * 1024 * 1024,
    },
    async () =>
      new Response(
        JSON.stringify({ ...success, validation: { passed: false } }),
        { status: 200 },
      ),
  );
  await assert.rejects(
    client.execute({
      sql: "SELECT client_id FROM accounts",
      context: getContext("holdings-t1"),
    }),
    { status: 502, code: "REMOTE_SPARK_INVALID_RESULT" },
  );
});

test("remote Spark health requires an available isolated Apache Spark runtime", async () => {
  const config = {
      endpoint: "https://spark.example.test/v1/execute",
      sharedSecret,
      projectId: "project-securities-lab",
      timeoutMs: 1000,
      maxRequestBytes: 2 * 1024 * 1024,
      maxResponseBytes: 2 * 1024 * 1024,
    },
    healthy = new RemoteSparkClient(config, async (url, options) => {
      assert.equal(String(url), "https://spark.example.test/health");
      assert.equal(options.method, "GET");
      return new Response(
        JSON.stringify({
          status: "ok",
          engine: "Apache Spark",
          isolation: "FUNCTION_PROCESS",
          runtimeAvailable: true,
        }),
        { status: 200 },
      );
    });
  assert.equal((await healthy.health()).runtimeAvailable, true);
  const unavailable = new RemoteSparkClient(config, async () =>
    new Response(
      JSON.stringify({
        status: "ok",
        engine: "Apache Spark",
        isolation: "FUNCTION_PROCESS",
        runtimeAvailable: false,
      }),
      { status: 200 },
    ),
  );
  await assert.rejects(unavailable.health(), {
    status: 503,
    code: "REMOTE_SPARK_NOT_READY",
  });
});

test("Spark worker accepts one valid signature and rejects replay or tampering", async () => {
  const fixedNow = 1789400000000,
    app = createRemoteSparkWorker({
      env: { V2_SPARK_WORKER_SECRET: sharedSecret },
      now: () => fixedNow,
      runner: async () => success,
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/v1/execute`,
    payload = {
      protocol: remoteSparkProtocol,
      requestId: "11111111-1111-4111-8111-111111111111",
      submittedAt: new Date(fixedNow).toISOString(),
      sql: "SELECT client_id FROM accounts",
      context: getContext("holdings-t1"),
      validationContexts: [],
    },
    body = JSON.stringify(payload),
    timestamp = String(fixedNow),
    nonce = "worker_nonce_synthetic_001",
    signature = signSparkRequest({ sharedSecret, timestamp, nonce, body }),
    headers = {
      "Content-Type": "application/json",
      "X-Project-Id": "project-securities-lab",
      "X-Shuzhan-Timestamp": timestamp,
      "X-Shuzhan-Nonce": nonce,
      "X-Shuzhan-Signature": signature,
    };
  try {
    const accepted = await fetch(url, { method: "POST", headers, body });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).isolation, "FUNCTION_PROCESS");
    const replayed = await fetch(url, { method: "POST", headers, body });
    assert.equal(replayed.status, 409);
    assert.equal((await replayed.json()).code, "SPARK_NONCE_REPLAYED");
    const tampered = await fetch(url, {
      method: "POST",
      headers: { ...headers, "X-Shuzhan-Nonce": "worker_nonce_synthetic_002" },
      body,
    });
    assert.equal(tampered.status, 401);
    assert.equal((await tampered.json()).code, "SPARK_SIGNATURE_INVALID");
    const invalidBody = JSON.stringify({
        ...payload,
        requestId: "22222222-2222-4222-8222-222222222222",
        context: {
          ...payload.context,
          tables: [
            {
              name: "private_unknown_table",
              columns: [["id", "STRING"]],
              rows: [["SECRET"]],
            },
          ],
        },
      }),
      invalidNonce = "worker_nonce_synthetic_003",
      invalidSignature = signSparkRequest({
        sharedSecret,
        timestamp,
        nonce: invalidNonce,
        body: invalidBody,
      }),
      invalid = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "X-Shuzhan-Nonce": invalidNonce,
          "X-Shuzhan-Signature": invalidSignature,
        },
        body: invalidBody,
      });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).code, "INVALID_SPARK_TABLE");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
