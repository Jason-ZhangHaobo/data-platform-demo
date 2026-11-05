import test from 'node:test';
import assert from 'node:assert/strict';
import {durableServiceFixture} from './fixtures/durable-service-agent.mjs';
import {AGENT_WAKE_PREFIX} from '../../src/v2/agent-event-driver.mjs';
import {privateServiceAgentProfile} from '../../src/v2/private-service-agent-policy.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {callServicePlan} from '../../src/v2/service-plan-client.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
const path=id=>'/data-services/agent/plans/'+id;
const advance=(f,p,extra={})=>f.call(path(p.id)+'/advance',{expectedVersion:p.version,...extra},f.a);
const read=async(f,id)=>{const value=await f.call(path(id),undefined,f.a);assert.equal(value.status,200,value.body.code??value.body.message);return value;};
const consume=(f,event=f.events[0])=>f.invoke(event);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};
const waitForStart=(started,running)=>Promise.race([started.promise,running.then(response=>{throw Error('event ended before model start: '+response.status+' '+(response.body.code??response.body.state??response.body.status));})]);
const result=f=>({plan:{serviceType:'DAPI',name:'虚构客户股票现金查询',slug:'synthetic-event-assets',sourceReleaseRunId:f.run.id,fields:['client_id','total_assets']},model:'qwen3.7-plus',usage:{total_tokens:700}});

test('event mode is explicit and fingerprinted; unchanged explicit profiles preserve their boundary',async t=>{
 const f=await durableServiceFixture(t),baseline=privateServiceAgentProfile(f.env),v=JSON.parse(f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE);
 const explicit=privateServiceAgentProfile({...f.env,V2_PRIVATE_SERVICE_AGENT_PROFILE:JSON.stringify({...v,driver:'EXPLICIT_ADVANCE'})});assert.equal(baseline.fingerprint,explicit.fingerprint);
 const event=privateServiceAgentProfile({...f.env,V2_PRIVATE_SERVICE_AGENT_PROFILE:JSON.stringify({...v,driver:'OSS_EVENTS'})});assert.notEqual(event.fingerprint,baseline.fingerprint);
 assert.throws(()=>privateServiceAgentProfile({...f.env,V2_PRIVATE_SERVICE_AGENT_PROFILE:JSON.stringify({...v,driver:'POLL'})}),/PROFILE_INVALID/);
 const p=(await f.create()).body;assert.equal((await consume(f,{events:[]})).status,422);assert.equal(p.recovery.driver,'EXPLICIT_ADVANCE');assert.equal(f.counts().calls,0);
});

test('foreground advance only persists a signed outbox; an independent event and fresh controller run the same plan once',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true,manual:true}),parent=structuredClone(f.store.get('agent',f.agent.id,f.project));
 const p=(await f.create()).body;assert.equal(p.recovery.driver,'OSS_EVENTS');assert.equal(f.counts().calls,0);assert.equal(f.eventCounts().puts,0);
 const queued=await advance(f,p);assert.equal(queued.status,202);assert.equal(queued.body.stage,'READY_FOR_MODEL');assert.equal(queued.body.attempts.length,0);assert.equal(queued.body.recovery.background.status,'ACTIVE');assert.equal(f.events.length,1);
 const puts=f.eventCounts().puts;await read(f,p.id);assert.equal(f.eventCounts().puts,puts);assert.equal(f.counts().calls,0);
 const next=await f.start(),processed=await consume(next,f.events[0]);assert.equal(processed.status,200);assert.equal(processed.body.status,'COMPLETED');assert.equal(f.counts().calls,1);
 const done=(await read(next,p.id)).body;assert.equal(done.status,'SUCCEEDED');assert.equal(done.attempts.length,1);assert.equal(done.usedTokens,700);assert.equal(done.recovery.background.status,'COMPLETED');
 await consume(next,f.events[0]);assert.equal(f.counts().calls,1);assert.deepEqual(f.store.get('agent',f.agent.id,f.project),parent);assert.equal(f.counts().compute,0);
 const applied=await next.call(path(p.id)+'/apply',{proposalHash:done.proposalHash},next.a);assert.equal(applied.status,200);assert.equal((await read(next,p.id)).body.status,'APPLIED');assert.equal(f.store.list('service_app',f.project).length,0);
 assert.equal((await advance(next,p)).body.code,'STALE_SERVICE_AGENT_VERSION');
});

