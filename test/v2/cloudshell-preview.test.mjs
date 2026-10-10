import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once, EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import { spawn } from "node:child_process";
import { createPreviewServer, privatePayload, invokePrivate, pipeBridge } from "../../scripts/run-v2-cloudshell-preview.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "shuduo-preview-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><html><head></head><body>数舵</body></html>");
  await writeFile(join(root, "outside.txt"), "private file");
  const calls = [];
  const server = createPreviewServer({ origin: "https://preview.example.invalid", webRoot: root,
    invoke: async payload => { calls.push(payload); return { status: 200, body: { id: "cloud-run", status: "SUCCEEDED" }, cookies: ["shuduo_session=session; HttpOnly; Secure; SameSite=Strict; Path=/api/v2"] }; }, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  const request = (path, init = {}) => new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path, method: init.method || "GET", headers: { host: "preview.example.invalid", "x-shuduo-client": "workbench", ...init.headers } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode, headers: new Headers(res.headers), text: async () => body, json: async () => JSON.parse(body) }));
    }); req.on("error", reject); req.end(init.body);
  });
  return { root, calls, request };
}

test("preview serves only compiled files and explicitly marks the narrowed UI", async t => {
  const { root, request, calls } = await fixture(t);
  let response = await request("/v2/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /shuduo-private-preview/);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  for (const path of ["/.env", "/v2/../outside.txt", "/v2/assets/%2e%2e%2foutside.txt", "/v2/assets/nested/a.js"])
    assert.equal((await request(path)).status, 404);
  await symlink(join(root, "../missing-secret.txt"), join(root, "assets/leak.js"));
  assert.notEqual((await request("/v2/assets/leak.js")).status, 200);
  assert.equal(calls.length, 0);
});

test("preview rejects other hosts, origins, routes and cross-site requests before CLI", async t => {
  const { request, calls } = await fixture(t);
  for (const headers of [{ host: "evil.invalid" }, { origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }, { "x-shuduo-client": "" }])
    assert.equal((await request("/api/v2/status", { headers })).status, 403);
  for (const path of ["/api/v2/agent/tasks", "/api/v2/runs?operation=PRIVATE_STATUS_V1", "/api/v2/auth/change-password", "/api/v2/admin"])
    assert.equal((await request(path)).status, 404);
  assert.equal((await request("/api/v2/runs", { method: "DELETE" })).status, 404);
  assert.equal(calls.length, 0);
});

test("preview preserves application auth and CSRF; never forwards Alibaba account cookies", async t => {
  const { request, calls } = await fixture(t);
  const options = { method: "POST", headers: { origin: "https://preview.example.invalid", "content-type": "application/json", cookie: "aliyun_token=never; shuduo_session=normal_session; shuduo_csrf=csrf_123", "x-csrf-token": "csrf_123", "idempotency-key": "run-stable" }, body: JSON.stringify({ revisionId: "version-one" }) };
  const response = await request("/api/v2/runs", options);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);
  assert.deepEqual(calls[0].headers, { "x-shuduo-client": "workbench", "x-csrf-token": "csrf_123", "idempotency-key": "run-stable", cookie: "shuduo_session=normal_session; shuduo_csrf=csrf_123" });
  assert.equal((await request("/api/v2/runs", { ...options, headers: { "content-type": "application/json" } })).status, 403);
  assert.equal((await request("/api/v2/runs", { ...options, body: "[]" })).status, 422);
  assert.equal((await request("/api/v2/runs", { ...options, body: "{" })).status, 400);
  assert.equal(calls.length, 1);
});

test("preview imposes a finite invocation allowance and never fabricates a successful result", async t => {
  const { request, calls } = await fixture(t, { maxCalls: 1 });
  assert.deepEqual(await (await request("/api/v2/runs")).json(), { id: "cloud-run", status: "SUCCEEDED" });
  assert.equal((await request("/api/v2/runs")).status, 429);
  assert.equal(calls.length, 1);
});

