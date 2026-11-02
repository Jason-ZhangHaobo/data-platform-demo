// Fake fetch and Web Streams only: no HTTP listener, network or real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCredentialAuthHttpAdapter } from "../../scripts/credential-auth-http-adapter.mjs";
import { AuthManager } from "../../src/v2/auth.mjs";

const email = "owner@synthetic.example", projectId = "project-securities-lab", time = Date.parse("2026-11-02T08:00:00Z");
const user = { id: "11111111-1111-4111-8111-111111111111", email, projectId, status: "ACTIVE", displayName: "not-needed" };
const xapiId = "22222222-2222-4222-8222-222222222222", otherId = "33333333-3333-4333-8333-333333333333";
const bootId = "44444444-4444-4444-8444-444444444444", newBootId = "55555555-5555-4555-8555-555555555555";
const token = label => label === "A" ? `sess_${label.repeat(43)}` : `csrf_${label.repeat(32)}`;
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
const authResponse = (patch = {}, cookiePatch) => {
  const body = { user, role: "ADMIN", permissions: ["SESSION"], readOnly: true, csrfToken: token("B"), ...patch }, headers = new Headers({ "Content-Type": "application/json" });
  const cookies = [`shuduo_session=${token("A")}; Path=/api/v2; HttpOnly; SameSite=Strict; Max-Age=28800; Secure`,
    `shuduo_csrf=${token("B")}; Path=/; SameSite=Strict; Max-Age=28800; Secure`];
  for (const cookie of cookiePatch ? cookiePatch(cookies) : cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status: 200, headers });
};
const manifest = () => [{ id: otherId, serviceType: "XAPI", scope: "PRIVATE_CLOUD_TEST", projectId, publishedVersionId: bootId },
  { id: xapiId, serviceType: "XAPI", scope: "PRIVATE_CLOUD_TEST", projectId, publishedVersionId: newBootId, token: "SYNTHETIC_PRIVATE_FIELD" }];
const recovery = (patch = {}) => ({ protocol: "shuduo-private-service-recovery/v1", scope: "PRIVATE_CLOUD_TEST", publicDeployed: false,
  bootId, checkedAt: new Date(time).toISOString(), healthy: true, fingerprint: "a".repeat(64),
  state: { serviceId: xapiId, serviceType: "XAPI", privateExtra: "SYNTHETIC_PRIVATE_FIELD" }, ...patch });
const fixture = (responses = [], options = {}) => {
  const accounted = [], calls = [], order = [];
  const adapter = createCredentialAuthHttpAdapter({ email, projectId, now: () => time,
    beforeRequest: async record => { accounted.push(record); order.push("accounted"); },
    fetchImpl: async (url, request) => {
      calls.push({ url, request }); order.push("fetch");
      assert.equal(order.at(-2), "accounted");
      const next = responses.shift(); assert.ok(next, "unexpected extra transport call");
      return typeof next === "function" ? next(url, request) : next;
    }, ...options });
  return { adapter, accounted, calls, order };
};
const login = adapter => adapter.login({ email, password: "  SyntheticCurrent!42  " });

test("fixed-origin authentication uses memory-only Cookie/CSRF and accounts before each exact request", async () => {
  const f = fixture([authResponse(), authResponse(), response({ authenticated: true, readOnly: true, user, role: "ADMIN", permissions: ["SESSION"] }),
    response({ authenticated: false, readOnly: true }), response({ code: "INVALID_LOGIN", message: "SYNTHETIC_PRIVATE_FIELD" }, 401)]);
  const old = await login(f.adapter);
  const changed = await f.adapter.changePassword({ session: old.session, currentPassword: "  SyntheticCurrent!42  ", newPassword: "SyntheticNext!42" });
  assert.equal((await f.adapter.readSession({ session: changed.session })).authenticated, true);
  assert.deepEqual(await f.adapter.readSession({ session: old.session }), { authenticated: false, readOnly: true });
  assert.deepEqual(await login(f.adapter), { status: 401, code: "INVALID_LOGIN" });
  assert.deepEqual(f.calls.map(x => x.url), ["/auth/login", "/auth/password", "/auth/session", "/auth/session", "/auth/login"].map(path => `https://shuduoai.cn/api/v2${path}`));
  assert.deepEqual(JSON.parse(f.calls[0].request.body), { email, password: "  SyntheticCurrent!42  " });
  assert.deepEqual(JSON.parse(f.calls[1].request.body), { currentPassword: "  SyntheticCurrent!42  ", newPassword: "SyntheticNext!42" });
  assert.equal(f.calls[0].request.headers.Cookie, undefined);
  assert.equal(f.calls[1].request.headers.Cookie, old.session.cookie);
  assert.equal(f.calls[1].request.headers["X-CSRF-Token"], old.session.csrfToken);
  assert.equal(f.calls[1].request.headers.Origin, "https://shuduoai.cn");
  assert.ok(f.calls.every(x => x.request.redirect === "error" && x.request.credentials === "omit" && x.request.signal instanceof AbortSignal));
  assert.ok(f.accounted.every((value, index) => value.sequence === index + 1 && Object.keys(value).join() === "sequence,operation,method,path"));
  assert.equal(JSON.stringify(f.accounted).includes("SyntheticCurrent"), false);
  assert.equal(JSON.stringify(f.accounted).includes(token("A")), false);
  assert.deepEqual(Object.keys(old.session.user).sort(), ["email", "id", "projectId", "status"]);
});

