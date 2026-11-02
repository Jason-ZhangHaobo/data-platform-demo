import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import {
  createSecureConfigServer,
  validateSecureConfig,
  validatePreparedConfig,
} from "../../scripts/start-v2-secure-config.mjs";

function call(url, method, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("secure config entry accepts query URLs and saves only individual encrypted Secret values", async (t) => {
  const calls = [];
  const entry = createSecureConfigServer({
    ghRunner: async (args, value) => calls.push({ args, value }),
    random: (size) => Buffer.alloc(size, 7),
  });
  const { url } = await entry.listen();
  t.after(() => entry.server.close());
  const page = await call(`${url}/?from=old-link`, "GET");
  assert.equal(page.status, 200);
  assert.match(page.text, /补齐最后三项账号信息/);
  const cookie = page.headers["set-cookie"][0].split(";")[0];
  const token = "07".repeat(32);
  const payload = JSON.stringify({
    mysql: "DemoMysql#123",
    email: "Admin@Shuduo.Example",
    password: "AdminPass#2026",
    confirm: "AdminPass#2026",
  });
  const saved = await call(`${url}/save`, "POST", {
    origin: url,
    cookie,
    "x-setup-token": token,
    "content-type": "application/json",
  }, payload);
  assert.equal(saved.status, 200);
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 3)), [
    ["secret", "set", "V2_MYSQL_PASSWORD"],
    ["secret", "set", "V2_BOOTSTRAP_ADMIN_EMAIL"],
    ["secret", "set", "V2_BOOTSTRAP_ADMIN_PASSWORD_HASH"],
    ["workflow", "run", "validate-v2-protected-config.yml"],
  ]);
  assert.equal(calls[1].value, "admin@shuduo.example");
  assert.match(calls[2].value, /^scrypt\$/);
  assert.notEqual(calls[2].value, "AdminPass#2026");
});

test("secure config entry rejects malformed values without an outbound GitHub call", () => {
  assert.throws(
    () => validateSecureConfig({ mysql: "short", email: "bad", password: "a", confirm: "a" }),
    /数据库密码格式不正确/,
  );
});

test("MySQL-only secure entry preserves the administrator account and rejects extra fields and cross-origin requests", async (t) => {
  const calls = [];
  const entry = createSecureConfigServer({ mysqlOnly: true, ghRunner: async (args, value) => calls.push({ args, value }), random: size => Buffer.alloc(size, 7) });
  const { url } = await entry.listen();
  t.after(() => entry.server.close());
  const page = await call(`${url}/`, "GET");
  assert.match(page.text, /更新数据库连接密码/);
  assert.doesNotMatch(page.text, /id="email"|id="password"|id="confirm"/);
  const headers = { origin: url, cookie: page.headers["set-cookie"][0].split(";")[0], "x-setup-token": "07".repeat(32), "content-type": "application/json" };
  const payload = JSON.stringify({ mysql: "SyntheticMysql!123" });
  assert.equal((await call(`${url}/save`, "POST", { ...headers, origin: "https://evil.example" }, payload)).status, 403);
  assert.equal((await call(`${url}/save`, "POST", headers, JSON.stringify({ mysql: "SyntheticMysql!123", email: "unwanted@example.test" }))).status, 400);
  assert.equal(calls.length, 0);
  const saved = await call(`${url}/save`, "POST", headers, payload);
  assert.equal(saved.status, 200);
  assert.deepEqual(calls.map(x => x.args.slice(0, 3)), [["secret", "set", "V2_MYSQL_PASSWORD"], ["workflow", "run", "sync-v2-control-mysql-secret.yml"]]);
  assert.equal(saved.text.includes("SyntheticMysql!123"), false);
  assert.equal((await call(`${url}/save`, "POST", headers, payload)).status, 409);
  const complete = await call(url, "GET");
  assert.match(complete.text, /保存成功不等于数据库连接已验证/);
});

