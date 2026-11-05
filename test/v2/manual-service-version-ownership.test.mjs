// Memory-only service snapshots and synthetic release receipts. No cloud/model/Spark.
import test from "node:test";
import assert from "node:assert/strict";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { createPrivateDataServices } from "../../src/v2/private-data-services.mjs";
import { createDeliveryPackage, sha256 } from "../../src/v2/delivery.mjs";
import { saveManualRevision } from "../../src/v2/manual-revisions.mjs";
import { getContext, referenceSqlForContext, validationFamilyForContext } from "../../src/v2/context.mjs";

function fixture(t) {
  const project="synthetic-manual-version-owner",store=new MetadataStore(":memory:"),businessStore=new BusinessQueryStore(":memory:");
  t.after(()=>{businessStore.close();store.close();});
  const owner=store.create("auth_user",project,{status:"ACTIVE"}),other=store.create("auth_user",project,{status:"ACTIVE"});
  const contextId="stock-cash-t1",family=validationFamilyForContext(contextId),validation={passed:true,contractId:family.id,
    regressions:family.contextIds.map(contextId=>({contextId,passed:true}))};
  const agent=store.create("agent",project,{submittedBy:owner.id,status:"FAILED",language:"SPARK_SQL",contextId,executionMode:"DURABLE_SQL_AGENT_V1",usedTokens:18000,attempts:[{status:"VALIDATION_FAILED"}]});
  let serial=0;
  const source=manual=>{
    const sql=referenceSqlForContext(contextId)+`\n-- synthetic source ${++serial}`;
    const revision=manual?saveManualRevision({store,project,actor:owner.id,key:`source-${serial}`,sql,contextId,originAgentTaskId:agent.id}).revision:
      store.create("revision",project,{sql,hash:sha256(sql),contextId});
    const sourceRun=store.create("run",project,{revisionId:revision.id,revisionHash:revision.hash,contextId,validationContractId:family.id,
      status:"SUCCEEDED",engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,isolation:"FUNCTION_PROCESS",validation,rows:getContext(contextId).expected});
    const bundle=store.create("delivery_package",project,{...createDeliveryPackage({run:sourceRun,revision}),sourceRunId:sourceRun.id,
      ...(manual?{sourceKind:"MANUAL",agentIndependentE2E:false}:{})});
    const attribution=manual?{sourceKind:"MANUAL",sourceAttribution:"ENGINEER_ASSISTED",agentIndependentE2E:false,sourceRunId:sourceRun.id,submittedBy:owner.id}:{};
    const approval=store.create("release_approval",project,{...attribution,status:"APPROVED",packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revision.id,sourceCodeHash:revision.hash});
    const release=store.create("release",project,{...attribution,sourceAgentTaskId:agent.id,sourceRevisionId:revision.id,sourceCodeHash:revision.hash,
      mode:"DURABLE_PRIVATE_RELEASE_V1",scope:"PRIVATE_CLOUD_TEST",status:"COMPLETED_CLOUD_TEST",health:"HEALTHY",packageId:bundle.id,
      packageDigest:bundle.digest,approvalId:approval.id,publicDeployed:false});
    const run=store.create("release_run",project,{...attribution,sourceAgentTaskId:agent.id,releaseId:release.id,mode:release.mode,scope:release.scope,
      status:"SUCCEEDED",published:true,publicDeployed:false,schedulerTriggered:true,clockMode:"FC_TIMER",engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,
      packageId:bundle.id,packageDigest:bundle.digest,rows:sourceRun.rows,validation,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files["tests.sql"])}});
    return {run,release,bundle};
  };
  const manual=source(true),legacy=source(false);
  const api=createPrivateDataServices({store,businessStore,project,bootId:"synthetic-boot",auth:{
    sessionFromHeaders:headers=>headers["x-test-actor"]?{role:"ADMIN",user:{id:headers["x-test-actor"]}}:undefined,requireMutation:()=>{} }});
  const call=async(path,body,actorId=owner.id,extra={})=>{
    try{return await api.handle({method:body===undefined?"GET":"POST",headers:{"x-test-actor":actorId,"idempotency-key":`synthetic-${++serial}`,...extra}},
      new URL("/api/v2"+path,"http://127.0.0.1"),async()=>body);}
    catch(error){return {status:error.status??500,body:{code:error.code,message:error.message}};}
  };
  const publish=async(type,id,version)=>{
    assert.equal((await call(`/data-services/${type}/${id}/test`,{})).status,200);
    const result=await call(`/data-services/${type}/${id}/publish`,{configHash:version.configHash});assert.equal(result.status,200);return result.body.service;
  };
  const dapi=async(label,from=legacy,fields=["client_id","total_assets"])=>{
    const result=await call("/data-services/dapis",{name:`合成${label}`,slug:`synthetic-${label}`,sourceReleaseRunId:from.run.id,fields});
    assert.equal(result.status,201);return publish("dapis",result.body.id,result.body.currentVersion);
  };
  const dapiVersion=async(service,from)=>{
    const result=await call(`/data-services/dapis/${service.id}/versions`,{sourceReleaseRunId:from.run.id});assert.equal(result.status,201);return result.body;
  };
  const xapi=async(label,holdings,cash)=>{
    const result=await call("/data-services/xapis",{name:`合成${label}`,slug:`synthetic-${label}`,steps:[
      {alias:"holdings",dapiId:holdings.id,dapiVersionId:holdings.publishedVersionId},{alias:"cash",dapiId:cash.id,dapiVersionId:cash.publishedVersionId}]});
    assert.equal(result.status,201);return publish("xapis",result.body.id,result.body.currentVersion);
  };
  const application=async(service,actorId)=>{
    const result=await call("/data-services/applications",{name:"合成应用",serviceIds:[service.id]},actorId);assert.equal(result.status,201);return result.body;
  };
  const invoke=(type,service,app)=>call(`/open/${type}/${service.slug}?client_id=CLIENT-001`,undefined,null,{authorization:`Bearer ${app.token}`});
  return {project,store,owner,other,agent,manual,legacy,call,publish,dapi,dapiVersion,xapi,application,invoke};
}

