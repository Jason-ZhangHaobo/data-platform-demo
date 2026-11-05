import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {durableServiceFixture} from './fixtures/durable-service-agent.mjs';
import {servicePlanSourcePath} from '../../src/v2/service-plan-request.mjs';
import {serviceAgentMonth,privateServiceAgentProfile,assertServiceAgentIngress} from '../../src/v2/private-service-agent-policy.mjs';
import {createFcIngress} from '../../src/v2/fc-ingress.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {callServicePlan} from '../../src/v2/service-plan-client.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {validatePrivateApplicationRequest,privateApplicationTimeoutMs} from '../../src/v2/private-application.mjs';

const result=(f,input,extra={})=>({plan:{serviceType:'DAPI',name:'当前股票与现金合计',slug:'synthetic-durable-assets',sourceReleaseRunId:f.run.id,fields:['client_id','total_assets']},explanation:'仅原股票与现金口径',model:'qwen3.7-plus',usage:{prompt_tokens:500,completion_tokens:200,total_tokens:700},...extra});
const planPath=id=>'/data-services/agent/plans/'+id;
const read=(f,id)=>f.call(planPath(id),undefined,f.a);
const advance=(f,p,extra={})=>f.call(planPath(p.id)+'/advance',{expectedVersion:p.version,...extra},f.a);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('a private planning profile cannot rely on a missing or writable ingress despite an env read-only flag',()=>{
 assert.throws(()=>assertServiceAgentIngress({configured:true},undefined),/PRIVATE_SERVICE_AGENT_READONLY_INGRESS_REQUIRED/);
 assert.throws(()=>assertServiceAgentIngress({configured:true},createFcIngress({publicHttpEnabled:true,publicReadOnly:false})),/PRIVATE_SERVICE_AGENT_READONLY_INGRESS_REQUIRED/);
 assert.doesNotThrow(()=>assertServiceAgentIngress({configured:true},createFcIngress({publicHttpEnabled:true,publicReadOnly:true})));
 assert.doesNotThrow(()=>assertServiceAgentIngress(undefined,undefined));
});

test('durable private plan is queued without compute, recovered by original request, generated once and applied to one private draft',async t=>{
 const f=await durableServiceFixture(t,{manual:true}),parent=structuredClone(f.store.get('agent',f.agent.id,f.project)),key=randomUUID(),made=await f.create(undefined,key);assert.equal(made.status,202,JSON.stringify(made.body));const p=made.body;
 assert.equal(p.stage,'READY_FOR_MODEL');assert.equal(f.counts().calls,0);assert.equal(p.sourceAttribution,'ENGINEER_ASSISTED');
 assert.equal(p.requestedModel,'qwen3.7-plus');assert.equal(p.executionWindow.expiresAt,f.profile.expiresAt);
 assert.equal((await f.create(undefined,key)).body.id,p.id);assert.equal((await f.call('/data-services/agent/requests/'+key,undefined,f.a)).body.id,p.id);
 const generated=await advance(f,p);assert.equal(generated.status,200,JSON.stringify(generated.body));const ready=generated.body;
 assert.equal(ready.status,'SUCCEEDED');assert.equal(ready.attempts.length,1);assert.equal(ready.usedTokens,700);assert.equal(ready.recovery.backgroundDispatcherVerified,false);
 assert.match(ready.proposalHash,/^[a-f0-9]{64}$/);assert.equal(ready.publicDeployed,false);assert.equal(ready.fullLifecycleE2E,false);
 const text=JSON.stringify(ready);for(const key of ['leaseToken','submittedBy','passwordHash','CLIENT-001','"rows"','queryTemplate'])assert.equal(text.includes(key),false,key);
 assert.equal((await f.call(planPath(p.id)+'/apply',{proposalHash:'f'.repeat(64)},f.a)).status,409);
 const applied=await f.call(planPath(p.id)+'/apply',{proposalHash:ready.proposalHash},f.a);assert.equal(applied.status,200,JSON.stringify(applied.body));
 assert.equal(applied.body.scope,'PRIVATE_CLOUD_TEST');assert.equal(applied.body.status,'DRAFT');assert.equal(applied.body.currentVersion.sourceReleaseRunId,f.run.id);
 const replay=await f.call(planPath(p.id)+'/apply',{proposalHash:ready.proposalHash},f.a);assert.equal(replay.body.id,applied.body.id);assert.equal(f.store.list('data_service',f.project).length,3);
 assert.equal((await read(f,p.id)).body.status,'APPLIED');assert.equal(f.counts().calls,1);assert.equal(f.counts().compute,0);assert.equal(f.store.list('service_app',f.project).length,0);
 assert.deepEqual(f.store.get('agent',f.agent.id,f.project),parent,'service planning must not rewrite original Agent attribution or failure history');
 const inputText=JSON.stringify({...f.inputs[0],signal:undefined});for(const key of ['CLIENT-001','"rows"','"sql"','queryTemplate','"files"','tokenHash'])assert.equal(inputText.includes(key),false,key);
});