test('lost OSS acknowledgement reuses the original wake and only an external event can start the model',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true});f.setPutFailure('AFTER');const p=(await f.create()).body;
 const pending=await advance(f,p);assert.equal(pending.status,202);assert.equal(pending.body.recovery.background.delivery,'UNCONFIRMED');assert.equal(f.objects.size,1);assert.equal(f.counts().calls,0);
 const before=[...f.objects.entries()],puts=f.eventCounts().puts;await read(f,p.id);assert.equal(f.eventCounts().puts,puts);
 f.setPutFailure(undefined);const restored=await advance(f,p);assert.equal(restored.body.recovery.background.delivery,'ACKNOWLEDGED');assert.deepEqual([...f.objects.entries()],before);assert.equal(f.events.length,1);
 assert.equal((await consume(f)).status,200);assert.equal(f.counts().calls,1);assert.equal((await read(f,p.id)).body.status,'SUCCEEDED');
});

test('unknown results do not retry on replay or read; reviewed retry uses a new wake and preserves all old tokens',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true});f.setNext(()=>{throw Error('synthetic unknown provider result');});const p=(await f.create()).body;
 await advance(f,p);await consume(f);const unknown=(await read(f,p.id)).body;assert.equal(unknown.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(unknown.usedTokens,8000);assert.equal(unknown.recovery.background.status,'NEEDS_CONFIRMATION');
 await consume(f);await read(f,p.id);assert.equal(f.counts().calls,1);assert.equal(f.events.length,1);assert.equal((await advance(f,unknown)).body.code,'SERVICE_AGENT_RETRY_CONFIRMATION_REQUIRED');
 f.setNext(()=>result(f));const resumed=await advance(f,unknown,{confirmModelRetry:true});assert.equal(resumed.status,202);assert.equal(resumed.body.usedTokens,8000);assert.equal(f.events.length,2);
 await consume(f,f.events[0]);assert.equal(f.counts().calls,1,'old signed wake cannot consume the new review');
 await consume(f,f.events[1]);const done=(await read(f,p.id)).body;assert.equal(done.status,'SUCCEEDED');assert.equal(done.attempts.length,2);assert.equal(done.usedTokens,8700);assert.equal(done.recovery.background.consumedEvents,2);
});

test('duplicate in-flight event stays bounded; cancellation preserves the grant and rejects late output',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true}),started=deferred(),work=deferred();f.setNext(()=>{started.resolve();return work.promise;});
 const p=(await f.create()).body;await advance(f,p);const running=consume(f);await waitForStart(started,running);
 const duplicate=await consume(f);assert.equal(duplicate.status,503);assert.equal(f.counts().calls,1);
 const live=(await read(f,p.id)).body;assert.equal(live.stage,'MODEL_IN_FLIGHT');assert.equal(live.recovery.background.consumedEvents,1);
 assert.equal((await f.call(path(p.id)+'/cancel',{},f.b)).status,403);assert.equal(f.inputs[0].signal.aborted,false);
 const stopped=await f.call(path(p.id)+'/cancel',{},f.a);assert.equal(stopped.body.status,'CANCELLED');assert.equal(stopped.body.recovery.background.status,'CANCELLED');
 work.resolve(result(f));await running;await consume(f);const final=(await read(f,p.id)).body;
 assert.equal(final.status,'CANCELLED');assert.equal(final.usedTokens,8000);assert.equal(final.recovery.background.status,'CANCELLED');assert.equal(f.store.list('data_service',f.project).length,2);assert.equal(f.counts().calls,1);
});