test("an old other-ADMIN token cannot inherit a newly published manual DAPI; denial is audited and own revocation survives",async t=>{
  const f=fixture(t),service=await f.dapi("transition"),otherApp=await f.application(service,f.other.id),ownApp=await f.application(service,f.owner.id);
  const manual=await f.dapiVersion(service,f.manual);
  assert.equal((await f.invoke("dapis",service,otherApp)).status,200,"an unpublished manual draft must not alter the live Agent grant");
  await f.publish("dapis",service.id,manual);
  const denied=await f.invoke("dapis",service,otherApp);
  assert.equal(denied.status,403);assert.equal(denied.body.code,"MANUAL_SERVICE_APPLICATION_OWNER_REQUIRED");assert.equal(denied.body.data,undefined);
  const failure=f.store.list("service_call",f.project).at(0);
  assert.equal(failure.applicationId,otherApp.application.id);assert.equal(failure.serviceVersionId,manual.id);assert.equal(failure.outcome,"FAILED");assert.equal(failure.statusCode,403);assert.equal(failure.rowCount,0);
  assert.equal((await f.invoke("dapis",service,ownApp)).status,200);
  const apps=await f.call("/data-services/applications",undefined,f.other.id);
  assert.deepEqual(apps.body.map(app=>app.id),[otherApp.application.id]);
  assert.equal((await f.call(`/data-services/applications/${otherApp.application.id}/revoke`,{},f.other.id)).status,200);
  assert.equal((await f.invoke("dapis",service,otherApp)).status,401);
  assert.equal((await f.invoke("dapis",service,ownApp)).status,200);
});

test("switching back to Agent cannot disclose manual version, call, recovery or history records to another ADMIN",async t=>{
  const f=fixture(t),service=await f.dapi("history"),otherApp=await f.application(service,f.other.id),ownApp=await f.application(service,f.owner.id);
  const manual=await f.dapiVersion(service,f.manual);await f.publish("dapis",service.id,manual);
  const ownCall=await f.invoke("dapis",service,ownApp);assert.equal(ownCall.status,200);
  const back=await f.dapiVersion(service,f.legacy);await f.publish("dapis",service.id,back);
  assert.equal((await f.invoke("dapis",service,otherApp)).status,200,"published Agent calls remain compatible despite protected manual history");
  for(const suffix of ["","/calls","/history","/recovery","/openapi"])
    assert.equal((await f.call(`/data-services/dapis/${service.id}${suffix}`,undefined,f.other.id)).status,403,suffix);
  assert.equal((await f.call("/data-services/dapis",undefined,f.other.id)).body.some(item=>item.id===service.id),false);
  assert.equal((await f.call("/data-services/calls",undefined,f.other.id)).body.some(item=>item.serviceId===service.id),false);
  assert.equal((await f.call("/data-services/applications",undefined,f.other.id)).body.some(item=>item.id===ownApp.application.id),false);
  const visible=await f.call(`/data-services/dapis/${service.id}`);assert.equal(visible.status,200);assert.ok(visible.body.versions.some(version=>version.id===manual.id));
  assert.ok((await f.call(`/data-services/dapis/${service.id}/calls`)).body.some(item=>item.id===ownCall.body.callId));
  assert.equal((await f.call(`/data-services/dapis/${service.id}/recovery`)).status,200);
  const rollback=await f.call(`/data-services/dapis/${service.id}/activate`,{versionId:manual.id,expectedPublishedVersionId:back.id,configHash:manual.configHash});
  assert.equal(rollback.status,200);assert.equal((await f.invoke("dapis",service,otherApp)).status,403);assert.equal((await f.invoke("dapis",service,ownApp)).status,200);
});

