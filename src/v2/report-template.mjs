import {distributionReportTemplateForContext} from './distribution-report-contract.mjs';
// Templates describe available fields; they never invent missing dimensions.
export function securitiesReportTemplate(fields = []) {
  const available = new Set(fields), widgets = [];
  const add = (widget) => {
    if (available.has(widget.field) && (!widget.dimension || available.has(widget.dimension)))
      widgets.push(widget);
  };
  add({ id: "total_assets", type: "KPI", title: "客户总资产合计（元）", aggregation: "SUM", field: "total_assets" });
  const value = available.has("holding_market_value") ? "holding_market_value" : "market_value";
  add({ id: "holding_value", type: "KPI", title: "持仓市值合计（元）", aggregation: "SUM", field: value });
  add({ id: "available_cash", type: "KPI", title: "可用现金合计（元）", aggregation: "SUM", field: "available_cash" });
  add({ id: "security_count", type: "KPI", title: "证券代码去重数", aggregation: "COUNT_DISTINCT", field: "security_code" });
  if (!available.has("security_code"))
    add({ id: "client_security_count", type: "BAR", title: "各客户证券数量", aggregation: "SUM", field: "security_count", dimension: "client_id" });
  add({ id: "client_assets", type: "BAR", title: "各客户总资产（元）", aggregation: "SUM", field: "total_assets", dimension: "client_id" });
  add({ id: "asset_class_distribution", type: "PIE", title: "资产类别分布（元）", aggregation: "SUM", field: value, dimension: "asset_class" });
  add({ id: "industry_distribution", type: "BAR", title: "行业分布（元）", aggregation: "SUM", field: value, dimension: "industry" });
  const notes = [];
  if (!available.has("total_assets")) notes.push("缺少 total_assets，不生成客户总资产；持仓市值不能替代总资产。");
  if (!available.has("asset_class")) notes.push("缺少 asset_class，不生成资产类别分布。");
  if (!available.has("industry")) notes.push("缺少 industry，不生成行业分布。");
  if (!available.has("security_code")) notes.push("缺少 security_code，不能计算全体客户的证券代码去重数。");
  if (widgets.some(widget => widget.id === "client_security_count"))
    notes.push("各客户证券数量使用已加工的 security_count；请确认每客户一行，不将跨客户合计当作全局去重数。");
  return { widgets, notes };
}
export function publishedReportTemplate(fields,contextId){
 const distribution=distributionReportTemplateForContext(contextId);if(distribution)return distribution;
 const result=securitiesReportTemplate(fields);
 if(contextId.startsWith('stock-cash'))for(const w of result.widgets){if(w.id==='total_assets')w.title='股票持仓＋现金合计（元）';if(w.id==='client_assets')w.title='各客户股票持仓＋现金（元）';}
 return result;
}
