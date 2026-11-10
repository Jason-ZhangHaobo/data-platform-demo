import {distributionReportTemplate} from '../../src/v2/distribution-report-contract.mjs';
import {distributionMetadataById} from '../../src/v2/output-contract-metadata.mjs';
import type {ReportWidgetResult} from './published-report-read';
export function checkedDistributionReportWidgets(value:unknown,definitions:unknown,contractId:string,rowCount:number):ReportWidgetResult[]{
 const c=distributionMetadataById(contractId),template=distributionReportTemplate(contractId),bad=()=>{throw Error('分布报表切片、精度或固定组件未确认');};
 if(!c||!template||!Array.isArray(value)||!Array.isArray(definitions)||!value.length||value.length>3||value.length!==definitions.length||new Set(value.map(w=>w?.id)).size!==value.length)bad();
 let keys:string[]|undefined;
 for(let i=0;i<(value as any[]).length;i++){
  const w=(value as any[])[i],d=(definitions as any[])[i],expected=template!.widgets.find(v=>v.id===w?.id);
  if(!expected||!d||Object.keys(d).length!==Object.keys(expected).length||JSON.stringify(['id','type','title','aggregation','field','dimension','partitionBy'].map(k=>d[k]))!==JSON.stringify(['id','type','title','aggregation','field','dimension','partitionBy'].map(k=>(expected as any)[k]))||!w||w.id!==d.id||['type','title','aggregation','field','dimension'].some(k=>w[k]!==d[k])||JSON.stringify(w.partitionBy)!==JSON.stringify(d.partitionBy)||w.evaluatedCount!==rowCount||!Array.isArray(w.series)||w.series.length!==rowCount||w.series.length>1000)bad();
  for(const s of w.series){if(!s||typeof s.group!=='string'||!s.group||typeof s.partitionKey!=='string'||!/^[a-f0-9]{64}$/.test(s.partitionKey)||typeof s.clientLabel!=='string'||!/^.{3}\*\*\*.{3}$/u.test(s.clientLabel)||typeof s.tradeDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s.tradeDate)||typeof s.value!=='string'||typeof s.zeroDenominator!=='boolean')bad();
   const f=c!.fields.find(f=>f.name===w.field)!;if(f.type==='INTEGER'){if(!/^\d+$/.test(s.value)||!Number.isSafeInteger(Number(s.value)))bad();}else if(!new RegExp('^\\d+\\.\\d{'+f.scale+'}$').test(s.value)||w.field==='market_value_ratio'&&Number(s.value)>1)bad();
  }
  const current=w.series.map((s:any)=>JSON.stringify([s.partitionKey,s.tradeDate,s.clientLabel,s.group,s.zeroDenominator])).sort();if(new Set(current).size!==current.length||keys&&JSON.stringify(keys)!==JSON.stringify(current))bad();keys=current;
 }
 return value as ReportWidgetResult[];
}
