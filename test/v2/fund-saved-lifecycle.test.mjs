import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { ReportDataStore } from "../../src/v2/reports.mjs";
import { expectedFundCallRows } from "../../src/v2/fund-saved-lifecycle.mjs";
import { verifySavedFundAgentLifecycle } from "../../src/v2/fund-agent-saved-lifecycle.mjs";
import { verifyFundQualityCounts } from "../../src/v2/fund-report-saved-quality.mjs";
import { publishedReportHash } from "../../src/v2/published-report-source.mjs";
import { createFundPreparations, fundAgentRequestSignature } from "../../src/v2/fund-preparation.mjs";
import { fundContextIds } from "../../src/v2/fund-contexts.mjs";
import { fundRequirementScope } from "../../src/v2/fund-requirement-contract.mjs";

test("saved fund replay derives DAPI and XAPI page results from the independent case", () => {
  const keys = ["portfolio_id", "trade_date", "asset_class"];
  const amount = { fields: [...keys, "exposure_amount"] }, ratio = { fields: [...keys, "exposure_ratio"] };
  const dapi = { ...amount, serviceType: "DAPI" };
  const xapi = { serviceType: "XAPI", steps: [{ alias: "amount" }, { alias: "ratio" }] };
  const filters = { page: 1, pageSize: 10, trade_date: "2026-09-10", asset_class: "未穿透" };
  assert.deepEqual(expectedFundCallRows(dapi, [dapi], { ...filters, portfolio_id: "PORT-DEMO-A1" }), [
    { portfolio_id: "PORT-DEMO-A1", trade_date: "2026-09-10", asset_class: "未穿透", exposure_amount: "450.00" },
  ]);
  assert.deepEqual(expectedFundCallRows(xapi, [amount, ratio], { ...filters, portfolio_id: "PORT-DEMO-A1" }), [
    { portfolio_id: "PORT-DEMO-A1", trade_date: "2026-09-10", exposures: [
      { asset_class: "未穿透", amount: { exposure_amount: "450.00" }, ratio: { exposure_ratio: "0.225000" } },
    ] },
  ]);
  const pageTwo = expectedFundCallRows(xapi, [amount, ratio], { page: 2, pageSize: 1 });
  assert.equal(pageTwo[0].portfolio_id, "PORT-DEMO-A2");
  assert.equal(pageTwo[0].exposures.length, 3);
  assert.throws(() => expectedFundCallRows(dapi, [dapi], { page: 0, pageSize: 10 }), { code: "FUND_CALL_PAGINATION_INVALID" });
  assert.throws(() => expectedFundCallRows(dapi, [dapi], { page: 1, pageSize: 1, client_id: "CLIENT-001" }), { code: "INVALID_FUND_QUERY" });
});

test("the evidence stores can open existing files without allowing SQLite writes", t => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-fund-readonly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [Store, file] of [[MetadataStore, "meta.sqlite"], [BusinessQueryStore, "business.sqlite"], [ReportDataStore, "reports.sqlite"]]) {
    const path = join(root, file);
    new Store(path).close();
    const reader = new Store(path, { readOnly: true });
    try {
      assert.ok(reader.db.prepare("SELECT count(*) AS count FROM sqlite_master").get().count > 0);
      assert.throws(() => reader.db.exec("CREATE TABLE unexpected_write(id TEXT)"), /readonly/i);
    } finally {
      reader.close();
    }
  }
});

