import {servicePlanSourceQuery} from './service-plan-request.mjs';
const uuid="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const digest = /^[a-f0-9]{64}$/;
// Optional source selection is all-or-nothing. Never degrade a malformed exact
// handoff into the older task-wide discovery request.
export function privateServiceSourceSelection(params, evidence = false) {
  const keys=["agent_task_id","manual_delivery_task_id","package_digest","release_id",...(evidence?["call_id_digest","release_batch_id"]:[])],entries=[...params];
  if(new Set(entries.map(([key])=>key)).size!==entries.length||entries.some(([key])=>!keys.includes(key)))return;
  const taskId=params.get("agent_task_id")??undefined,manualDeliveryTaskId=params.get('manual_delivery_task_id')??undefined,packageDigest=params.get("package_digest")??undefined,releaseId=params.get("release_id")??undefined;
  if(taskId!==undefined&&!new RegExp(`^${uuid}$`).test(taskId)||manualDeliveryTaskId!==undefined&&!new RegExp(`^${uuid}$`).test(manualDeliveryTaskId)||taskId!==undefined&&manualDeliveryTaskId!==undefined||packageDigest!==undefined&&!digest.test(packageDigest)||releaseId!==undefined&&!new RegExp(`^${uuid}$`).test(releaseId))return;
  const callIdDigest = params.get("call_id_digest") ?? undefined;
  const batchId = params.get("release_batch_id") ?? undefined;
  if (callIdDigest !== undefined && (!releaseId || !digest.test(callIdDigest))) return;
  if (batchId !== undefined && (!taskId || !releaseId || !packageDigest || !new RegExp(`^${uuid}$`).test(batchId))) return;
  const call = callIdDigest === undefined ? {} : {callIdDigest};
  if(manualDeliveryTaskId)return packageDigest&&releaseId?{manualDeliveryTaskId,packageDigest,releaseId,...call}:undefined;
  if(evidence?!(taskId&&packageDigest):(packageDigest!==undefined||releaseId!==undefined)&&!(taskId&&packageDigest&&releaseId))return;
  return {taskId,packageDigest,releaseId,...call,...(batchId ? {batchId} : {})};
}
export function privateServiceRoute(method,path,{agentPlanning=false,agentRead=false}={}) {
  if(typeof path!=="string" || path.length>700 || /[#\\]/.test(path) || !path.startsWith("/api/v2/"))return false;
  const url=new URL(path,"http://127.0.0.1"),p=url.pathname;
  if(p!==path.split("?")[0] || new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)return false;
  let allowed=[];
  if(method==="GET" && /^\/api\/v2\/open\/(dapis|xapis)\/[a-z][a-z0-9-]{2,47}$/.test(p))allowed=["client_id","clientId","portfolio_id","trade_date","asset_class","page","page_size","pageSize"];
  else if(method==='GET' && p==='/api/v2/data-services/agent/context'){
    try{return Boolean(servicePlanSourceQuery(url.searchParams));}catch{return false;}
  }
  else if(agentRead&&method==='GET'&&p==='/api/v2/data-services/agent/plans'){
    try{return Boolean(servicePlanSourceQuery(url.searchParams));}catch{return false;}
  }
  else if(agentRead&&method==='GET'&&new RegExp(`^/api/v2/data-services/agent/(?:plans|requests)/${uuid}$`).test(p))allowed=[];
  else if(agentPlanning&&method==='POST'&&(p==='/api/v2/data-services/agent/plans'||new RegExp(`^/api/v2/data-services/agent/plans/${uuid}/(?:advance|apply|cancel)$`).test(p)))allowed=[];
  else if(agentRead&&method==='POST'&&new RegExp(`^/api/v2/data-services/agent/plans/${uuid}/cancel$`).test(p))allowed=[];
  else if(method==="GET" && p==="/api/v2/data-services/sources")return Boolean(privateServiceSourceSelection(url.searchParams));
  else if(method==="GET" && p==="/api/v2/data-services/task-evidence"){
    // Keep the existing bare route so its authenticated handler returns the
    // established 422 missing-input response; populated queries are strict.
    return !url.search||Boolean(privateServiceSourceSelection(url.searchParams,true));
  }
  else if(method==="GET" && p==="/api/v2/data-services/calls")allowed=["service_id"];
  else if(["GET","POST"].includes(method) && /^\/api\/v2\/data-services\/(dapis|xapis|applications)$/.test(p))allowed=[];
  else if(method==="POST" && new RegExp(`^/api/v2/data-services/applications/${uuid}/revoke$`).test(p))allowed=[];
  else if(method==="GET" && new RegExp(`^/api/v2/data-services/(dapis|xapis)/${uuid}(?:/(openapi|calls|recovery|history))?$`).test(p))allowed=[];
  else if(method==="POST" && new RegExp(`^/api/v2/data-services/(dapis|xapis)/${uuid}/(versions|test|publish|activate)$`).test(p))allowed=[];
  else return false;
  return [...url.searchParams].every(([k,v])=>allowed.includes(k)&&v.length<=100);
}
