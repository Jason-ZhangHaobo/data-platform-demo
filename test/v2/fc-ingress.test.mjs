import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFcIngress } from "../../src/v2/fc-ingress.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { validatePrivateApplicationRequest } from "../../src/v2/private-application.mjs";

const stub = (url, control, method = "POST", headers = {}) => ({
  url, method, headers: { ...(control === undefined ? {} : { "x-fc-control-path": control }), ...headers },
  rawHeaders: control === undefined ? [] : ["X-Fc-Control-Path", control],
  socket: { remoteAddress: "127.0.0.1" },
});
const rejected = fn => assert.throws(fn, error => error.code === "INGRESS_DENIED" && error.status === 404);

test("FC ingress is fail-closed; event marker only admits exact POST /invoke", () => {
  const gate = createFcIngress();
  assert.doesNotThrow(() => gate.assertRequest(stub("/invoke", "/invoke")));
  for (const control of [undefined, "/http-invoke", "/initialize", "", "/invoke, /http-invoke", ["/invoke"]])
    rejected(() => gate.assertRequest(stub("/invoke", control)));
  for (const path of ["/invoke?x=1", "/invoke/", "/INVOKE", "/%69nvoke", "/a/../invoke", "/api/v2/auth/session"])
    rejected(() => gate.assertRequest(stub(path, "/invoke")));
  rejected(() => gate.assertRequest(stub("/invoke", "/invoke", "GET")));
  rejected(() => gate.assertRequest(stub("/v2/", "/http-invoke", "GET")));
});

test("ingress diagnostics distinguish failure causes without reflecting request contents", async t => {
  const enabled = createFcIngress({ publicHttpEnabled: true });
  for (const [req, reason] of [[stub('/invoke', undefined, 'POST'), 'ROUTE_METHOD'],
    [stub('/v2/', 'secret-not-an-allowed-marker', 'GET'), 'CONTROL_UNRECOGNIZED'],
    [stub('/api/v2/internal/scheduler/tick', '/http-invoke'), 'INTERNAL_PATH']]) {
    assert.throws(() => enabled.assertRequest(req), e => e.code === 'INGRESS_DENIED' && e.ingressReason === reason && !JSON.stringify(e).includes('secret-not-an-allowed-marker'));
  }
  const { call, refreshes } = await open(t, false);
  const response = await call('/v2/', 'GET', httpHeaders);
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { message: '访问入口不可用', code: 'INGRESS_DENIED', ingressReason: 'HTTP_DISABLED' });
  assert.equal(refreshes(), 0);
});

test("public routes cannot reach private operations by normalization, forwarded headers or duplicates", () => {
  const gate = createFcIngress({ publicHttpEnabled: true });
  for (const path of ["/", "/v2/", "/v2/assets/index-abc.js", "/api/v2/auth/session", "/v2/?module=agent-center", "/api/v2/contexts?q=%E8%AF%81"])
    assert.doesNotThrow(() => gate.assertRequest(stub(path, "/http-invoke", "GET")));
  assert.doesNotThrow(() => gate.assertRequest(stub("/api/v2/auth/login", "/http-invoke")));
  for (const path of ["/invoke", "/invoke/", "/invoke?x=1", "/%69nvoke", "/%2569nvoke", "//invoke", "/v2/../invoke", "/v2/%2e%2e/invoke", "/v2/..\\invoke", "http://localhost/invoke", "/api/v2/internal/scheduler/tick", "/api/v2/internal", "/other", "/v2/#invoke"])
    rejected(() => gate.assertRequest(stub(path, "/http-invoke", "POST", { "x-forwarded-for": "127.0.0.1", host: "localhost", "x-original-url": "/api/v2/status" })));
  const duplicate = stub("/invoke", "/invoke");
  duplicate.rawHeaders.push("x-fc-control-path", "/invoke");
  rejected(() => gate.assertRequest(duplicate));
  rejected(() => gate.assertRequest(stub("/api/v2/auth/session", "/http-invoke", "TRACE")));
  rejected(() => gate.assertRequest(stub("/v2/", "/http-invoke", "POST")));
});