test('changing a window identity in place cannot clear quotas; removing config preserves owner reads and cancellation',async t=>{
 const f=await durableServiceFixture(t),p=(await f.create()).body;
 f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE=JSON.stringify({...f.profile,maxPlans:2});const changed=await f.start();
 assert.equal((await changed.call(planPath(p.id),undefined,changed.a)).body.id,p.id);
 assert.equal((await changed.call(planPath(p.id)+'/advance',{expectedVersion:p.version},changed.a)).body.code,'SERVICE_AGENT_PROFILE_CHANGED');
 assert.equal((await changed.call('/data-services/agent/plans',{message:'不能改写原窗口额度',sourceBinding:f.sourceBinding},changed.a)).body.code,'SERVICE_AGENT_PROFILE_CHANGED');
 delete f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE;const disabled=await f.start();
 assert.equal((await disabled.call('/data-services/agent/requests/'+p.requestId,undefined,disabled.a)).body.id,p.id);
 assert.equal((await disabled.call(planPath(p.id)+'/cancel',{},disabled.a)).body.status,'CANCELLED');assert.equal(f.counts().calls,0);
});

test('stale bills and revoked membership stop before model, and contradictory usage stays conservatively reserved',async t=>{
 const f=await durableServiceFixture(t,{profilePatch:{bill:{month:serviceAgentMonth(Date.now()),observedAt:new Date(Date.now()-1800001).toISOString(),spendCny:40,unsettledReserveCny:60}}}),p=(await f.create()).body;
 assert.equal((await advance(f,p)).body.code,'SERVICE_AGENT_BILL_STALE');assert.equal(f.counts().calls,0);assert.equal((await read(f,p.id)).body.attempts.length,0);
 const revoked=await durableServiceFixture(t),queued=(await revoked.create()).body;revoked.store.update('auth_user',revoked.owner.id,revoked.project,{memberships:[{projectId:revoked.project,role:'VIEWER'}]});
 assert.equal((await advance(revoked,queued)).status,403);assert.equal(revoked.counts().calls,0);
 const usage=await durableServiceFixture(t);usage.env.V2_EXECUTION_UNAVAILABLE='true';usage.setNext(input=>result(usage,input,{usage:{total_tokens:1,completion_tokens:200,providerSecret:'DO_NOT_PERSIST'}}));
 const draft=(await usage.create()).body,generated=(await advance(usage,draft)).body;assert.equal(generated.status,'SUCCEEDED');assert.equal(generated.usedTokens,8000);assert.equal(generated.attempts[0].usageEstimated,true);assert.equal(JSON.stringify(generated).includes('DO_NOT_PERSIST'),false);
});

