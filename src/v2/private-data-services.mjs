import { DataServiceManager, serviceHash, verifiedPrivateServiceSource } from "./data-services.mjs";
import { privateServiceRoute, privateServiceSourceSelection } from "./private-service-routes.mjs";
import { privateServiceRecovery } from "./private-service-recovery.mjs";
import { publishServiceReviewed, activateServiceReviewed } from "./service-version-governance.mjs";
import { privateTaskConsumption } from "./private-task-consumption.mjs";
import { createServicePilotGuard, assertServiceMutation } from "./public-service-access.mjs";
const uuid="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const fail=(status,message,code="PRIVATE_SERVICE_ACCESS_DENIED")=>Object.assign(new Error(message),{status,code});

// One shared allowlist for the private transport, temporary preview and router.
export { privateServiceRoute } from "./private-service-routes.mjs";

export function createPrivateDataServices({store,businessStore,project,auth,now,origin,bootId,pilotConfig,persist=async()=>{}}) {
  const get=(kind,id)=>typeof id==="string"?store.get(kind,id,project):undefined;
  const source=id=>{
    const run=get("release_run",id),release=run&&get("release",run.releaseId),bundle=run&&get("delivery_package",run.packageId),approval=release&&get("release_approval",release.approvalId);
    return verifiedPrivateServiceSource({run,release,bundle,approval});
  };
  const manager=new DataServiceManager({store,businessStore,project,scope:"PRIVATE_CLOUD_TEST",releaseRunFor:source,verifySource:run=>source(run?.id),now});
  const pilot = pilotConfig ? createServicePilotGuard({config:pilotConfig,store,project,source,detail:id=>manager.detail(id),now}) : undefined;
  const actor=req=>{const a=auth.sessionFromHeaders(req.headers);if(!a)throw fail(401,"请先登录受邀账号","AUTHENTICATION_REQUIRED");return a;};
  const manualReleaseOwned=(a,release)=>{
    const bundle=get("delivery_package",release?.packageId),origin=bundle?.manifest?.source,attribution=origin?.attribution;
    if(!release||!bundle)return false;
    const manual=attribution!==undefined||[release,bundle].some(item=>item.sourceKind==="MANUAL"||item.sourceAttribution==="ENGINEER_ASSISTED");
    if(!manual)return [undefined,"AGENT"].includes(release.sourceKind)&&[undefined,"AGENT"].includes(bundle.sourceKind);
    const owner=a?.user?.id;
    return Boolean(typeof owner==="string"&&owner&&release.sourceKind==="MANUAL"&&release.sourceAttribution==="ENGINEER_ASSISTED"&&release.agentIndependentE2E===false&&
      bundle.sourceKind==="MANUAL"&&bundle.agentIndependentE2E===false&&bundle.digest===release.packageDigest&&
      attribution?.kind==="ENGINEER_ASSISTED"&&attribution.agentIndependentE2E===false&&attribution.actorId===owner&&
      attribution.originAgentTaskId===release.sourceAgentTaskId&&release.submittedBy===owner&&get("agent",release.sourceAgentTaskId)?.submittedBy===owner&&
      bundle.sourceRunId===origin.runId&&release.sourceRunId===origin.runId&&release.sourceRevisionId===origin.revisionId&&release.sourceCodeHash===origin.sqlHash);
  };
  const versionOwned=(a,version)=>{
    if(!version||version.scope!=="PRIVATE_CLOUD_TEST")return false;
    if(version.serviceType==="DAPI"){
      const run=get("release_run",version.sourceReleaseRunId),release=get("release",version.sourceReleaseId);
      if(!run||!release||run.releaseId!==release.id||run.packageId!==release.packageId||run.packageDigest!==version.sourcePackageDigest||
        release.packageDigest!==version.sourcePackageDigest||!manualReleaseOwned(a,release))return false;
      return release.sourceKind==="MANUAL"
        ? run.sourceKind==="MANUAL"&&run.sourceAttribution==="ENGINEER_ASSISTED"&&run.agentIndependentE2E===false&&run.submittedBy===a?.user?.id&&
          run.sourceAgentTaskId===release.sourceAgentTaskId&&run.sourceRunId===release.sourceRunId
        : [undefined,"AGENT"].includes(run.sourceKind)&&run.sourceAttribution!=="ENGINEER_ASSISTED";
    }
    if(version.serviceType!=="XAPI"||!Array.isArray(version.steps)||version.steps.length<2||version.steps.length>5)return false;
    return version.steps.every(step=>{
      const child=get("data_service_version",step.dapiVersionId);
      return child?.serviceId===step.dapiId&&child.serviceType==="DAPI"&&versionOwned(a,child);
    });
  };
  const assertApplicationVersion=({service,application,version})=>{
    // Invoke supplies the actual published root and pinned children. A private
    // draft or an unrelated historical version must not alter a live Agent grant.
    if(!application||application.scope!=="PRIVATE_CLOUD_TEST"||version?.serviceId!==service.id||!versionOwned({user:{id:application.createdBy}},version))
      throw fail(403,"应用创建者无权调用当前人工来源版本","MANUAL_SERVICE_APPLICATION_OWNER_REQUIRED");
  };
  // ADMIN retains the legacy Agent policy, but cannot inherit another
  // engineer's manual services, pinned children, applications or call history.
  const manualSourcesOwned=(a,item,seen=new Set())=>{
    if(!item)return false;
    const key=`${item.serviceType??"app"}:${item.id}`;
    if(seen.has(key))return true;
    seen.add(key);
    if(item.serviceType===undefined&&Array.isArray(item.serviceIds))return item.serviceIds.every(id=>manualSourcesOwned(a,get("data_service",id),seen));
    // Detail/history/recovery expose all saved versions, not only the two current
    // pointers. Switching back to Agent cannot unprotect an earlier manual source.
    const versions=store.list("data_service_version",project).filter(version=>version.serviceId===item.id);
    return versions.some(version=>version.id===item.currentVersionId)&&(!item.publishedVersionId||versions.some(version=>version.id===item.publishedVersionId))&&
      versions.every(version=>versionOwned(a,version));
  };
  const owned=(a,item)=>{
    if(!item||item.scope!=="PRIVATE_CLOUD_TEST")return false;
    // Losing access to a service version must not remove an application's own
    // creator's ability to inspect/revoke that token. This exposes no service history.
    if(item.serviceType===undefined&&Array.isArray(item.serviceIds)&&item.createdBy===a.user.id)return true;
    return Boolean((a.role==="ADMIN"||item.createdBy===a.user.id)&&manualSourcesOwned(a,item));
  };
  const requireOwned=(a,item)=>{if(!owned(a,item))throw fail(403,"无权管理其他用户的数据服务");return item;};
  const sourceOwner=(a,run)=>{const release=get("release",run.releaseId),task=get("agent",release.sourceAgentTaskId);if(!task || (a.role!=="ADMIN" && task.submittedBy!==a.user.id)||!manualReleaseOwned(a,release))throw fail(403,"无权使用该发布批次");};
  const bodyKeys=(b,keys)=>{if(!b || Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k)))throw fail(422,"请求包含未支持字段","INVALID_PRIVATE_SERVICE_INPUT");return b;};
  const service=(a,id)=>requireOwned(a,manager.detail(id));
  const callOwned=(a,call)=>{
    const version=get("data_service_version",call.serviceVersionId);
    return version?.serviceId===call.serviceId&&versionOwned(a,version);
  };
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
    if(open){if(queries>=8)throw fail(429,"私有查询队列已满","PRIVATE_SERVICE_QUEUE_FULL");queries++;const query=queryTail.then(async()=>{try{return {status:200,body:await manager.invoke(open[1]==="dapis"?"DAPI":"XAPI",open[2],req.headers.authorization,Object.fromEntries(url.searchParams),{assertAccess:input=>{
      pilot?.assertService(input.service);pilot?.assertApplication(input.application);assertApplicationVersion(input);
    }})};}finally{await persist();}});queryTail=query.catch(()=>{});try{return await query;}finally{queries--;}}
    const a=actor(req),owner=a.user.id;
    assertServiceMutation(pilotConfig,a,method,path,now?.()??Date.now());
    if(method==="POST")auth.requireMutation(req.headers,path);
    if(method==="GET" && path.endsWith("/task-evidence")){
      const selection=privateServiceSourceSelection(url.searchParams,true);
      if(!selection)throw fail(422,"需提供任务编号、确切包摘要及合法发布选择","INVALID_CONSUMPTION_INPUT");
      const {taskId,packageDigest,releaseId}=selection;
      const task=get("agent",taskId);
      if(!task || (a.role!=="ADMIN" && task.submittedBy!==owner))throw fail(403,"无权读取此任务消费证据");
      const releases=store.list("release",project).filter(release=>release.sourceAgentTaskId===taskId&&release.packageDigest===packageDigest&&(releaseId===undefined||release.id===releaseId));
      if(releases.some(release=>!manualReleaseOwned(a,release)))throw fail(403,"人工消费记录仅属于原任务工程师和发布者");
      return {status:200,body:await privateTaskConsumption({taskId,packageDigest,releaseId,
        getPackage:id=>get("delivery_package",id),
        services:manager.list().filter(s=>owned(a,s)),ownedService:id=>service(a,id),getVersion:id=>get("data_service_version",id),source:id=>{const run=source(id);sourceOwner(a,run);return run;},getRelease:id=>get("release",id),
        application:id=>get("service_app",id)?manager.application(id):undefined,calls:id=>manager.listCalls(id).filter(call=>callOwned(a,call)),recheckCall:(id,callId)=>{
          const call=get("service_call",callId);
          assertApplicationVersion({service:manager.detail(id),application:get("service_app",call?.applicationId),version:get("data_service_version",call?.serviceVersionId)});
          return manager.recheckCall(id,callId);
        }})};
    }
    if(path.endsWith("/sources")){
      const selection=privateServiceSourceSelection(url.searchParams);if(!selection)throw fail(422,"发布来源选择不完整");
      const {taskId,packageDigest,releaseId}=selection,selected=releaseId&&get("release",releaseId);
      if(selected&&selected.sourceAgentTaskId===taskId&&selected.packageDigest===packageDigest&&!manualReleaseOwned(a,selected))throw fail(403,"人工发布仅属于原任务工程师和发布者");
      const rows=[];for(const r of store.list("release_run",project)){try {const run=source(r.id);sourceOwner(a,run);const release=get("release",run.releaseId);
        if(taskId&&release.sourceAgentTaskId!==taskId||packageDigest&&run.packageDigest!==packageDigest||releaseId&&run.releaseId!==releaseId)continue;
        const sourceInfo=get("delivery_package",run.packageId).manifest.source;
        rows.push({id:run.id,releaseId:run.releaseId,sourceAgentTaskId:release.sourceAgentTaskId,sourceKind:release.sourceKind??"AGENT",scope:"PRIVATE_CLOUD_TEST",
          sourceRevisionId:sourceInfo.revisionId,sourceRunId:sourceInfo.runId,
          ...(release.sourceKind==="MANUAL"?{sourceAttribution:"ENGINEER_ASSISTED"}:{}),agentIndependentE2E:false,
          status:run.status,published:run.published,schedulerTriggered:run.schedulerTriggered,engine:run.engine,engineVersion:run.engineVersion,mainSqlExecuted:run.mainSqlExecuted,testSqlValidation:{passed:true},validation:{passed:true},packageDigest:run.packageDigest,sequence:run.sequence,createdAt:run.createdAt,rowCount:run.rows.length});}catch(e){if(![403,409,422].includes(e.status))throw e;}}
      return {status:200,body:rows};
    }
    if(method==="GET" && /\/data-services\/(dapis|xapis)$/.test(path))return {status:200,body:manager.list(path.endsWith("dapis")?"DAPI":"XAPI").filter(s=>owned(a,s))};
    if(method==="GET" && path.endsWith("/applications"))return {status:200,body:manager.listApplications().filter(s=>owned(a,s))};
    if(method==="GET" && path.endsWith("/calls") && !path.match(new RegExp(`/${uuid}/calls$`))){const id=url.searchParams.get("service_id");if(id)service(a,id);return {status:200,body:manager.listCalls(id??undefined).filter(c=>owned(a,get("data_service",c.serviceId))&&callOwned(a,c))};}
    const key=req.headers["idempotency-key"];
    const dedup=(namespace,b,create)=>{if(typeof key!=="string"||key.length<1||key.length>100)throw fail(422,"缺少幂等键");return store.deduplicate(`${project}:private-service:${owner}:${namespace}:${key}`,serviceHash(b),create);};
    if(method==="POST" && path.endsWith("/applications")){
      const b=bodyKeys(await readBody(req),["name","serviceIds"]);if(!Array.isArray(b.serviceIds))throw fail(422,"授权服务列表无效");for(const id of b.serviceIds)service(a,id);
      let issued;const record=dedup("app",b,()=>{pilot?.assertApplicationCreate(b);issued=manager.createApplication(b,{expiresAt:pilot?.applicationTags.expiresAt});return store.update("service_app",issued.application.id,project,{createdBy:owner,...pilot?.applicationTags});});
      if(record.replayed)return {status:200,body:{application:manager.application(record.id),token:null,tokenShownOnce:false}};
      return {status:201,body:{...issued,application:manager.application(record.id)}};
    }
    const app=path.match(new RegExp(`^/api/v2/data-services/applications/(${uuid})/revoke$`));
    if(app){const application=requireOwned(a,manager.application(app[1]));pilot?.assertApplication(application);bodyKeys(await readBody(req),[]);return {status:200,body:manager.revokeApplication(app[1])};}
    if(method==="POST" && /\/data-services\/(dapis|xapis)$/.test(path)){
      const type=path.endsWith("dapis")?"DAPI":"XAPI",b=await readBody(req);checkInput(a,type,b);
      const d=dedup(type,b,()=>{pilot?.assertCreate(type,b);const s=type==="DAPI"?manager.createDapi(b):manager.createXapi(b);return store.update("data_service",s.id,project,{createdBy:owner,scope:"PRIVATE_CLOUD_TEST",...pilot?.recordTags});});return {status:d.replayed?200:201,body:manager.detail(d.id)};
    }
    const match=path.match(new RegExp(`^/api/v2/data-services/(dapis|xapis)/(${uuid})(?:/(versions|test|publish|activate|openapi|calls|recovery|history))?$`));
    if(match){const type=match[1]==="dapis"?"DAPI":"XAPI",s=service(a,match[2]),action=match[3];if(s.serviceType!==type)throw fail(404,"服务类型不匹配");
      if(method!=="GET")pilot?.assertService(s);
      if(method==="GET" && action==="history")return {status:200,body:store.list("service_version_switch",project).filter(r=>r.serviceId===s.id)};
      if(method==="GET" && action==="recovery")return {status:200,body:privateServiceRecovery({
        service:s,bootId,businessStore,source,ownedService:id=>service(a,id),
        getVersion:id=>get("data_service_version",id),
        applications:manager.listApplications().filter(app=>owned(a,app)&&app.serviceIds.includes(s.id)),
        calls:manager.listCalls(s.id).filter(call=>callOwned(a,call)),
      })};
      if(method==="GET")return {status:200,body:action==="openapi"?manager.openApi(s.id,origin??"/"):action==="calls"?manager.listCalls(s.id).filter(call=>callOwned(a,call)):s};
      const b=await readBody(req);
      assertServiceMutation(pilotConfig,a,method,path,now?.()??Date.now());
      if(action==="versions"){checkInput(a,type,b,true);const d=dedup(`${type}:${s.id}:version`,b,()=>type==="DAPI"?manager.createDapiVersion(s.id,b):manager.createXapiVersion(s.id,b));return {status:d.replayed?200:201,body:get("data_service_version",d.id)};}
      if(action==="test")return {status:200,body:await manager.test(s.id,b)};
      if(action==="publish")return {status:200,body:publishServiceReviewed(manager,s.id,b)};
      if(action==="activate"){
        return {status:200,body:activateServiceReviewed({manager,store,project,serviceId:s.id,actorId:owner,key,body:b})};
      }
    }
    throw fail(404,"接口不存在");
  }
  return {handle,manager};
}
