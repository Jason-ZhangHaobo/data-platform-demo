import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { referenceSql, getContext } from "../../src/v2/context.mjs";
import { generateSql, ModelUnavailable } from "../../src/v2/model.mjs";
import {
  saveLocalModelKey,
  normalizeModelKey,
} from "../../src/v2/model-credentials.mjs";
import { parseEnv } from "node:util";

async function setup(options = {}) {
  const path = join(
    mkdtempSync(join(tmpdir(), "shuzhan-v2-test-")),
    "metadata.sqlite",
  );
  const store = new MetadataStore(path);
  const app = createV2Server({
    store,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const call = async (path, body, headers = {}) => {
    const response = await fetch(base + "/api/v2" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuzhan-Client": "workbench",
        "Idempotency-Key": "test-request",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    store,
    path,
    close: async () => {
      await new Promise((r) => app.server.close(r));
      store.close();
    },
  };
}
const result = () => ({
  status: "SUCCEEDED",
  engine: "Apache Spark",
  engineVersion: "TEST_DOUBLE",
  rows: getContext().expected,
  columns: [],
  validation: { passed: true, issues: [], assertions: ["TEST_DOUBLE"] },
});
const eventually = async (read, expected) => {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (value.body.status === expected) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("状态未达到 " + expected);
};

test("versions remain immutable and metadata survives reopening", () => {
  const path = join(mkdtempSync(join(tmpdir(), "shuzhan-store-")), "db.sqlite");
  let store = new MetadataStore(path);
  const rev = store.create("revision", PROJECT, { sql: referenceSql });
  assert.equal(store.get("revision", rev.id, "other-project"), undefined);
  store.close();
  store = new MetadataStore(path);
  assert.equal(store.get("revision", rev.id, PROJECT).sql, referenceSql);
  store.close();
});
test("source contexts omit independent expected results", async () => {
  const app = await setup();
  try {
    const r = await app.call("/contexts");
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 5);
    assert.ok(r.body.every((c) => !("expected" in c)));
  } finally {
    await app.close();
  }
});
test("missing model configuration fails closed without creating a fake agent task", async () => {
  const app = await setup();
  try {
    const r = await app.call("/agent/tasks", {
      message: "请检查客户总资产代码",
      sql: referenceSql,
      contextId: "holdings-t1",
    });
    assert.equal(r.status, 503);
    assert.equal(app.store.list("agent", PROJECT).length, 0);
  } finally {
    await app.close();
  }
});
test("cross-project requests and foreign origins are rejected", async () => {
  const app = await setup();
  try {
    assert.equal(
      (await app.call("/revisions", undefined, { "x-project-id": "other" }))
        .status,
      403,
    );
    assert.equal(
      (
        await app.call(
          "/revisions",
          {},
          { Origin: "https://untrusted.example" },
        )
      ).status,
      403,
    );
  } finally {
    await app.close();
  }
});
test("public read-only mode cannot create revisions", async () => {
  const app = await setup({ env: { V2_LOCAL_DEVELOPMENT: "false" } });
  try {
    assert.equal(
      (
        await app.call("/revisions", {
          sql: referenceSql,
          contextId: "holdings-t1",
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
  }
});
test("background runs deduplicate and reject reused keys for different revisions", async () => {
  let calls = 0;
  const app = await setup({
    runner: async () => {
      calls++;
      return result();
    },
  });
  try {
    const rev = (
      await app.call("/revisions", {
        sql: referenceSql,
        contextId: "holdings-t1",
      })
    ).body;
    const first = await app.call("/runs", { revisionId: rev.id });
    const again = await app.call("/runs", { revisionId: rev.id });
    assert.equal(first.status, 202);
    assert.equal(first.body.id, again.body.id);
    await eventually(() => app.call("/runs/" + first.body.id), "SUCCEEDED");
    assert.equal(calls, 1);
    const next = (
      await app.call("/revisions", {
        sql: referenceSql + "\n",
        contextId: "cash-change",
      })
    ).body;
    assert.equal(
      (await app.call("/runs", { revisionId: next.id })).status,
      409,
    );
    const bundle = (await app.call("/runs/" + first.body.id + "/bundle")).body;
    assert.equal(bundle.revision.id, rev.id);
    assert.equal(bundle.releaseState, "NOT_PUBLISHED");
    assert.equal(bundle.files["main.sql"], referenceSql.trim());
  } finally {
    await app.close();
  }
});
test("cancellation stops queued execution and cannot become a success", async () => {
  let finish;
  const app = await setup({
    runner: () =>
      new Promise((r) => {
        finish = r;
      }),
  });
  try {
    const rev = (
      await app.call("/revisions", {
        sql: referenceSql,
        contextId: "holdings-t1",
      })
    ).body;
    const first = (await app.call("/runs", { revisionId: rev.id })).body;
    await eventually(() => app.call("/runs/" + first.id), "RUNNING");
    const cancelled = await app.call("/runs/" + first.id + "/cancel", {});
    assert.equal(cancelled.body.status, "CANCELLED");
    finish(result());
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      (await app.call("/runs/" + first.id)).body.status,
      "CANCELLED",
    );
  } finally {
    await app.close();
  }
});
test("restart marks unfinished work interrupted instead of rerunning", () => {
  const store = new MetadataStore(
    join(mkdtempSync(join(tmpdir(), "shuzhan-restart-")), "db"),
  );
  const run = store.create("run", PROJECT, { status: "RUNNING" });
  store.interruptPending(PROJECT);
  assert.equal(store.get("run", run.id, PROJECT).status, "INTERRUPTED");
  store.close();
});
test("agent repairs at most three times and does not mark bad results complete", async () => {
  let calls = 0;
  const app = await setup({
    generator: async () => {
      calls++;
      return {
        sql: referenceSql,
        explanation: "接口单元测试",
        model: "TEST_DOUBLE",
        usage: { total_tokens: 100 },
      };
    },
    runner: async () => ({
      ...result(),
      status: "VALIDATION_FAILED",
      validation: { passed: false, issues: ["金额不符"], assertions: [] },
    }),
  });
  try {
    const task = (
      await app.call("/agent/tasks", {
        message: "检查客户总资产",
        sql: referenceSql,
        contextId: "holdings-t1",
      })
    ).body;
    const complete = await eventually(
      () => app.call("/agent/tasks/" + task.id),
      "FAILED",
    );
    assert.equal(calls, 3);
    assert.equal(complete.body.attempts.length, 3);
    assert.match(complete.body.error, /三次/);
  } finally {
    await app.close();
  }
});
test("model request uses the real API protocol and rejects malformed output", async () => {
  await assert.rejects(
    () =>
      generateSql(
        {
          message: "生成代码",
          context: getContext(),
          currentSql: referenceSql,
        },
        {},
      ),
    ModelUnavailable,
  );
  let request;
  const valid = await generateSql(
    { message: "检查代码", context: getContext(), currentSql: referenceSql },
    { DASHSCOPE_API_KEY: "TEST_ONLY" },
    async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  sql: referenceSql,
                  explanation: "测试",
                }),
              },
            },
          ],
          usage: { total_tokens: 100 },
        }),
      );
    },
  );
  assert.equal(valid.mode, "LIVE_MODEL");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer TEST_ONLY");
  assert.ok(
    !JSON.parse(request.options.body).messages[1].content.includes(
      '"expected"',
    ),
  );
  await assert.rejects(
    () =>
      generateSql(
        {
          message: "检查代码",
          context: getContext(),
          currentSql: referenceSql,
        },
        { DASHSCOPE_API_KEY: "TEST_ONLY" },
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "invalid json" } }],
            }),
          ),
      ),
    /可解析/,
  );
});
test("malformed bodies and missing context are rejected before persistence", async () => {
  const app = await setup();
  try {
    for (const body of [
      null,
      [],
      { sql: referenceSql },
      { sql: referenceSql, contextId: "missing" },
    ]) {
      assert.equal((await app.call("/revisions", body)).status, 400);
    }
    assert.equal(app.store.list("revision", PROJECT).length, 0);
  } finally {
    await app.close();
  }
});
test("insufficient model budget makes no network request", async () => {
  let called = false;
  await assert.rejects(
    () =>
      generateSql(
        {
          message: "检查代码",
          context: getContext(),
          currentSql: referenceSql,
          remainingBudget: 100,
        },
        { DASHSCOPE_API_KEY: "TEST_ONLY" },
        async () => {
          called = true;
        },
      ),
    /预算/,
  );
  assert.equal(called, false);
});
test("model cancellation is retained alongside its timeout signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      generateSql(
        {
          message: "检查代码",
          context: getContext(),
          currentSql: referenceSql,
          signal: controller.signal,
        },
        { DASHSCOPE_API_KEY: "TEST_ONLY" },
        async (_url, options) => {
          options.signal.throwIfAborted();
        },
      ),
    { name: "AbortError" },
  );
});
test("missing usage consumes the remaining budget instead of allowing more calls", async () => {
  let calls = 0;
  const app = await setup({
    generator: async () => {
      calls++;
      return {
        sql: referenceSql,
        explanation: "接口单元测试",
        model: "TEST_DOUBLE",
        usage: { total_tokens: -1 },
      };
    },
    runner: async () => ({
      ...result(),
      status: "VALIDATION_FAILED",
      validation: { passed: false, issues: ["金额不符"], assertions: [] },
    }),
  });
  try {
    const task = (
      await app.call("/agent/tasks", {
        message: "检查客户总资产",
        sql: referenceSql,
        contextId: "holdings-t1",
      })
    ).body;
    const complete = await eventually(
      () => app.call("/agent/tasks/" + task.id),
      "FAILED",
    );
    assert.equal(calls, 1);
    assert.match(complete.body.error, /预算/);
  } finally {
    await app.close();
  }
});
test("local model setup persists only in protected config without echoing the key", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-credentials-test-"));
  writeFileSync(join(root, ".env.local"), "V2_PORT=3100\n");
  const key = "sk-" + "LOCAL_TEST_ONLY_".repeat(3);
  const app = await setup({ root });
  try {
    const response = await app.call("/settings/model-key", { apiKey: key });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      configured: true,
      connectionVerified: false,
    });
    assert.ok(!JSON.stringify(response.body).includes(key));
    assert.ok(
      readFileSync(join(root, ".env.local"), "utf8").includes("V2_PORT=3100"),
    );
    assert.equal(statSync(join(root, ".env.local")).mode & 0o777, 0o600);
    assert.equal((await app.call("/status")).body.model.configured, true);
    assert.ok(
      !JSON.stringify(app.store.list("settings_audit", PROJECT)).includes(key),
    );
    assert.equal(app.store.list("agent", PROJECT).length, 0);
  } finally {
    await app.close();
  }
});
test("model credentials reject line injection without writing a file", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-invalid-key-"));
  await assert.rejects(
    saveLocalModelKey(
      root,
      {},
      "sk-" + "LOCAL_TEST_ONLY_".repeat(3) + "\nV2_HOST=0.0.0.0",
    ),
    { status: 400 },
  );
  assert.equal(existsSync(join(root, ".env.local")), false);
});
test("model credentials cannot overwrite a symlink target", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-key-link-"));
  const target = join(root, "protected-test.txt");
  writeFileSync(target, "DO_NOT_CHANGE");
  symlinkSync(target, join(root, ".env.local"));
  await assert.rejects(
    saveLocalModelKey(root, {}, "sk-" + "LOCAL_TEST_ONLY_".repeat(3)),
    { status: 409 },
  );
  assert.equal(readFileSync(target, "utf8"), "DO_NOT_CHANGE");
});
test("public mode rejects model setup before creating local credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-public-key-"));
  const app = await setup({ root, env: { V2_LOCAL_DEVELOPMENT: "false" } });
  try {
    assert.equal(
      (
        await app.call("/settings/model-key", {
          apiKey: "sk-" + "LOCAL_TEST_ONLY_".repeat(3),
        })
      ).status,
      403,
    );
    assert.equal(existsSync(join(root, ".env.local")), false);
  } finally {
    await app.close();
  }
});
test("model setup trims only outer clipboard whitespace", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-trim-key-")),
    env = {};
  const key = "sk-" + "LOCAL_TEST_ONLY_".repeat(3);
  await saveLocalModelKey(root, env, " \r\n" + key + "\n\t ");
  assert.equal(env.DASHSCOPE_API_KEY, key);
  assert.equal(
    readFileSync(join(root, ".env.local"), "utf8"),
    "DASHSCOPE_API_KEY=" + key + "\n",
  );
  await assert.rejects(
    saveLocalModelKey(root, env, key.slice(0, 12) + " " + key.slice(12)),
    { status: 400 },
  );
  assert.equal(env.DASHSCOPE_API_KEY, key);
});
test("a successful SQL agent stage is never reported as full lifecycle E2E", async () => {
  const app = await setup({
    generator: async () => ({
      sql: referenceSql,
      explanation: "阶段边界测试",
      model: "TEST_DOUBLE",
      usage: { total_tokens: 100 },
    }),
    runner: async () => result(),
  });
  try {
    const task = (
      await app.call("/agent/tasks", {
        message: "检查客户资产计算",
        sql: referenceSql,
        contextId: "holdings-t1",
      })
    ).body;
    const complete = await eventually(
      () => app.call("/agent/tasks/" + task.id),
      "SUCCEEDED",
    );
    assert.equal(complete.body.completionScope, "SQL_DEVELOPMENT");
    assert.equal(complete.body.fullLifecycleE2E, false);
  } finally {
    await app.close();
  }
});
test("long segmented model keys save unchanged and survive dotenv parsing", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-long-key-")),
    env = {};
  const key =
    "sk-ws-" + "LONG_TEST_ONLY_".repeat(50) + ".segment+test/encoded_value=~";
  const saved = await saveLocalModelKey(root, env, key);
  assert.equal(saved.connectionVerified, false);
  assert.equal(env.DASHSCOPE_API_KEY, key);
  assert.equal(
    parseEnv(readFileSync(join(root, ".env.local"), "utf8")).DASHSCOPE_API_KEY,
    key,
  );
  assert.equal(statSync(join(root, ".env.local")).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(saved).includes(key));
});
test("a single pair of surrounding clipboard quotes is normalized", () => {
  const key = "sk-" + "QUOTED_TEST_ONLY_".repeat(3);
  assert.equal(normalizeModelKey('  "' + key + '" \n'), key);
  assert.equal(normalizeModelKey(" '" + key + "' "), key);
});
test("model key input problems have specific non-secret diagnostics", () => {
  const samples = [
    ["", "MODEL_KEY_EMPTY"],
    ["sk-TEST_ONLY_****MASKED", "MODEL_KEY_MASKED"],
    ["sk-TEST_ONLY_...MASKED", "MODEL_KEY_MASKED"],
    ["LTAI_CLOUD_ID_TEST_ONLY", "MODEL_KEY_WRONG_KIND"],
    ["Bearer sk-HEADER_TEST_ONLY", "MODEL_KEY_PREFIX"],
    ["sk-TEST_ONLY_\nV2_HOST=0.0.0.0", "MODEL_KEY_WHITESPACE"],
    ["sk-TEST_ONLY_\u200bINVISIBLE", "MODEL_KEY_WHITESPACE"],
    ['sk-TEST_ONLY_"EXTRA', "MODEL_KEY_CHARACTERS"],
  ];
  for (const [value, code] of samples) {
    assert.throws(
      () => normalizeModelKey(value),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, code);
        if (value) assert.ok(!error.message.includes(value));
        return true;
      },
    );
  }
});
test("key limit is an explicit transport bound rather than the legacy short-key cap", () => {
  const key = "sk-" + "a".repeat(8189);
  assert.equal(normalizeModelKey(key), key);
  assert.throws(() => normalizeModelKey(key + "a"), {
    status: 400,
    code: "MODEL_KEY_TOO_LONG",
  });
});
test("rejected input never replaces a previously saved credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-preserve-key-")),
    env = {};
  const key = "sk-" + "PRESERVE_TEST_ONLY_".repeat(3);
  await saveLocalModelKey(root, env, key);
  await assert.rejects(saveLocalModelKey(root, env, "sk-***MASKED"), {
    code: "MODEL_KEY_MASKED",
  });
  assert.equal(env.DASHSCOPE_API_KEY, key);
  assert.equal(
    parseEnv(readFileSync(join(root, ".env.local"), "utf8")).DASHSCOPE_API_KEY,
    key,
  );
});
test("save API returns a diagnostic code without echoing a rejected key", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-key-feedback-"));
  const app = await setup({ root });
  try {
    const value = "sk-DO_NOT_ECHO_****MASKED";
    const response = await app.call("/settings/model-key", { apiKey: value });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "MODEL_KEY_MASKED");
    assert.ok(!JSON.stringify(response.body).includes(value));
    assert.equal(existsSync(join(root, ".env.local")), false);
  } finally {
    await app.close();
  }
});
test("SQL execution receives the registered independent regression contexts", async () => {
  let input;
  const app = await setup({
    runner: async (value) => {
      input = value;
      return result();
    },
  });
  try {
    const revision = (
      await app.call("/revisions", {
        sql: referenceSql,
        contextId: "cash-change",
      })
    ).body;
    const run = (await app.call("/runs", { revisionId: revision.id })).body;
    await eventually(() => app.call("/runs/" + run.id), "SUCCEEDED");
    assert.deepEqual(
      input.validationContexts.map((context) => context.id),
      [
        "holdings-t1",
        "cash-change",
        "duplicate-position",
        "equal-value-positions",
        "cash-only-client",
      ],
    );
    assert.equal(input.context.id, "cash-change");
    assert.equal(
      (await app.call("/status")).body.model.connectionVerified,
      false,
    );
  } finally {
    await app.close();
  }
});
