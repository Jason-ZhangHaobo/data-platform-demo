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
export function getContext(id = "holdings-t1") {
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
  return { ...context, referenceSql };
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