test("XAPI invocation follows pinned children, independent of child candidates or their newly published versions",async t=>{
  const f=fixture(t),holdings=await f.dapi("holdings",f.legacy,["client_id","holding_market_value","security_count"]),
    cash=await f.dapi("cash",f.legacy,["client_id","available_cash","total_assets"]),service=await f.xapi("pinned",holdings,cash),
    otherApp=await f.application(service,f.other.id),ownApp=await f.application(service,f.owner.id);
  const mh=await f.dapiVersion(holdings,f.manual),mc=await f.dapiVersion(cash,f.manual);
  await f.publish("dapis",holdings.id,mh);await f.publish("dapis",cash.id,mc);
  assert.equal((await f.invoke("xapis",service,otherApp)).status,200,"the published XAPI still pins its Agent children");
  const manual=await f.call(`/data-services/xapis/${service.id}/versions`,{steps:[{alias:"holdings",dapiId:holdings.id,dapiVersionId:mh.id},{alias:"cash",dapiId:cash.id,dapiVersionId:mc.id}]});
  assert.equal(manual.status,201);assert.equal((await f.invoke("xapis",service,otherApp)).status,200,"an unpublished XAPI draft is not the invocation target");
  await f.publish("xapis",service.id,manual.body);
  const denied=await f.invoke("xapis",service,otherApp);assert.equal(denied.status,403);assert.equal(denied.body.data,undefined);
  assert.equal((await f.invoke("xapis",service,ownApp)).status,200);
  const bh=await f.dapiVersion(holdings,f.legacy),bc=await f.dapiVersion(cash,f.legacy);
  await f.publish("dapis",holdings.id,bh);await f.publish("dapis",cash.id,bc);
  assert.equal((await f.invoke("xapis",service,otherApp)).status,403,"latest child pointers cannot replace the XAPI's pinned manual versions");
  const unknown=f.store.get("service_app",ownApp.application.id,f.project);f.store.update("service_app",unknown.id,f.project,{createdBy:undefined});
  assert.equal((await f.invoke("xapis",service,ownApp)).status,403,"a manual application's unknown issuer fails closed");
  f.store.update("service_app",unknown.id,f.project,unknown);assert.equal((await f.invoke("xapis",service,ownApp)).status,200);
});

test("manual owner disagreement in application, manifest, release or original task cannot return snapshot rows",async t=>{
  const f=fixture(t),service=await f.dapi("owner-chain",f.manual),app=await f.application(service,f.owner.id);
  for(const [kind,id,patch] of [["service_app",app.application.id,{createdBy:undefined}],
    ["release_run",f.manual.run.id,{submittedBy:f.other.id}], ["release_run",f.manual.run.id,{sourceRunId:"synthetic-mismatched-run"}],
    ["release",f.manual.release.id,{submittedBy:f.other.id}], ["agent",f.agent.id,{submittedBy:f.other.id}],
    ["delivery_package",f.manual.bundle.id,{manifest:{...f.manual.bundle.manifest,source:{...f.manual.bundle.manifest.source,
      attribution:{...f.manual.bundle.manifest.source.attribution,actorId:f.other.id}}}}]]){
    const before=f.store.get(kind,id,f.project);f.store.update(kind,id,f.project,patch);
    const denied=await f.invoke("dapis",service,app);assert.equal(denied.status,403);assert.equal(denied.body.data,undefined);
    f.store.update(kind,id,f.project,before);
  }
  assert.equal((await f.invoke("dapis",service,app)).status,200);
});

test("a historical receipt from a non-owner application cannot mark manual consumption VERIFIED",async t=>{
  const f=fixture(t),holdings=await f.dapi("proof-holdings",f.manual,["client_id","holding_market_value","security_count"]),
    cash=await f.dapi("proof-cash",f.manual,["client_id","available_cash","total_assets"]),service=await f.xapi("proof",holdings,cash),app=await f.application(service,f.owner.id);
  assert.equal((await f.invoke("xapis",service,app)).status,200);
  const path="/data-services/task-evidence?"+new URLSearchParams({agent_task_id:f.agent.id,package_digest:f.manual.bundle.digest,release_id:f.manual.release.id});
  assert.equal((await f.call(path)).body.status,"VERIFIED");
  f.store.update("service_app",app.application.id,f.project,{createdBy:f.other.id});
  const proof=await f.call(path);assert.equal(proof.status,200);assert.equal(proof.body.status,"PENDING");
  assert.equal(proof.body.services.find(item=>item.serviceId===service.id).status,"NEEDS_ATTENTION");
  assert.equal(proof.body.services.find(item=>item.serviceId===service.id).code,"MANUAL_SERVICE_APPLICATION_OWNER_REQUIRED");
});

test("pure legacy Agent management, applications and invocation remain available to another ADMIN",async t=>{
  const f=fixture(t),service=await f.dapi("legacy-only"),app=await f.application(service,f.other.id);
  assert.equal((await f.call(`/data-services/dapis/${service.id}`,undefined,f.other.id)).status,200);
  assert.equal((await f.invoke("dapis",service,app)).status,200);
  assert.equal((await f.call(`/data-services/dapis/${service.id}/calls`,undefined,f.other.id)).status,200);
  assert.equal((await f.call(`/data-services/applications/${app.application.id}/revoke`,{},f.other.id)).status,200);
});