test("process hop requires an unforgeable per-instance token, loopback and no FC marker", () => {
  const gate = createFcIngress(), other = createFcIngress();
  const own = stub("/api/v2/auth/session", undefined, "GET", gate.internalHeaders);
  assert.doesNotThrow(() => gate.assertRequest(own));
  rejected(() => gate.assertRequest(stub(own.url, undefined, "GET")));
  rejected(() => gate.assertRequest(stub(own.url, undefined, "GET", other.internalHeaders)));
  rejected(() => gate.assertRequest({ ...own, socket: { remoteAddress: "192.0.2.1" } }));
  rejected(() => gate.assertRequest(stub("/invoke", undefined, "POST", gate.internalHeaders)));
  rejected(() => gate.assertRequest(stub("/api/v2/internal", undefined, "GET", gate.internalHeaders)));
  rejected(() => gate.assertRequest(stub(own.url, "/http-invoke", "GET", gate.internalHeaders)));
  assert.throws(() => validatePrivateApplicationRequest({ operation: "PRIVATE_APPLICATION_HTTP_V1", method: "GET", path: own.url, headers: gate.internalHeaders }), /PRIVATE_APPLICATION_HEADERS_INVALID/);
});

async function open(t, publicHttpEnabled, publicReadOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "shuduo-ingress-"));
  const ingress = createFcIngress({ publicHttpEnabled, publicReadOnly });
  let refreshes = 0;
  const app = createV2Server({ root, ingress,
    stateCoordinator: { refresh: async () => { refreshes++; }, flush: async () => {} },
    env: { V2_LOCAL_DEVELOPMENT: "false", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: "true", V2_PRIVATE_DATA_SERVICES_ENABLED: "true", V2_ALLOW_INSECURE_PUBLIC_COOKIES: "true" },
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (path, method, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: app.server.address().port, path, method, headers }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers }); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, ingress, call, refreshes: () => refreshes };
}
const eventHeaders = { "x-fc-control-path": "/invoke", "content-type": "application/octet-stream" };
const httpHeaders = { "x-fc-control-path": "/http-invoke", "content-type": "application/json", "x-shuduo-client": "workbench" };

test("actual HTTP server blocks private fixture/forwarding before persistence and still handles event status", async t => {
  const { app, call, refreshes } = await open(t, false);
  for (const operation of ["PRIVATE_STATUS_V1", "PRIVATE_APPLICATION_TASK_V1", "PRIVATE_APPLICATION_HTTP_V1", "PRIVATE_AGENT_TICK_V1"]) {
    const result = await call("/invoke", "POST", { ...httpHeaders, "content-type": "application/octet-stream" }, { operation, caseId: "holdings-t1" });
    assert.equal(result.status, 404); assert.equal(result.body.code, "INGRESS_DENIED");
  }
  assert.equal((await call("/v2/../invoke", "POST", eventHeaders, { operation: "PRIVATE_STATUS_V1" })).status, 404);
  assert.equal(refreshes(), 0);
  assert.equal(app.store.list("auth_user", PROJECT).length, 0);
  assert.equal(app.store.list("run", PROJECT).length, 0);
  const status = await call("/invoke", "POST", eventHeaders, { operation: "PRIVATE_STATUS_V1" });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.ingress, { mode: "FC_CONTROL_PATH", publicHttpEnabled: false });
  // The gate does not replace payload validation for timer/OSS dispatch.
  assert.equal((await call("/invoke", "POST", eventHeaders, { events: [] })).status, 422);
  const session = await call("/invoke", "POST", eventHeaders, { operation: "PRIVATE_APPLICATION_HTTP_V1", method: "GET", path: "/api/v2/auth/session", headers: {} });
  assert.equal(session.body.status, 200); assert.equal(session.body.body.authenticated, false);
});

test("public HTTP keeps login and CSRF enforcement; private forwarding credentials are not reflected", async t => {
  const { app, call, ingress } = await open(t, true);
  app.auth.bootstrapAdmin({ email: "synthetic-owner@example.invalid", password: "SyntheticOnly!2026", displayName: "虚构管理员" });
  assert.equal((await call("/api/v2/auth/session", "GET")).body.authenticated, false);
  const guest = await call("/api/v2/auth/session", "GET", httpHeaders);
  assert.equal(guest.status, 200); assert.equal(guest.body.authenticated, false);
  assert.equal((await call("/api/v2/revisions", "POST", httpHeaders, {})).status, 401);
  const login = await call("/api/v2/auth/login", "POST", httpHeaders, { email: "synthetic-owner@example.invalid", password: "SyntheticOnly!2026" });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
  assert.equal((await call("/api/v2/revisions", "POST", { ...httpHeaders, cookie }, {})).status, 403);
  const forwarded = await call("/invoke", "POST", eventHeaders, { operation: "PRIVATE_APPLICATION_HTTP_V1", method: "GET", path: "/api/v2/auth/session", headers: { cookie } });
  assert.equal(forwarded.body.body.authenticated, true);
  assert.equal(JSON.stringify(forwarded).includes(ingress.internalHeaders["x-shuduo-process-hop"]), false);
  assert.equal((await call("/api/v2/internal/scheduler/tick", "POST", httpHeaders, {})).status, 404);
});

