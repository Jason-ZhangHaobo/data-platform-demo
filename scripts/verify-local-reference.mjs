import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runV2Cli } from "../bin/shuduo.mjs";
import { handleV2Mcp } from "../bin/shuduo-mcp.mjs";
import { V2Client } from "../src/v2/client.mjs";
import { referenceSql } from "../src/v2/context.mjs";
import { validateDeliveryPackage } from "../src/v2/delivery.mjs";

const [mode, origin] = process.argv.slice(2);
const dir = ".v2-artifacts";
const file = dir + "/reference-reproduction.json";
const sql = referenceSql.trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const caseIds = ["cash-change", "cash-only-client", "duplicate-position", "equal-value-positions", "holdings-t1"];
const resources = ["/revisions", "/runs", "/delivery/packages", "/delivery/verifications"];
const emptyResources = ["/agent/tasks", "/release/approvals", "/releases", "/release/runs"];
const counts = { get: 0, post: 0 };
let step = "输入检查";

function save(checkpoint, first = false) {
  const target = first ? file : file + "." + randomUUID();
  writeFileSync(target, JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (!first) renameSync(target, file);
}

function checkResult(run) {
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.engine, "Apache Spark");
  assert.equal(run.mainSqlExecuted, true);
  assert.notEqual(run.testDouble, true);
  assert.equal(run.validation.passed, true);
  assert.deepEqual(run.validation.regressions.map(check => check.contextId).sort(), caseIds);
  assert.ok(run.validation.regressions.every(check => check.passed === true));
  const rows = [...run.rows].sort((a, b) => a.client_id.localeCompare(b.client_id));
  assert.deepEqual(rows.map(row => [
    row.client_id, row.holding_market_value, row.available_cash, row.total_assets, row.security_count,
  ]), [
    ["CLIENT-001", "1500.00", "300.00", "1800.00", 2],
    ["CLIENT-002", "750.00", "200.00", "950.00", 1],
  ]);
}

async function completed(client, path) {
  const deadline = Date.now() + 120_000;
  do {
    const record = await client.request(path);
    if (!["QUEUED", "RUNNING"].includes(record.status)) return record;
    await delay(1_500);
  } while (Date.now() < deadline);
  throw new Error("原运行未在时限内结束");
}

