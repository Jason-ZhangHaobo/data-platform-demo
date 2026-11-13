import {distributionMetadataById} from './output-contract-metadata.mjs';
import {isDeepStrictEqual as same} from "node:util";
import {fundDapiContract} from "./fund-dapi-contract.mjs";
export const snapshotContractById = id => id === fundDapiContract.id ? fundDapiContract : distributionMetadataById(id);
const fail=message=>Object.assign(Error(message),{status:422,code:'INVALID_DISTRIBUTION_SERVICE'});
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function distributionFields(id,fields){
 const c=snapshotContractById(id);if(!c)throw fail('结果服务契约未登记');
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
 const c=snapshotContractById(id);if(!c||!Array.isArray(rows)||!rows.length||rows.length>1000)throw fail('分布快照行数或契约不合法');
 const values=rows.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==c.fields.length||c.fields.some(f=>!Object.hasOwn(row,f.name)))throw fail('分布字段与契约不符');
  const out={};for(const f of c.fields){const v=row[f.name];
   if(f.type==='STRING'){if(typeof v!=='string'||!v.trim()||v.length>100||['client_id','portfolio_id'].includes(f.name)&&!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(v)||f.name==='trade_date'&&!/^\d{4}-\d{2}-\d{2}$/.test(v))throw fail('分布复合键不合法');out[f.name]=v;}
   else{const text=fixed(v,f.scale??0,f.maximum??f.max);if(f.type==='INTEGER'){const n=Number(text);if(!Number.isSafeInteger(n))throw fail('证券数量超出安全范围');out[f.name]=n;}else out[f.name]=text;}
  }return out;
 });
 const key=r=>JSON.stringify(c.keyFields.map(k=>r[k]));if(new Set(values.map(key)).size!==values.length)throw fail('分布复合键重复');
 return values.sort((a,b)=>{for(const k of c.keyFields){const order=compare(a[k],b[k]);if(order)return order;}return 0;});
}
function compositionLayout(contract) {
 const fund = contract.id === fundDapiContract.id;
 return {
  groupKeys: [contract.keyFields[0], "trade_date"],
  dimension: contract.dimension ?? "asset_class",
  arrayField: fund ? "exposures" : "distributions",
  composition: fund ? "FUND_EXPOSURE_ARRAY_V1" : "CLIENT_DISTRIBUTION_ARRAY_V1",
 };
}

export function distributionComposition(versions, steps) {
 const ids = versions.map(version => version.outputContractId);
 if (!ids.some(Boolean)) return undefined;
 const first = versions[0];
 if (!ids[0] || ids.some(id => id !== ids[0]) || versions.some(version =>
   version.sourceReleaseRunId !== first.sourceReleaseRunId || version.snapshotHash !== first.snapshotHash))
  throw fail("组合 XAPI 需要同一契约、同一发布批次和同一快照的 DAPI");
 const contract = snapshotContractById(ids[0]);
 if (!contract) throw fail("组合 XAPI 契约未登记");
 const { groupKeys, arrayField, composition } = compositionLayout(contract);
 if (steps.some(step => [...contract.keyFields, arrayField].includes(step.alias)))
  throw fail("组合编排别名与输出字段冲突");
 const fund = contract.id === fundDapiContract.id;
 if (fund) {
  if (versions.some(version => !Array.isArray(version.fields) || contract.keyFields.some(key => !version.fields.includes(key))))
   throw fail("基金 DAPI 缺少组合、交易日或资产类别");
  const metrics = versions.map(version => version.fields.filter(field => !contract.keyFields.includes(field)));
  if (!same(metrics.map(fields => fields.join(",")).sort(), ["exposure_amount", "exposure_ratio"]) ||
      versions.some(version => !["LOCAL_TEST_ONLY","PRIVATE_CLOUD_TEST"].includes(version.scope) || version.scope !== first.scope || version.snapshotId !== first.snapshotId ||
        version.sourceReleaseId !== first.sourceReleaseId || version.sourcePackageDigest !== first.sourcePackageDigest ||
        !same(version.sourceEvidence, first.sourceEvidence)))
   throw fail("基金 XAPI 需要同一已核验快照的金额与占比 DAPI 各一个");
 }
 return { sourceEvidence: { protocol: fund ? "shuduo-fund-composition-source/v1" : "shuduo-distribution-composition-source/v1",
  children: versions.map(version => version.sourceEvidence), agentIndependentE2E: false },
  outputContractId: contract.id, composition, groupKeys, joinKeys: contract.keyFields };
}

