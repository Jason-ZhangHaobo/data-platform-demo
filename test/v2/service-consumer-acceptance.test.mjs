import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { runConsumerAcceptance, validateConsumerPlan } from "../../scripts/verify-service-consumer.mjs";

// Synthetic HTTP fixtures exercise the standalone consumer, never real cloud
// execution. Server rows and the independent plan oracle are separate literals.
const TOKEN = `sz_local_${"L".repeat(32)}`;
const script = resolve("scripts/verify-service-consumer.mjs");
const privateJson = (file, value) => { writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); chmodSync(file, 0o600); };
const load = (file) => JSON.parse(readFileSync(file, "utf8"));

async function fixture(t, behavior = {}) {
  const root = mkdtempSync(join(tmpdir(), "service-consumer-fixture-"));
  const state = { requests: [], allowed: new Map(), revoked: false };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"), path = url.pathname;
    state.requests.push({ method: request.method, path, query: url.search });
    if (behavior.onRequest) behavior.onRequest(state, request);
    const reply = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (behavior.redirect) { response.writeHead(302, { Location: behavior.redirect }); response.end(); return; }
    if (behavior.disconnect) { request.socket.destroy(); return; }
    if (behavior.hang) return;
    if (state.revoked || request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "TOKEN_INVALID" });
    if (path.endsWith("/cash-demo")) return reply(403, { error: "SERVICE_FORBIDDEN" });
    const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("page_size"));
    if (!Number.isSafeInteger(page) || page < 1) return reply(400, { error: "INVALID_INTEGER" });
    const count = state.allowed.get(path) ?? 0;
    if (count >= 6) return reply(429, { error: "RATE_LIMITED" });
    state.allowed.set(path, count + 1);
    const isXapi = path.endsWith("/overview-demo");
    let source = [
      { client_id: "DEMO-101", holding_market_value: "120.00", available_cash: "30.00", total_assets: "150.00", security_count: 2 },
      { client_id: "DEMO-102", holding_market_value: "230.00", available_cash: "40.00", total_assets: "270.00", security_count: 1 },
    ];
    if (url.searchParams.has("client_id")) source = source.filter((row) => row.client_id === url.searchParams.get("client_id"));
    const data = source.slice((page - 1) * pageSize, page * pageSize).map((row) => isXapi ? {
      client_id: row.client_id,
      holdings: { holding_market_value: row.holding_market_value, total_assets: row.total_assets, security_count: row.security_count },
      cash: { available_cash: row.available_cash },
    } : { client_id: row.client_id, holding_market_value: row.holding_market_value, total_assets: row.total_assets, security_count: row.security_count });
    const body = {
      data, pagination: { page, pageSize, total: source.length, totalPages: Math.max(1, Math.ceil(source.length / pageSize)) },
      service: isXapi ? { id: "service-overview", slug: "overview-demo", type: "XAPI", versionId: "version-overview-1", steps: [
        { alias: "holdings", dapiId: "service-holdings", dapiVersionId: "version-holdings-1" },
        { alias: "cash", dapiId: "service-cash", dapiVersionId: "version-cash-1" },
      ] } : { id: "service-holdings", slug: "holdings-demo", type: "DAPI", versionId: "version-holdings-1" },
      callId: `fixture-call-${state.requests.length}`, localTestOnly: true, scope: "LOCAL_TEST_ONLY",
    };
    behavior.mutate?.(body, { isXapi, page, query: url.searchParams });
    reply(200, body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const plan = {
    protocol: "SERVICE_CONSUMER_V1", authorized: true, origin, approvedOrigin: origin, testOnly: true,
    startedAt: new Date(Date.now() - 1000).toISOString(), deadline: new Date(Date.now() + 300_000).toISOString(),
    timeoutMs: 2000, maxRequests: 15, reportFile: join(root, "report.json"),
    expectedRows: [
      { client_id: "DEMO-102", holding_market_value: "230.00", available_cash: "40.00", total_assets: "270.00", security_count: 1 },
      { client_id: "DEMO-101", holding_market_value: "120.00", available_cash: "30.00", total_assets: "150.00", security_count: 2 },
    ],
    dapis: [
      { id: "service-holdings", slug: "holdings-demo", versionId: "version-holdings-1", alias: "holdings",
        fields: ["client_id", "holding_market_value", "total_assets", "security_count"], granted: true },
      { id: "service-cash", slug: "cash-demo", versionId: "version-cash-1", alias: "cash",
        fields: ["client_id", "available_cash"], granted: false },
    ],
    xapi: { id: "service-overview", slug: "overview-demo", versionId: "version-overview-1" },
    ungranted: { type: "DAPI", slug: "cash-demo" }, rateLimit: { serviceId: "service-holdings", perMinute: 6 },
  };
  const planFile = join(root, "plan.json"), tokenFile = join(root, "token");
  privateJson(planFile, plan); writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); rmSync(root, { recursive: true, force: true }); });
  return { root, plan, planFile, tokenFile, state,
    save: () => privateJson(planFile, plan),
    run: (options = {}) => runConsumerAcceptance({ planFile, tokenFile, execute: true, ...options }),
  };
}
async function cli(args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close"); return { code, stdout, stderr };
}