test("saved fund quality independently checks counts with exact cent precision", () => {
  const businessDate = '2026-09-11';
  const rows = [
    { trade_date: businessDate, asset_class: '债券', exposure_amount: '999999999999999999.99' },
    { trade_date: businessDate, asset_class: '未穿透', exposure_amount: '0.00' },
    { trade_date: '2026-09-10', asset_class: ' ', exposure_amount: '1000000000000000000.00' },
    { trade_date: businessDate, asset_class: '', exposure_amount: '-0.01' },
  ];
  const checks = [['trade-date', 3], ['asset-class', 2], ['exposure-amount', 2]].map(([id, passedCount]) => ({
    id, evaluatedCount: rows.length, passedCount, failedCount: rows.length - passedCount,
  }));
  const receipt = { businessDate, snapshot: { rowCount: rows.length, contentHash: publishedReportHash(rows) }, checks };
  assert.deepEqual(verifyFundQualityCounts(receipt, rows), checks.map(({ evaluatedCount, ...check }) => check));
  const changed = structuredClone(receipt);
  changed.checks[2].passedCount++;
  changed.checks[2].failedCount--;
  assert.throws(() => verifyFundQualityCounts(changed, rows), { code: 'FUND_SAVED_REPORT_QUALITY_COUNTS_CHANGED' });
  assert.throws(() => verifyFundQualityCounts(receipt, [...rows].reverse()), { code: 'FUND_SAVED_REPORT_QUALITY_SOURCE_CHANGED' });
});

test("saved Agent verification requires the original request ledger and rejects missing publication evidence", async t => {
  const store = new MetadataStore(":memory:"), project = "synthetic-project", actor = "synthetic-engineer";
  t.after(() => store.close());
  const requestId = randomUUID(), contextId = fundContextIds[1], businessDate = "2026-09-11", message = "核对虚构基金穿透结果";
  const preparations = createFundPreparations({ store, project });
  const { receipt } = preparations.submit({ contextId, businessDate, message,
    metrics: fundRequirementScope(contextId).metrics.map(metric => metric.field) }, actor, requestId);
  const fundPreparation = preparations.bindExecution({ requestId, basisDigest: receipt.basis.digest, confirm: true },
    actor, { contextId, message, requestKey: requestId });
  const task = { status: "SUCCEEDED", submittedBy: actor, message, contextId, language: "SPARK_SQL",
    fundPreparation, requirements: { basis: receipt.basis } };
  const ledgerKey = project + ":agent:" + requestId;
  const entry = store.deduplicate(ledgerKey, fundAgentRequestSignature(task), () => store.create("agent", project, task));
  const input = { store, project, actor, requestId, taskId: entry.id, releaseId: randomUUID(), packageDigest: "0".repeat(64),
    dapiCallIds: [randomUUID()], xapiCallIds: [randomUUID()] };
  await assert.rejects(verifySavedFundAgentLifecycle(input), { code: "FUND_SAVED_AGENT_RECORD_MISSING" });
  await assert.rejects(verifySavedFundAgentLifecycle({ ...input, xapiCallIds: input.dapiCallIds }), { code: "FUND_SAVED_AGENT_SELECTION_INVALID" });
  store.db.prepare("UPDATE idempotency SET signature=? WHERE key=?").run("1".repeat(64), ledgerKey);
  await assert.rejects(verifySavedFundAgentLifecycle(input), { code: "FUND_SAVED_AGENT_REQUEST_BINDING_CHANGED" });
  assert.equal(store.list("run", project).length + store.list("release", project).length, 0);
});

test("signed receipt and test clock options stay on the saved Agent command and reject invalid inputs", () => {
  const script = fileURLToPath(new URL("../../scripts/verify-saved-fund-lifecycle.mjs", import.meta.url));
  const common = ["--active-metadata", "unused.sqlite", "--business-snapshots", "unused.sqlite", "--request-id", randomUUID(),
    "--dapi-call-id", randomUUID(), "--xapi-call-id", randomUUID()];
  const agent = ["--agent", "--task-id", randomUUID(), "--release-id", randomUUID(), "--package-digest", "0".repeat(64)];
  for (const args of [
    ["--history-metadata", "unused.sqlite", "--report-snapshots", "unused.sqlite", "--signed-receipt-root", "."],
    [...agent, "--signed-receipt-root", " "],
    [...agent, "--test-clock-unit-ms", "0"],
    [...agent, "--test-clock-unit-ms", "1001"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...common, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { status: "FAILED", code: "FUND_EVIDENCE_ARGUMENTS_REQUIRED" });
  }
});