async function main() {
  assert.ok(["run", "readback"].includes(mode));
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  assert.ok(Number(new URL(origin).port) <= 65535);
  const client = new V2Client({
    baseUrl: origin + "/api/v2",
    timeoutMs: 5_000,
    fetchImpl(url, options) {
      assert.ok(url.startsWith(origin + "/api/v2/"));
      if (options.method === "GET") counts.get++;
      else {
        assert.equal(mode, "run");
        assert.equal(options.method, "POST");
        counts.post++;
      }
      return fetch(url, options);
    },
  });
  step = "本机环境与工作台";
  const status = await client.request("/status");
  assert.equal(status.mode, "LOCAL_DEVELOPMENT");
  assert.equal(status.model.configured, false);
  assert.equal(status.metadata.driver, "sqlite");
  assert.equal(status.spark.available, true);
  assert.equal(status.spark.isolation, "LOCAL_PROCESS");
  assert.equal(status.agentDevelopment.durableEnabled, false);
  assert.equal(status.agentDevelopment.durableDeliveryEnabled, false);
  assert.equal(status.agentDevelopment.publishAvailable, false);
  const page = await fetch(origin + "/v2/", { redirect: "error", signal: AbortSignal.timeout(5_000) });
  assert.ok(page.ok && /text\/html/.test(page.headers.get("content-type") ?? ""));
  assert.match(await page.text(), /<div id="root"/);
  const original = mode === "readback" ? readFileSync(file, "utf8") : undefined;
  const checkpoint = original ? JSON.parse(original) : { origin, requests: {}, ids: {} };
  assert.equal(checkpoint.origin, origin);

  async function submit(name, path, body) {
    step = name;
    const idempotencyKey = randomUUID();
    checkpoint.requests[name] = { path, idempotencyKey };
    save(checkpoint);
    const result = await client.request(path, { method: "POST", body, idempotencyKey });
    assert.match(result.id, /^[a-f0-9-]{36}$/);
    checkpoint.ids[name] = result.id;
    if (name === "package") checkpoint.digest = result.digest;
    save(checkpoint);
    return result;
  }

  if (mode === "run") {
    step = "空库检查";
    for (const path of [...resources, ...emptyResources]) {
      assert.deepEqual(await client.request(path), []);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    save(checkpoint, true);
    const revision = await submit("revision", "/revisions", { sql, contextId: "holdings-t1" });
    assert.equal(revision.hash, hash(sql));
    const run = await submit("run", "/runs", { revisionId: revision.id });
    checkResult(await completed(client, "/runs/" + run.id));
    const bundle = await submit("package", "/delivery/packages", { sourceRunId: run.id, name: "虚构客户资产 T+1 参考交付" });
    validateDeliveryPackage(bundle, checkpoint.digest);
    const verification = await submit("verification", "/delivery/packages/" + bundle.id + "/verify",
      { scheduledFor: "2026-09-11T09:00:00+08:00" });
    checkResult(await completed(client, "/delivery/verifications/" + verification.id));
  }

  step = "代码、结果与交付绑定";
  const ids = checkpoint.ids;
  for (const id of [ids.revision, ids.run, ids.package, ids.verification]) assert.match(id, /^[a-f0-9-]{36}$/);
  const revision = await client.request("/revisions/" + ids.revision);
  const run = await client.request("/runs/" + ids.run);
  const runBundle = await client.request("/runs/" + ids.run + "/bundle");
  const bundle = await client.request("/delivery/packages/" + ids.package);
  const verification = await client.request("/delivery/verifications/" + ids.verification);
  checkResult(run);
  checkResult(verification);
  assert.equal(revision.source, "MANUAL");
  assert.equal(revision.hash, hash(sql));
  assert.equal(run.revisionId, revision.id);
  assert.equal(run.revisionHash, revision.hash);
  assert.equal(runBundle.revision.hash, revision.hash);
  assert.equal(runBundle.files["main.sql"], sql);
  assert.deepEqual(runBundle.rows, run.rows);
  assert.equal(runBundle.releaseState, "NOT_PUBLISHED");
  assert.equal(runBundle.requiresRevalidation, false);
  validateDeliveryPackage(bundle, checkpoint.digest);
  assert.equal(bundle.files["main.sql"], sql);
  assert.equal(bundle.manifest.source.runId, run.id);
  assert.equal(bundle.manifest.source.revisionId, revision.id);
  assert.equal(bundle.manifest.source.sqlHash, revision.hash);
  assert.equal(verification.packageId, bundle.id);
  assert.equal(verification.packageDigest, bundle.digest);
  assert.deepEqual(verification.source, bundle.manifest.source);
  assert.equal(verification.testSqlValidation.passed, true);
  assert.equal(verification.testSqlValidation.sqlHash, hash(bundle.files["tests.sql"]));
  assert.equal(verification.engineVersion, run.engineVersion);
  assert.equal(verification.occurrence.businessDate, "2026-09-10");
  assert.equal(verification.published, false);
  assert.equal(verification.schedulerTriggered, false);
  for (const path of resources) assert.equal((await client.request(path)).length, 1);
  for (const path of emptyResources) assert.deepEqual(await client.request(path), []);

  step = "CLI 与 MCP 原包读取";
  let cli;
  assert.equal(await runV2Cli(["delivery", "show", "--id", ids.package], {}, {
    client, output: value => { cli = JSON.parse(value); }, error: () => {},
  }), 0);
  const mcp = JSON.parse(await handleV2Mcp({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "delivery_package_detail", arguments: { packageId: ids.package } },
  }, { client })).result.structuredContent;
  for (const result of [cli, mcp]) {
    assert.equal(result.id, ids.package);
    validateDeliveryPackage(result, checkpoint.digest);
  }
  if (mode === "readback") assert.equal(readFileSync(file, "utf8"), original);
  console.log(JSON.stringify({
    passed: true, mode, ids, digest: bundle.digest, engineVersion: run.engineVersion,
    rows: run.rows.length, regressionCases: caseIds.length, files: Object.keys(bundle.files).length,
    counts, modelTasks: 0, releases: 0,
  }));
}

try {
  await main();
} catch (error) {
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  console.error(JSON.stringify({ passed: false, step, status, counts, checkpoint: file }));
  process.exitCode = 1;
}
