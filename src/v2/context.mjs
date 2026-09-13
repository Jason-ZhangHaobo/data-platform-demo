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
  } else if (id !== base.id) return undefined;
  return value;
}
export function publicContext(id) {
  const { expected, ...context } = getContext(id);
  return { ...context, referenceSql };
}
export const contextIds = ["holdings-t1", "cash-change", "duplicate-position"];
