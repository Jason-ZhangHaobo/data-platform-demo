import type {CustomerAssetAnalysis} from '../../src/v2/customer-asset-analysis-client.mjs';
import {encodeReportCsv} from '../../src/v2/report-csv.mjs';

export function displayHoldingRatio(ratio:string) {
  const [whole,tail]=ratio.split('.');
  const digits=(whole+tail.slice(0,2)).replace(/^0+(?=\d)/,'');
  const fraction=tail.slice(2).replace(/0+$/,'');
  return digits+(fraction?'.'+fraction:'')+'%';
}

export function customerAnalysisCsv(verified:CustomerAssetAnalysis, customerKey:string, displayedDigest:string) {
  if(verified.digest!==displayedDigest) throw Error('报表依据已变化，请重新读取后导出。');
  const customer=verified.customers.find(c=>c.customerKey===customerKey);
  if(!customer) throw Error('当前客户不在这次报表的已核对范围内。');
  const source=verified.source, report=verified.report, clientLabel=customer.clientLabel;
  const rows=[['客户','业务日','项目','分类','数值','单位','持仓市值占比','口径或来源']];
  function add(project:string, grouping:string, value:string, unit:string, ratio:string, note:string) {
    rows.push([clientLabel,source.businessDate,project,grouping,value,unit,ratio,note]);
  }
  add('客户总资产','',customer.totalAssets,'元（CNY）','','本次持仓市值＋可用现金');
  add('持仓市值','',customer.holdingMarketValue,'元（CNY）','','该客户当日持仓合计');
  add('可用现金','',customer.availableCash,'元（CNY）','','仅计入总资产');
  add('证券数量','',String(customer.securityCount),'只','','按证券代码去重');
  for(const [title,group] of [['资产类别分布',customer.assetClasses],['行业分布',customer.industries]] as const) {
    for(const item of group) add(title,item.label,item.marketValue,'元（CNY）',
      customer.holdingMarketValue==='0.00'?'不适用':displayHoldingRatio(item.ratio),
      (title==='行业分布'?'按原持仓行业标签分组。':'')+'分母为该客户当日持仓市值，现金单列');
  }
  if(customer.nullMarketValueCount>0) add('空市值持仓','',String(customer.nullMarketValueCount),'条','','按登记口径以零计入');
  add('来源','发布批次',source.batchId,'','','第 '+source.sequence+' 批');
  add('来源','报表运行',report.runId,'','','MySQL 全量持仓归档');
  add('来源','持仓快照摘要',source.landingSnapshotHash,'','','SHA-256');
  return {name:'shuduo-customer-assets-'+source.businessDate+'-'+report.runId.slice(0,8)+'-'+customerKey.slice(0,8)+'.csv',
    content:encodeReportCsv(rows)};
}
