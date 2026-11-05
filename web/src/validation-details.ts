export type ValidationDetailKind = "VALUE_MISMATCH" | "INVALID_VALUE" | "MISSING_CLIENT" | "DUPLICATE_CLIENT" | "CLIENT_COUNT" | "OUT_OF_SCOPE_CLIENTS" | "OUTPUT_FIELDS";
export type ValidationMismatch = {kind:ValidationDetailKind;clientId?:string;field?:string;expected?:string;actual?:string;expectedCount?:number;actualCount?:number};
export type ValidationDetailScenario = {contextId:string;name:string;passed:boolean;detailsStatus:"AVAILABLE"|"LEGACY_UNAVAILABLE"|"INVALID";mismatches:ValidationMismatch[];totalMismatches:number;truncated:boolean};
export type ValidationDetailSource = {runId?:string;revisionId?:string;revisionHash?:string;contextId?:string;contractId?:string};
export type ValidationDetailsReport = {schema:"shuduo-validation-details/v1";status:"AVAILABLE"|"LEGACY_UNAVAILABLE"|"UNVERIFIED";source:ValidationDetailSource;scenarios:ValidationDetailScenario[]};
type View = {status:"AVAILABLE"|"LEGACY_UNAVAILABLE"|"UNVERIFIED";scenarios:ValidationDetailScenario[]};
const record = (value:unknown):value is Record<string,unknown> => Boolean(value&&typeof value==="object"&&!Array.isArray(value));
const text = (value:unknown,max:number):value is string => typeof value==="string"&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const id = (value:unknown):value is string => text(value,128)&&/^[a-zA-Z0-9_-]+$/.test(value);
const kinds = new Set<unknown>(["VALUE_MISMATCH","INVALID_VALUE","MISSING_CLIENT","DUPLICATE_CLIENT","CLIENT_COUNT","OUT_OF_SCOPE_CLIENTS","OUTPUT_FIELDS"]);
const fields = new Set<unknown>(["client_id","holding_market_value","available_cash","total_assets","security_count"]);
const decimal = (value:unknown,field?:unknown):value is string => typeof value==="string"&&value.length<=64&&
  (field==="security_count"?/^\d{1,38}$/:/^-?\d{1,38}(?:\.\d{1,18})?$/).test(value);
const count = (value:unknown,max=1000):value is number => typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=max;

function safeMismatch(value:unknown):ValidationMismatch|undefined {
  if(!record(value)||!kinds.has(value.kind))return;
  if(value.clientId!==undefined&&(!id(value.clientId)||value.kind==="OUT_OF_SCOPE_CLIENTS"))return;
  if(value.field!==undefined&&!fields.has(value.field))return;
  if(value.expected!==undefined&&!decimal(value.expected,value.field)||value.actual!==undefined&&!decimal(value.actual))return;
  if(value.expectedCount!==undefined&&!count(value.expectedCount)||value.actualCount!==undefined&&!count(value.actualCount))return;
  if(value.kind==="VALUE_MISMATCH"&&(!id(value.clientId)||!fields.has(value.field)||value.field==="client_id"||!decimal(value.expected,value.field)||!decimal(value.actual)))return;
  if(value.kind==="INVALID_VALUE"&&(!id(value.clientId)||!fields.has(value.field)||value.field==="client_id"))return;
  // Rebuild the display projection: never echo arbitrary fields or raw errors.
  return {kind:value.kind as ValidationDetailKind,
    ...(value.clientId===undefined?{}:{clientId:value.clientId as string}),
    ...(value.field===undefined?{}:{field:value.field as string}),
    ...(value.expected===undefined?{}:{expected:value.expected as string}),
    ...(value.actual===undefined?{}:{actual:value.actual as string}),
    ...(value.expectedCount===undefined?{}:{expectedCount:value.expectedCount as number}),
    ...(value.actualCount===undefined?{}:{actualCount:value.actualCount as number})};
}

