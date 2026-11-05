import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { validationDetails, equalValidationNumber } from "../../src/v2/validation-details.mjs";
import { publicDevelopmentRun } from "../../src/v2/durable-development.mjs";
import { developmentVerificationReport } from "../../src/v2/agent-development-workflow.mjs";
import { getContext, validationFamilyForContext, referenceSqlForContext } from "../../src/v2/context.mjs";
import { buildSqlRepairFeedback } from "../../src/v2/sql-repair-feedback.mjs";
import { generateSql } from "../../src/v2/model.mjs";
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult, verifyQueuedSparkResult } from "../../src/v2/remote-spark-queue.mjs";

const contextId = "stock-cash-t1", family = validationFamilyForContext(contextId);
const hash = sql => createHash("sha256").update(sql).digest("hex");
export function detailsFixture() {
  const revision = { id: randomUUID(), projectId: "project-securities-lab", contextId, sql: referenceSqlForContext(contextId).replace("SELECT DISTINCT position_id", "SELECT position_id") };
  revision.hash = hash(revision.sql);
  const run = { id: randomUUID(), projectId: revision.projectId, revisionId: revision.id, revisionHash: revision.hash, contextId,
    validationContractId: family.id, engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, status: "VALIDATION_FAILED",
    rows: getContext(contextId).expected, validation: { passed: false, selectedPassed: true, contractId: family.id,
      issues: ["重复持仓：holding_market_value 结果不符"], regressions: family.contextIds.map(id => ({ contextId: id, name: getContext(id).name,
        passed: !id.includes("duplicate-position"), issues: id.includes("duplicate-position") ? ["CLIENT-001.holding_market_value 结果不符"] : [],
        comparison: { schema: "shuduo-result-comparison/v1", totalMismatches: id.includes("duplicate-position") ? 1 : 0, truncated: false,
          mismatches: id.includes("duplicate-position") ? [{ kind: "VALUE_MISMATCH", clientId: "CLIENT-001", field: "holding_market_value", expected: "1000", actual: "2000" }] : [] } })) } };
  return { run, revision, task: { id: randomUUID(), projectId: revision.projectId, contextId, validationContractId: family.id } };
}

test("same-source details retain the failed scenario values, never invent them from selected rows", () => {
  const { run, revision } = detailsFixture(), result = validationDetails(run, revision);
  assert.equal(result.status, "AVAILABLE"); assert.equal(result.source.runId, run.id);
  const failed = result.scenarios.find(row => !row.passed);
  assert.equal(failed.contextId, "stock-cash-duplicate-position"); assert.equal(failed.mismatches[0].actual, "2000");
  assert.equal(run.rows[0].holding_market_value, "1000.00", "selected-case rows intentionally differ from failure details");
  const visible = publicDevelopmentRun(run, revision);
  assert.equal(visible.validation.regressions[2].comparison, undefined);
  assert.equal(visible.validationDetails.scenarios[2].mismatches[0].actual, "2000");
  assert.equal(run.validation.regressions[2].comparison.mismatches[0].actual, "2000", "presentation does not mutate stored receipt");
});

test("wrong project, context, revision, SQL hash, contract or execution cannot expose numeric details", () => {
  for (const change of [
    (r) => { r.revisionId = "other"; }, (r) => { r.revisionHash = "a".repeat(64); }, (r) => { r.projectId = "other"; },
    (r) => { r.contextId = "holdings-t1"; }, (r) => { r.validationContractId = "other"; }, (r) => { r.validation.contractId = "other"; },
    (r) => { r.engine = "not-spark"; }, (r) => { r.testDouble = true; }, (r) => { r.mainSqlExecuted = false; },
    (r) => { r.status = "RUNNING"; }, (_r, v) => { v.sql += " changed"; },
    (r) => { r.validation.regressions[2].contextId = r.validation.regressions[0].contextId; },
  ]) {
    const { run, revision } = detailsFixture(); change(run, revision);
    const result = validationDetails(run, revision); assert.equal(result.status, "UNVERIFIED"); assert.deepEqual(result.scenarios, []);
  }
});

