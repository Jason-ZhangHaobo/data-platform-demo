import {checkedDistributionReportWidgets} from './distribution-report-read';
import {useState} from 'react';
import {ReportWidget} from './ReportsWorkbench';
import {distributionReportTemplate} from '../../src/v2/distribution-report-contract.mjs';
import type {ReportWidgetResult} from './published-report-read';
export function DistributionReportResults({contractId,widgets,sourceEvidence}:{contractId:string;widgets:ReportWidgetResult[];sourceEvidence?:{modelClassification?:string;engineClassification?:string}}){
 const partitions=[...new Map(widgets.flatMap(w=>(w.series??[]).map(s=>[s.partitionKey!,{id:s.partitionKey!,client:s.clientLabel!,date:s.tradeDate!}] as const))).values()], [chosen,setChosen]=useState(''),selected=partitions.find(p=>p.id===chosen)??partitions[0];
 try{const template=distributionReportTemplate(contractId);checkedDistributionReportWidgets(widgets,widgets.map(w=>template?.widgets.find(d=>d.id===w.id)),contractId,widgets[0]?.evaluatedCount??0);}catch{return <p role="status">分布报表的切片或固定字段尚未确认，请重读原报告；不会汇总其他客户。</p>;}
 if(!selected)return <p role="status">此报表没有可确认的客户交易日切片。</p>;
 const filtered=widgets.map(w=>({...w,series:w.series?.filter(s=>s.partitionKey===selected.id)})),values=filtered.find(w=>w.field==='holding_market_value')?.series??[],ratios=filtered.find(w=>w.field==='market_value_ratio')?.series??[],counts=filtered.find(w=>w.field==='security_count')?.series??[],zero=filtered.some(w=>w.series?.length)&&filtered.every(w=>w.series?.every(s=>s.zeroDenominator===true));
 const percent=(value:string|undefined)=>value===undefined?'—':`${(Number(value)*100).toFixed(4)}%`;
 return <section className="distribution-report-view" aria-label="客户持仓分布报表"><label>客户与交易日<select aria-label="分布报表客户与交易日" value={selected.id} onChange={e=>setChosen(e.target.value)}>{partitions.map(p=><option key={p.id} value={p.id}>{p.client} · {p.date}</option>)}</select></label><p>当前仅展示 {selected.client} 在 {selected.date} 的分类；切换不创建报表或重新计算。</p>
  {sourceEvidence&&<p className="agent-dev-notice">{sourceEvidence.modelClassification==='SYNTHETIC_UPSTREAM'?'模型响应使用测试替身':'模型真实性待独立验证'} · 本机报表快照，不计完整自主E2E。</p>}
  {zero&&<p role="status" className="agent-dev-notice">该客户当日持仓市值为零，没有有效占比；保留源分类及零值，不绘制占比饼图。</p>}
  <div className="report-widgets-v2">{filtered.filter(w=>!(zero&&(w.type==='PIE'||w.field==='market_value_ratio'))).map(w=><ReportWidget key={w.id} widget={w}/>)}</div>
  <div className="report-distribution-table"><table><caption>固定快照分类明细 · 金额及占比保留原精度</caption><thead><tr><th>分类</th><th>市值（元）</th><th>分类内证券数量</th><th>市值占比</th></tr></thead><tbody>{(values.length?values:ratios.length?ratios:counts).map(s=><tr key={s.group}><td>{s.group}</td><td>{values.find(v=>v.group===s.group)?.value??'—'}</td><td>{counts.find(v=>v.group===s.group)?.value??'—'}</td><td>{zero?'不适用（零市值）':percent(ratios.find(v=>v.group===s.group)?.value)}</td></tr>)}</tbody></table></div>
  <aside className="report-template-notes-v2">{distributionReportTemplate(contractId)?.notes.map(note=><p key={note}>{note}</p>)}</aside>
 </section>;
}
