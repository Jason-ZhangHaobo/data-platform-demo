import contract from "../../fixtures/fund-lookthrough/contract.json" with { type: "json" };
import { isFundContext } from "./fund-contexts.mjs";

const marketInputs = ["fund_positions.market_value", "fund_allocations.allocation_weight"];
const sources = {
  portfolio_id: ["portfolios.portfolio_id", "fund_positions.portfolio_id"],
  trade_date: ["fund_positions.trade_date", "fund_allocations.trade_date"],
  asset_class: ["fund_allocations.asset_class"],
  exposure_amount: marketInputs,
  exposure_ratio: marketInputs,
};

export const fundConstraintLabels = Object.freeze({
  MANAGER_SCOPED_PORTFOLIOS: "只读取登记管理人的组合",
  SAME_TRADE_DATE: "持仓与权重使用同一交易日",
  CNY_POSITIONS_ONLY: "仅人民币基金持仓",
  POSITION_AND_ALLOCATION_DEDUP: "按持仓和底层明细标识去重",
  UNALLOCATED_AS_UNCOVERED: "缺失权重保留为未穿透",
  SINGLE_LEVEL_LOOKTHROUGH: "只穿透一层基金持仓",
  PORTFOLIO_DATE_DENOMINATOR: "占比以当日组合基金持仓市值为分母",
  DECIMAL_EXPOSURE: "敞口金额与占比使用定点精度",
});

export const fundRequirementContractId = contract.id;
export function fundRequirementScope(id) {
  if (!isFundContext(id)) return undefined;
  return {
    id: contract.id, definition: contract.definition, definitionVersion: 1, grain: contract.grain,
    metrics: contract.fields.map(({ name, label }) => ({ field: name, label, sourceFields: [...sources[name]] })),
    constraints: Object.keys(fundConstraintLabels),
    tables: contract.sourceTables.map(({ name, columns }) => ({ name, columns: columns.map(column => [...column]) })),
  };
}
