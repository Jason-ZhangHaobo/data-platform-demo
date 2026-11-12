import {checkedDistributionReportWidgets} from './distribution-report-read';
import {useState} from 'react';
import {ReportWidget} from './ReportsWorkbench';
import {distributionReportTemplate,fundReportContractId} from '../../src/v2/distribution-report-contract.mjs';
import type {ReportWidgetResult,ReportSourceEvidence} from './published-report-read';
export function DistributionReportResults({contractId,widgets,sourceEvidence}:{contractId:string;widgets:ReportWidgetResult[];sourceEvidence?:ReportSourceEvidence}){
 const partitions=[...new Map(widgets.flatMap(w=>(w.series??[]).map(s=>[s.partitionKey!,{id:s.partitionKey!,client:s.clientLabel!,date:s.tradeDate!}] as const))).values()], [chosen,setChosen]=useState(''),selected=partitions.find(p=>p.id===chosen)??partitions[0];
 try{const template=distributionReportTemplate(contractId);checkedDistributionReportWidgets(widgets,widgets.map(w=>template?.widgets.find(d=>d.id===w.id)),contractId,widgets[0]?.evaluatedCount??0);}catch{return <p role="status">分布报表的切片或固定字段尚未确认，请重读原报告；不会汇总其他客户。</p>;}
 const fund = contractId === fundReportContractId, entity = fund ? "组合" : "客户";
 if (!selected) return <p role="status">此报表没有可确认的{entity}交易日切片。</p>;
 const amountField = fund ? "exposure_amount" : "holding_market_value", ratioField = fund ? "exposure_ratio" : "market_value_ratio";
 const filtered = widgets.map(widget => ({...widget,series:widget.series?.filter(item=>item.partitionKey===selected.id)}));
 const values = filtered.find(widget=>widget.field===amountField)?.series??[];
 const ratios = filtered.find(widget=>widget.field===ratioField)?.series??[];
 const counts = filtered.find(widget=>widget.field==="security_count")?.series??[];
 const zero = filtered.some(widget=>widget.series?.length)&&filtered.every(widget=>widget.series?.every(item=>item.zeroDenominator===true));
 const percent=(value:string|undefined)=>value===undefined?'—':`${(Number(value)*100).toFixed(4)}%`;
 return <section className="distribution-report-view" aria-label={fund ? "基金组合敞口报表" : "客户持仓分布报表"}>
  <label>{entity}与交易日<select aria-label={fund ? "基金报表组合与交易日" : "分布报表客户与交易日"} value={selected.id} onChange={event=>setChosen(event.target.value)}>
   {partitions.map(item=><option key={item.id} value={item.id}>{item.client} · {item.date}</option>)}</select></label>
  <p>当前展示 {selected.client} 在 {selected.date} 的分类。</p>
  {sourceEvidence&&(fund?<p className="agent-dev-notice">本机 Spark 已核验 · 原包 <code title={sourceEvidence.packageDigest}>{sourceEvidence.packageDigest?.slice(0,12)}</code>
   {" · 批次结果 "}<code title={sourceEvidence.resultDigest}>{sourceEvidence.resultDigest?.slice(0,12)}</code>
   {" · 独立断言 "}<code title={sourceEvidence.assertionDigest}>{sourceEvidence.assertionDigest?.slice(0,12)}</code></p>:
   <p className="agent-dev-notice">{sourceEvidence.modelClassification==='SYNTHETIC_UPSTREAM'?'模型响应使用测试替身':'模型真实性待独立验证'} · 本机报表快照，不计完整自主E2E。</p>)}
  {zero&&<p role="status" className="agent-dev-notice">{fund ? "该组合当日基金持仓市值为零，保留源分类和金额。" : "该客户当日持仓市值为零，没有有效占比；保留源分类及零值，不绘制占比饼图。"}</p>}
  <div className="report-widgets-v2">{filtered.filter(widget=>!(zero&&(widget.type==="PIE"||widget.field===ratioField))).map(widget=><ReportWidget key={widget.id} widget={widget}/>)}</div>
  <div className="report-distribution-table"><table><caption>固定快照分类明细 · 金额及占比保留原精度</caption><thead><tr>
   <th>分类</th><th>{fund ? "敞口金额（元）" : "市值（元）"}</th>{!fund&&<th>分类内证券数量</th>}<th>{fund ? "敞口占比" : "市值占比"}</th>
  </tr></thead><tbody>{(values.length?values:ratios.length?ratios:counts).map(item=><tr key={item.group}>
   <td>{item.group}</td><td>{values.find(value=>value.group===item.group)?.value??"—"}</td>
   {!fund&&<td>{counts.find(value=>value.group===item.group)?.value??"—"}</td>}
   <td>{zero?"不适用（零市值）":percent(ratios.find(value=>value.group===item.group)?.value)}</td>
  </tr>)}</tbody></table></div>
  <aside className="report-template-notes-v2">{distributionReportTemplate(contractId)?.notes.map(note=><p key={note}>{note}</p>)}</aside>
 </section>;
}