test("invalid identity, foreign session, extra fields and failed accounting cannot reach transport", async () => {
  assert.throws(() => createCredentialAuthHttpAdapter({ email }), { code: "AUTH_HTTP_CONFIG_INVALID" });
  const f = fixture();
  await assert.rejects(f.adapter.login({ email: "other@example.invalid", password: "Synthetic!42" }), { code: "AUTH_HTTP_INPUT_INVALID" });
  await assert.rejects(f.adapter.login({ email, password: "Synthetic!42", url: "https://evil.example" }), { code: "AUTH_HTTP_INPUT_INVALID" });
  await assert.rejects(f.adapter.readSession({ session: { cookie: "SYNTHETIC_PRIVATE_FIELD", csrfToken: "private" } }), { code: "AUTH_HTTP_SESSION_INVALID" });
  assert.equal(f.calls.length, 0); assert.equal(f.accounted.length, 0);
  const denied = fixture([], { beforeRequest: () => { throw Error("SYNTHETIC_PRIVATE_FIELD"); } });
  await assert.rejects(login(denied.adapter), { code: "AUTH_HTTP_ACCOUNTING_FAILED", message: "AUTH_HTTP_ACCOUNTING_FAILED" });
  assert.equal(denied.calls.length, 0);
});

test("login errors are bounded and redacted; no status or transport failure triggers retries", async () => {
  for (const status of [401, 429, 500, 503]) {
    const f = fixture([response({ code: "SYNTHETIC_PRIVATE_FIELD", message: token("A") }, status)]);
    assert.deepEqual(await login(f.adapter), { status });
    assert.equal(f.calls.length, 1); assert.equal(f.accounted.length, 1);
  }
  const f = fixture([() => { throw Error(`private transport ${token("A")}`); }]);
  await assert.rejects(login(f.adapter), { code: "AUTH_HTTP_RESPONSE_UNKNOWN", message: "AUTH_HTTP_RESPONSE_UNKNOWN" });
  assert.equal(f.calls.length, 1);
});

test("successful authentication requires secure host-only cookies, matching CSRF and a readonly fixed identity", async () => {
  const responses = [authResponse({ user: { ...user, email: "other@example.invalid" } }), authResponse({ permissions: ["*"] }), authResponse({ readOnly: false }),
    authResponse({ csrfToken: "SYNTHETIC_PRIVATE_FIELD" }), authResponse({}, cookies => [cookies[0]]), authResponse({}, cookies => [...cookies, cookies[0]]),
    authResponse({}, cookies => cookies.map(cookie => cookie.replace("; Secure", ""))),
    authResponse({}, cookies => cookies.map(cookie => cookie + "; Domain=evil.example")),
    authResponse({}, cookies => cookies.map(cookie => cookie.replace("Max-Age=28800", "Max-Age=0")))];
  for (const value of responses) {
    const f = fixture([value]); await assert.rejects(login(f.adapter), error => /^AUTH_HTTP_(?:IDENTITY|COOKIE)_INVALID$/.test(error.code));
    assert.equal(f.calls.length, 1);
  }
  const first = fixture([authResponse()]), second = fixture();
  const authenticated = await login(first.adapter);
  await assert.rejects(second.adapter.readSession({ session: authenticated.session }), { code: "AUTH_HTTP_SESSION_INVALID" });
  assert.equal(second.calls.length, 0);
});

