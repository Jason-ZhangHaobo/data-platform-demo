export const assetQueryFieldNames=Object.freeze({client_id:'客户编号',holding_market_value:'持仓市值',available_cash:'可用现金',total_assets:'口径内资产合计',security_count:'证券数量'});
export const assetQueryFields=Object.freeze(Object.keys(assetQueryFieldNames));
const slugPattern=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const validFields=items=>Array.isArray(items)&&items.includes('client_id')&&items.length<=assetQueryFields.length&&
  new Set(items).size===items.length&&items.every(field=>assetQueryFields.includes(field));

export function assetQueryContract(service,version,children){
  if(version.outputContractId || version.serviceId!==service.id || version.serviceType!==service.serviceType)return;
  const parts=version.serviceType==='DAPI'?[version]:children;
  if(!parts?.length || parts.some(v=>!v || v.outputContractId || v.serviceType!=='DAPI' || !validFields(v.fields)))return;
  const sources=parts.map((v,i)=>({serviceId:v.serviceId,versionId:v.id,configHash:v.configHash,batchId:v.sourceReleaseRunId,fields:v.fields,
    ...(version.serviceType==='XAPI'?{alias:version.steps[i].alias}:{})}));
  return {scope:version.scope,serviceType:version.serviceType,serviceId:service.id,slug:service.slug,name:service.name,
    versionId:version.id,versionNumber:version.versionNumber,configHash:version.configHash,
    current:service.status==='PUBLISHED'&&service.publishedVersionId===version.id&&version.status==='PUBLISHED',
    timeoutMs:version.timeoutMs,rateLimitPerMinute:version.rateLimitPerMinute,sources};
}

export function boundAssetQueryContract(entry,batchId){
  const c=entry?.queryContract,refs=entry?.sourceVersions;
  if(!id(batchId)||!c||entry.source?.sourceReleaseRunId!==batchId||entry.source.scope!=='PRIVATE_CLOUD_TEST'||
    entry.source.sourceKind!=='AGENT'||!id(entry.releaseId)||entry.source.releaseId!==entry.releaseId||!hash(entry.source.packageDigest)||
    c.scope!=='PRIVATE_CLOUD_TEST'||!id(c.serviceId)||c.serviceId!==entry.serviceId||!id(c.versionId)||
    c.versionId!==entry.versionId||!hash(c.configHash)||c.configHash!==entry.configHash||c.name!==entry.name||typeof c.name!=='string'||
    !['DAPI','XAPI'].includes(c.serviceType)||c.serviceType!==entry.serviceType||typeof c.current!=='boolean'||
    c.current&&entry.versionStatus==='RETIRED'||typeof c.slug!=='string'||c.slug.length<3||c.slug.length>48||!slugPattern.test(c.slug)||
    !Number.isSafeInteger(c.versionNumber)||c.versionNumber<1||!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<100||c.timeoutMs>5000||
    !Number.isSafeInteger(c.rateLimitPerMinute)||c.rateLimitPerMinute<1||c.rateLimitPerMinute>600||
    !Array.isArray(c.sources)||!Array.isArray(refs)||c.sources.length!==refs.length||
    (c.serviceType==='DAPI'?c.sources.length!==1:c.sources.length<2||c.sources.length>5))return;
  const seen=new Set(),aliases=new Set();
  for(const source of c.sources){
    if(!source||!id(source.serviceId)||!id(source.versionId)||!hash(source.configHash)||source.batchId!==batchId||
      seen.has(source.serviceId)||!validFields(source.fields))return;
    seen.add(source.serviceId);
    if(c.serviceType==='DAPI'){
      if(source.serviceId!==c.serviceId||source.versionId!==c.versionId||source.configHash!==c.configHash||source.alias!==undefined)return;
    }else{
      if(typeof source.alias!=='string'||!/^[a-z][a-z0-9_]{1,29}$/.test(source.alias)||source.alias==='client_id'||aliases.has(source.alias))return;
      aliases.add(source.alias);
    }
    const ref=refs.find(r=>r?.serviceId===source.serviceId&&r.versionId===source.versionId);
    if(!ref||ref.sourceReleaseRunId!==batchId||ref.releaseId!==entry.releaseId||ref.packageDigest!==entry.source.packageDigest||
      ref.configHash!==source.configHash||!validFields(ref.fields)||
      source.fields.length!==ref.fields.length||source.fields.some(field=>!ref.fields.includes(field)))return;
  }
  return c;
}

