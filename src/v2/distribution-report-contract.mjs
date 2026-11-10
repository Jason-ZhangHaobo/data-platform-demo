import {distributionMetadataById,distributionMetadataForContext} from './output-contract-metadata.mjs';
export const distributionReportMetricIds=Object.freeze(['asset_class_distribution','industry_distribution','distribution_security_count','distribution_ratio']);
export function distributionReportTemplate(contractId){
 const c=distributionMetadataById(contractId);if(!c)return undefined;
 return {widgets:[
  {id:c.dimension==='asset_class'?'asset_class_distribution':'industry_distribution',type:'PIE',title:c.dimension==='asset_class'?'资产类别持仓市值（元）':'行业标签持仓市值（元）',aggregation:'VALUE',field:'holding_market_value',dimension:c.dimension,partitionBy:['client_id','trade_date']},
  {id:'distribution_security_count',type:'BAR',title:'各分类证券数量',aggregation:'VALUE',field:'security_count',dimension:c.dimension,partitionBy:['client_id','trade_date']},
  {id:'distribution_ratio',type:'BAR',title:'各分类市值占比',aggregation:'VALUE',field:'market_value_ratio',dimension:c.dimension,partitionBy:['client_id','trade_date']}
 ],notes:['每次仅展示一个客户、一个交易日的分类，不跨客户或日期汇总占比。','持仓分布不含现金，不代表客户全资产；零持仓市值没有有效占比。','证券数量为分类内去重数，不能相加作为全局证券去重数。',...(c.dimension==='industry'?['行业是证券分类标签，不作基金底层持仓穿透。']:[]),'未知分类沿用源结果，不补造标签；客户编号已脱敏，切片保持独立。']};
}
export const distributionReportTemplateForContext=id=>distributionReportTemplate(distributionMetadataForContext(id)?.id);
