import { readFileSync } from "node:fs";
const base = JSON.parse(
  readFileSync(
    new URL("../../fixtures/holdings/context.json", import.meta.url),
  ),
);
export const referenceSql = readFileSync(
  new URL("../../fixtures/holdings/reference.sql", import.meta.url),
  "utf8",
);
const stockCashReferenceSql = readFileSync(
  new URL("../../fixtures/holdings/stock-cash-reference.sql", import.meta.url),
  "utf8",
);
const stockCashDefinition =
  "股票持仓＋可用现金 = 去重股票持仓市值 + 客户可用现金，不等于客户全资产。仅统计 asset_class = '股票' 的持仓；按客户与交易日聚合，股票证券数量按代码去重，现金独立聚合后关联，保留仅有现金客户，空金额按 0 处理。";
// Reviewed answers are literal fixtures, independent of either reference SQL.
const stockCashVariants = {
  "stock-cash-t1": {
    sourceId: "holdings-t1",
    name: "股票持仓＋可用现金 T+1（非客户全资产）",
    expected: [
      { client_id: "CLIENT-001", holding_market_value: "1000.00", available_cash: "300.00", total_assets: "1300.00", security_count: 1 },
      { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 },
    ],
  },
  "stock-cash-cash-change": {
    sourceId: "cash-change",
    name: "股票持仓＋可用现金 · 现金变更（非客户全资产）",
    expected: [
      { client_id: "CLIENT-001", holding_market_value: "1000.00", available_cash: "800.00", total_assets: "1800.00", security_count: 1 },
      { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 },
    ],
  },
  "stock-cash-duplicate-position": {
    sourceId: "duplicate-position",
    name: "股票持仓＋可用现金 · 重复持仓（非客户全资产）",
    expected: [
      { client_id: "CLIENT-001", holding_market_value: "1000.00", available_cash: "300.00", total_assets: "1300.00", security_count: 1 },
      { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 },
    ],
  },
  "stock-cash-equal-value-positions": {
    sourceId: "equal-value-positions",
    name: "股票持仓＋可用现金 · 同额不同持仓（非客户全资产）",
    expected: [
      { client_id: "CLIENT-001", holding_market_value: "2000.00", available_cash: "300.00", total_assets: "2300.00", security_count: 1 },
      { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 },
    ],
  },
  "stock-cash-cash-only-client": {
    sourceId: "cash-only-client",
    name: "股票持仓＋可用现金 · 仅有现金客户（非客户全资产）",
    expected: [
      { client_id: "CLIENT-001", holding_market_value: "1000.00", available_cash: "300.00", total_assets: "1300.00", security_count: 1 },
      { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 },
      { client_id: "CLIENT-004", holding_market_value: "0.00", available_cash: "100.00", total_assets: "100.00", security_count: 0 },
    ],
  },
};
export function getContext(id = "holdings-t1") {
  if (Object.hasOwn(stockCashVariants, id)) {
    const variant = stockCashVariants[id];
    const value = getContext(variant.sourceId);
    value.id = id;
    value.name = variant.name;
    value.definition = stockCashDefinition;
    value.expected = structuredClone(variant.expected);
    return value;
  }
  const value = structuredClone(base);
  if (id === "cash-change") {
    value.id = id;
    value.name = "客户资产 · 现金变更";
    value.tables.find((t) => t.name === "cash").rows[0][1] = "800.00";
    value.expected[0].available_cash = "800.00";
    value.expected[0].total_assets = "2300.00";
  } else if (id === "duplicate-position") {
    value.id = id;
    value.name = "客户资产 · 重复持仓";
    const rows = value.tables.find((t) => t.name === "positions").rows;
    rows.push([...rows[0]]);
  } else if (id === "equal-value-positions") {
    value.id = id;
    value.name = "客户资产 · 同额不同持仓";
    const rows = value.tables.find((t) => t.name === "positions").rows;
    rows.push(["POS-DISTINCT", ...rows[0].slice(1)]);
    value.expected[0].holding_market_value = "2500.00";
    value.expected[0].total_assets = "2800.00";
  } else if (id === "cash-only-client") {
    value.id = id;
    value.name = "客户资产 · 仅有现金客户";
    value.tables
      .find((t) => t.name === "accounts")
      .rows.push(["CLIENT-004", value.advisorId]);
    value.tables
      .find((t) => t.name === "cash")
      .rows.push(["CLIENT-004", "100.00", value.businessDate]);
    value.expected.push({
      client_id: "CLIENT-004",
      holding_market_value: "0.00",
      available_cash: "100.00",
      total_assets: "100.00",
      security_count: 0,
    });
  } else if (id !== base.id) return undefined;
  return value;
}
export function publicContext(id) {
  const { expected, ...context } = getContext(id);
  return {
    ...context,
    referenceSql: referenceSqlForContext(id),
    validationFamily: validationFamilyForContext(id),
  };
}
export const contextIds = [
  "holdings-t1",
  "cash-change",
  "duplicate-position",
  "equal-value-positions",
  "cash-only-client",
];
export const validationContractId =
  "securities-assets-five-fixtures-2026-09-14";
const stockCashContextIds = Object.keys(stockCashVariants);
export const allContextIds = [...contextIds, ...stockCashContextIds];
const validationFamilies = [
  {
    id: validationContractId,
    contextIds: [...contextIds],
    name: "客户全品类持仓＋可用现金",
    definitionVersion: 1,
    metricLabels: {
      client_id: "客户编号",
      holding_market_value: "持仓市值",
      available_cash: "可用现金",
      total_assets: "客户总资产（持仓＋可用现金）",
      security_count: "证券数量（按代码去重）",
    },
  },
  {
    id: "securities-stock-cash-five-fixtures-v1",
    contextIds: stockCashContextIds,
    name: "股票持仓＋可用现金（非客户全资产）",
    definitionVersion: 1,
    metricLabels: {
      client_id: "客户编号",
      holding_market_value: "股票持仓市值",
      available_cash: "可用现金",
      total_assets: "股票持仓＋可用现金（非客户全资产）",
      security_count: "股票证券数量（按代码去重）",
    },
  },
];
export function validationFamilyForContext(id) {
  const family = validationFamilies.find((item) => item.contextIds.includes(id));
  return family ? structuredClone(family) : undefined;
}
export function referenceSqlForContext(id) {
  if (contextIds.includes(id)) return referenceSql;
  if (stockCashContextIds.includes(id)) return stockCashReferenceSql;
  return undefined;
}