test("real AuthManager login and password-change cookies pass the adapter's distinct session and CSRF contracts", async () => {
  const rows = [], store = {
    list: kind => rows.filter(row => row.kind === kind),
    create: (kind, project, value) => { const row = { ...value, id: randomUUID(), kind, projectId: project }; rows.push(row); return row; },
    get: (_kind, id) => rows.find(row => row.id === id),
    update: (_kind, id, _project, patch) => Object.assign(rows.find(row => row.id === id), patch),
  };
  const manager = new AuthManager({ store, project: projectId, now: () => time, env: {} });
  const currentPassword = "SyntheticCurrent!42", newPassword = "SyntheticChanged!42";
  manager.bootstrapAdmin({ email, displayName: "合成管理员", password: currentPassword });
  const old = manager.login({ email, password: currentPassword });
  const changed = manager.changePassword({ user: old.user }, { currentPassword, newPassword });
  const serialized = [old, changed].map(value => {
    assert.equal(value.rawToken.slice("sess_".length).length, 43);
    assert.equal(value.csrfToken.slice("csrf_".length).length, 32);
    const output = manager.sessionResponse(value, true), headers = new Headers({ "Content-Type": "application/json" });
    for (const cookie of output.cookies) headers.append("Set-Cookie", cookie);
    return new Response(JSON.stringify({ ...output.body, permissions: ["SESSION"], readOnly: true }), { status: 200, headers });
  });
  const f = fixture(serialized), signedIn = await f.adapter.login({ email, password: currentPassword });
  assert.equal(signedIn.session.csrfToken, old.csrfToken);
  const updated = await f.adapter.changePassword({ session: signedIn.session, currentPassword, newPassword });
  assert.equal(updated.session.csrfToken, changed.csrfToken);
  assert.equal(updated.session.user.id, old.user.id);
  assert.equal(f.calls.length, 2);
});

test("session and CSRF cookie suffixes reject both shorter and longer values independently", async () => {
  for (const [label, prefix, lengths] of [["A", "sess_", [42, 44]], ["B", "csrf_", [31, 33, 43]]]) {
    for (const length of lengths) {
      const invalid = prefix + "X".repeat(length);
      const f = fixture([authResponse(label === "B" ? { csrfToken: invalid } : {}, cookies => cookies.map(cookie => cookie.replace(token(label), invalid)))]);
      await assert.rejects(login(f.adapter), { code: "AUTH_HTTP_COOKIE_INVALID" });
      assert.equal(f.calls.length, 1);
    }
  }
});

test("response byte limits, JSON validation and redirect evidence fail closed without exposing bodies", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2048)); }, cancel() { cancelled = true; } });
  const oversized = fixture([new Response(stream, { headers: { "content-type": "application/json" } })], { maxResponseBytes: 1024 });
  await assert.rejects(login(oversized.adapter), { code: "AUTH_HTTP_RESPONSE_TOO_LARGE" }); assert.equal(cancelled, true);
  const redirected = response({ message: "SYNTHETIC_PRIVATE_FIELD" }); Object.defineProperty(redirected, "redirected", { value: true });
  const wrongUrl = response({}); Object.defineProperty(wrongUrl, "url", { value: "https://evil.example" });
  for (const value of [response({}, 200, { "content-length": "10000000" }), new Response("SYNTHETIC_PRIVATE_FIELD", { headers: { "content-type": "application/json" } }),
    new Response("SYNTHETIC_PRIVATE_FIELD", { headers: { "content-type": "text/html" } }), redirected, wrongUrl]) {
    const f = fixture([value]); await assert.rejects(login(f.adapter), error => /^AUTH_HTTP_RESPONSE_(?:INVALID|TOO_LARGE)$/.test(error.code) && !error.message.includes("SYNTHETIC_PRIVATE_FIELD"));
    assert.equal(f.calls.length, 1);
  }
});

test("timeouts bound both headers and streaming bodies, abort once and never retry", async () => {
  let aborted = 0;
  const headers = fixture([(_url, request) => { request.signal.addEventListener("abort", () => { aborted++; }); return new Promise(() => {}); }], { timeoutMs: 10 });
  await assert.rejects(login(headers.adapter), { code: "AUTH_HTTP_TIMEOUT" }); assert.equal(aborted, 1); assert.equal(headers.calls.length, 1);
  let cancelled = false;
  const body = fixture([new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }),
    { headers: { "content-type": "application/json" } })], { timeoutMs: 10 });
  await assert.rejects(login(body.adapter), { code: "AUTH_HTTP_TIMEOUT" }); assert.equal(cancelled, true); assert.equal(body.calls.length, 1);
});