test("Agent preview opt-in allows only scoped SQL task lifecycle with original session and idempotency", async t => {
  const { request, calls } = await fixture(t, { allowAgent: true });
  assert.match(await (await request("/v2/")).text(), /shuduo-agent-development/);
  assert.equal((await request("/")).headers.get("location"), "/v2/?module=agent-center");
  assert.equal((await request("/api/v2/agent/tasks")).status, 200);
  const id = "00000000-0000-4000-8000-000000000001";
  const options = { method: "POST", headers: { origin: "https://preview.example.invalid", "content-type": "application/json", cookie: "aliyun_token=never; shuduo_session=owner; shuduo_csrf=csrf_123", "x-csrf-token": "csrf_123", "idempotency-key": "same-request" }, body: JSON.stringify({ expectedVersion: 3 }) };
  assert.equal((await request(`/api/v2/agent/tasks/${id}/advance`, options)).status, 200);
  assert.equal(calls.at(-1).headers["idempotency-key"], "same-request");
  assert.equal(calls.at(-1).headers.cookie, "shuduo_session=owner; shuduo_csrf=csrf_123");
  assert.equal(calls.at(-1).body.expectedVersion, 3);
  assert.equal((await request("/api/v2/agent/tasks", { ...options, body: JSON.stringify({ language: "PYTHON" }) })).status, 422);
  for (const path of ["/invoke", "/api/v2/internal/scheduler/tick", `/api/v2/agent/tasks/${id}/prepare-delivery`, `/api/v2/agent/tasks/${id}/journey`])
    assert.equal((await request(path, options)).status, path === "/invoke" ? 405 : 404);
  assert.equal(calls.length, 2);
});

test("preview sanitizes transport errors and serializes cloud requests", async t => {
  let active = 0, maximum = 0;
  const { request } = await fixture(t, { invoke: async () => {
    active++; maximum = Math.max(active, maximum);
    await new Promise(r => setTimeout(r, 10)); active--;
    throw new Error("password=secret-session");
  } });
  const responses = await Promise.all([request("/api/v2/runs"), request("/api/v2/contexts")]);
  assert.equal(maximum, 1);
  for (const response of responses) { assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /secret-session/); }
});

test("CLI bridge carries secrets through stdin, not argv or shell expansion", async () => {
  let args, input;
  const result = await invokePrivate(privatePayload("POST", "/api/v2/auth/login", {}, { password: "SecretForTestOnly!" }), (command, argv, options) => {
    assert.equal(command, "python3"); assert.equal(argv[2], "aliyun"); assert.equal(options.shell, undefined); assert.equal(options.detached, true); args = argv;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.on("data", chunk => { input = String(chunk); });
    child.stdin.on("finish", () => { child.stdout.write(JSON.stringify({ protocol: "shuduo-private-application-http/v1", status: 200, cookies: [], body: { authenticated: true } })); child.emit("close", 0); });
    return child;
  });
  assert.ok(args.includes("/dev/stdin")); assert.doesNotMatch(args.join(" "), /SecretForTestOnly/);
  assert.match(input, /SecretForTestOnly/); assert.equal(result.body.authenticated, true);
});

test("real anonymous pipe supports CLI-style /dev/stdin reopening on Linux", async () => {
  const child = spawn("python3", ["-c", pipeBridge, "python3", "-c", "import sys;sys.stdout.write(open('/dev/stdin').read())"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { stderr += b; });
  const closed = once(child, "close");
  child.stdin.end("synthetic-pipe-probe");
  assert.equal((await closed)[0], 0, stderr);
  assert.equal(output, "synthetic-pipe-probe");
});

test("official Cloud Shell loopback Host is accepted without relaxing browser Origin", async t => {
  const origin = "https://60000-dot-fixture.shell.aliyuncs.com";
  const { request, calls } = await fixture(t, { origin, localProxyPort: 60000 });
  const proxyHeaders = { host: "127.0.0.1:60000", "x-forwarded-proto": "https" };
  assert.equal((await request("/v2/", { headers: { ...proxyHeaders, "sec-fetch-site": "cross-site" } })).status, 200);
  assert.equal((await request("/api/v2/runs", { headers: proxyHeaders })).status, 200);
  for (const extra of [{ host: "127.0.0.1:61000" }, { host: "localhost:60000" }, { "x-forwarded-proto": "http" }, { origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }])
    assert.equal((await request("/api/v2/runs", { headers: { ...proxyHeaders, ...extra } })).status, 403);
  assert.equal((await request("/api/v2/runs", { method: "POST", headers: { ...proxyHeaders, origin: "https://evil.invalid", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await request("/api/v2/runs", { method: "POST", headers: { ...proxyHeaders, origin, "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal(calls.length, 2);
});

test("loopback proxy cannot be enabled for arbitrary hosts or mismatched ports", () => {
  for (const origin of ["https://evil.invalid", "https://61000-dot-fixture.shell.aliyuncs.com", "https://60000-dot-fixture.shell.aliyuncs.com.evil.invalid", "http://127.0.0.1"])
    assert.throws(() => createPreviewServer({ origin, webRoot: ".", localProxyPort: 60000 }), /matching official/);
});
