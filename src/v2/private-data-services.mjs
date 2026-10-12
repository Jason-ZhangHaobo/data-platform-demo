import { DataServiceManager, serviceHash, verifiedPrivateServiceSource } from "./data-services.mjs";
import { privateServiceRoute } from "./private-service-routes.mjs";
import { privateServiceRecovery } from "./private-service-recovery.mjs";
const uuid="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const fail=(status,message,code="PRIVATE_SERVICE_ACCESS_DENIED")=>Object.assign(new Error(message),{status,code});

// One shared allowlist for the private transport, temporary preview and router.
export { privateServiceRoute } from "./private-service-routes.mjs";

export function createPrivateDataServices({store,businessStore,project,auth,now,origin,bootId,persist=async()=>{}}) {
  const get=(kind,id)=>store.get(kind,id,project);
  const source=id=>{
    const run=get("release_run",id),release=run&&get("release",run.releaseId),bundle=run&&get("delivery_package",run.packageId),approval=release&&get("release_approval",release.approvalId);
    return verifiedPrivateServiceSource({run,release,bundle,approval});
  };
  const manager=new DataServiceManager({store,businessStore,project,scope:"PRIVATE_CLOUD_TEST",releaseRunFor:source,verifySource:run=>source(run?.id),now});
  const actor=req=>{const a=auth.sessionFromHeaders(req.headers);if(!a)throw fail(401,"请先登录受邀账号","AUTHENTICATION_REQUIRED");return a;};
  const owned=(a,item)=>Boolean(item && item.scope==="PRIVATE_CLOUD_TEST" && (a.role==="ADMIN" || item.createdBy===a.user.id));
  const requireOwned=(a,item)=>{if(!owned(a,item))throw fail(403,"无权管理其他用户的数据服务");return item;};
  const sourceOwner=(a,run)=>{const release=get("release",run.releaseId),task=get("agent",release.sourceAgentTaskId);if(!task || (a.role!=="ADMIN" && task.submittedBy!==a.user.id))throw fail(403,"无权使用该发布批次");};
  const bodyKeys=(b,keys)=>{if(!b || Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k)))throw fail(422,"请求包含未支持字段","INVALID_PRIVATE_SERVICE_INPUT");return b;};
  const service=(a,id)=>requireOwned(a,manager.detail(id));
  const checkInput=(a,type,b,version=false)=>{
    bodyKeys(b,type==="DAPI"?[...(version?[]:["name","slug"]),"sourceReleaseRunId","fields","timeoutMs","rateLimitPerMinute"]:[...(version?[]:["name","slug"]),"steps","timeoutMs","rateLimitPerMinute"]);
    if(type==="DAPI")sourceOwner(a,source(b.sourceReleaseRunId));
    else if(b.steps!==undefined){if(!Array.isArray(b.steps))throw fail(422,"XAPI步骤无效");for(const s of b.steps){bodyKeys(s,["alias","dapiId","dapiVersionId"]);const child=service(a,s.dapiId);if(s.dapiVersionId && s.dapiVersionId!==child.publishedVersionId)throw fail(409,"XAPI子版本已经变更","STALE_SERVICE_VERSION");}}
  };
  let queryTail=Promise.resolve(),queries=0;
  async function handle(req,url,readBody) {
    const method=req.method,path=url.pathname;
    if(!privateServiceRoute(method,url.pathname+url.search))throw fail(404,"私有数据服务接口未开放");
    const open=path.match(/^\/api\/v2\/open\/(dapis|xapis)\/([a-z][a-z0-9-]{2,47})$/);
    if(open){if(queries>=8)throw fail(429,"私有查询队列已满","PRIVATE_SERVICE_QUEUE_FULL");queries++;const query=queryTail.then(async()=>{try{return {status:200,body:await manager.invoke(open[1]==="dapis"?"DAPI":"XAPI",open[2],req.headers.authorization,Object.fromEntries(url.searchParams))};}finally{await persist();}});queryTail=query.catch(()=>{});try{return await query;}finally{queries--;}}
    const a=actor(req),owner=a.user.id;
    if(method==="POST")auth.requireMutation(req.headers,path);
    if(path.endsWith("/sources")){
      const taskId=url.searchParams.get("agent_task_id");if(taskId&&!new RegExp(`^${uuid}$`).test(taskId))throw fail(422,"任务编号无效");
      const rows=[];for(const r of store.list("release_run",project)){try {const run=source(r.id);sourceOwner(a,run);const release=get("release",run.releaseId);if(taskId&&release.sourceAgentTaskId!==taskId)continue;rows.push({id:run.id,releaseId:run.releaseId,sourceAgentTaskId:release.sourceAgentTaskId,status:run.status,published:run.published,schedulerTriggered:run.schedulerTriggered,engine:run.engine,engineVersion:run.engineVersion,mainSqlExecuted:run.mainSqlExecuted,testSqlValidation:{passed:true},validation:{passed:true},packageDigest:run.packageDigest,sequence:run.sequence,createdAt:run.createdAt,rowCount:run.rows.length});}catch(e){if(![403,409,422].includes(e.status))throw e;}}
      return {status:200,body:rows};
    }
    if(method==="GET" && /\/data-services\/(dapis|xapis)$/.test(path))return {status:200,body:manager.list(path.endsWith("dapis")?"DAPI":"XAPI").filter(s=>owned(a,s))};
    if(method==="GET" && path.endsWith("/applications"))return {status:200,body:manager.listApplications().filter(s=>owned(a,s))};
    if(method==="GET" && path.endsWith("/calls") && !path.match(new RegExp(`/${uuid}/calls$`))){const id=url.searchParams.get("service_id");if(id)service(a,id);return {status:200,body:manager.listCalls(id??undefined).filter(c=>owned(a,get("data_service",c.serviceId)))};}
    const key=req.headers["idempotency-key"];
    const dedup=(namespace,b,create)=>{if(typeof key!=="string"||key.length<1||key.length>100)throw fail(422,"缺少幂等键");return store.deduplicate(`${project}:private-service:${owner}:${namespace}:${key}`,serviceHash(b),create);};
    if(method==="POST" && path.endsWith("/applications")){
      const b=bodyKeys(await readBody(req),["name","serviceIds"]);if(!Array.isArray(b.serviceIds))throw fail(422,"授权服务列表无效");for(const id of b.serviceIds)service(a,id);
      let issued;const record=dedup("app",b,()=>{issued=manager.createApplication(b);return store.update("service_app",issued.application.id,project,{createdBy:owner});});
      if(record.replayed)return {status:200,body:{application:manager.application(record.id),token:null,tokenShownOnce:false}};
      return {status:201,body:{...issued,application:manager.application(record.id)}};
    }
    const app=path.match(new RegExp(`^/api/v2/data-services/applications/(${uuid})/revoke$`));
    if(app){requireOwned(a,manager.application(app[1]));bodyKeys(await readBody(req),[]);return {status:200,body:manager.revokeApplication(app[1])};}
    if(method==="POST" && /\/data-services\/(dapis|xapis)$/.test(path)){
      const type=path.endsWith("dapis")?"DAPI":"XAPI",b=await readBody(req);checkInput(a,type,b);
      const d=dedup(type,b,()=>{const s=type==="DAPI"?manager.createDapi(b):manager.createXapi(b);return store.update("data_service",s.id,project,{createdBy:owner,scope:"PRIVATE_CLOUD_TEST"});});return {status:d.replayed?200:201,body:manager.detail(d.id)};
    }
    const match=path.match(new RegExp(`^/api/v2/data-services/(dapis|xapis)/(${uuid})(?:/(versions|test|publish|activate|openapi|calls|recovery))?$`));
    if(match){const type=match[1]==="dapis"?"DAPI":"XAPI",s=service(a,match[2]),action=match[3];if(s.serviceType!==type)throw fail(404,"服务类型不匹配");
      if(method==="GET" && action==="recovery")return {status:200,body:privateServiceRecovery({
        service:s,bootId,businessStore,source,ownedService:id=>service(a,id),
        getVersion:id=>get("data_service_version",id),
        applications:manager.listApplications().filter(app=>owned(a,app)&&app.serviceIds.includes(s.id)),
        calls:manager.listCalls(s.id),
      })};
      if(method==="GET")return {status:200,body:action==="openapi"?manager.openApi(s.id,origin??"/"):action==="calls"?manager.listCalls(s.id):s};
      const b=await readBody(req);
      if(action==="versions"){checkInput(a,type,b,true);const d=dedup(`${type}:${s.id}:version`,b,()=>type==="DAPI"?manager.createDapiVersion(s.id,b):manager.createXapiVersion(s.id,b));return {status:d.replayed?200:201,body:get("data_service_version",d.id)};}
      if(action==="test")return {status:200,body:await manager.test(s.id,b)};
      if(action==="publish"){bodyKeys(b,["configHash"]);if(b.configHash!==s.currentVersion.configHash)throw fail(409,"服务配置已经变更，请重新审阅测试","STALE_SERVICE_VERSION");return {status:200,body:manager.publish(s.id)};}
      if(action==="activate"){bodyKeys(b,["versionId"]);return {status:200,body:manager.activate(s.id,b.versionId)};}
    }
    throw fail(404,"接口不存在");
  }
  return {handle,manager};
}
