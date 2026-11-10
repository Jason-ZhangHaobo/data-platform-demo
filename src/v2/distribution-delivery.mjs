import {createHash} from 'node:crypto';
import {getContext} from './context.mjs';
import {outputContractForContext,verifyOutputRows} from './output-contracts.mjs';
const canonical=v=>JSON.stringify(v,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const fail=()=>Object.assign(Error('分布交付的登记契约、复合键、精度或本机范围不一致'),{status:422,code:'DISTRIBUTION_DELIVERY_CONTRACT_MISMATCH'});
const literal=v=>"'"+String(v).replaceAll("'","''")+"'";
export function distributionDeliveryBinding(contextId){
 const c=outputContractForContext(contextId);
 return c?{id:c.id,metadataHash:createHash('sha256').update(canonical(c)).digest('hex')}:undefined;
}
export function createDistributionTestSql(expected,contextId){
 const c=outputContractForContext(contextId),context=getContext(contextId);
 if(!c||!context||canonical(expected)!==canonical(context.expected)||!verifyOutputRows(expected,context))throw fail();
 const checks=expected.map(row=>{
  const predicates=c.fields.map(field=>field.type==='STRING'?`${field.name} = ${literal(row[field.name])}`:
   `${field.name} = CAST(${literal(row[field.name])} AS DECIMAL(${field.name==='market_value_ratio'?20:38},${field.scale??0}))`);
  return `SUM(CASE WHEN ${predicates.join(' AND ')} THEN 1 ELSE 0 END) = 1`;
 });
 // Exact row count plus one match per registered composite-key row forbids
 // duplicates and unknown groups. Never round the actual value before equality.
 return `-- Independent registered distribution assertions; composite keys and six-place ratios.\nSELECT CASE WHEN COUNT(*) = ${expected.length}\n  AND ${checks.join('\n  AND ')}\nTHEN true ELSE false END AS passed\nFROM __shuduo_result\n`;
}
export function validateDistributionDelivery({source,fixtures,testSql,localTarget}){
 const c=outputContractForContext(source?.contextId),binding=distributionDeliveryBinding(source?.contextId);
 if(!c){if(source?.outputContract!==undefined||fixtures?.outputContract!==undefined)throw fail();return;}
 if(!localTarget||canonical(source.outputContract)!==canonical(binding)||canonical(fixtures.outputContract)!==canonical(c)||
   canonical(Object.keys(fixtures).sort())!==canonical(['context','outputContract','validationContexts'])||
   testSql!==createDistributionTestSql(getContext(source.contextId).expected,source.contextId))throw fail();
}