test('source, member, expired window and model-boundary drift reject registered events before OSS reads or models',async t=>{
 for(const fault of ['source','member','expired','model','event-key','event-bucket'])await t.test(fault,async t=>{
  const f=await durableServiceFixture(t,{eventMode:true}),p=(await f.create()).body;await advance(f,p);
  const grant=structuredClone(f.store.list('agent_background',f.project)[0]);let api=f;
  if(fault==='source')f.store.update('release',f.release.id,f.project,{health:'NEEDS_ATTENTION'});
  if(fault==='member')f.store.update('auth_user',f.owner.id,f.project,{memberships:[]});
  if(fault==='expired')f.moveClock(7200000);
  if(fault==='model'){f.env.V2_MODEL='different-model';api=await f.start();}
  if(fault==='event-key'){f.env.V2_SPARK_EXECUTOR_SECRET='different-synthetic-event-key-'.repeat(3);api=await f.start();}
  if(fault==='event-bucket'){f.env.OSS_BUCKET='different-fictional-events';api=await f.start();}
  const reads=f.eventCounts().reads;const response=await consume(api,f.events[0]);if(fault==='event-bucket')assert.equal(response.status,401);else assert.equal(response.body.state,'SCOPE_DENIED');assert.equal(f.eventCounts().reads,reads);assert.equal(f.counts().calls,0);
  assert.deepEqual(f.store.get('agent_background',grant.id,f.project),grant);
  if(fault==='source'){const visible=(await read(f,p.id)).body;assert.equal(visible.sourceCheck,'UNAVAILABLE');assert.equal(visible.recovery.background.scopeBlocked,true);}
 });
});

test('service events ignore the SQL family and reject changed signed bytes without touching foreign grants',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true}),p=(await f.create()).body;await advance(f,p);
 const grant=f.store.create('agent_background',f.project,{taskId:f.agent.id,status:'ACTIVE',scope:'SQL_DEVELOPMENT'}),wake=f.store.create('agent_wake',f.project,{grantId:grant.id,taskId:f.agent.id,status:'SENT'}),foreign=structuredClone(grant);
 const foreignEvent=structuredClone(f.events[0]);foreignEvent.events[0].oss.object.key=AGENT_WAKE_PREFIX+'/'+wake.id+'.json';const reads=f.eventCounts().reads;
 assert.equal((await consume(f,foreignEvent)).body.state,'IGNORED_UNREGISTERED');assert.equal(f.eventCounts().reads,reads);assert.deepEqual(f.store.get('agent_background',grant.id,f.project),foreign);
 const key=f.events[0].events[0].oss.object.key,raw=f.objects.get(key);f.objects.set(key,raw.replace('shuduo-service-agent-wake/v1','shuduo-agent-wake/v1'));
 assert.equal((await consume(f)).status,401);assert.equal(f.counts().calls,0);f.objects.set(key,raw);assert.equal((await consume(f)).status,200);assert.equal(f.counts().calls,1);
});

test('expired model lease is reconciled by a fresh event controller without sending a second model',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true}),started=deferred(),work=deferred();f.setNext(()=>{started.resolve();return work.promise;});
 const p=(await f.create()).body;await advance(f,p);const running=consume(f);await waitForStart(started,running);
 const next=await f.start();f.moveClock(100000);const recovered=await consume(next,f.events[0]);assert.equal(recovered.status,200);assert.equal(recovered.body.status,'NEEDS_CONFIRMATION');
 work.resolve(result(f));await running;const saved=(await read(next,p.id)).body;assert.equal(saved.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(saved.attempts.length,1);assert.equal(saved.usedTokens,8000);assert.equal(f.counts().calls,1);
});

test('bill rejection remains unsent; reviewed recovery creates a distinct wake and old claims cannot spend the new consent',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true}),p=(await f.create()).body;await advance(f,p);
 f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE=JSON.stringify({...f.profile,bill:{...f.profile.bill,observedAt:new Date(f.now()-1800001).toISOString()}});
 const stale=await f.start(),blocked=await consume(stale,f.events[0]);assert.equal(blocked.body.status,'PAUSED');assert.equal(blocked.body.code,'SERVICE_AGENT_BILL_STALE');assert.equal(f.counts().calls,0);
 f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE=JSON.stringify({...f.profile,bill:{...f.profile.bill,observedAt:new Date(f.now()).toISOString()}});
 const fresh=await f.start(),original=(await read(fresh,p.id)).body;assert.equal(original.attempts.length,0);assert.equal(original.usedTokens,0);
 const resumed=await advance(fresh,original);assert.equal(resumed.status,202);assert.equal(f.events.length,2);
 await consume(fresh,f.events[0]);assert.equal(f.counts().calls,0);await consume(fresh,f.events[1]);assert.equal(f.counts().calls,1);assert.equal((await read(fresh,p.id)).body.status,'SUCCEEDED');
});