test("real loopback consumer proves rows, exact versions, nested joins, pagination, auth, limits and later revocation", async (t) => {
  const f = await fixture(t);
  const consumed = await f.run();
  assert.equal(consumed.requestCount, 14); assert.equal(consumed.evidence, "LOCAL_HTTP_FIXTURE");
  const before = load(f.plan.reportFile);
  assert.equal(before.phases.consume, "PASSED"); assert.equal(before.phases.revoked, "NOT_STARTED");
  assert.equal(before.requests.filter((entry) => entry.childBindingsVerified).length, 3);
  assert.ok(before.requests.filter((entry) => entry.statusCode === 200).every((entry) => /^[a-f0-9]{64}$/.test(entry.callIdDigest)));
  assert.deepEqual(before.requests.map((entry) => entry.statusCode), [200, 200, 200, 200, 200, 200, 401, 401, 403, 400, 200, 200, 200, 429]);
  assert.equal(f.state.requests.filter((entry) => entry.path.endsWith("cash-demo")).length, 1);
  f.state.revoked = true;
  assert.equal((await f.run({ phase: "revoked" })).requestCount, 15);
  const after = load(f.plan.reportFile);
  assert.deepEqual(after.requests.slice(0, 14), before.requests);
  assert.deepEqual(after.phases, { consume: "PASSED", revoked: "PASSED" });
  assert.ok(f.state.requests.every((entry) => entry.method === "GET"));
  assert.equal(statSync(f.plan.reportFile).mode & 0o777, 0o600);
  const serialized = readFileSync(f.plan.reportFile, "utf8");
  for (const secret of [TOKEN, "Authorization", f.plan.origin, "DEMO-101", "120.00", "version-cash-1"])
    assert.equal(serialized.includes(secret), false);
  await assert.rejects(f.run(), { code: "PHASE_ALREADY_ATTEMPTED" });
  await assert.rejects(f.run({ phase: "revoked" }), { code: "PHASE_ALREADY_ATTEMPTED" });
  assert.equal(f.state.requests.length, 15);
});

test("CLI defaults to plan-only, requires explicit authorization, and never accepts token values", async (t) => {
  const f = await fixture(t);
  const preview = await cli(["--plan", f.planFile]);
  assert.equal(preview.code, 0); assert.equal(JSON.parse(preview.stdout).mode, "PLAN_ONLY");
  assert.equal(existsSync(f.plan.reportFile), false);
  f.plan.authorized = false; f.save();
  const rejected = await cli(["--plan", f.planFile, "--token-file", f.tokenFile, "--execute"]);
  assert.equal(rejected.code, 1); assert.equal(JSON.parse(rejected.stderr).code, "EXPLICIT_AUTHORIZATION_REQUIRED");
  const tokenArgument = await cli(["--token", TOKEN]);
  assert.equal(tokenArgument.code, 1); assert.equal(tokenArgument.stderr.includes(TOKEN), false);
  assert.equal(f.state.requests.length, 0);
});

test("plan rejects unapproved origins, expanded budgets, windows and missing independent expectations before HTTP", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { origin: "http://localhost:1234", approvedOrigin: "http://localhost:1234" },
    { origin: "https://example.invalid/extra", approvedOrigin: "https://example.invalid/extra", testOnly: false },
    { approvedOrigin: "https://different.invalid" }, { maxRequests: 41 }, { maxRequests: 14 },
    { deadline: new Date(Date.parse(f.plan.startedAt) + 7_200_001).toISOString() }, { expectedRows: [] },
    { ungranted: { type: "DAPI", slug: "holdings-demo" } }, { rateLimit: { serviceId: "service-cash", perMinute: 6 } },
  ]) assert.throws(() => validateConsumerPlan({ ...f.plan, ...changes }));
  f.plan.deadline = new Date(Date.now() - 500).toISOString(); f.save();
  await assert.rejects(f.run(), { code: "OUTSIDE_FIXED_WINDOW" }); assert.equal(f.state.requests.length, 0);
});

test("private inputs and report refuse weak modes, symbolic links and altered binding", async (t) => {
  const f = await fixture(t);
  chmodSync(f.tokenFile, 0o644);
  await assert.rejects(f.run(), { code: "PRIVATE_FILE_REQUIRED" }); chmodSync(f.tokenFile, 0o600);
  const link = join(f.root, "linked-token"); symlinkSync(f.tokenFile, link);
  await assert.rejects(f.run({ tokenFile: link }));
  chmodSync(f.planFile, 0o644);
  await assert.rejects(f.run(), { code: "PRIVATE_FILE_REQUIRED" }); chmodSync(f.planFile, 0o600);
  assert.equal(f.state.requests.length, 0);
  await f.run(); const original = readFileSync(f.plan.reportFile, "utf8");
  f.plan.maxRequests = 16; f.save();
  await assert.rejects(f.run({ phase: "revoked" }), { code: "REPORT_BINDING_INVALID" });
  assert.equal(readFileSync(f.plan.reportFile, "utf8"), original);
});

