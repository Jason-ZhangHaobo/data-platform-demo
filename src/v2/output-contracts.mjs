import {readFileSync} from 'node:fs';
import {distributionMetadataById,distributionMetadataForContext} from './output-contract-metadata.mjs';
import {equalValidationNumber} from './validation-number.mjs';
const cases=JSON.parse(readFileSync(new URL('./output-contracts.json',import.meta.url),'utf8'));
const registry={contracts:cases.contracts.map(c=>({...distributionMetadataById(c.id),cases:c.cases}))};
export const distributionContextIds=registry.contracts.flatMap(c=>c.cases.map(v=>v.id));
export function outputContractForContext(id){return distributionMetadataForContext(id);}
export function distributionFamilyForContext(id){const c=outputContractForContext(id);return c?{id:c.id,contextIds:c.contextIds,name:c.name,definitionVersion:c.definitionVersion,
 outputContractId:c.id,grain:c.grain,keyFields:c.keyFields,metricLabels:Object.fromEntries(c.fields.map(f=>[f.name,f.label]))}:undefined;}
export function distributionContext(id,getBase){
 const c=registry.contracts.find(c=>c.cases.some(v=>v.id===id)),item=c?.cases.find(v=>v.id===id);if(!item)return;
 const value=getBase(item.sourceId);if(item.variant==='unclassified-zero'){
  const table=value.tables.find(t=>t.name==='positions'),index=Object.fromEntries(table.columns.map(([name],i)=>[name,i]));
  for(const r of table.rows){if(r[index.position_id]==='POS-001'){r[index.asset_class]=null;r[index.industry]=' ';}
   if(r[index.position_id]==='POS-003'){r[index.asset_class]='';r[index.industry]=null;r[index.market_value]='0.00';}}
  const cash=value.tables.find(t=>t.name==='cash');for(const r of cash.rows){if(r[0]==='CLIENT-001')r[1]='999999.00';if(r[0]==='CLIENT-002')r[1]='777777.00';}
 }
 return {...value,id:item.id,name:item.name,definition:c.definition,expected:structuredClone(item.expected),outputContractId:c.id};
}
export function distributionReferenceSql(id){const contract=outputContractForContext(id);if(!contract)return;
 const d=contract.dimension;
 return `-- 虚构证券持仓分布；分母不含现金，不代表穿透敞口。\nWITH clients AS (SELECT DISTINCT client_id FROM accounts WHERE advisor_id = '{{advisor_id}}'),
 deduplicated AS (SELECT DISTINCT position_id, client_id,
 CASE WHEN ${d} IS NULL OR TRIM(${d}) = '' THEN '未分类' ELSE TRIM(${d}) END AS dimension_value,
 CASE WHEN security_code IS NULL OR TRIM(security_code) = '' THEN NULL ELSE TRIM(security_code) END AS security_code,
 COALESCE(market_value, CAST(0 AS DECIMAL(38,2))) AS market_value FROM positions WHERE trade_date = '{{trade_date}}'),
 grouped AS (SELECT p.client_id, p.dimension_value, SUM(p.market_value) AS holding_market_value, COUNT(DISTINCT p.security_code) AS security_count
 FROM deduplicated p JOIN clients c ON p.client_id = c.client_id GROUP BY p.client_id,p.dimension_value),
 totals AS (SELECT client_id,SUM(holding_market_value) AS total_value FROM grouped GROUP BY client_id)
 SELECT c.client_id, '{{trade_date}}' AS trade_date, COALESCE(g.dimension_value,'未持仓') AS ${d},
 CAST(COALESCE(g.holding_market_value,0) AS DECIMAL(38,2)) AS holding_market_value, COALESCE(g.security_count,0) AS security_count,
 CAST(CASE WHEN t.total_value > 0 THEN ROUND(g.holding_market_value/t.total_value,6) ELSE 0 END AS DECIMAL(20,6)) AS market_value_ratio
 FROM clients c LEFT JOIN grouped g ON c.client_id=g.client_id LEFT JOIN totals t ON c.client_id=t.client_id ORDER BY c.client_id,${d}\n`;
}
function validNumericField(value,field){
 if(!["string","number"].includes(typeof value))return false;
 const raw=String(value);if(raw.length>64||!/^\d{1,38}(?:\.\d{1,18})?$/.test(raw))return false;
 const [whole,fraction=""]=raw.split(".");
 if(fraction.replace(/0+$/,"").length>(field.scale??0))return false;
 return field.max===undefined||BigInt(whole)<BigInt(field.max)||(BigInt(whole)===BigInt(field.max)&&!/[1-9]/.test(fraction));
}
export function verifyOutputRows(rows,context){
 const c=outputContractForContext(context?.id);if(!c||context.outputContractId!==c.id||!Array.isArray(rows))return false;
 const keys=c.keyFields,fields=c.fields,expected=registry.contracts.find(v=>v.id===c.id).cases.find(v=>v.id===context.id).expected;
 if(JSON.stringify(context.expected)!==JSON.stringify(expected))return false;
 if(rows.length!==expected.length||rows.length>1000)return false;
 const key=r=>JSON.stringify(keys.map(k=>r?.[k]));
 if(new Set(rows.map(key)).size!==rows.length)return false;
 return expected.every(w=>{const actual=rows.find(r=>key(r)===key(w));return actual&&Object.keys(actual).length===fields.length&&fields.every(f=>Object.hasOwn(actual,f.name)&&
  (f.type==='STRING'?typeof actual[f.name]==='string'&&actual[f.name]===w[f.name]:validNumericField(actual[f.name],f)&&equalValidationNumber(actual[f.name],w[f.name])));});
}