test('CLI client and MCP register and restore the same event task without model or extra wake side effects',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true}),p=(await f.create()).body;
 const client=new V2Client({baseUrl:f.base+'/api/v2',fetchImpl:(url,options)=>fetch(url,{...options,headers:{...options.headers,...f.internalHeaders,...f.a}})});
 const queued=await callServicePlan(client,'advance',{planId:p.id,expectedVersion:p.version});assert.equal(queued.recovery.background.status,'ACTIVE');assert.equal(f.counts().calls,0);
 const puts=f.eventCounts().puts,mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'service_agent_plan_detail',arguments:{planId:p.id}}},{client}));
 assert.equal(mcp.error,undefined);assert.equal(f.eventCounts().puts,puts);assert.equal(f.counts().calls,0);
});

test('an expired event window can only be explicitly continued within the unchanged original execution budget',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true,profilePatch:{expiresAt:new Date(Date.now()+7200000-10000).toISOString()}}),p=(await f.create()).body;await advance(f,p);
 const first=(await read(f,p.id)).body.recovery.background;f.moveClock(901000);const puts=f.eventCounts().puts;await read(f,p.id);assert.equal(f.eventCounts().puts,puts);
 const continued=await advance(f,p);assert.equal(continued.status,202);assert.equal(continued.body.attempts.length,0);assert.equal(continued.body.usedTokens,0);assert.equal(f.events.length,2);
 assert.ok(continued.body.recovery.background.expiresAt>first.expiresAt);assert.ok(continued.body.recovery.background.expiresAt<=Date.parse(p.executionWindow.expiresAt));
 assert.equal((await consume(f,f.events[0])).body.state,'IGNORED_SUPERSEDED');assert.equal(f.counts().calls,0);await consume(f,f.events[1]);assert.equal(f.counts().calls,1);
});

test('after a temporary source denial, explicit redrive creates a new checkpoint and old queued events cannot run it',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true}),p=(await f.create()).body;await advance(f,p);
 f.store.update('release',f.release.id,f.project,{health:'NEEDS_ATTENTION'});assert.equal((await consume(f)).body.state,'SCOPE_DENIED');assert.equal(f.counts().calls,0);
 f.store.update('release',f.release.id,f.project,{health:'HEALTHY'});const recovered=(await read(f,p.id)).body,puts=f.eventCounts().puts;
 assert.equal(f.eventCounts().puts,puts);const redriven=await advance(f,recovered);assert.equal(redriven.status,202);assert.ok(redriven.body.version>p.version);assert.equal(f.events.length,2);assert.equal(f.counts().calls,0);
 await consume(f,f.events[0]);assert.equal(f.counts().calls,0);await consume(f,f.events[1]);assert.equal(f.counts().calls,1);
});

test('a second claimed event waits for the existing model without consuming a model attempt or an extra event on retry',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true,profilePatch:{maxPlans:2}}),started=deferred(),work=deferred();let first=true;
 f.setNext(()=>{if(first){first=false;started.resolve();return work.promise;}return result(f);});
 const a=(await f.create()).body,b=(await f.create('同一虚构证券来源的另一项服务需求')).body;await advance(f,a);await advance(f,b);
 const running=consume(f,f.events[0]);await waitForStart(started,running);
 assert.equal((await consume(f,f.events[1])).status,503);assert.equal(f.counts().calls,1);const waiting=(await read(f,b.id)).body;assert.equal(waiting.attempts.length,0);assert.equal(waiting.recovery.background.consumedEvents,1);
 work.resolve(result(f));await running;await consume(f,f.events[1]);const done=(await read(f,b.id)).body;
 assert.equal(done.status,'SUCCEEDED');assert.equal(done.attempts.length,1);assert.equal(done.recovery.background.consumedEvents,1);assert.equal(f.counts().calls,2);
});

test('changing the configured driver does not prevent an owner from cancelling an old explicit task',async t=>{
 const f=await durableServiceFixture(t,{eventMode:true,profilePatch:{driver:'EXPLICIT_ADVANCE'}}),p=(await f.create()).body;
 f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE=JSON.stringify({...f.profile,driver:'OSS_EVENTS'});const next=await f.start();
 const cancelled=await next.call(path(p.id)+'/cancel',{},next.a);assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'CANCELLED');assert.equal(cancelled.body.recovery.driver,'EXPLICIT_ADVANCE');
 assert.equal(f.counts().calls,0);assert.equal(f.eventCounts().puts,0);
});
