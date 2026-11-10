import {isDeepStrictEqual as same} from 'node:util';
import {getContext} from './context.mjs';
import {distributionMetadataForContext} from './output-contract-metadata.mjs';

// Server-only independent oracle. Never send fixture answers or query inputs in
// the evidence report. Do not reuse the production XAPI combination function.
export function checkDistributionResponse({contextId,version,children,query,response}) {
 const context=getContext(contextId),contract=distributionMetadataForContext(contextId);
 if(!contract||version.outputContractId!==contract.id)throw Object.assign(Error('分布消费独立依据未确认'),{status:409,code:'DISTRIBUTION_ORACLE_UNAVAILABLE'});
 const order=(a,b)=>a<b?-1:a>b?1:0;
 const rows=context.expected.filter(row=>!query.clientId||row.client_id===query.clientId).map(row=>({...row}));
 rows.sort((a,b)=>{for(const key of contract.keyFields){const n=order(a[key],b[key]);if(n)return n;}return 0;});
 let all;
 if(version.serviceType==='DAPI')all=rows.map(row=>Object.fromEntries(version.fields.map(field=>[field,row[field]])));
 else{
  all=[];
  for(const row of rows){
   let group=all.find(g=>g.client_id===row.client_id&&g.trade_date===row.trade_date);
   if(!group){group={client_id:row.client_id,trade_date:row.trade_date,distributions:[]};all.push(group);}
   const item={[contract.dimension]:row[contract.dimension]};
   version.steps.forEach((step,i)=>{item[step.alias]=Object.fromEntries(children[i].fields.filter(f=>!contract.keyFields.includes(f)).map(f=>[f,row[f]]));});
   group.distributions.push(item);
  }
 }
 const expected=all.slice((query.page-1)*query.pageSize,query.page*query.pageSize),unit=version.serviceType==='DAPI'?'DISTRIBUTION_ROWS':'CLIENT_DATE_GROUPS';
 const expectedContract={id:contract.id,grain:version.serviceType==='DAPI'?contract.grain:'CLIENT_TRADE_DATE_WITH_DISTRIBUTION_ARRAY',keyFields:version.serviceType==='DAPI'?contract.keyFields:['client_id','trade_date'],paginationUnit:unit};
 return{independentResultVerified:same(response.data,expected)&&same(response.pagination,{page:query.page,pageSize:query.pageSize,total:all.length,totalPages:Math.max(1,Math.ceil(all.length/query.pageSize))})&&same(response.resultContract,expectedContract),expectedRowCount:expected.length,paginationUnit:unit};
}
