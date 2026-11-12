import { DataServiceManager, serviceHash, serviceVersionConfigValid } from "./data-services.mjs";
import { readPrivateReleaseBatch } from "./private-release-source.mjs";
import {servicePlanSourceBinding,servicePlanSourceQuery} from './service-plan-request.mjs';
import {getContext,validationFamilyForContext} from './context.mjs';
import { privateServiceRoute, privateServiceSourceSelection } from "./private-service-routes.mjs";
import { privateServiceRecovery } from "./private-service-recovery.mjs";
import { publishServiceReviewed, activateServiceReviewed } from "./service-version-governance.mjs";
import { privateTaskConsumption } from "./private-task-consumption.mjs";
import { createServicePilotGuard, assertServiceMutation } from "./public-service-access.mjs";
import {createDurableServiceAgent} from './durable-service-agent.mjs';
import {assertServiceAgentMutation} from './private-service-agent-policy.mjs';
const uuid="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const fail=(status,message,code="PRIVATE_SERVICE_ACCESS_DENIED")=>Object.assign(new Error(message),{status,code});

// One shared allowlist for the private transport, temporary preview and router.
export { privateServiceRoute } from "./private-service-routes.mjs";

export function createPrivateDataServices({store,businessStore,project,auth,now,origin,bootId,pilotConfig,persist=async()=>{},
  agentConfig,planner,assertModelBudget=()=>{throw Error('Model budget not configured');},budgetOverview=()=>{throw Error('Budget not configured');},modelLeaseMs,waitForModel,backgroundView,dispatchPlan,cancelPlan}) {
  const get=(kind,id)=>typeof id==="string"?store.get(kind,id,project):undefined;
  const source=id=>readPrivateReleaseBatch(store,project,id).batch;
  const manager=new DataServiceManager({store,businessStore,project,scope:"PRIVATE_CLOUD_TEST",releaseRunFor:source,verifySource:run=>source(run?.id),now});
  const pilot = pilotConfig ? createServicePilotGuard({config:pilotConfig,store,project,source,detail:id=>manager.detail(id),now}) : undefined;
  const actor=req=>{const a=auth.sessionFromHeaders(req.headers);if(!a)throw fail(401,"请先登录受邀账号","AUTHENTICATION_REQUIRED");return a;};
  const manualReleaseOwned=(a,release)=>{
    const bundle=get("delivery_package",release?.packageId),origin=bundle?.manifest?.source,attribution=origin?.attribution;
    if(!release||!bundle)return false;
    const manual=attribution!==undefined||[release,bundle].some(item=>item.sourceKind==="MANUAL"||item.sourceAttribution==="ENGINEER_ASSISTED");
    if(!manual)return [undefined,"AGENT"].includes(release.sourceKind)&&[undefined,"AGENT"].includes(bundle.sourceKind);
    if(attribution?.kind==='ENGINEER_AUTHORED')return Boolean(a?.user?.id&&attribution.actorId===a.user.id&&release.submittedBy===a.user.id&&release.manualDeliveryTaskId===bundle.manualDeliveryTaskId&&release.sourceAgentTaskId===undefined&&get('manual_delivery_task',release.manualDeliveryTaskId)?.submittedBy===a.user.id&&release.sourceKind==='MANUAL'&&release.sourceAttribution==='ENGINEER_AUTHORED'&&release.agentIndependentE2E===false&&bundle.digest===release.packageDigest&&bundle.sourceRunId===origin.runId&&release.sourceRunId===origin.runId&&release.sourceRevisionId===origin.revisionId&&release.sourceCodeHash===origin.sqlHash);
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
      if(release.manualDeliveryTaskId)return run.sourceKind==='MANUAL'&&run.sourceAttribution==='ENGINEER_AUTHORED'&&run.agentIndependentE2E===false&&run.submittedBy===a?.user?.id&&run.manualDeliveryTaskId===release.manualDeliveryTaskId&&run.sourceAgentTaskId===undefined&&run.sourceRunId===release.sourceRunId;
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
  const sourceOwner=(a,run)=>{const release=get("release",run.releaseId),task=get(release.manualDeliveryTaskId?"manual_delivery_task":"agent",release.manualDeliveryTaskId??release.sourceAgentTaskId);if(!task || (a.role!=="ADMIN" && task.submittedBy!==a.user.id)||!manualReleaseOwned(a,release))throw fail(403,"无权使用该发布批次");};
  // This is a read-only authority adapter, not a model execution grant. Keep it
  // behind the same source/ownership checks as manual service development.
  const agentContext=(a,input)=>{
    const binding=servicePlanSourceBinding(input),run=source(binding.sourceReleaseRunId),release=get('release',run.releaseId);
    sourceOwner(a,run);
    if(run.releaseId!==binding.releaseId||run.packageDigest!==binding.packageDigest||(binding.manualDeliveryTaskId?release.manualDeliveryTaskId!==binding.manualDeliveryTaskId||release.sourceAgentTaskId!==undefined:release.sourceAgentTaskId!==binding.taskId||release.manualDeliveryTaskId!==undefined))
      throw fail(409,'发布批次与所选任务、交付包或发布不一致','SERVICE_PLAN_SOURCE_MISMATCH');
    if(pilotConfig&&((binding.manualDeliveryTaskId?pilotConfig.plan.manualDeliveryTaskId!==binding.manualDeliveryTaskId||pilotConfig.plan.taskId!==undefined:pilotConfig.plan.taskId!==binding.taskId||pilotConfig.plan.manualDeliveryTaskId!==undefined)||pilotConfig.plan.packageDigest!==binding.packageDigest||pilotConfig.plan.sourceReleaseRunId!==run.id))
      throw fail(403,'上下文不属于当前限定消费来源','PUBLIC_SERVICE_TARGET_MISMATCH');
    const bundle=get('delivery_package',run.packageId),origin=bundle.manifest.source,context=getContext(origin.contextId),family=validationFamilyForContext(origin.contextId);
    // getContext has a legacy default. A missing/unregistered manifest context
    // must never acquire that default or borrow a mutable Agent context instead.
    if(typeof origin.contextId!=='string'||context.id!==origin.contextId||family?.id!==origin.validationContractId||!family?.contextIds.includes(context.id))
      throw fail(409,'发布包业务口径未登记或与独立断言契约不一致','SERVICE_PLAN_CONTEXT_UNAVAILABLE');
    const available=[];let unavailableServiceCount=0;
    for(const item of store.list('data_service',project)){
      if(item.serviceType!=='DAPI'||item.scope!=='PRIVATE_CLOUD_TEST'||item.status!=='PUBLISHED'||!owned(a,item))continue;
      const version=get('data_service_version',item.publishedVersionId);
      if(!version||version.sourceReleaseRunId!==run.id||version.sourceReleaseId!==release.id||version.sourcePackageDigest!==binding.packageDigest)continue;
      const snapshot=businessStore.snapshotEvidence(version.snapshotId);
      if(version.serviceId!==item.id||version.status!=='PUBLISHED'||!versionOwned(a,version)||!serviceVersionConfigValid(version)||
        version.snapshotId!==`release-run:${run.id}`||!snapshot?.integrityVerified||snapshot.contentHash!==version.snapshotHash||
        !Array.isArray(version.fields)||version.fields.length<1||version.fields.length>5||new Set(version.fields).size!==version.fields.length||
        version.fields.some(field=>!['client_id','holding_market_value','available_cash','total_assets','security_count'].includes(field))){unavailableServiceCount++;continue;}
      available.push({id:item.id,name:item.name,slug:item.slug,serviceType:'DAPI',status:'PUBLISHED',publishedVersion:{id:version.id,configHash:version.configHash,fields:[...version.fields]}});
    }
    const services=available.sort((a,b)=>a.id.localeCompare(b.id)).slice(0,100);
    return {protocol:'shuduo-service-agent-context/v1',scope:'PRIVATE_CLOUD_TEST',sourceBinding:binding,sourceKind:release.sourceKind??'AGENT',
      ...(release.sourceKind==='MANUAL'?{sourceAttribution:binding.manualDeliveryTaskId?'ENGINEER_AUTHORED':'ENGINEER_ASSISTED'}:{}),
      sourceContext:{id:context.id,name:context.name,definition:context.definition,validationContractId:family.id,metricLabels:family.metricLabels},
      releaseRuns:[{id:run.id,releaseId:release.id,packageDigest:binding.packageDigest,...(binding.manualDeliveryTaskId?{manualDeliveryTaskId:binding.manualDeliveryTaskId}:{sourceAgentTaskId:binding.taskId}),sourceRevisionId:origin.revisionId,sourceRunId:origin.runId,
        scope:'PRIVATE_CLOUD_TEST',sourceKind:release.sourceKind??'AGENT',status:run.status,published:true,schedulerTriggered:true,engine:run.engine,engineVersion:run.engineVersion}],
      services,resourceVersions:services.map(item=>({serviceId:item.id,versionId:item.publishedVersion.id,configHash:item.publishedVersion.configHash,fields:[...item.publishedVersion.fields]})),
      resourcesTruncated:available.length>100,unavailableServiceCount,planning:{enabled:false,code:'PRIVATE_SERVICE_AGENT_EXECUTION_NOT_ENABLED'},agentIndependentE2E:false,publicDeployed:false};
  };
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
  const identity=id=>{const user=get('auth_user',id);return {user,role:user?.memberships?.find(item=>item.projectId===project)?.role};};
  const assertPlanVersions=(actorId,binding,refs,current)=>{
    const a=identity(actorId);
    if(!Array.isArray(refs)||refs.length>100||new Set(refs.map(ref=>ref?.serviceId)).size!==refs.length)throw fail(409,'原规划固定版本记录不完整','SERVICE_PLAN_VERSION_CHANGED');
    for(const ref of refs){
      const item=get('data_service',ref?.serviceId),v=get('data_service_version',ref?.versionId),snapshot=v&&businessStore.snapshotEvidence(v.snapshotId);
      if(!item||!owned(a,item)||item.serviceType!=='DAPI'||!v||v.serviceId!==item.id||!versionOwned(a,v)||!serviceVersionConfigValid(v)||
        v.sourceReleaseRunId!==binding.sourceReleaseRunId||v.sourceReleaseId!==binding.releaseId||v.sourcePackageDigest!==binding.packageDigest||v.configHash!==ref.configHash||
        serviceHash(v.fields)!==serviceHash(ref.fields)||!snapshot?.integrityVerified||snapshot.contentHash!==v.snapshotHash||
        current&&(item.status!=='PUBLISHED'||item.publishedVersionId!==v.id||v.status!=='PUBLISHED'))throw fail(409,'原规划DAPI固定版本、权限或快照已经变化','SERVICE_PLAN_VERSION_CHANGED');
    }
  };
  const agentPlanner=createDurableServiceAgent({store,project,config:agentConfig,now,modelLeaseMs,persist,planner,waitForModel,backgroundView,assertBudget:assertModelBudget,budgetOverview,
    contextFor:(actorId,binding)=>agentContext(identity(actorId),binding),assertVersions:assertPlanVersions,validateProposal:value=>manager.validateAgentPlan(value),
    createDraft:(proposal,actorId)=>{
      const {serviceType,...body}=proposal;checkInput(identity(actorId),serviceType,body);
      const made=serviceType==='DAPI'?manager.createDapi(body):manager.createXapi(body);
      return store.update('data_service',made.id,project,{createdBy:actorId,scope:'PRIVATE_CLOUD_TEST'});
    },draftDetail:(id,actorId)=>service(identity(actorId),id)});
  async function readTaskEvidence(req, params, verifySavedRelease) {
    const a = actor(req), owner = a.user.id;
    const selection = privateServiceSourceSelection(params, true);
    if (!selection || (verifySavedRelease && (!selection.taskId || !selection.releaseId)))
      throw fail(422, "需提供任务编号、确切包摘要及合法发布选择", "INVALID_CONSUMPTION_INPUT");
    const { taskId, manualDeliveryTaskId, packageDigest, releaseId, callIdDigest } = selection;
    const task = get(manualDeliveryTaskId ? "manual_delivery_task" : "agent", manualDeliveryTaskId ?? taskId);
    if (!task || ((manualDeliveryTaskId || verifySavedRelease || a.role !== "ADMIN") && task.submittedBy !== owner))
      throw fail(403, "无权读取此任务消费证据");
    const releases = store.list("release", project).filter(release =>
      (manualDeliveryTaskId
        ? release.manualDeliveryTaskId === manualDeliveryTaskId && release.sourceAgentTaskId === undefined
        : release.sourceAgentTaskId === taskId && release.manualDeliveryTaskId === undefined) &&
      release.packageDigest === packageDigest && (releaseId === undefined || release.id === releaseId));
    if (releases.some(release => !manualReleaseOwned(a, release)))
      throw fail(403, "人工消费记录仅属于原任务工程师和发布者");
    if (verifySavedRelease) {
      if (releases.length !== 1) throw fail(409, "原发布与所选消费来源不一致", "CONSUMPTION_PUBLICATION_UNCONFIRMED");
      verifySavedRelease(taskId, releases[0], owner);
    }
    return privateTaskConsumption({ taskId, manualDeliveryTaskId, packageDigest, releaseId, callIdDigest,
      getPackage: id => get("delivery_package", id),
      services: manager.list().filter(item => owned(a, item)), ownedService: id => service(a, id),
      getVersion: id => get("data_service_version", id),
      source: id => { const run = source(id); sourceOwner(a, run); return run; }, getRelease: id => get("release", id),
      application: id => get("service_app", id) ? manager.application(id) : undefined,
      calls: id => manager.listCalls(id).filter(call => callOwned(a, call)),
      recheckCall: (id, callId, options) => {
        const call = get("service_call", callId);
        assertApplicationVersion({ service: manager.detail(id), application: get("service_app", call?.applicationId),
          version: get("data_service_version", call?.serviceVersionId) });
        return manager.recheckCall(id, callId, options);
      },
    });
  }
  let queryTail=Promise.resolve(),queries=0;
  async function handle(req,url,readBody) {
    const method=req.method,path=url.pathname;
    if(!privateServiceRoute(method,url.pathname+url.search,{agentRead:true,agentPlanning:Boolean(agentConfig)}))throw fail(404,"私有数据服务接口未开放");
    const open=path.match(/^\/api\/v2\/open\/(dapis|xapis)\/([a-z][a-z0-9-]{2,47})$/);
    if(open){if(queries>=8)throw fail(429,"私有查询队列已满","PRIVATE_SERVICE_QUEUE_FULL");queries++;const query=queryTail.then(async()=>{try{return {status:200,body:await manager.invoke(open[1]==="dapis"?"DAPI":"XAPI",open[2],req.headers.authorization,Object.fromEntries(url.searchParams),{assertAccess:input=>{
      pilot?.assertService(input.service);pilot?.assertApplication(input.application);assertApplicationVersion(input);
    }})};}finally{await persist();}});queryTail=query.catch(()=>{});try{return await query;}finally{queries--;}}
    const a=actor(req),owner=a.user.id;
    assertServiceMutation(pilotConfig,a,method,path,now?.()??Date.now());
    assertServiceAgentMutation(agentConfig,a,method,path);
    if(method==="POST")auth.requireMutation(req.headers,path);
    if(method==='GET'&&path==='/api/v2/data-services/agent/context')return {status:200,body:agentContext(a,servicePlanSourceQuery(url.searchParams))};
    if(path==='/api/v2/data-services/agent/plans'){
      if(method==='GET')return {status:200,body:agentPlanner.list(servicePlanSourceQuery(url.searchParams),owner)};
      const b=bodyKeys(await readBody(req),['message','sourceBinding']);return {status:202,body:await agentPlanner.create({...b,actorId:owner,requestId:req.headers['idempotency-key']})};
    }
    const planRequest=path.match(new RegExp(`^/api/v2/data-services/agent/requests/(${uuid})$`));
    if(planRequest&&method==='GET')return {status:200,body:agentPlanner.request(planRequest[1],owner)};
    const planPath=path.match(new RegExp(`^/api/v2/data-services/agent/plans/(${uuid})(?:/(advance|apply|cancel))?$`));
    if(planPath){
      const id=planPath[1],action=planPath[2];
      if(method==='GET'&&!action)return {status:200,body:agentPlanner.read(id,owner)};
      const b=await readBody(req);
      if(action==='advance'){bodyKeys(b,['expectedVersion','confirmModelRetry']);if(agentConfig?.driver==='OSS_EVENTS'&&!dispatchPlan)throw fail(503,'受控事件驱动未就绪');return {status:agentConfig?.driver==='OSS_EVENTS'?202:200,body:await(dispatchPlan?dispatchPlan(id,owner,b):agentPlanner.advance(id,owner,b))};}
      if(action==='apply'){bodyKeys(b,['proposalHash']);return {status:200,body:await agentPlanner.apply(id,owner,b.proposalHash)};}
      if(action==='cancel'){bodyKeys(b,['sourceBoundOnly']);if(b.sourceBoundOnly!==undefined&&b.sourceBoundOnly!==true)throw fail(422,'仅可取消原同源规划');return {status:200,body:await(cancelPlan?cancelPlan(id,owner):agentPlanner.cancel(id,owner))};}
    }
    if(method==="GET" && path.endsWith("/task-evidence"))
      return {status:200,body:await readTaskEvidence(req,url.searchParams)};
    if(path.endsWith("/sources")){
      const selection=privateServiceSourceSelection(url.searchParams);if(!selection)throw fail(422,"发布来源选择不完整");
      const {taskId,manualDeliveryTaskId,packageDigest,releaseId}=selection,selected=releaseId&&get("release",releaseId);
      if(selected&&(manualDeliveryTaskId?selected.manualDeliveryTaskId===manualDeliveryTaskId:selected.sourceAgentTaskId===taskId)&&selected.packageDigest===packageDigest&&!manualReleaseOwned(a,selected))throw fail(403,"人工发布仅属于原任务工程师和发布者");
      const rows=[];for(const r of store.list("release_run",project)){try {const run=source(r.id);sourceOwner(a,run);const release=get("release",run.releaseId);
        if(manualDeliveryTaskId&&(release.manualDeliveryTaskId!==manualDeliveryTaskId||release.sourceAgentTaskId!==undefined)||taskId&&(release.sourceAgentTaskId!==taskId||release.manualDeliveryTaskId!==undefined)||packageDigest&&run.packageDigest!==packageDigest||releaseId&&run.releaseId!==releaseId)continue;
        const sourceInfo=get("delivery_package",run.packageId).manifest.source;
        rows.push({id:run.id,releaseId:run.releaseId,...(release.manualDeliveryTaskId?{manualDeliveryTaskId:release.manualDeliveryTaskId}:{sourceAgentTaskId:release.sourceAgentTaskId}),sourceKind:release.sourceKind??"AGENT",scope:"PRIVATE_CLOUD_TEST",
          sourceRevisionId:sourceInfo.revisionId,sourceRunId:sourceInfo.runId,sourceRevisionHash:sourceInfo.sqlHash,
          ...(release.sourceKind==="MANUAL"?{sourceAttribution:release.sourceAttribution}:{}),agentIndependentE2E:false,
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
  return {handle,manager,agentPlanner,readTaskEvidence};
}
