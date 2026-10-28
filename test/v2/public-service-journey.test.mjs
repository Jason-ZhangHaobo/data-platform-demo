// Real HTTP/FC ingress and persistent SQLite. Saved Spark receipts below are
// synthetic; this suite is not evidence of cloud execution or external delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { createFcIngress } from '../../src/v2/fc-ingress.mjs';
import { BusinessQueryStore } from '../../src/v2/data-services.mjs';
import { createDeliveryPackage, sha256 } from '../../src/v2/delivery.mjs';
import { contextIds, referenceSql, validationContractId } from '../../src/v2/context.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'shuduo-service-journey-'));
  let store = new MetadataStore(join(directory, 'metadata.sqlite')), app, base, now = Date.now();
  const rows = [
    {client_id:'CLIENT-001',holding_market_value:'1500.00',available_cash:'300.00',total_assets:'1800.00',security_count:2},
    {client_id:'CLIENT-002',holding_market_value:'750.00',available_cash:'200.00',total_assets:'950.00',security_count:1},
  ];
  const agent = store.create('agent',PROJECT,{});
  const revision = store.create('revision',PROJECT,{sql:referenceSql,hash:sha256(referenceSql),contextId:'holdings-t1'});
  const validation = {passed:true,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:true}))};
  const savedRun = store.create('run',PROJECT,{revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,isolation:'FUNCTION_PROCESS',rows,validation});
  const bundle = store.create('delivery_package',PROJECT,createDeliveryPackage({run:savedRun,revision}));
  const approval = store.create('release_approval',PROJECT,{status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest});
  const release = store.create('release',PROJECT,{mode:'DURABLE_PRIVATE_RELEASE_V1',scope:'PRIVATE_CLOUD_TEST',status:'COMPLETED_CLOUD_TEST',health:'HEALTHY',sourceAgentTaskId:agent.id,sourceCodeHash:bundle.manifest.source.sqlHash,packageId:bundle.id,packageDigest:bundle.digest,approvalId:approval.id,publicDeployed:false});
  const run = store.create('release_run',PROJECT,{releaseId:release.id,mode:release.mode,scope:release.scope,status:'SUCCEEDED',published:true,publicDeployed:false,schedulerTriggered:true,clockMode:'FC_TIMER',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,packageId:bundle.id,packageDigest:bundle.digest,rows,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},validation});
  const plan = {taskId:agent.id,packageDigest:bundle.digest,sourceReleaseRunId:run.id,
    dapis:[{name:'虚构客户持仓查询',slug:'journey-holdings',fields:['client_id','holding_market_value','security_count'],timeoutMs:1000,rateLimitPerMinute:30},
      {name:'虚构客户现金查询',slug:'journey-cash',fields:['client_id','available_cash','total_assets'],timeoutMs:1000,rateLimitPerMinute:30}],
    xapi:{name:'虚构客户资产组合',slug:'journey-overview',timeoutMs:2000,rateLimitPerMinute:3,steps:[{alias:'holdings',dapiSlug:'journey-holdings'},{alias:'cash',dapiSlug:'journey-cash'}]},applicationName:'虚构独立消费验收'};
  const env = {V2_LOCAL_DEVELOPMENT:'false',V2_HOST:'127.0.0.1',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true',
    V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PUBLIC_ORIGIN:'https://service.example.invalid',V2_BOOTSTRAP_ADMIN_EMAIL:'owner@example.invalid',
    V2_FC_PUBLIC_WRITE_SCOPE:'SERVICE_CONSUMPTION_ONLY',V2_PUBLIC_SERVICE_PLAN:JSON.stringify(plan),
    V2_PUBLIC_SERVICE_STARTS_AT:new Date(now-1000).toISOString(),V2_PUBLIC_SERVICE_EXPIRES_AT:new Date(now+3600000).toISOString()};
  let callsToCompute = 0, ingress, readonly = false;
  const runner = async()=>{callsToCompute++;throw Error('COMPUTE_FORBIDDEN');};
  const close = async()=>{if(app){app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.businessStore.close();app=undefined;}if(store){store.close();store=undefined;}};
  t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
  const open = async()=>{
    store ??= new MetadataStore(join(directory,'metadata.sqlite'));
    ingress = createFcIngress({publicHttpEnabled:true,publicReadOnly:readonly});
    // Both stores survive controller restart; passing only metadata would use
    // the server's intentionally ephemeral test business-store default.
    app = createV2Server({root:directory,store,businessStore:new BusinessQueryStore(join(directory,'business.sqlite')),env,ingress,runner,now:()=>now,generator:runner});
    const owner=app.auth.bootstrapAdmin({email:env.V2_BOOTSTRAP_ADMIN_EMAIL,password:'SyntheticService!2026',displayName:'虚构接口管理员'});
    app.auth.bootstrapAdmin({email:'other@example.invalid',password:'SyntheticService!2026',displayName:'虚构其他管理员'});
    if(!store.get('agent',agent.id,PROJECT).submittedBy)store.update('agent',agent.id,PROJECT,{submittedBy:owner.id});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;
  };
  const identities = {};
  const call = async(path,body,{identity='owner',key='fixed-'+path,headers={}}={})=>{
    const response=await fetch(base+'/api/v2'+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(5000),
      headers:{'content-type':'application/json','x-shuduo-client':'workbench',origin:env.V2_PUBLIC_ORIGIN,'idempotency-key':key,...(identity?identities[identity]:{}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
  };
  await open();
  for(const [name,email] of [['owner',env.V2_BOOTSTRAP_ADMIN_EMAIL],['other','other@example.invalid']]){
    const logged=await call('/auth/login',{email,password:'SyntheticService!2026'},{identity:null});assert.equal(logged.status,200);
    identities[name]={cookie:logged.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':logged.body.csrfToken};
  }
  const create = async(type,body)=>{
    const made=await call(`/data-services/${type}`,body,{key:body.slug});assert.equal(made.status,201,JSON.stringify(made.body));
    const detail=made.body;
    assert.equal((await call(`/data-services/${type}/${detail.id}/test`,{})).status,200);
    const published=await call(`/data-services/${type}/${detail.id}/publish`,{configHash:detail.currentVersion.configHash});
    assert.equal(published.status,200,JSON.stringify(published.body));return published.body.service;
  };
  const services = async()=>{
    const holdings=await create('dapis',{...plan.dapis[0],sourceReleaseRunId:run.id});
    const cash=await create('dapis',{...plan.dapis[1],sourceReleaseRunId:run.id});
    const {steps,...x}=plan.xapi;
    const overview=await create('xapis',{...x,steps:[{alias:steps[0].alias,dapiId:holdings.id,dapiVersionId:holdings.publishedVersionId},{alias:steps[1].alias,dapiId:cash.id,dapiVersionId:cash.publishedVersionId}]});
    return {holdings,cash,overview};
  };
  return {call,plan,run,release,bundle,agent,services,env,
    get store(){return store;},get internalHeaders(){return ingress.internalHeaders;},get app(){return app;},computeCalls:()=>callsToCompute,
    restart:async({removeScope=false}={})=>{await close();if(removeScope){delete env.V2_FC_PUBLIC_WRITE_SCOPE;readonly=true;}await open();},
    expire:()=>{now=Date.parse(env.V2_PUBLIC_SERVICE_EXPIRES_AT);}};
}

test('consumption mode rejects missing private backend flags before creating a server or store',()=>{
  const env={V2_FC_PUBLIC_WRITE_SCOPE:'SERVICE_CONSUMPTION_ONLY',V2_LOCAL_DEVELOPMENT:'false',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true'};
  for(const key of ['V2_LOCAL_DEVELOPMENT','V2_PROVISIONING_ONLY','V2_PRIVATE_SMOKE_ENABLED','V2_PRIVATE_DATA_SERVICES_ENABLED']){
    const missing={...env};delete missing[key];assert.throws(()=>createV2Server({env:missing}),/PUBLIC_SERVICE_BACKEND_REQUIRED/);
  }
});

test('service window limits the real HTTP and trusted internal channels to the selected administrator and plan',{timeout:20000},async t=>{
  const f=await fixture(t),session=(await f.call('/auth/session')).body;
  assert.equal(session.consumptionOnly,true);assert.equal(session.readOnly,false);assert.deepEqual(session.permissions,['SESSION','SERVICES']);
  assert.equal(session.consumptionTaskId,f.agent.id);assert.deepEqual(session.consumptionPlan,f.plan);
  for(const identity of [null,'other']){
    const view=(await f.call('/auth/session',undefined,{identity})).body;
    assert.equal(view.readOnly,true);assert.equal(view.consumptionPlan,undefined);
    assert.equal((await f.call('/data-services/dapis',{...f.plan.dapis[0],sourceReleaseRunId:f.run.id},{identity})).status,403);
  }
  for(const path of ['/agent/tasks','/revisions','/runs','/python/runs','/releases','/auth/invitations','/auth/password','/auth/redeem',`/agent/tasks/${f.agent.id}/publication`]){
    for(const headers of [{},f.internalHeaders]){
      const response=await f.call(path,{}, {headers});assert.equal(response.status,403,path);assert.equal(response.body.code,'PUBLIC_SERVICE_SCOPE_DENIED');
    }
  }
  const body={...f.plan.dapis[0],sourceReleaseRunId:f.run.id};
  assert.equal((await f.call('/data-services/dapis',body,{headers:{'x-csrf-token':'invalid'}})).status,403);
  assert.equal((await f.call('/data-services/dapis',body,{headers:{'x-project-id':'other'}})).status,403);
  assert.equal((await f.call('/data-services/dapis',{...body,fields:['client_id']})).status,403);
  assert.equal((await f.call('/data-services/dapis',{...body,slug:'outside-scope'})).status,403);
  assert.equal(f.store.list('data_service',PROJECT).length,0);assert.equal(f.computeCalls(),0);
});

test('same release becomes query services, pinned XAPI and one scoped expiring consumer across restart',{timeout:20000},async t=>{
  const f=await fixture(t),s=await f.services();
  const body={name:f.plan.applicationName,serviceIds:[s.holdings.id,s.overview.id]};
  const issued=await f.call('/data-services/applications',body,{key:'one-consumer'});
  assert.equal(issued.status,201);assert.equal(issued.body.application.expiresAt,f.env.V2_PUBLIC_SERVICE_EXPIRES_AT);
  const bearer={authorization:'Bearer '+issued.body.token};
  assert.ok(!JSON.stringify(f.store.list('service_app',PROJECT)).includes(issued.body.token));
  const replay=await f.call('/data-services/applications',body,{key:'one-consumer'});
  assert.equal(replay.status,200);assert.equal(replay.body.token,null);
  assert.equal((await f.call('/data-services/applications',body,{key:'cannot-reissue'})).status,403);
  for(const action of ['versions','activate'])assert.equal((await f.call(`/data-services/dapis/${s.holdings.id}/${action}`,{})).status,403);
  await f.restart();
  const queried=await f.call('/open/xapis/journey-overview?page=1&page_size=1',undefined,{identity:null,headers:bearer});
  assert.equal(queried.status,200,JSON.stringify(queried.body));assert.deepEqual(queried.body.data,[{client_id:'CLIENT-001',holdings:{holding_market_value:'1500.00',security_count:2},cash:{available_cash:'300.00',total_assets:'1800.00'}}]);
  assert.equal(queried.body.service.versionId,s.overview.publishedVersionId);
  assert.deepEqual(queried.body.service.steps,[{alias:'holdings',dapiId:s.holdings.id,dapiVersionId:s.holdings.publishedVersionId},{alias:'cash',dapiId:s.cash.id,dapiVersionId:s.cash.publishedVersionId}]);
  const page2=await f.call('/open/xapis/journey-overview?page=2&page_size=1',undefined,{identity:null,headers:bearer});
  assert.equal(page2.status,200);assert.equal(page2.body.data[0].client_id,'CLIENT-002');assert.equal(page2.body.data[0].cash.total_assets,'950.00');
  assert.equal((await f.call('/open/xapis/journey-overview?client_id=CLIENT-001',undefined,{identity:null,headers:bearer})).status,200);
  assert.equal((await f.call('/open/xapis/journey-overview',undefined,{identity:null,headers:bearer})).status,429);
  assert.equal((await f.call('/open/dapis/journey-cash',undefined,{identity:null,headers:bearer})).status,403);
  assert.equal((await f.call('/open/dapis/journey-holdings?page_size=101',undefined,{identity:null,headers:bearer})).status,400);
  assert.equal((await f.call('/open/dapis/journey-holdings',undefined,{identity:null})).status,401);
  const holdings=await f.call('/open/dapis/journey-holdings',undefined,{identity:null,headers:bearer});
  assert.equal(holdings.status,200);assert.deepEqual(holdings.body.data[0],{client_id:'CLIENT-001',holding_market_value:'1500.00',security_count:2});
  const logs=(await f.call('/data-services/calls')).body;
  assert.ok(logs.some(c=>c.outcome==='RATE_LIMITED'));assert.ok(logs.some(c=>c.id===queried.body.callId&&c.serviceVersionId===s.overview.publishedVersionId));
  assert.ok(!JSON.stringify(logs).includes(issued.body.token));
  const evidence=`/data-services/task-evidence?agent_task_id=${f.agent.id}&package_digest=${f.bundle.digest}`;
  assert.equal((await f.call(evidence)).body.status,'VERIFIED');
  f.expire();assert.equal((await f.call('/auth/session')).body.readOnly,true);
  assert.equal((await f.call('/open/dapis/journey-holdings',undefined,{identity:null,headers:bearer})).body.code,'TOKEN_EXPIRED');
  assert.equal((await f.call('/data-services/applications')).body[0].status,'EXPIRED');
  assert.equal((await f.call(evidence)).body.services.find(x=>x.serviceId===s.overview.id).call.applicationStatus,'EXPIRED');
  const revoke=`/data-services/applications/${issued.body.application.id}/revoke`;
  assert.equal((await f.call(revoke,{}, {identity:'other'})).status,403);
  assert.equal((await f.call(revoke,{})).status,200,'selected admin may clean up after window expiry');
  await f.restart({removeScope:true});
  assert.equal((await f.call('/auth/session')).body.readOnly,true);
  assert.equal((await f.call('/open/xapis/journey-overview',undefined,{identity:null,headers:bearer})).status,401);
  assert.equal((await f.call(evidence)).body.status,'VERIFIED');
  assert.equal(f.store.list('service_app',PROJECT).length,1);assert.equal(f.computeCalls(),0);
});

test('temporary consumer expiry survives removing the rollout config without manual revocation',{timeout:20000},async t=>{
  const f=await fixture(t),s=await f.services();
  const issued=await f.call('/data-services/applications',{name:f.plan.applicationName,serviceIds:[s.overview.id]});
  assert.equal(issued.status,201);f.expire();await f.restart({removeScope:true});
  const denied=await f.call('/open/xapis/journey-overview',undefined,{identity:null,headers:{authorization:'Bearer '+issued.body.token}});
  assert.equal(denied.status,401);assert.equal(denied.body.code,'TOKEN_EXPIRED');assert.equal(f.computeCalls(),0);
});

test('an issued consumer cannot borrow a service whose source task changed',{timeout:20000},async t=>{
  const f=await fixture(t),s=await f.services();
  const issued=await f.call('/data-services/applications',{name:f.plan.applicationName,serviceIds:[s.holdings.id,s.overview.id]});
  assert.equal(issued.status,201);
  f.store.update('release',f.release.id,PROJECT,{sourceAgentTaskId:'00000000-0000-4000-8000-000000000099'});
  const denied=await f.call('/open/xapis/journey-overview',undefined,{identity:null,headers:{authorization:'Bearer '+issued.body.token}});
  assert.equal(denied.status,403);assert.equal(denied.body.code,'PUBLIC_SERVICE_TARGET_MISMATCH');assert.equal(denied.body.data,undefined);
  assert.equal(f.computeCalls(),0);
});