export function validationDetailsView(details:unknown, expected:ValidationDetailSource):View {
  const unavailable:View={status:"UNVERIFIED",scenarios:[]};
  if(details===undefined||details===null)return {status:"LEGACY_UNAVAILABLE",scenarios:[]};
  if(!record(details)||details.schema!=="shuduo-validation-details/v1")return unavailable;
  if(details.status==="LEGACY_UNAVAILABLE")return {status:"LEGACY_UNAVAILABLE",scenarios:[]};
  if(details.status!=="AVAILABLE"||!record(details.source))return unavailable;
  const source=details.source;
  if(!["runId","revisionId","contextId"].every(key=>id(expected[key as keyof ValidationDetailSource])&&source[key]===expected[key as keyof ValidationDetailSource]))return unavailable;
  if(typeof source.revisionHash!=="string"||!/^[a-f0-9]{64}$/.test(source.revisionHash)||!id(source.contractId))return unavailable;
  if(expected.revisionHash!==undefined&&source.revisionHash!==expected.revisionHash||expected.contractId!==undefined&&source.contractId!==expected.contractId)return unavailable;
  if(!Array.isArray(details.scenarios)||details.scenarios.length>5||!details.scenarios.length)return unavailable;
  const scenarios:ValidationDetailScenario[]=[],seen=new Set<string>();
  for(const row of details.scenarios){
    if(!record(row)||!id(row.contextId)||seen.has(row.contextId)||!text(row.name,200)||typeof row.passed!=="boolean")return unavailable;
    seen.add(row.contextId);
    const invalid:ValidationDetailScenario={contextId:row.contextId,name:row.name,passed:row.passed,detailsStatus:"INVALID",mismatches:[],totalMismatches:0,truncated:false};
    if(row.detailsStatus==="LEGACY_UNAVAILABLE"){scenarios.push({...invalid,detailsStatus:"LEGACY_UNAVAILABLE"});continue;}
    if(row.detailsStatus!=="AVAILABLE"||!Array.isArray(row.mismatches)||row.mismatches.length>20||!count(row.totalMismatches,10000)||typeof row.truncated!=="boolean"){
      scenarios.push(invalid);continue;
    }
    const mismatches=row.mismatches.map(safeMismatch);
    if(mismatches.some(item=>!item)||row.totalMismatches<mismatches.length||row.truncated!==(row.totalMismatches>mismatches.length)||row.passed&&(row.totalMismatches!==0||row.truncated)||!row.passed&&row.totalMismatches===0){
      scenarios.push(invalid);continue;
    }
    scenarios.push({...invalid,detailsStatus:"AVAILABLE",mismatches:mismatches as ValidationMismatch[],totalMismatches:row.totalMismatches,truncated:row.truncated});
  }
  return {status:"AVAILABLE",scenarios};
}

export const validationFieldLabels:Record<string,string>={client_id:"客户",holding_market_value:"持仓市值（元）",available_cash:"可用现金（元）",total_assets:"口径内资产合计（元）",security_count:"证券数量"};
export function validationMismatchCells(item:ValidationMismatch){
  switch(item.kind){
    case "VALUE_MISMATCH":return {label:"数值不符",expected:item.expected!,actual:item.actual!};
    case "INVALID_VALUE":return {label:"无效数值",expected:item.expected??"有效数值",actual:"无效或缺失（原值不回显）"};
    case "MISSING_CLIENT":return {label:"缺少客户",expected:"应包含该客户",actual:"未返回该客户"};
    case "DUPLICATE_CLIENT":return {label:"客户记录重复",expected:item.expectedCount===undefined?"客户记录唯一":`${item.expectedCount} 条`,actual:item.actualCount===undefined?"存在重复记录":`${item.actualCount} 条`};
    case "CLIENT_COUNT":return {label:"客户记录数不符",expected:item.expectedCount===undefined?"数量未记录":`${item.expectedCount} 条`,actual:item.actualCount===undefined?"数量未记录":`${item.actualCount} 条`};
    case "OUT_OF_SCOPE_CLIENTS":return {label:"包含范围外客户",expected:"仅限当前授权客户",actual:item.actualCount===undefined?"存在范围外记录（不展示标识）":`${item.actualCount} 条范围外记录（不展示标识）`};
    case "OUTPUT_FIELDS":return {label:"输出字段不符",expected:item.expectedCount===undefined?"符合固定输出契约":`${item.expectedCount} 个字段`,actual:item.actualCount===undefined?"与契约不一致":`${item.actualCount} 个字段`};
  }
}