test("unsafe, contradictory, out-of-scope and oversized case details are hidden rather than echoed", () => {
  for (const change of [
    c => { c.mismatches[0].actual = "PRIVATE_ARBITRARY_TEXT"; }, c => { c.mismatches[0].actual = "Infinity"; },
    c => { c.mismatches[0].expected = "9999"; }, c => { c.mismatches[0].actual = "1000.00"; },
    c => { c.mismatches[0].clientId = "OUTSIDE_PRIVATE_CLIENT"; }, c => { c.mismatches[0].field = "secret"; },
    c => { c.mismatches[0].extra = "PRIVATE_ARBITRARY_TEXT"; }, c => { c.totalMismatches = 10001; },
    c => { c.totalMismatches = 2; }, c => { c.mismatches = Array(21).fill(c.mismatches[0]); c.totalMismatches = 21; },
  ]) {
    const { run, revision } = detailsFixture(); change(run.validation.regressions[2].comparison);
    const result = validationDetails(run, revision), failed = result.scenarios[2];
    assert.equal(failed.detailsStatus, "INVALID"); assert.deepEqual(failed.mismatches, []);
    assert.doesNotMatch(JSON.stringify(publicDevelopmentRun(run, revision)), /PRIVATE_ARBITRARY_TEXT|OUTSIDE_PRIVATE_CLIENT/);
  }
});

test("legacy, mixed and safely truncated evidence is explicit without re-running or fabricating values", () => {
  const { run, revision } = detailsFixture();
  run.validation.regressions[2].comparison.totalMismatches = 2; run.validation.regressions[2].comparison.truncated = true;
  assert.equal(validationDetails(run, revision).scenarios[2].truncated, true);
  delete run.validation.regressions[2].comparison;
  assert.equal(validationDetails(run, revision).scenarios[2].detailsStatus, "LEGACY_UNAVAILABLE");
  for (const row of run.validation.regressions) delete row.comparison;
  const old = validationDetails(run, revision); assert.equal(old.status, "LEGACY_UNAVAILABLE"); assert.deepEqual(old.scenarios, []);
});

test("SQL execution can be complete while business validation fails; no contradictory failure becomes PASSED", () => {
  const { task, run, revision } = detailsFixture();
  let report = developmentVerificationReport(task, run, revision);
  assert.equal(report.checks.find(c => c.id === "execution").passed, true); assert.equal(report.status, "NEEDS_ATTENTION");
  run.validation.passed = true;
  run.validation.regressions = family.contextIds.map(contextId => ({ contextId, passed: true }));
  report = developmentVerificationReport(task, run, revision);
  assert.ok(report.checks.every(check => check.passed)); assert.equal(report.status, "NEEDS_ATTENTION");
  run.status = "SUCCEEDED"; assert.equal(developmentVerificationReport(task, run, revision).status, "PASSED");
});

test("numeric comparison preserves decimal precision without boolean or floating-point coercion", () => {
  assert.equal(equalValidationNumber("1000.000000000000001", "1000.00"), false);
  assert.equal(equalValidationNumber("9999999999999999.99", "9999999999999999.98"), false);
  assert.equal(equalValidationNumber("001.000", 1), true); assert.equal(equalValidationNumber("-0.00", "0"), true);
  for (const value of [null, undefined, true, {}, "", "NaN", "Infinity", "1e999999", "1." + "1".repeat(1000)])
    assert.equal(equalValidationNumber(value, "1"), false);
});

test("new details survive signed queue verification; tampering with an actual value invalidates the signature", () => {
  const { run, revision } = detailsFixture();
  const config = { projectId: run.projectId, sharedSecret: "synthetic-comparison-signature-secret-0123456789", jobPrefix: SPARK_QUEUE_PREFIXES.jobs,
    resultPrefix: SPARK_QUEUE_PREFIXES.results, cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations, timeoutMs: 180000 };
  const client = new RemoteSparkQueueClient(config, { read: async () => undefined, create: async () => ({ created: true }) });
  const prepared = client.prepare({ sql: revision.sql, context: getContext(contextId), validationContexts: family.contextIds.map(getContext) }, run.id);
  const envelope = createQueuedSparkResult(prepared.job, { status: run.status, engine: run.engine, engineVersion: run.engineVersion, mainSqlExecuted: true, validation: run.validation }, config);
  const result = verifyQueuedSparkResult(envelope, run.id, config); assert.deepEqual(result.validation, run.validation);
  const changed = structuredClone(envelope); changed.result.validation.regressions[2].comparison.mismatches[0].actual = "3000";
  assert.throws(() => verifyQueuedSparkResult(changed, run.id, config));
});

