const uuid="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
export function privateServiceRoute(method,path) {
  if(typeof path!=="string" || path.length>700 || /[#\\]/.test(path) || !path.startsWith("/api/v2/"))return false;
  const url=new URL(path,"http://127.0.0.1"),p=url.pathname;
  if(p!==path.split("?")[0] || new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)return false;
  let allowed=[];
  if(method==="GET" && /^\/api\/v2\/open\/(dapis|xapis)\/[a-z][a-z0-9-]{2,47}$/.test(p))allowed=["client_id","clientId","page","page_size","pageSize"];
  else if(method==="GET" && p==="/api/v2/data-services/sources")allowed=["agent_task_id"];
  else if(method==="GET" && p==="/api/v2/data-services/task-evidence")allowed=["agent_task_id","package_digest"];
  else if(method==="GET" && p==="/api/v2/data-services/calls")allowed=["service_id"];
  else if(["GET","POST"].includes(method) && /^\/api\/v2\/data-services\/(dapis|xapis|applications)$/.test(p))allowed=[];
  else if(method==="POST" && new RegExp(`^/api/v2/data-services/applications/${uuid}/revoke$`).test(p))allowed=[];
  else if(method==="GET" && new RegExp(`^/api/v2/data-services/(dapis|xapis)/${uuid}(?:/(openapi|calls|recovery|history))?$`).test(p))allowed=[];
  else if(method==="POST" && new RegExp(`^/api/v2/data-services/(dapis|xapis)/${uuid}/(versions|test|publish|activate)$`).test(p))allowed=[];
  else return false;
  return [...url.searchParams].every(([k,v])=>allowed.includes(k)&&v.length<=100);
}
