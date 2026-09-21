import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import {
  createSecureConfigServer,
  validateSecureConfig,
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
