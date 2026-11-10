import {distributionMetadataById} from './output-contract-metadata.mjs';
const fail=message=>Object.assign(Error(message),{status:422,code:'INVALID_DISTRIBUTION_SERVICE'});
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function distributionFields(id,fields){
 const c=distributionMetadataById(id);if(!c)throw fail('分布服务契约未登记');
 const selected=fields??c.fields.map(f=>f.name);
 if(!Array.isArray(selected)||!selected.length||selected.length>c.fields.length||new Set(selected).size!==selected.length||selected.some(f=>!c.fields.some(v=>v.name===f)))throw fail('字段不在分布输出契约内');
 return [...c.keyFields,...selected.filter(f=>!c.keyFields.includes(f))];
}
function fixed(value,scale,max){
 if(!['string','number'].includes(typeof value))throw fail('分布数值类型不合法');
 const raw=String(value);if(!/^\d{1,38}(?:\.\d{1,18})?$/.test(raw))throw fail('分布数值格式不合法');
 const [whole,part='']=raw.split('.');if(part.replace(/0+$/,'').length>scale)throw fail('分布数值精度不合法');
 const integer=BigInt(whole);if(max!==undefined&&(integer>BigInt(max)||integer===BigInt(max)&&/[1-9]/.test(part)))throw fail('分布数值超出范围');
 return integer.toString()+(scale?'.'+part.slice(0,scale).padEnd(scale,'0'):'');
}
export function normalizedDistributionRows(rows,id){
 const c=distributionMetadataById(id);if(!c||!Array.isArray(rows)||!rows.length||rows.length>1000)throw fail('分布快照行数或契约不合法');
 const values=rows.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==c.fields.length||c.fields.some(f=>!Object.hasOwn(row,f.name)))throw fail('分布字段与契约不符');
  const out={};for(const f of c.fields){const v=row[f.name];
   if(f.type==='STRING'){if(typeof v!=='string'||!v.trim()||v.length>100||f.name==='client_id'&&!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(v)||f.name==='trade_date'&&!/^\d{4}-\d{2}-\d{2}$/.test(v))throw fail('分布复合键不合法');out[f.name]=v;}
   else{const text=fixed(v,f.scale??0,f.maximum??f.max);if(f.type==='INTEGER'){const n=Number(text);if(!Number.isSafeInteger(n))throw fail('证券数量超出安全范围');out[f.name]=n;}else out[f.name]=text;}
  }return out;
 });
 const key=r=>JSON.stringify(c.keyFields.map(k=>r[k]));if(new Set(values.map(key)).size!==values.length)throw fail('分布复合键重复');
 return values.sort((a,b)=>{for(const k of c.keyFields){const order=compare(a[k],b[k]);if(order)return order;}return 0;});
}
export function distributionComposition(versions,steps){
 const ids=versions.map(v=>v.outputContractId);if(!ids.some(Boolean))return undefined;
 if(!ids[0]||ids.some(id=>id!==ids[0])||versions.some(v=>v.sourceReleaseRunId!==versions[0].sourceReleaseRunId||v.snapshotHash!==versions[0].snapshotHash))throw fail('分布XAPI只能组合同一契约、同一发布批次的DAPI');
 const c=distributionMetadataById(ids[0]);if(!c||steps.some(s=>[...c.keyFields,'distributions'].includes(s.alias)))throw fail('分布编排别名与复合键冲突');
 return {sourceEvidence:{protocol:'shuduo-distribution-composition-source/v1',children:versions.map(v=>v.sourceEvidence),agentIndependentE2E:false},outputContractId:c.id,composition:'CLIENT_DISTRIBUTION_ARRAY_V1',groupKeys:['client_id','trade_date'],joinKeys:c.keyFields};
}
export function combineDistributionResults(results,contractId,query){
 const c=distributionMetadataById(contractId),groups=new Map();if(!c)throw fail('分布组合契约未登记');
 let expectedKeys;
 for(const {alias,rows} of results){
  const seen=new Set();for(const row of rows){
   if(c.keyFields.some(k=>typeof row[k]!=='string'))throw fail('组合结果缺少分布复合键');
   const key=JSON.stringify(c.keyFields.map(k=>row[k]));if(seen.has(key))throw fail('组合结果出现重复分组');seen.add(key);
   const customer=JSON.stringify([row.client_id,row.trade_date]);if(!groups.has(customer))groups.set(customer,{client_id:row.client_id,trade_date:row.trade_date,values:new Map()});
   const group=groups.get(customer);if(!group.values.has(key))group.values.set(key,{[c.dimension]:row[c.dimension]});
   group.values.get(key)[alias]=Object.fromEntries(Object.entries(row).filter(([name])=>!c.keyFields.includes(name)));
  }
  const keys=[...seen].sort();if(expectedKeys&&JSON.stringify(expectedKeys)!==JSON.stringify(keys))throw fail('分布子接口返回的分组集合不一致');expectedKeys=keys;
 }
 const all=[...groups.values()].sort((a,b)=>compare(a.client_id,b.client_id)||compare(a.trade_date,b.trade_date)).map(g=>({client_id:g.client_id,trade_date:g.trade_date,distributions:[...g.values.values()].sort((a,b)=>compare(a[c.dimension],b[c.dimension]))}));
 return {rows:all.slice((query.page-1)*query.pageSize,query.page*query.pageSize),pagination:{page:query.page,pageSize:query.pageSize,total:all.length,totalPages:Math.max(1,Math.ceil(all.length/query.pageSize))}};
}

// OpenAPI describes exact decimal strings; it does not publish fixture answers.
export function distributionResponseSchema(version,childVersions=[]){
 const c=distributionMetadataById(version.outputContractId);if(!c)return undefined;
 const field=name=>{const f=c.fields.find(v=>v.name===name);return f.type==='STRING'?{type:'string'}:f.type==='INTEGER'?{type:'integer',minimum:0}:{type:'string',pattern:`^\\d+\\.\\d{${f.scale}}$`,description:`精确十进制字符串，固定${f.scale}位小数`};};
 const object=names=>({type:'object',additionalProperties:false,required:names,properties:Object.fromEntries(names.map(name=>[name,field(name)]))});
 const item=version.serviceType==='DAPI'?object(version.fields):{...object(['client_id','trade_date']),required:['client_id','trade_date','distributions'],properties:{...object(['client_id','trade_date']).properties,distributions:{type:'array',items:{type:'object',additionalProperties:false,required:[c.dimension,...version.steps.map(s=>s.alias)],properties:{[c.dimension]:field(c.dimension),...Object.fromEntries(version.steps.map((s,i)=>[s.alias,object(childVersions[i].fields.filter(f=>!c.keyFields.includes(f)))]))}}}}};
 return{type:'object',required:['data','pagination','resultContract'],properties:{data:{type:'array',items:item},pagination:{type:'object',required:['page','pageSize','total','totalPages'],properties:Object.fromEntries(['page','pageSize','total','totalPages'].map(n=>[n,{type:'integer',minimum:n==='total'?0:1}]))},resultContract:{type:'object',description:version.serviceType==='DAPI'?'按客户、交易日、分类明细分页':'按客户及交易日分页，分类数组不会跨页截断'},sourceEvidence:{type:'object',description:'保留本机执行与上游模型归因；不代表真实模型完整自主E2E'}}};
}