test("one existing published XAPI is pinned across recovery reads and full snapshot state never leaves the adapter", async () => {
  const f = fixture([authResponse(), response(manifest()), response(recovery()), response(recovery({ bootId: newBootId }))]);
  const { session } = await login(f.adapter);
  assert.deepEqual(await f.adapter.selectExistingXapi({ session }), { serviceId: xapiId, serviceType: "XAPI" });
  const before = await f.adapter.readRecovery({ session }), after = await f.adapter.readRecovery({ session });
  assert.equal(before.bootId, bootId); assert.equal(after.bootId, newBootId); assert.equal(before.fingerprint, after.fingerprint);
  assert.deepEqual(Object.keys(before), ["protocol", "serviceId", "bootId", "checkedAt", "healthy", "fingerprint"]);
  assert.equal(JSON.stringify(before).includes("SYNTHETIC_PRIVATE_FIELD"), false);
  assert.equal(f.calls.filter(x => x.url.endsWith("/xapis")).length, 1);
  assert.ok(f.calls.slice(2).every(x => x.request.method === "GET" && x.url === `https://shuduoai.cn/api/v2/data-services/xapis/${xapiId}/recovery`));
  assert.deepEqual(f.accounted.map(x => x.operation), ["AUTH_LOGIN", "XAPI_LIST", "XAPI_RECOVERY_READ", "XAPI_RECOVERY_READ"]);
});

test("a caller-pinned XAPI avoids discovery; missing, foreign or stale recovery evidence never selects another service", async () => {
  const direct = fixture([authResponse(), response(recovery())], { xapiId });
  const { session } = await login(direct.adapter); assert.equal((await direct.adapter.readRecovery({ session })).serviceId, xapiId);
  assert.equal(direct.calls.some(x => x.url.endsWith("/xapis")), false);
  for (const patch of [{ state: { serviceId: otherId, serviceType: "XAPI" } }, { bootId: "bad" }, { fingerprint: "bad" },
    { checkedAt: new Date(time - 300001).toISOString() }, { checkedAt: new Date(time + 60001).toISOString() }]) {
    const f = fixture([authResponse(), response(recovery(patch))], { xapiId });
    const authenticated = await login(f.adapter);
    await assert.rejects(f.adapter.readRecovery({ session: authenticated.session }), { code: "AUTH_HTTP_RECOVERY_INVALID" });
    assert.equal(f.calls.length, 2);
  }
  const none = fixture([authResponse(), response([])]), authenticated = await login(none.adapter);
  await assert.rejects(none.adapter.readRecovery({ session: authenticated.session }), { code: "AUTH_HTTP_EXISTING_XAPI_REQUIRED" });
  assert.ok(none.calls.slice(1).every(x => x.request.method === "GET"));
});

test("status projection reports only metadata health and does not invent boot or new-connection proof", async () => {
  const f = fixture([response({ projectId, mode: "PUBLIC_INVITATION", publicReady: false,
    metadata: { driver: "mysql-project-snapshot-cas", cloudVerified: true, privateValue: "SYNTHETIC_PRIVATE_FIELD" },
    persistence: { mode: "single-instance-two-store-cas", healthy: true }, authentication: { mode: "INVITATION_SESSION", publicSessionEnforced: true },
    model: { apiKey: "SYNTHETIC_PRIVATE_FIELD" }, bootId, budget: { privateValue: "SYNTHETIC_PRIVATE_FIELD" } })]);
  const status = await f.adapter.readStatus();
  assert.equal(status.metadata.cloudVerified, true); assert.equal(Object.hasOwn(status, "bootId"), false);
  assert.equal(Object.hasOwn(status, "freshInstance"), false); assert.equal(Object.hasOwn(status, "newDatabaseConnection"), false);
  assert.equal(JSON.stringify(status).includes("SYNTHETIC_PRIVATE_FIELD"), false);
  f.adapter.dispose(); await assert.rejects(login(f.adapter), { code: "AUTH_HTTP_DISPOSED" }); assert.equal(f.calls.length, 1);
});
