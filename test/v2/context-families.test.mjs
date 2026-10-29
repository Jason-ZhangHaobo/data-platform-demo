import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  allContextIds,
  contextIds,
  getContext,
  publicContext,
  referenceSql,
  referenceSqlForContext,
  validationContractId,
  validationFamilyForContext,
} from "../../src/v2/context.mjs";

const originalIds = ["holdings-t1", "cash-change", "duplicate-position", "equal-value-positions", "cash-only-client"];
const stockIds = ["stock-cash-t1", "stock-cash-cash-change", "stock-cash-duplicate-position", "stock-cash-equal-value-positions", "stock-cash-cash-only-client"];
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("legacy five contexts, contract and reference SQL preserve historical bytes", () => {
  const originalHashes = [
    "611338dc3e84007da46265f895c38791fb8d77fdde243eb071c1ba8ac70d9e4b",
    "07da376e7651358fa2d8d4411069c93443dcc64c37154072335e1ebf608f1ebb",
    "6d1ce0315a5a1ce7f7ec65dff7ffc2fe1f4ce6f87319814c1636221fefc75271",
    "ee8158d65b5bbb01a7b8b85d6d1d78097c1baced437e3c592fad7ec599377090",
    "502b992f040226e66931fe60a1c67dafd0f4322557aca95d15752d3022cff172",
  ];
  assert.deepEqual(contextIds, originalIds);
  assert.equal(validationContractId, "securities-assets-five-fixtures-2026-09-14");
  assert.equal(hash(referenceSql), "73387d32f70023fda192f00b0fbcf4f1773ba949a80a4ed2f48538d797420c39");
  originalIds.forEach((id, index) => {
    assert.equal(hash(JSON.stringify(getContext(id))), originalHashes[index], id);
    assert.equal(referenceSqlForContext(id), referenceSql);
  });
  assert.deepEqual(getContext(), getContext("holdings-t1"));
});

test("families partition ten contexts into separate five-case semantic contracts", () => {
  assert.deepEqual(allContextIds, [...originalIds, ...stockIds]);
  assert.equal(new Set(allContextIds).size, 10);
  for (const id of allContextIds) {
    const stock = stockIds.includes(id);
    const family = validationFamilyForContext(id);
    assert.equal(family.id, stock ? "securities-stock-cash-five-fixtures-v1" : validationContractId);
    assert.deepEqual(family.contextIds, stock ? stockIds : originalIds);
    assert.equal(family.definitionVersion, 1);
  }
  for (const id of [undefined, "unknown", "__proto__", "stock-cash-t1-extra"]) {
    assert.equal(validationFamilyForContext(id), undefined);
    assert.equal(referenceSqlForContext(id), undefined);
  }
  assert.equal(getContext("__proto__"), undefined);
});

test("stock contexts reuse the exact synthetic input variants but change only declared semantics and answers", () => {
  stockIds.forEach((id, index) => {
    const { id: oldId, name: oldName, definition: oldDefinition, expected: oldExpected, ...oldInputs } = getContext(originalIds[index]);
    const { id: newId, name, definition, expected, ...newInputs } = getContext(id);
    assert.deepEqual(newInputs, oldInputs);
    assert.equal(newId, id);
    assert.match(name, /股票持仓＋可用现金.*非客户全资产/);
    assert.match(definition, /不等于客户全资产/);
    assert.match(definition, /asset_class = '股票'/);
    assert.notDeepEqual(expected, oldExpected);
  });
});

test("stock expected answers are independent reviewed literals for all five cases", () => {
  const client2 = { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 };
  const firstRows = [
    ["1000.00", "300.00", "1300.00"],
    ["1000.00", "800.00", "1800.00"],
    ["1000.00", "300.00", "1300.00"],
    ["2000.00", "300.00", "2300.00"],
    ["1000.00", "300.00", "1300.00"],
  ];
  stockIds.forEach((id, index) => {
    const [holding_market_value, available_cash, total_assets] = firstRows[index];
    const expected = [
      { client_id: "CLIENT-001", holding_market_value, available_cash, total_assets, security_count: 1 },
      client2,
    ];
    if (id === "stock-cash-cash-only-client") expected.push({ client_id: "CLIENT-004", holding_market_value: "0.00", available_cash: "100.00", total_assets: "100.00", security_count: 0 });
    assert.deepEqual(getContext(id).expected, expected);
    assert.equal(getContext(id).expected.some((row) => row.client_id === "CLIENT-003"), false);
  });
});

test("public contexts disclose scope and matching reference SQL, never independent answers", () => {
  for (const id of allContextIds) {
    const context = publicContext(id);
    assert.equal(Object.hasOwn(context, "expected"), false);
    assert.equal(JSON.stringify(context).includes('"expected"'), false);
    assert.deepEqual(context.validationFamily, validationFamilyForContext(id));
    assert.equal(context.referenceSql, referenceSqlForContext(id));
    if (stockIds.includes(id)) {
      const labels = context.validationFamily.metricLabels;
      assert.equal(labels.holding_market_value, "股票持仓市值");
      assert.match(labels.total_assets, /股票持仓＋可用现金.*非客户全资产/);
      assert.equal(labels.security_count, "股票证券数量（按代码去重）");
    }
  }
});

test("returned contexts and family metadata cannot mutate subsequent requests", () => {
  const context = getContext("stock-cash-t1");
  context.expected[0].total_assets = "0.00";
  context.tables[0].rows.length = 0;
  const family = validationFamilyForContext("stock-cash-t1");
  family.contextIds.push("holdings-t1");
  family.metricLabels.total_assets = "客户全资产";
  assert.equal(getContext("stock-cash-t1").expected[0].total_assets, "1300.00");
  assert.equal(getContext("stock-cash-t1").tables[0].rows.length, 3);
  assert.deepEqual(validationFamilyForContext("stock-cash-t1").contextIds, stockIds);
  assert.match(validationFamilyForContext("stock-cash-t1").metricLabels.total_assets, /非客户全资产/);
});

test("stock reference declares stock-only positions, deduplication, independent cash and eligible-client left joins", () => {
  const sql = referenceSqlForContext("stock-cash-t1");
  assert.notEqual(sql, referenceSql);
  for (const id of stockIds) assert.equal(referenceSqlForContext(id), sql);
  assert.match(sql, /WHERE advisor_id = '\{\{advisor_id\}\}'/);
  assert.match(sql, /SELECT DISTINCT position_id, client_id, security_code, market_value/);
  assert.match(sql, /AND asset_class = '股票'/);
  assert.match(sql, /COUNT\(DISTINCT security_code\)/);
  assert.match(sql, /cash_totals AS \([\s\S]*FROM cash[\s\S]*GROUP BY client_id/);
  assert.match(sql, /FROM eligible_clients c\s+LEFT JOIN position_totals p[\s\S]*LEFT JOIN cash_totals b/);
  assert.match(sql, /非|不等于客户全资产/);
});