test('trusted bill refresh preserves the same window identity and all unknown usage rather than opening new quotas',async t=>{
 const f=await durableServiceFixture(t,{profilePatch:{expiresAt:new Date(Date.now()+3600000).toISOString()}});f.setNext(()=>{throw Error('synthetic unknown');});
 const p=(await f.create()).body,unknown=(await advance(f,p)).body,oldFingerprint=privateServiceAgentProfile(f.env).fingerprint;
 f.moveClock(1800001);assert.equal((await advance(f,unknown,{confirmModelRetry:true})).body.code,'SERVICE_AGENT_BILL_STALE');
 f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE=JSON.stringify({...f.profile,bill:{...f.profile.bill,observedAt:new Date(f.now()).toISOString(),spendCny:42}});
 assert.equal(privateServiceAgentProfile(f.env).fingerprint,oldFingerprint);const next=await f.start();f.setNext(input=>result(f,input));
 const resumed=await next.call(planPath(p.id)+'/advance',{expectedVersion:unknown.version,confirmModelRetry:true},next.a);
 assert.equal(resumed.body.status,'SUCCEEDED');assert.equal(resumed.body.attempts.length,2);assert.equal(resumed.body.usedTokens,8700);assert.equal(f.counts().calls,2);
 const changed=privateServiceAgentProfile({...f.env,V2_PRIVATE_SERVICE_AGENT_PROFILE:JSON.stringify({...f.profile,bill:{...f.profile.bill,unsettledReserveCny:0}})});
 assert.notEqual(changed.fingerprint,oldFingerprint);
 assert.notEqual(privateServiceAgentProfile({...f.env,V2_MODEL:'another-synthetic-model'}).fingerprint,oldFingerprint);
 assert.notEqual(privateServiceAgentProfile({...f.env,V2_MODEL_BASE_URL:'https://another-synthetic.invalid/v1'}).fingerprint,oldFingerprint);
 assert.throws(()=>privateServiceAgentProfile({...f.env,V2_MODEL_BASE_URL:'https://user:password@example.invalid/v1'}));
});

test('concurrent advance and readback cannot duplicate an owned model lease',async t=>{
 const f=await durableServiceFixture(t),started=deferred(),work=deferred();f.setNext(input=>{started.resolve();return work.promise;});
 const p=(await f.create()).body,pending=advance(f,p);await started.promise;const running=(await read(f,p.id)).body;
 assert.equal(running.stage,'MODEL_IN_FLIGHT');assert.equal(running.usedTokens,8000);
 const duplicate=await advance(f,running);assert.equal(duplicate.status,200);assert.equal(duplicate.body.stage,'MODEL_IN_FLIGHT');assert.equal(f.counts().calls,1);
 assert.equal((await f.call(servicePlanSourcePath(f.sourceBinding),undefined,f.a)).body.length,1);assert.equal(f.counts().calls,1);
 work.resolve(result(f));assert.equal((await pending).body.status,'SUCCEEDED');assert.equal(f.counts().calls,1);
});

test('failed durable reservation stops before model and retains the original attempt and conservative accounting',async t=>{
 const f=await durableServiceFixture(t),p=(await f.create()).body;f.failFlushAt(f.counts().flushes+1);
 const failed=await advance(f,p);assert.equal(failed.status,503);assert.equal(failed.body.code,'SERVICE_AGENT_RESERVATION_UNCONFIRMED');assert.equal(f.counts().calls,0);
 const saved=(await read(f,p.id)).body;assert.equal(saved.stage,'MODEL_NOT_SENT');assert.equal(saved.attempts.length,1);assert.equal(saved.usedTokens,8000);assert.equal(saved.attempts[0].diagnostic.requestMayHaveBeenSent,false);
 assert.equal((await advance(f,saved)).body.status,'SUCCEEDED');assert.equal(f.counts().calls,1);assert.equal((await read(f,p.id)).body.usedTokens,8700);
});

