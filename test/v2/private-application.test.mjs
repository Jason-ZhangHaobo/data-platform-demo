import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV2Server } from "../../src/v2/server.mjs";
import { getContext } from "../../src/v2/context.mjs";
import { validatePrivateApplicationRequest, callPrivateApplication } from "../../src/v2/private-application.mjs";

test("private application rejects external targets, unlisted paths and injected headers", async () => {
  const good = { operation: "PRIVATE_APPLICATION_HTTP_V1", method: "GET", path: "/api/v2/status" };
  assert.equal(validatePrivateApplicationRequest(good).path, good.path);
  for (const path of ["https://example.invalid/api/v2/status", "/invoke", "/api/v2/settings/model-key", "/api/v2/status?url=https://example.invalid", "/api/v2/../settings"])
    assert.throws(() => validatePrivateApplicationRequest({ ...good, path }), { code: "PRIVATE_APPLICATION_REQUEST_INVALID" });
  assert.throws(() => validatePrivateApplicationRequest({ ...good, headers: { host: "evil.invalid" } }), { code: "PRIVATE_APPLICATION_HEADERS_INVALID" });
  assert.throws(() => validatePrivateApplicationRequest({ ...good, headers: { cookie: "a\r\nb" } }), { code: "PRIVATE_APPLICATION_HEADERS_INVALID" });
  await assert.rejects(callPrivateApplication(good, "http://evil.invalid:3000"), { code: "PRIVATE_APPLICATION_TARGET_INVALID" });
});

test("private Agent transport is explicit, SQL-only and preserves ordinary authentication", async () => {
  const input = { operation: "PRIVATE_APPLICATION_HTTP_V1", method: "POST", path: "/api/v2/agent/tasks", body: { message: "虚构证券加工", sql: "SELECT 1" } };
  assert.throws(() => validatePrivateApplicationRequest(input), { code: "PRIVATE_APPLICATION_REQUEST_INVALID" });
  assert.equal(validatePrivateApplicationRequest(input, { allowDurableAgent: true }).path, input.path);
  assert.throws(() => validatePrivateApplicationRequest({ ...input, body: { ...input.body, language: "PYTHON" } }, { allowDurableAgent: true }), { code: "PRIVATE_AGENT_LANGUAGE_NOT_ENABLED" });
  assert.throws(() => validatePrivateApplicationRequest({ ...input, path: "/api/v2/internal/scheduler/tick" }, { allowDurableAgent: true }), { code: "PRIVATE_APPLICATION_REQUEST_INVALID" });
  let forwarded;
  const response = await callPrivateApplication(input, "http://127.0.0.1:3100", async (url, options) => {
    forwarded = { url, options };
    return new Response(JSON.stringify({ code: "AUTHENTICATION_REQUIRED" }), { status: 401 });
  }, { allowDurableAgent: true });
  assert.equal(response.status, 401); assert.equal(response.body.code, "AUTHENTICATION_REQUIRED");
  assert.equal(forwarded.options.headers.cookie, undefined);
  assert.equal(forwarded.options.headers["x-csrf-token"], undefined);
  assert.equal(forwarded.url, "http://127.0.0.1:3100/api/v2/agent/tasks");
});

async function open(enabled = true, durable = false) {
  const runner = async ({ context }) => ({ status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, rows: context.expected, validation: { passed: true } });
  if (durable) runner.durable = { prepare() {}, submit() {}, read() {}, cancel() {} };
  const app = createV2Server({
    root: mkdtempSync(join(tmpdir(), "shuduo-private-app-")),
    env: { V2_LOCAL_DEVELOPMENT: "false", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: String(enabled), V2_DURABLE_SQL_AGENT_ENABLED: String(durable) },
    runner,
    ...(durable ? { generator: async () => { throw new Error("creation must not call a model"); } } : {}),
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const invoke = async body => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/invoke`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, invoke, close: async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); } };
}

test("normal private app login and CSRF are required to create a durable Agent task", async () => {
  const service = await open(true, true);
  const call = async (path, body, headers = {}) => (await service.invoke({ operation: "PRIVATE_APPLICATION_HTTP_V1", method: "POST", path, body, headers })).body;
  try {
    const body = { message: "理解虚构证券资产口径并编写SQL", sql: "SELECT 1 AS pending", contextId: "holdings-t1" };
    assert.equal((await call("/api/v2/agent/tasks", body)).status, 401);
    service.app.auth.bootstrapAdmin({ email: "recovery-owner@example.invalid", password: "SyntheticPassword!2026", displayName: "测试工程师" });
    const login = await call("/api/v2/auth/login", { email: "recovery-owner@example.invalid", password: "SyntheticPassword!2026" });
    assert.equal(login.status, 200);
    const headers = { cookie: login.cookies.map(c => c.split(";")[0]).join("; "), "idempotency-key": "private-intake-test" };
    assert.equal((await call("/api/v2/agent/tasks", body, headers)).status, 403);
    headers["x-csrf-token"] = login.body.csrfToken;
    const task = await call("/api/v2/agent/tasks", body, headers);
    assert.equal(task.status, 202); assert.equal(task.body.stage, "READY_FOR_MODEL");
    assert.equal(task.body.usedTokens, 0); assert.equal(task.body.attempts.length, 0);
    assert.equal((await call("/api/v2/agent/tasks", body, headers)).body.id, task.body.id);
    assert.equal((await call("/api/v2/agent/tasks", { ...body, language: "PYTHON" }, headers)).code, "PRIVATE_AGENT_LANGUAGE_NOT_ENABLED");
  } finally { await service.close(); }
});

test("private application preserves ordinary authentication and CSRF checks", async () => {
  const app = await open();
  try {
    const result = await app.invoke({ operation: "PRIVATE_APPLICATION_HTTP_V1", method: "POST", path: "/api/v2/revisions", body: { sql: "SELECT 1", contextId: "holdings-t1" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 401);
    assert.equal(result.body.body.code, "AUTHENTICATION_REQUIRED");
  } finally { await app.close(); }
});

test("fixture acceptance exercises task API, deduplication, changed context and revocation", async () => {
  const app = await open();
  try {
    for (const caseId of ["holdings-t1", "cash-change"]) {
      const result = await app.invoke({ operation: "PRIVATE_APPLICATION_TASK_V1", caseId });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.totalAssets, String(getContext(caseId).expected[0].total_assets));
      assert.equal(result.body.duplicateSubmissionDeduplicated, true);
      assert.equal(result.body.refreshedResultMatches, true);
      assert.equal(result.body.fullAgentLifecycleVerified, false);
      assert.ok(!JSON.stringify(result.body).includes("csrf_"));
    }
    const users = app.app.store.list("auth_user", "project-securities-lab");
    assert.equal(users.length, 2);
    assert.ok(users.every(u => u.status === "DISABLED"));
  } finally { await app.close(); }
});

test("private application invocation is unavailable when the private gate is disabled", async () => {
  const app = await open(false);
  try {
    assert.equal((await app.invoke({ operation: "PRIVATE_APPLICATION_TASK_V1", caseId: "holdings-t1" })).status, 404);
  } finally { await app.close(); }
});