test("comparison values do not enter SQL repair model requests or independent standard answers", async () => {
  const { run, revision } = detailsFixture(); let prompt;
  await generateSql({ message: "修正重复持仓场景", currentSql: revision.sql, context: getContext(contextId), error: run.validation.issues.join("；"),
    repairFeedback: buildSqlRepairFeedback(run, contextId), remainingBudget: 16000 }, { DASHSCOPE_API_KEY: "sk-synthetic-never-sent" }, async (_url, options) => {
    prompt = JSON.parse(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sql: revision.sql, explanation: "合成测试" }) } }], usage: { total_tokens: 100 } }));
  });
  assert.equal(prompt.repairFeedback.failedCaseCount, 1); assert.equal(prompt.repairFeedback.passedCaseCount, 4);
  assert.doesNotMatch(JSON.stringify(prompt), /mismatches|comparison|"expected"|"actual"|2000/);
});

test("authorized run/report reads share checked details, deny another engineer and perform no computation", async t => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-comparison-api-")), store = new MetadataStore(":memory:");
  let compute = 0;
  const blocked = () => { compute++; throw Error("synthetic computation forbidden"); };
  const runner = async () => blocked(); runner.durable = Object.fromEntries(["prepare", "submit", "read", "cancel"].map(name => [name, blocked]));
  const app = createV2Server({ root, store, runner, env: { V2_LOCAL_DEVELOPMENT: "false", V2_HOST: "127.0.0.1", V2_ALLOW_INSECURE_PUBLIC_COOKIES: "true", V2_DURABLE_SQL_AGENT_ENABLED: "true" } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const password = "SyntheticComparison!2026";
  const owner = app.auth.bootstrapAdmin({ email: "comparison-owner@example.invalid", password, displayName: "合成工程师" });
  const other = app.auth.bootstrapAdmin({ email: "comparison-other@example.invalid", password, displayName: "另一个合成工程师" });
  for (const user of [owner, other]) store.update("auth_user", user.id, PROJECT, { memberships: [{ projectId: PROJECT, role: "ENGINEER" }] });
  const f = detailsFixture(), revision = store.create("revision", PROJECT, { ...f.revision, source: "LIVE_MODEL", author: owner.id });
  const run = store.create("run", PROJECT, { ...f.run, revisionId: revision.id, revisionHash: revision.hash });
  const task = store.create("agent", PROJECT, { contextId, validationContractId: family.id, submittedBy: owner.id, status: "FAILED", language: "SPARK_SQL", mode: "LIVE_MODEL", executionMode: "DURABLE_SQL_AGENT_V1",
    sql: revision.sql, revisionId: revision.id, runId: run.id, attempts: [{ status: "VALIDATION_FAILED", model: "SYNTHETIC_FIXTURE", revisionId: revision.id, runId: run.id }] });
  store.update("run", run.id, PROJECT, { agentTaskId: task.id });
  const request = async (path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-shuduo-client": "workbench", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  };
  const login = async email => { const r = await request("/auth/login", { email, password }); assert.equal(r.status, 200); return { cookie: r.cookies.map(c => c.split(";")[0]).join("; "), "x-csrf-token": r.body.csrfToken }; };
  const auth = await login(owner.email), stranger = await login(other.email);
  const result = await request(`/runs/${run.id}`, undefined, auth), report = await request(`/agent/tasks/${task.id}/workflow`, undefined, auth);
  assert.equal(result.status, 200); assert.equal(report.status, 200);
  assert.deepEqual(report.body.report.validationDetails, result.body.validationDetails);
  assert.equal(result.body.validationDetails.scenarios[2].mismatches[0].actual, "2000");
  assert.equal(result.body.validation.regressions[2].comparison, undefined);
  assert.equal(report.body.report.status, "NEEDS_ATTENTION");
  assert.equal((await request(`/runs/${run.id}`, undefined, stranger)).status, 403);
  assert.equal((await request(`/agent/tasks/${task.id}/workflow`, undefined, stranger)).status, 403);
  assert.ok([401, 403].includes((await request(`/runs/${run.id}`)).status));
  store.update("revision", revision.id, PROJECT, { sql: "SELECT 1 AS changed" });
  const changed = await request(`/runs/${run.id}`, undefined, auth);
  assert.equal(changed.status, 200); assert.equal(changed.body.validationDetails.status, "UNVERIFIED");
  assert.deepEqual(changed.body.validationDetails.scenarios, []); assert.equal(compute, 0);
});