function rowProperties(selected){
  return Object.fromEntries(selected.map(name=>{
    if(name==='client_id')return [name,{type:'string',description:assetQueryFieldNames[name]}];
    const value=name==='security_count'?{type:'integer',minimum:0}:{type:'string',pattern:'^-?[0-9]+\\.[0-9]{2}$'};
    return [name,{description:assetQueryFieldNames[name],oneOf:[value,{type:'string',const:'******',description:'该字段已脱敏'}]}];
  }));
}

export function assetQueryDocument(c,origin='/'){
  const dapi=c.serviceType==='DAPI',endpoint='/api/v2/open/'+c.serviceType.toLowerCase()+'s/'+c.slug;
  const properties=dapi?rowProperties(c.sources[0].fields):{
    ...rowProperties(['client_id']),
    ...Object.fromEntries(c.sources.map(source=>{
      const selected=source.fields.filter(name=>name!=='client_id');
      return [source.alias,{type:'object',properties:rowProperties(selected),required:selected,additionalProperties:false}];
    }))};
  const serviceSchema={type:'object',required:['id','type','slug','version','versionId'],properties:{
    id:{const:c.serviceId},type:{const:c.serviceType},slug:{const:c.slug},version:{const:c.versionNumber},versionId:{const:c.versionId}}};
  if(!dapi){
    serviceSchema.required.push('steps');
    serviceSchema.properties.steps={type:'array',minItems:c.sources.length,maxItems:c.sources.length,items:false,
      prefixItems:c.sources.map(s=>({type:'object',required:['alias','dapiId','dapiVersionId'],additionalProperties:false,
        properties:{alias:{const:s.alias},dapiId:{const:s.serviceId},dapiVersionId:{const:s.versionId}}}))};
  }
  const pagination={type:'object',required:['page','pageSize','total','totalPages'],properties:{
    page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100},total:{type:'integer',minimum:0},totalPages:{type:'integer',minimum:1}}};
  const response={type:'object',required:['data','pagination','service','callId','scope','localTestOnly','publicDeployed'],properties:{
    data:{type:'array',items:{type:'object',properties,required:dapi?c.sources[0].fields:['client_id'],additionalProperties:false}},
    pagination,service:serviceSchema,callId:{type:'string',format:'uuid'},scope:{const:c.scope},localTestOnly:{type:'boolean'},publicDeployed:{type:'boolean'},
    customerAccess:{type:'object',properties:{maskedFields:{type:'array',items:{enum:assetQueryFields}}}}}};
  const environment=c.scope==='PRIVATE_CLOUD_TEST'?'私有测试':'本机测试';
  return {openapi:'3.1.0',info:{title:c.name,version:String(c.versionNumber),description:environment+'环境下的虚构客户资产查询。金额使用两位小数的字符串，受限字段按应用授权脱敏。'},
    servers:[{url:origin}],paths:{[endpoint]:{get:{operationId:'query'+c.serviceType+c.serviceId.replaceAll('-',''),security:[{bearerAuth:[]}],
      parameters:[{name:'client_id',in:'query',required:false,schema:{type:'string',pattern:'^[A-Z0-9][A-Z0-9-]{2,63}$'}},
        {name:'page',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:10000,default:1}},
        {name:'page_size',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:100,default:20}}],
      responses:{200:{description:'查询成功。单客户应用按其授权客户返回结果。',content:{'application/json':{schema:response}}},
        400:{description:'查询参数无效'},401:{description:'应用令牌无效或已撤销'},403:{description:'应用未获服务、版本或客户授权'},
        404:{description:'接口未发布或已下线'},429:{description:'超过版本限流'},504:{description:'查询超过版本超时'}}}}},
    components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'opaque'}}},
    'x-shuduo-scope':c.scope,'x-shuduo-service-version-id':c.versionId,'x-shuduo-config-hash':c.configHash,'x-shuduo-current-published-version':c.current,
    'x-shuduo-timeout-ms':c.timeoutMs,'x-shuduo-rate-limit-per-minute':c.rateLimitPerMinute};
}
