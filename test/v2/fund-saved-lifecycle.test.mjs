import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { ReportDataStore } from "../../src/v2/reports.mjs";
import { expectedFundCallRows } from "../../src/v2/fund-saved-lifecycle.mjs";

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