test("a durable reservation precedes HTTP and an unknown response cannot be retried or reset", async (t) => {
  let f, observed;
  f = await fixture(t, { disconnect: true, onRequest: () => { observed = load(f.plan.reportFile); } });
  await assert.rejects(f.run(), { code: "TRANSPORT_FAILED" });
  assert.equal(observed.requestCount, 1); assert.equal(observed.requests[0].result, "PENDING");
  await assert.rejects(f.run(), { code: "PHASE_ALREADY_ATTEMPTED" });
  assert.equal(load(f.plan.reportFile).requestCount, 1); assert.equal(f.state.requests.length, 1);
  const report = load(f.plan.reportFile); report.requestCount = 0; privateJson(f.plan.reportFile, report);
  await assert.rejects(f.run(), { code: "REPORT_BINDING_INVALID" }); assert.equal(f.state.requests.length, 1);
});

test("redirects never forward a credential and a transport timeout has one counted attempt", async (t) => {
  const redirect = await fixture(t, { redirect: "https://example.invalid/credential-trap" });
  await assert.rejects(redirect.run(), { code: "REDIRECT_REFUSED" }); assert.equal(redirect.state.requests.length, 1);
  const hanging = await fixture(t, { hang: true }); hanging.plan.timeoutMs = 30; hanging.save();
  await assert.rejects(hanging.run(), { code: "REQUEST_TIMEOUT" });
  assert.equal(load(hanging.plan.reportFile).requestCount, 1); assert.equal(hanging.state.requests.length, 1);
});

test("independent oracle rejects wrong amounts, row merging, pages and frozen dependency versions", async (t) => {
  const cases = [
    [(body) => { body.data[0].total_assets = "999.00"; }, "BUSINESS_ROWS_MISMATCH"],
    [(body, context) => { if (context.isXapi) body.data[0].cash.available_cash = "999.00"; }, "BUSINESS_ROWS_MISMATCH"],
    [(body) => { body.pagination.total = 999; }, "PAGINATION_MISMATCH"],
    [(body) => { body.service.versionId = "version-incorrect"; }, "EXACT_VERSION_MISMATCH"],
    [(body, context) => { if (context.isXapi) body.service.steps[1].dapiVersionId = "version-incorrect"; }, "CHILD_VERSION_MISMATCH"],
    [(body, context) => { if (context.isXapi) delete body.service.steps; }, "CHILD_VERSION_MISMATCH"],
    [(body) => { body.scope = "PRIVATE_CLOUD_TEST"; }, "EVIDENCE_SCOPE_MISMATCH"],
  ];
  for (const [mutate, code] of cases) {
    const f = await fixture(t, { mutate }); await assert.rejects(f.run(), { code });
    assert.equal(load(f.plan.reportFile).phases.consume, "FAILED");
  }
});

test("revoke phase is operator-owned, requires the original credential, and can follow a failed consume", async (t) => {
  const f = await fixture(t, { mutate: (body) => { body.data[0].total_assets = "999.00"; } });
  await assert.rejects(f.run({ phase: "revoked" }), { code: "PRIOR_CONSUMER_REPORT_REQUIRED" });
  await assert.rejects(f.run(), { code: "BUSINESS_ROWS_MISMATCH" });
  writeFileSync(f.tokenFile, `sz_local_${"Z".repeat(32)}`);
  await assert.rejects(f.run({ phase: "revoked" }), { code: "REPORT_BINDING_INVALID" });
  writeFileSync(f.tokenFile, TOKEN); f.state.revoked = true;
  const result = await f.run({ phase: "revoked" });
  assert.equal(result.requestCount, 2); assert.deepEqual(result.phases, { consume: "FAILED", revoked: "PASSED" });
});

test("an existing pending phase or lock fails closed without erasing prior request history", async (t) => {
  const f = await fixture(t); await f.run();
  const report = load(f.plan.reportFile); report.phases.consume = "RUNNING"; report.requests.at(-1).result = "PENDING";
  privateJson(f.plan.reportFile, report); const original = readFileSync(f.plan.reportFile, "utf8");
  await assert.rejects(f.run(), { code: "PHASE_ALREADY_ATTEMPTED" });
  assert.equal(readFileSync(f.plan.reportFile, "utf8"), original);
  writeFileSync(`${f.plan.reportFile}.lock`, "", { mode: 0o600 });
  await assert.rejects(f.run({ phase: "revoked" }), { code: "REPORT_LOCKED_OR_UNAVAILABLE" });
  assert.equal(f.state.requests.length, 14);
});