test("cloud bootstrap always installs the FC boundary with public HTTP opt-in", () => {
  const source = readFileSync(new URL("../../src/v2/cloud-server.mjs", import.meta.url), "utf8");
  assert.match(source, /publicHttpEnabled: env\.V2_FC_PUBLIC_HTTP_ENABLED === "true"/);
  assert.match(source, /publicReadOnly: env\.V2_FC_PUBLIC_READ_ONLY !== "false"/);
});

test("read-only public gate rejects every business write before persistence without disabling private events", async t => {
  const { call, refreshes } = await open(t, true, true);
  for (const path of ["/api/v2/agent/tasks", "/api/v2/runs", "/api/v2/revisions", "/api/v2/releases", "/api/v2/auth/invitations", "/api/v2/auth/redeem", "/api/v2/auth/password", "/api/v2/services/applications"]) {
    const result = await call(path, "POST", httpHeaders, {});
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "PUBLIC_READ_ONLY");
  }
  assert.equal(refreshes(), 0);
  const status = await call("/invoke", "POST", eventHeaders, { operation: "PRIVATE_STATUS_V1" });
  assert.equal(status.status, 200);
  assert.equal(status.body.ingress.publicReadOnly, true);
  const session = await call("/api/v2/auth/session", "GET", httpHeaders);
  assert.equal(session.body.readOnly, true);
  assert.equal(session.body.authenticated, false);
});

test("unmarked custom-domain HTTP remains public and read-only, never a private event or trusted hop", async t => {
  const { call, refreshes } = await open(t, true, true);
  for (const path of ['/invoke', '/invoke?x=1', '/invoke/', '/%69nvoke', '/api/v2/internal', '/api/v2/internal/scheduler/tick']) {
    const denied = await call(path, 'POST', {'content-type':'application/octet-stream'}, {operation:'PRIVATE_STATUS_V1'});
    assert.equal(denied.status,404);assert.equal(denied.body.code,'INGRESS_DENIED');
  }
  for(const path of ['/api/v2/agent/tasks','/api/v2/runs','/api/v2/releases','/api/v2/auth/invitations']) {
    const denied=await call(path,'POST',{'content-type':'application/json','x-shuduo-process-hop':'guessed'},{});
    assert.equal(denied.status,403);assert.equal(denied.body.code,'PUBLIC_READ_ONLY');
  }
  assert.equal(refreshes(),0);
  const session=await call('/api/v2/auth/session','GET');
  assert.equal(session.status,200);assert.equal(session.body.authenticated,false);assert.equal(session.body.readOnly,true);
  const spoofed=await call('/api/v2/status','POST',eventHeaders,{operation:'PRIVATE_STATUS_V1'});
  assert.equal(spoofed.status,404);assert.equal(spoofed.body.ingressReason,'CONTROL_EVENT_ROUTE');
});

test("read-only public login keeps original role, narrows presentation permissions and permits logout", async t => {
  const { app, call } = await open(t, true, true);
  const credentials = { email: "readonly-owner@example.invalid", password: "SyntheticOnly!2026", displayName: "虚构管理员" };
  app.auth.bootstrapAdmin(credentials);
  const {['x-fc-control-path']:unused,...unmarkedHeaders}=httpHeaders;
  const login = await call("/api/v2/auth/login", "POST", unmarkedHeaders, credentials);
  assert.equal(login.status, 200);
  assert.equal(login.body.readOnly, true);
  assert.equal(login.body.role, "ADMIN");
  assert.deepEqual(login.body.permissions, ["SESSION"]);
  const cookie = login.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
  const headers = { ...unmarkedHeaders, cookie, "x-csrf-token": login.body.csrfToken };
  assert.deepEqual((await call("/api/v2/auth/session", "GET", headers)).body.permissions, ["SESSION"]);
  assert.equal((await call("/api/v2/revisions", "POST", headers, {})).body.code, "PUBLIC_READ_ONLY");
  const forwarded = await call("/invoke", "POST", eventHeaders, { operation: "PRIVATE_APPLICATION_HTTP_V1", method: "GET", path: "/api/v2/auth/session", headers: { cookie } });
  assert.deepEqual(forwarded.body.body.permissions, ["*"]);
  assert.equal(forwarded.body.body.readOnly, undefined);
  assert.equal((await call("/api/v2/auth/logout", "POST", headers, {})).status, 200);
  assert.equal((await call("/api/v2/auth/session", "GET", headers)).body.authenticated, false);
});
