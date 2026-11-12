import { fundOutputContract } from "./fund-lookthrough.mjs";

const fund = fundOutputContract();
export const fundDapiContract = {
  id: fund.id, name: fund.name, grain: fund.grain, keyFields: fund.keyFields,
  fields: fund.fields.map(field => ({ ...field,
    ...(field.name === "exposure_amount" ? { type: "DECIMAL", scale: 2 } :
      field.name === "exposure_ratio" ? { type: "DECIMAL", scale: 6, maximum: 1 } : { type: "STRING" }),
  })),
};

export function normalizeFundFilters(value) {
  const keys = [...fundDapiContract.keyFields, "page", "pageSize", "page_size"];
  const bad = () => Object.assign(new Error("基金查询仅接受合法的组合编号、交易日、资产类别和分页参数"), {
    status: 400, code: "INVALID_FUND_QUERY",
  });
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) ||
      value.pageSize !== undefined && value.page_size !== undefined) throw bad();
  const { portfolio_id, trade_date, asset_class } = value;
  if (portfolio_id !== undefined && (typeof portfolio_id !== "string" || !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(portfolio_id))) throw bad();
  if (trade_date !== undefined && (typeof trade_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(trade_date) ||
      !Number.isFinite(Date.parse(trade_date)) || new Date(trade_date).toISOString().slice(0, 10) !== trade_date)) throw bad();
  if (asset_class !== undefined && (typeof asset_class !== "string" || !/^[\p{L}\p{N}_-]{1,40}$/u.test(asset_class))) throw bad();
  return Object.fromEntries(fundDapiContract.keyFields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
