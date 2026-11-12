import { fundDapiContract, normalizeFundFilters } from "./fund-dapi-contract.mjs";
import { fundContext } from "./fund-lookthrough.mjs";

export function expectedFundCallRows(version, children, parameters, context = fundContext()) {
  const filters = normalizeFundFilters(parameters);
  const { page, pageSize } = parameters;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw Object.assign(new Error("基金历史调用分页不合法"), { status: 409, code: "FUND_CALL_PAGINATION_INVALID" });
  const rows = context.expected
    .filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
    .sort((left, right) => {
      for (const key of fundDapiContract.keyFields) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
      }
      return 0;
    });
  const offset = (page - 1) * pageSize;
  if (version.serviceType === "DAPI") {
    return rows.slice(offset, offset + pageSize)
      .map(row => Object.fromEntries(version.fields.map(field => [field, row[field]])));
  }
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.portfolio_id, row.trade_date]);
    if (!groups.has(key)) groups.set(key, { portfolio_id: row.portfolio_id, trade_date: row.trade_date, exposures: [] });
    const exposure = { asset_class: row.asset_class };
    for (const [index, child] of children.entries()) {
      const fields = child.fields.filter(field => !fundDapiContract.keyFields.includes(field));
      exposure[version.steps[index].alias] = Object.fromEntries(fields.map(field => [field, row[field]]));
    }
    groups.get(key).exposures.push(exposure);
  }
  return [...groups.values()].slice(offset, offset + pageSize);
}