test("MySQL-only entry distinguishes saved secret from failed workflow dispatch without repeat input", async (t) => {
  let saves = 0;
  const entry = createSecureConfigServer({ mysqlOnly: true, ghRunner: async args => { if (args[0] === "secret") saves++; else throw new Error("private-cloud-error"); }, random: size => Buffer.alloc(size, 7) });
  const { url } = await entry.listen();
  t.after(() => entry.server.close());
  const page = await call(url, "GET");
  const response = await call(`${url}/save`, "POST", { origin: url, cookie: page.headers["set-cookie"][0].split(";")[0], "x-setup-token": "07".repeat(32), "content-type": "application/json" }, JSON.stringify({ mysql: "SyntheticMysql!123" }));
  assert.deepEqual(JSON.parse(response.text), { ok: true, workflowStarted: false });
  assert.equal(saves, 1);
  assert.match((await call(url, "GET")).text, /但同步任务未启动/);
  assert.equal(response.text.includes("private-cloud-error"), false);
});

const preparationInput = () => ({ mysql: "SyntheticMysql!42", currentPassword: "  OldPassword!42  ",
  password: "NewSynthetic!42", confirm: "NewSynthetic!42", modelKey: "sk-synthetic-preparation-key" });
async function preparationFixture(t, options = {}) {
  const calls = [];
  const entry = createSecureConfigServer({ prepareOnly: true, plannedEmail: "Owner@Synthetic.Example", random: size => Buffer.alloc(size, 7),
    ghRunner: async (...args) => calls.push(args), ...options });
  const { url, ...info } = await entry.listen();
  t.after(() => new Promise(resolve => { entry.server.close(resolve); entry.server.closeAllConnections(); }));
  const page = await call(url, "GET");
  const headers = { origin: url, cookie: page.headers["set-cookie"][0].split(";")[0], "x-setup-token": "07".repeat(32), "content-type": "application/json" };
  return { entry, url, info, page, headers, calls,
    submit: (input = preparationInput(), overrides = {}) => call(`${url}/save`, "POST", { ...headers, ...overrides }, typeof input === "string" ? input : JSON.stringify(input)) };
}