test('untrusted provider error keeps unknown outcome and cannot masquerade as an unsent key failure',async t=>{
 const f=await durableServiceFixture(t);f.setNext(()=>{throw Object.assign(Error('SYNTHETIC_PROVIDER_SECRET_MUST_NOT_LEAK'),{code:'MODEL_KEY_MISSING',response:{body:'SYNTHETIC_PROVIDER_SECRET_MUST_NOT_LEAK'}});});
 const p=(await f.create()).body,unknown=(await advance(f,p)).body;assert.equal(unknown.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(unknown.usedTokens,8000);assert.equal(unknown.attempts[0].diagnostic.requestMayHaveBeenSent,true);
 assert.equal(JSON.stringify(unknown).includes('SYNTHETIC_PROVIDER_SECRET'),false);assert.equal((await advance(f,unknown)).body.code,'SERVICE_AGENT_RETRY_CONFIRMATION_REQUIRED');assert.equal(f.counts().calls,1);
 for(let i=0;i<2;i++)assert.equal((await read(f,p.id)).body.id,p.id);assert.equal(f.counts().calls,1);
 f.setNext(input=>result(f,input));const repaired=await advance(f,unknown,{confirmModelRetry:true});assert.equal(repaired.body.status,'SUCCEEDED');assert.equal(repaired.body.attempts.length,2);assert.equal(repaired.body.usedTokens,8700);assert.equal(f.counts().calls,2);
 assert.equal((await f.create('试图换编号清空额度')).status,429);assert.equal(f.store.list('service_agent_plan',f.project).length,1);
});

test('a second controller recovers an expired lease in the same SQLite record and rejects a late result without another automatic call',async t=>{
 const f=await durableServiceFixture(t,{modelLeaseMs:1000}),started=deferred(),work=deferred();f.setNext(()=>{started.resolve();return work.promise;});
 const p=(await f.create()).body,pending=advance(f,p);await started.promise;const running=(await read(f,p.id)).body;f.moveClock(1001);const second=await f.start();
 const recovered=await second.call(planPath(p.id),undefined,second.a);assert.equal(recovered.body.stage,'MODEL_IN_FLIGHT');assert.equal(recovered.body.recovery.leaseExpired,true);assert.equal(f.counts().calls,1);
 const marked=await second.call(planPath(p.id)+'/advance',{expectedVersion:running.version},second.a);assert.equal(marked.body.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(f.counts().calls,1);
 work.resolve(result(f));assert.equal((await pending).body.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(f.counts().calls,1);
 const denied=await second.call(planPath(p.id)+'/advance',{expectedVersion:marked.body.version},second.a);assert.equal(denied.body.code,'SERVICE_AGENT_RETRY_CONFIRMATION_REQUIRED');
 f.setNext(input=>result(f,input));const explicit=await second.call(planPath(p.id)+'/advance',{expectedVersion:marked.body.version,confirmModelRetry:true},second.a);
 assert.equal(explicit.body.status,'SUCCEEDED');assert.equal(explicit.body.usedTokens,8700);assert.equal(explicit.body.id,p.id);assert.equal(f.counts().calls,2);
});

test('model lease cannot outlive its approved execution window and an expiry result cannot reopen work',async t=>{
 const f=await durableServiceFixture(t),started=deferred(),work=deferred(),p=(await f.create()).body;
 f.moveClock(Date.parse(f.profile.expiresAt)-f.now()-10000);f.setNext(()=>{started.resolve();return work.promise;});
 const pending=advance(f,p);await started.promise;const raw=f.store.get('service_agent_plan',p.id,f.project);
 assert.equal(raw.durable.leaseExpiresAt,f.profile.expiresAt);f.moveClock(10001);work.resolve(result(f));
 const expired=(await pending).body;assert.equal(expired.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(expired.usedTokens,8000);
 assert.equal((await advance(f,expired,{confirmModelRetry:true})).body.code,'SERVICE_AGENT_WINDOW_CLOSED');assert.equal(f.counts().calls,1);
});

test('source health loss still permits original metadata and cancellation, with unknown usage retained',async t=>{
 const f=await durableServiceFixture(t),started=deferred(),work=deferred();f.setNext(()=>{started.resolve();return work.promise;});
 const p=(await f.create()).body,pending=advance(f,p);await started.promise;f.store.update('release',f.release.id,f.project,{health:'NEEDS_ATTENTION'});
 const stale=(await read(f,p.id)).body;assert.equal(stale.sourceCheck,'UNAVAILABLE');assert.equal((await f.call(planPath(p.id),undefined,f.b)).status,403);
 const cancelled=await f.call(planPath(p.id)+'/cancel',{sourceBoundOnly:true},f.a);assert.equal(cancelled.body.status,'CANCELLED');assert.equal(cancelled.body.sourceCheck,'UNAVAILABLE');assert.equal(cancelled.body.usedTokens,8000);
 work.resolve(result(f));assert.equal((await pending).body.status,'CANCELLED');assert.equal(f.counts().calls,1);assert.equal(f.store.list('data_service',f.project).length,2);
});

test('source or published version drift rejects the returned proposal while keeping measured usage',async t=>{
 const f=await durableServiceFixture(t),started=deferred(),work=deferred();f.setNext(()=>{started.resolve();return work.promise;});
 const p=(await f.create()).body,pending=advance(f,p);await started.promise;
 f.privateManager.createDapiVersion(f.holdings.id,{sourceReleaseRunId:f.run.id,fields:['client_id','holding_market_value']});await f.privateManager.test(f.holdings.id,{});f.privateManager.publish(f.holdings.id);
 work.resolve(result(f));const failed=await pending;assert.equal(failed.body.status,'FAILED');assert.equal(failed.body.usedTokens,700);assert.equal(failed.body.errorCode,'SERVICE_PLAN_VERSION_CHANGED');assert.equal(f.store.list('data_service',f.project).length,2);
});

test('private XAPI plans pin only same-source DAPI versions and apply replays keep those versions after a DAPI upgrade',async t=>{
 const f=await durableServiceFixture(t,{profilePatch:{maxPlans:2}});let serial=0;
 f.setNext(input=>result(f,input,{plan:{serviceType:'XAPI',name:'股票与现金组合接口',slug:'synthetic-private-composition-'+(++serial),
  steps:[{alias:'holdings',dapiId:f.holdings.id,dapiVersionId:f.holdings.publishedVersionId},{alias:'cash',dapiId:f.cash.id,dapiVersionId:f.cash.publishedVersionId}]}}));
 const p=(await f.create('规划同一发布批次的股票与现金XAPI')).body,ready=(await advance(f,p)).body;
 assert.equal(ready.status,'SUCCEEDED');assert.equal(ready.selectedVersions.length,2);
 const applied=await f.call(planPath(p.id)+'/apply',{proposalHash:ready.proposalHash},f.a);assert.equal(applied.status,200);assert.equal(applied.body.serviceType,'XAPI');
 assert.deepEqual(applied.body.currentVersion.steps,ready.proposal.steps);assert.equal(applied.body.currentVersion.scope,'PRIVATE_CLOUD_TEST');
 const second=(await f.create('再规划一个同源股票与现金组合')).body,proposal=(await advance(f,second)).body;assert.equal(proposal.status,'SUCCEEDED');
 f.privateManager.createDapiVersion(f.holdings.id,{sourceReleaseRunId:f.run.id,fields:['client_id','holding_market_value']});await f.privateManager.test(f.holdings.id,{});f.privateManager.publish(f.holdings.id);
 assert.equal((await f.call(planPath(second.id)+'/apply',{proposalHash:proposal.proposalHash},f.a)).body.code,'SERVICE_PLAN_VERSION_CHANGED');
 const replay=await f.call(planPath(p.id)+'/apply',{proposalHash:ready.proposalHash},f.a);assert.equal(replay.status,200);assert.equal(replay.body.id,applied.body.id);assert.deepEqual(replay.body.currentVersion.steps,ready.proposal.steps);
 assert.equal(f.store.list('data_service',f.project).length,3);assert.equal(f.counts().calls,2);assert.equal(f.counts().compute,0);
});

test('a valid other published batch cannot replace the selected private source in a model proposal',async t=>{
 const f=await durableServiceFixture(t),other=f.store.create('release_run',f.project,{...f.run,sequence:2});
 f.setNext(input=>result(f,input,{plan:{serviceType:'DAPI',name:'不应使用其他批次',slug:'synthetic-other-batch',sourceReleaseRunId:other.id,fields:['client_id','total_assets']}}));
 const p=(await f.create()).body,failed=(await advance(f,p)).body;assert.equal(failed.status,'FAILED');assert.equal(failed.errorCode,'SERVICE_PLAN_SOURCE_MISMATCH');assert.equal(failed.usedTokens,700);
 assert.equal(f.store.list('data_service',f.project).length,2);assert.equal(f.counts().calls,1);
});

test('applied draft survives a lost plan checkpoint and changed draft cannot masquerade as the original',async t=>{
 const f=await durableServiceFixture(t),p=(await f.create()).body,ready=(await advance(f,p)).body,update=f.store.update.bind(f.store);let lost=false;
 f.store.update=(kind,id,project,patch,...rest)=>{if(kind==='service_agent_plan'&&id===p.id&&patch.status==='APPLIED'&&!lost){lost=true;throw Error('Synthetic checkpoint lost');}return update(kind,id,project,patch,...rest);};
 assert.equal((await f.call(planPath(p.id)+'/apply',{proposalHash:ready.proposalHash},f.a)).status,500);assert.equal(f.store.list('data_service',f.project).length,3);f.store.update=update;
 const recovered=await f.call(planPath(p.id)+'/apply',{proposalHash:ready.proposalHash},f.a);assert.equal(recovered.status,200);assert.equal(f.store.list('data_service',f.project).length,3);
 f.privateManager.createDapiVersion(recovered.body.id,{sourceReleaseRunId:f.run.id,fields:['client_id']});
 assert.equal((await f.call(planPath(p.id)+'/apply',{proposalHash:ready.proposalHash},f.a)).body.code,'APPLIED_SERVICE_CHANGED');assert.equal(f.counts().calls,1);
});

test('independent private scope refuses public writes, CSRF failures, other actors, changed sources and unrelated operations',async t=>{
 const f=await durableServiceFixture(t),body={message:'当前私有证券接口规划',sourceBinding:f.sourceBinding};
 assert.equal((await f.call('/data-services/agent/plans',body,f.a,randomUUID(),true)).body.code,'PUBLIC_READ_ONLY');
 assert.equal((await f.call('/data-services/agent/plans',body,{cookie:f.a.cookie})).status,403);assert.equal((await f.call('/data-services/agent/plans',body,f.b)).status,403);
 assert.equal((await f.create(undefined,randomUUID(),{...f.sourceBinding,sourceReleaseRunId:randomUUID()})).status,403);
 const p=(await f.create()).body;assert.equal((await read(f,p.id)).body.id,p.id);assert.equal((await f.call(planPath(p.id),undefined,f.b)).status,403);
 for(const path of ['/agent/tasks','/runs','/releases','/data-services/dapis','/data-services/applications',`/data-services/dapis/${f.holdings.id}/publish`])assert.equal((await f.call(path,{},f.a)).status,403,path);
 assert.equal(f.counts().calls,0);assert.equal(f.counts().compute,0);
});

test('window expiry, shared call/token limits and a changed profile cannot reset original attempts',async t=>{
 const f=await durableServiceFixture(t,{profilePatch:{maxPlans:2,maxModelCalls:1,tokenBudget:8000}});f.setNext(()=>{throw Error('synthetic unknown');});
 const p=(await f.create()).body,unknown=(await advance(f,p)).body;assert.equal(unknown.usedTokens,8000);
 const second=(await f.create('第二个证券接口规划')).body;assert.equal((await advance(f,second)).body.code,'SERVICE_AGENT_EXECUTION_LIMIT');assert.equal((await advance(f,unknown,{confirmModelRetry:true})).body.code,'SERVICE_AGENT_EXECUTION_LIMIT');assert.equal(f.counts().calls,1);
 f.moveClock(600001);assert.equal((await f.create(undefined,p.requestId)).body.id,p.id,'idempotent recovery is not a new paid window');
 assert.equal((await advance(f,unknown,{confirmModelRetry:true})).body.code,'SERVICE_AGENT_WINDOW_CLOSED');assert.equal((await f.call(planPath(p.id)+'/cancel',{},f.a)).body.status,'CANCELLED');
});

test('full bill and unsettled reserve stop work before a new attempt; private reservations cannot borrow SQL leases',async t=>{
 const f=await durableServiceFixture(t,{profilePatch:{bill:{month:serviceAgentMonth(Date.now()),observedAt:new Date().toISOString(),spendCny:180,unsettledReserveCny:60}}}),p=(await f.create()).body;
 assert.equal((await advance(f,p)).body.code,'MONTHLY_HARD_BUDGET_EXCEEDED');assert.equal((await read(f,p.id)).body.attempts.length,0);assert.equal(f.counts().calls,0);
 const ready=await durableServiceFixture(t),started=deferred(),work=deferred();ready.setNext(()=>{started.resolve();return work.promise;});const made=(await ready.create()).body,pending=advance(ready,made);await started.promise;
 const raw=ready.store.get('service_agent_plan',made.id,ready.project),reservation={taskId:raw.id,attempt:1,leaseToken:raw.durable.leaseToken};
 assert.doesNotThrow(()=>ready.app.budget.assertCanStartServiceModel(reservation));assert.throws(()=>ready.app.budget.assertCanStartModel(reservation),error=>error.code==='MODEL_RESERVATION_INVALID');
 assert.throws(()=>ready.app.budget.assertCanStartServiceModel({...reservation,leaseToken:randomUUID()}),error=>error.code==='MODEL_RESERVATION_INVALID');
 work.resolve(result(ready));await pending;
});

test('CLI/MCP explicitly advance one private plan and only apply its reviewed hash; private transport remains opt-in',async t=>{
 const f=await durableServiceFixture(t),seen=[];
 const client=new V2Client({baseUrl:f.base+'/api/v2',fetchImpl:async(url,options)=>{seen.push({path:new URL(url).pathname,method:options.method,body:options.body&&JSON.parse(options.body)});return fetch(url,{...options,headers:{...options.headers,...f.internalHeaders,...f.a}});}});
 const requestId=randomUUID(),p=await callServicePlan(client,'create',{message:'证券私有服务规划多端联测',sourceBinding:f.sourceBinding,requestId});assert.equal(f.counts().calls,0);
 let out;const code=await runV2Cli(['services','advance-plan','--id',p.id,'--expected-version',String(p.version)],{}, {client,output:value=>{out=JSON.parse(value);},error:()=>{}});assert.equal(code,0);assert.equal(out.status,'SUCCEEDED');assert.equal(f.counts().calls,1);
 const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'service_agent_plan_apply',arguments:{planId:p.id}}},{client}));assert.equal(mcp.error,undefined);
 assert.equal(JSON.parse(mcp.result.content[0].text).status,'DRAFT');assert.equal(seen.find(call=>call.path.endsWith('/apply')).body.proposalHash,out.proposalHash);
 const input={operation:'PRIVATE_APPLICATION_HTTP_V1',method:'POST',path:'/api/v2'+planPath(p.id)+'/advance',headers:{},body:{expectedVersion:p.version}};
 assert.throws(()=>validatePrivateApplicationRequest(input,{allowDataServices:true}));assert.equal(validatePrivateApplicationRequest(input,{allowDataServices:true,allowServiceAgent:true}).path,input.path);
 assert.equal(privateApplicationTimeoutMs(input.path),105000);
 assert.throws(()=>privateServiceAgentProfile({...f.env,V2_FC_PUBLIC_READ_ONLY:'false'}));assert.throws(()=>privateServiceAgentProfile({...f.env,V2_FC_PUBLIC_WRITE_SCOPE:'SERVICE_CONSUMPTION_ONLY'}));
 assert.equal(f.counts().calls,1);assert.equal(f.counts().compute,0);
});
