import test from "node:test";
import assert from "node:assert/strict";
import { MySqlMetadataBackend } from "../../src/v2/mysql-metadata-backend.mjs";

const env = {
  V2_MYSQL_HOST: "synthetic.internal",
  V2_MYSQL_USER: "platform_app",
  V2_MYSQL_PASSWORD: "Synthetic-only-password-42!",
  V2_MYSQL_DATABASE: "platform_meta",
  V2_MYSQL_CONNECT_ATTEMPTS: "3",
  V2_MYSQL_RETRY_DELAY_MS: "250",
};

function poolFactory(outcomes, calls) {
  let index = 0;
  return (config) => {
    const outcome = outcomes[index++];
    const pool = {
      async query() {
        calls.push({ type: "query", config });
        if (outcome) throw Object.assign(new Error(`must not expose ${config.host}`), { code: outcome });
      },
      async end() {
        calls.push({ type: "end" });
      },
    };
    return pool;
  };
}

test("MySQL metadata cold start retries bounded transient wake-up failures", async () => {
  const calls = [],
    delays = [],
    backend = await MySqlMetadataBackend.open(env, {
      createPool: poolFactory(["ETIMEDOUT", "ECONNREFUSED", null], calls),
      sleep: async (delay) => delays.push(delay),
    });
  assert.ok(backend instanceof MySqlMetadataBackend);
  assert.deepEqual(delays, [250, 500]);
  assert.equal(calls.filter((call) => call.type === "query").length, 3);
  assert.equal(calls.filter((call) => call.type === "end").length, 2);
  assert.equal(calls[0].config.connectTimeout, 5000);
  assert.equal(calls[0].config.connectionLimit, 2);
  await backend.close();
});

test("MySQL metadata cold start does not retry authentication or permission failures", async () => {
  const calls = [];
  await assert.rejects(
    MySqlMetadataBackend.open(env, {
      createPool: poolFactory(["ER_ACCESS_DENIED_ERROR"], calls),
      sleep: async () => assert.fail("non-transient failure must not sleep"),
    }),
    (error) => {
      assert.equal(error.code, "ER_ACCESS_DENIED_ERROR");
      assert.equal(error.transient, false);
      assert.equal(error.message.includes(env.V2_MYSQL_HOST), false);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.type === "query").length, 1);
  assert.equal(calls.filter((call) => call.type === "end").length, 1);
});

test("MySQL metadata cold start exhausts transient retries without leaking endpoint details", async () => {
  const calls = [];
  await assert.rejects(
    MySqlMetadataBackend.open(
      { ...env, V2_MYSQL_CONNECT_ATTEMPTS: "2" },
      {
        createPool: poolFactory(["ETIMEDOUT", "ETIMEDOUT"], calls),
        sleep: async () => undefined,
      },
    ),
    (error) => {
      assert.equal(error.code, "MYSQL_CONNECT_RETRIES_EXHAUSTED");
      assert.equal(error.transient, true);
      assert.equal(error.message.includes(env.V2_MYSQL_HOST), false);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.type === "query").length, 2);
});

test("MySQL metadata cold start validates retry and pool bounds before connecting", async () => {
  for (const invalid of [
    { V2_MYSQL_CONNECT_ATTEMPTS: "0" },
    { V2_MYSQL_RETRY_DELAY_MS: "10001" },
    { V2_MYSQL_CONNECT_TIMEOUT_MS: "NaN" },
    { V2_MYSQL_POOL_SIZE: "99" },
    { V2_MYSQL_PORT: "70000" },
  ])
    await assert.rejects(
      MySqlMetadataBackend.open({ ...env, ...invalid }, { createPool: () => assert.fail("must not connect") }),
      (error) => error.code === "MYSQL_CONFIG_INVALID",
    );
});
