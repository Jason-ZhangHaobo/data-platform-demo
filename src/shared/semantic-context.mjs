const contextItems = [
  { kind: "metric", id: "total_assets", name: "客户总资产", definition: "客户在指定交易日的持仓市值与可用现金合计。", formula: "SUM(holding_market_value) + available_cash", grain: "客户 × 交易日", sourceAsset: "dws_position_snapshot", fields: ["client_id", "market_value", "available_cash"], caveat: "第一版使用虚构持仓快照，不包含真实资金余额。" },
  { kind: "metric", id: "holding_market_value", name: "持仓市值", definition: "客户持有证券按估值价格计算的市值。", formula: "SUM(market_value)", grain: "客户 × 交易日", sourceAsset: "dws_position_snapshot", fields: ["client_id", "market_value", "trade_date"], caveat: "估值价格为虚构数据，需与交易日口径一致。" },
  { kind: "metric", id: "security_count", name: "证券数量", definition: "客户持仓中去重后的证券代码数量。", formula: "COUNT(DISTINCT security_code)", grain: "客户 × 交易日", sourceAsset: "dws_position_snapshot", fields: ["client_id", "security_code", "trade_date"], caveat: "不等于持仓股数，必须使用 DISTINCT。" },
  { kind: "metric", id: "asset_class_distribution", name: "资产类别分布", definition: "按股票、债券、基金等资产类别汇总持仓市值及占比。", formula: "SUM(market_value) GROUP BY asset_class", grain: "客户 × 资产类别 × 交易日", sourceAsset: "dws_position_snapshot", fields: ["client_id", "asset_class", "market_value"], caveat: "类别字典需要与证券主数据关联。" },
  { kind: "metric", id: "industry_distribution", name: "行业分布", definition: "按证券所属行业汇总持仓市值及占比。", formula: "SUM(market_value) GROUP BY industry", grain: "客户 × 行业 × 交易日", sourceAsset: "dws_position_snapshot", fields: ["client_id", "industry", "market_value"], caveat: "行业分类口径来自证券主数据快照。" },
  { kind: "term", id: "t_plus_1", name: "T+1", definition: "交易日收盘后生成快照，下一交易日供财富顾问查询。", sourceAsset: "dws_position_snapshot", fields: ["trade_date"], caveat: "节假日和交易日历必须由调度配置提供。" },
  { kind: "term", id: "own_clients_only", name: "本人客户范围", definition: "财富顾问只能查询 advisor_id 等于当前用户身份的客户。", sourceAsset: "dws_position_snapshot", fields: ["advisor_id", "client_id"], caveat: "SQL 必须带当前用户过滤条件，不能只依赖前端隐藏。" },
];

const examples = [
  { question: "财富顾问如何查看客户持仓？", answer: "先按当前用户过滤 advisor_id，再按 trade_date 取最新 T+1 快照，最后聚合市值和证券数量。" },
  { question: "客户总资产怎么计算？", answer: "持仓市值与可用现金合计；当前 Demo 只演示持仓市值。" },
  { question: "行业分布从哪张表来？", answer: "从持仓快照的 industry 字段汇总，正式实现应关联证券主数据分类。" },
];

export function searchSemanticContext(query = "") {
  const normalized = String(query).trim().toLowerCase();
  const matches = (item) => !normalized || [item.name, item.definition, item.formula, item.sourceAsset, ...(item.fields ?? [])].join(" ").toLowerCase().includes(normalized);
  return { items: contextItems.filter(matches), examples: examples.filter((item) => !normalized || `${item.question} ${item.answer}`.toLowerCase().includes(normalized)) };
}

export function holdingsSemanticContext() {
  return searchSemanticContext("持仓");
}