export function combineDistributionResults(results, contractId, query) {
 const contract = snapshotContractById(contractId);
 if (!contract) throw fail("组合 XAPI 契约未登记");
 const { groupKeys, dimension, arrayField } = compositionLayout(contract);
 const groups = new Map();
 let expectedKeys;
 for (const { alias, rows } of results) {
  const seen = new Set();
  for (const row of rows) {
   if (contract.keyFields.some(key => typeof row[key] !== "string")) throw fail("组合结果缺少复合键");
   const key = JSON.stringify(contract.keyFields.map(field => row[field]));
   if (seen.has(key)) throw fail("组合结果出现重复分组");
   seen.add(key);
   const group = JSON.stringify(groupKeys.map(field => row[field]));
   if (!groups.has(group))
    groups.set(group, { keys: Object.fromEntries(groupKeys.map(field => [field, row[field]])), values: new Map() });
   const { values } = groups.get(group);
   if (!values.has(key)) values.set(key, { [dimension]: row[dimension] });
   values.get(key)[alias] = Object.fromEntries(Object.entries(row).filter(([name]) => !contract.keyFields.includes(name)));
  }
  const keys = [...seen].sort();
  if (expectedKeys && !same(expectedKeys, keys)) throw fail("组合子接口返回的复合键集合不一致");
  expectedKeys = keys;
 }
 const all = [...groups.values()].sort((a, b) =>
  compare(a.keys[groupKeys[0]], b.keys[groupKeys[0]]) || compare(a.keys.trade_date, b.keys.trade_date))
  .map(({ keys, values }) => ({ ...keys, [arrayField]: [...values.values()].sort((a, b) => compare(a[dimension], b[dimension])) }));
 return { rows: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
  pagination: { page: query.page, pageSize: query.pageSize, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / query.pageSize)) } };
}

// OpenAPI describes exact decimal strings; it does not publish fixture answers.
export function distributionResponseSchema(version,childVersions=[]){
 const c=snapshotContractById(version.outputContractId);if(!c)return undefined;
 const field=name=>{const f=c.fields.find(v=>v.name===name);return f.type==='STRING'?{type:'string'}:f.type==='INTEGER'?{type:'integer',minimum:0}:{type:'string',pattern:`^\\d+\\.\\d{${f.scale}}$`,description:`精确十进制字符串，固定${f.scale}位小数`};};
 const object=names=>({type:'object',additionalProperties:false,required:names,properties:Object.fromEntries(names.map(name=>[name,field(name)]))});
 const { groupKeys, dimension, arrayField } = compositionLayout(c);
 const item = version.serviceType === "DAPI" ? object(version.fields) : {
  ...object(groupKeys), required: [...groupKeys, arrayField],
  properties: { ...object(groupKeys).properties, [arrayField]: { type: "array", items: {
   type: "object", additionalProperties: false, required: [dimension, ...version.steps.map(step => step.alias)],
   properties: { [dimension]: field(dimension), ...Object.fromEntries(version.steps.map((step, index) =>
    [step.alias, object(childVersions[index].fields.filter(name => !c.keyFields.includes(name)))])) },
  } } },
 };
 return{type:'object',required:['data','pagination','resultContract'],properties:{data:{type:'array',items:item},pagination:{type:'object',required:['page','pageSize','total','totalPages'],properties:Object.fromEntries(['page','pageSize','total','totalPages'].map(n=>[n,{type:'integer',minimum:n==='total'?0:1}]))},resultContract:{type:'object',description:version.serviceType==='DAPI'?(c.id===fundDapiContract.id?'按组合、交易日、资产类别明细分页':'按客户、交易日、分类明细分页'):(c.id===fundDapiContract.id?'按组合及交易日分页，资产类别数组不会跨页截断':'按客户及交易日分页，分类数组不会跨页截断')},sourceEvidence:{type:'object',description:'保留本机执行与上游模型归因；不代表真实模型完整自主E2E'}}};
}