test("prepare-only reuses the protected page, fixes the account and returns only a local receipt without GitHub or model calls", async (t) => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => { modelCalls++; throw Error("external request forbidden"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const f = await preparationFixture(t), input = preparationInput();
  assert.equal(f.info.mode, "PREPARE_ONLY");
  assert.equal(f.info.preparedExpiresInMinutes, 15);
  assert.match(f.page.text, /只准备，未修改数据库、登录密码、Secret 或云端配置，模型未调用/);
  assert.match(f.page.text, /owner@synthetic\.example/);
  assert.doesNotMatch(f.page.text, /<input[^>]*id="email"|加密保存并同步|加密保存并校验/);
  assert.match(f.page.text, /Worker 密钥不在此收取或生成/);
  assert.equal(f.page.headers["cache-control"], "no-store");
  assert.match(f.page.headers["content-security-policy"], /connect-src 'self'/);
  let responseFinished = false;
  f.entry.server.prependListener("request", (req, res) => {
    if (req.url === "/save") res.once("finish", () => { responseFinished = true; });
  });
  const waiting = f.entry.waitUntilPrepared(), submission = f.submit(input);
  const receipt = await waiting;
  assert.equal(responseFinished, true);
  const prepared = f.entry.consumePrepared();
  const result = await submission;
  assert.equal(result.status, 200);
  assert.equal(receipt.status, "PREPARED_IN_MEMORY");
  assert.deepEqual(receipt.fields, ["mysql", "currentPassword", "password", "modelKey"]);
  for (const key of ["databaseChanged", "loginChanged", "secretsChanged", "cloudChanged", "modelCalled", "workerSecretGenerated"]) assert.equal(receipt[key], false);
  for (const secret of Object.values(input)) assert.equal(result.text.includes(secret), false);
  assert.deepEqual(receipt, JSON.parse(result.text), "waiting returns only the sent receipt, never the private payload");
  assert.equal(f.calls.length, 0); assert.equal(modelCalls, 0);
  assert.equal(prepared.email, "owner@synthetic.example");
  assert.equal(prepared.mysql, input.mysql); assert.equal(prepared.currentPassword, input.currentPassword);
  assert.equal(prepared.password, input.password); assert.equal(prepared.modelKey, input.modelKey);
  assert.match(prepared.bootstrapPasswordHash, /^scrypt\$/);
  assert.equal(Object.hasOwn(prepared, "confirm"), false);
  assert.equal(Object.hasOwn(prepared, "workerSecret"), false);
  assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
  await assert.rejects(f.entry.waitUntilPrepared(), /暂存不可领取/);
  assert.equal((await f.submit()).status, 409);
  const completed = await call(f.url, "GET");
  assert.match(completed.text, /已由进程内驱动领取/);
  for (const secret of Object.values(input)) assert.equal(completed.text.includes(secret), false);
  for (const path of ["/prepared", "/consume", "/save"]) assert.equal((await call(f.url + path, "GET")).status, 404);
});

test("prepare-only requires a planned account, rejects extra fields and preserves Host, Origin and CSRF checks", async (t) => {
  for (const options of [{}, { plannedEmail: "bad" }, { plannedEmail: "owner@example.test", mysqlOnly: true },
    { plannedEmail: "owner@example.test", preparedTtlMs: 0 }, { plannedEmail: "owner@example.test", preparedTtlMs: 7200001 }])
    assert.throws(() => createSecureConfigServer({ prepareOnly: true, ...options }), /固定账号和有效暂存期限/);
  const f = await preparationFixture(t);
  assert.equal((await call(f.url, "GET", { host: "evil.example" })).status, 403);
  for (const headers of [{ origin: "https://evil.example" }, { "x-setup-token": "wrong" }, { cookie: "wrong" }])
    assert.equal((await f.submit(preparationInput(), headers)).status, 403);
  for (const addition of [{ email: "other@example.test" }, { workerSecret: "SyntheticWorkerSecret" }, { approved: true }])
    assert.equal((await f.submit({ ...preparationInput(), ...addition })).status, 400);
  for (const input of [null, [], {}, { ...preparationInput(), mysql: 123 }]) assert.equal((await f.submit(JSON.stringify(input))).status, 400);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
});

test("executionAuthorized changes only preparation copy and preserves receipt waiting, no cloud calls and one-time consumption", async (t) => {
  const f = await preparationFixture(t, { executionAuthorized: true });
  assert.match(f.page.text, /提交后由已授权的同进程维护驱动校验并按批准范围执行；本页不直接改云端，结果以执行回执为准/);
  assert.match(f.page.text, /提交给已授权维护驱动/);
  assert.doesNotMatch(f.page.text, /等待独立的执行授权/);
  assert.equal((await f.submit({ ...preparationInput(), executionAuthorized: true })).status, 400);
  const waiting = f.entry.waitUntilPrepared(), submission = f.submit();
  const receipt = await waiting;
  assert.equal(receipt.cloudChanged, false); assert.equal(receipt.secretsChanged, false); assert.equal(receipt.modelCalled, false);
  assert.equal(Object.hasOwn(receipt, "executionAuthorized"), false, "display copy is not an authorization receipt");
  const value = f.entry.consumePrepared();
  assert.equal(value.password, preparationInput().password);
  assert.equal((await submission).status, 200);
  assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
  const completed = await call(f.url, "GET");
  assert.match(completed.text, /执行结果以维护回执为准/);
  assert.doesNotMatch(completed.text, /等待独立的执行授权/);
  assert.equal(f.calls.length, 0);
});

test("executionAuthorized rejects non-booleans and cannot activate any non-preparation mode", () => {
  for (const executionAuthorized of ["true", "false", 1, 0, null, {}])
    assert.throws(() => createSecureConfigServer({ prepareOnly: true, plannedEmail: "owner@example.test", executionAuthorized }), /executionAuthorized 必须为布尔值/);
  for (const options of [{}, { mysqlOnly: true }])
    assert.throws(() => createSecureConfigServer({ ...options, executionAuthorized: true }), /仅准备模式可启用/);
});

test("prepare-only validates user-chosen password limits and model syntax without trimming current passwords or echoing failures", async (t) => {
  const f = await preparationFixture(t);
  const cases = [{ mysql: "Aa1!" }, { mysql: "Aa1!" + "x".repeat(29) }, { mysql: "aaaaaaaaAAAA" }, { mysql: "Aa1!\r\nxx" },
    { mysql: " Aa1!xxxx" }, { currentPassword: "" }, { currentPassword: "x".repeat(129) }, { password: "weak", confirm: "weak" },
    { password: "A1!" + "x".repeat(126), confirm: "A1!" + "x".repeat(126) }, { confirm: "Different!42" },
    { currentPassword: "NewSynthetic!42" }, { mysql: "NewSynthetic!42" }, { currentPassword: "SyntheticMysql!42" },
    { modelKey: "sk-***masked***" }, { modelKey: "LTAISyntheticNotModel" }, { modelKey: "sk-contains space" }];
  for (const patch of cases) {
    const input = { ...preparationInput(), ...patch }, result = await f.submit(input);
    assert.equal(result.status, 400);
    for (const secret of Object.values(input).filter(value => value.length >= 8)) assert.equal(result.text.includes(secret), false);
    assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
  }
  const invalidJson = await f.submit('{"mysql":"SYNTHETIC_PRIVATE_PARSE_ERROR');
  assert.equal(invalidJson.status, 400); assert.equal(invalidJson.text.includes("SYNTHETIC_PRIVATE_PARSE_ERROR"), false);
  const normalized = validatePreparedConfig({ ...preparationInput(), modelKey: '  "sk-synthetic-normalized"  ' });
  assert.equal(normalized.currentPassword, preparationInput().currentPassword);
  assert.equal(normalized.modelKey, "sk-synthetic-normalized");
  assert.equal(f.calls.length, 0);
});

test("prepare-only accepts the maximum model Key and exactly 16 KiB, but rejects larger keys or bodies", async (t) => {
  const tooLarge = await preparationFixture(t);
  assert.equal((await tooLarge.submit({ ...preparationInput(), modelKey: "sk-" + "a".repeat(8190) })).status, 400);
  const exactKey = "sk-" + "a".repeat(8189), input = { ...preparationInput(), modelKey: exactKey };
  const serialized = JSON.stringify(input), padded = serialized + " ".repeat(16 * 1024 - Buffer.byteLength(serialized));
  assert.equal((await tooLarge.submit(padded + " ")).status, 413);
  assert.equal(tooLarge.calls.length, 0);
  const accepted = await tooLarge.submit(padded);
  assert.equal(accepted.status, 200); assert.equal(accepted.text.includes(exactKey), false);
  assert.equal(tooLarge.entry.consumePrepared().modelKey.length, 8192);
  assert.equal(tooLarge.calls.length, 0);
});

test("prepare-only rejects concurrent and repeated submissions and only releases a successfully prepared payload once", async (t) => {
  const f = await preparationFixture(t), payload = JSON.stringify(preparationInput()), target = new URL(f.url);
  const observed = new Promise(resolve => f.entry.server.once("request", resolve));
  const waiting = f.entry.waitUntilPrepared();
  let firstRequest;
  const first = new Promise((resolve, reject) => {
    firstRequest = request({ hostname: target.hostname, port: target.port, path: "/save", method: "POST", headers: f.headers }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    firstRequest.on("error", reject);
    firstRequest.write(payload.slice(0, 1));
  });
  await observed;
  assert.equal((await f.submit()).status, 409);
  assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
  firstRequest.end(payload.slice(1));
  assert.equal((await waiting).status, "PREPARED_IN_MEMORY");
  assert.equal(f.entry.consumePrepared().password, preparationInput().password);
  assert.equal(await first, 200);
  assert.equal((await f.submit()).status, 409);
  assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
  assert.equal(f.calls.length, 0);
});

test("prepare-only expiry and service close release the retained values", async (t) => {
  let now = Date.parse("2026-11-02T00:00:00Z");
  const expired = await preparationFixture(t, { now: () => now, preparedTtlMs: 1000 });
  assert.equal((await expired.submit()).status, 200); now += 1000;
  assert.throws(() => expired.entry.consumePrepared(), /没有可领取/);
  assert.equal((await expired.submit()).status, 410);
  assert.match((await call(expired.url, "GET")).text, /暂存已过期/);
  const closed = await preparationFixture(t); assert.equal((await closed.submit()).status, 200);
  await new Promise(resolve => closed.entry.server.close(resolve));
  assert.throws(() => closed.entry.consumePrepared(), /没有可领取/);
  const timer = await preparationFixture(t, { preparedTtlMs: 10 });
  assert.equal((await timer.submit()).status, 200);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.throws(() => timer.entry.consumePrepared(), /没有可领取/);
  assert.equal(expired.calls.length + closed.calls.length + timer.calls.length, 0);
});

test("waiting survives invalid input and a caller failure cannot undo a completed one-time consumption", async (t) => {
  const f = await preparationFixture(t);
  let resolved = false;
  const waiting = f.entry.waitUntilPrepared();
  waiting.then(() => { resolved = true; }, () => {});
  const failed = await f.submit({ ...preparationInput(), confirm: "MismatchSynthetic!42" });
  assert.equal(failed.status, 400); assert.equal(failed.text.includes("MismatchSynthetic!42"), false);
  assert.equal(resolved, false); assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
  const caller = (async () => {
    await waiting;
    assert.equal(f.entry.consumePrepared().password, preparationInput().password);
    throw new Error("SYNTHETIC_CALLER_FAILURE");
  })();
  const rejected = assert.rejects(caller, /SYNTHETIC_CALLER_FAILURE/);
  assert.equal((await f.submit()).status, 200); await rejected;
  assert.equal(resolved, true); assert.throws(() => f.entry.consumePrepared(), /没有可领取/);
  assert.equal((await f.submit()).status, 409);
  assert.match((await call(f.url, "GET")).text, /已由进程内驱动领取/);
  assert.equal(f.calls.length, 0);
});

test("pending preparation waiters reject safely on close or expiry before the success response completes", async (t) => {
  const closed = await preparationFixture(t);
  const closing = assert.rejects(closed.entry.waitUntilPrepared(), /本机准备已过期或服务已关闭，暂存不可领取/);
  await new Promise(resolve => closed.entry.server.close(resolve)); await closing;
  assert.throws(() => closed.entry.consumePrepared(), /没有可领取/);
  let now = Date.parse("2026-11-02T00:00:00Z");
  const expired = await preparationFixture(t, { now: () => now, preparedTtlMs: 1000 });
  expired.entry.server.prependListener("request", (req, res) => {
    if (req.url === "/save") res.once("finish", () => { now += 1000; });
  });
  const expiry = assert.rejects(expired.entry.waitUntilPrepared(), /本机准备已过期或服务已关闭，暂存不可领取/);
  await expired.submit(); await expiry;
  assert.throws(() => expired.entry.consumePrepared(), /没有可领取/);
  await assert.rejects(expired.entry.waitUntilPrepared(), /暂存不可领取/);
  assert.equal(closed.calls.length + expired.calls.length, 0);
});

test("RDS rotation input rejects unsupported API characters before any cloud operation", () => {
  for (const character of ['?', ':', '~', '"', "'", '\\', '/', '[', ']']) {
    assert.throws(() => validatePreparedConfig({ ...preparationInput(), mysql: `SyntheticDb${character}New42!` }), /特殊字符仅支持/);
  }
  assert.doesNotThrow(() => validatePreparedConfig({ ...preparationInput(), mysql: "SyntheticDb#New42!" }));
});

test("standalone prepare-only CLI fails safely without starting a page or printing provided account arguments", () => {
  for (const args of [["--prepare-only"], ["--prepare-only", "--email", "SYNTHETIC_PRIVATE_ACCOUNT@example.invalid"]]) {
    const result = spawnSync(process.execPath, ["scripts/start-v2-secure-config.mjs", ...args], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr, "准备模式仅供已审阅的同进程驱动通过 createSecureConfigServer 启动；独立 CLI 没有消费端，未启动填写页面。\n");
  }
});
