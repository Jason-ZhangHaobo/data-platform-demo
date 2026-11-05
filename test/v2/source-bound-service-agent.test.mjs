import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalSourceApiFixture,publishLocalAgentFixture} from './fixtures/local-service-api-journey.mjs';
import {PROJECT,createV2Server} from '../../src/v2/server.mjs';
import {servicePlanSourcePath} from '../../src/v2/service-plan-source.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Actual published-task/controller/files/SQLite with synthetic upstream models
// and Spark. The injected service model is explicit, not production matching.
async function fixture(t){
 const inputs=[];let next=input=>({serviceType:'DAPI',name:'同源持仓查询',slug:'bound-agent-holdings',sourceReleaseRunId:input.releaseRuns[0].id,fields:['client_id','holding_market_value','security_count']});
 const f=await createLocalSourceApiFixture({servicePlanner:async input=>{inputs.push(input);return {plan:await next(input),model:'synthetic-service-planner',explanation:'合成模型方案，仅用于流程验收',usage:{total_tokens:30}};}});t.after(()=>f.dispose());
 const old=await publishLocalAgentFixture(f),selected=await publishLocalAgentFixture(f,{contextId:'stock-cash-t1'});
 const sourceBinding={taskId:selected.agent.id,packageDigest:selected.bundle.digest,releaseId:selected.release.id,sourceReleaseRunId:selected.sources[0].id};
 async function dapi(slug,sourceReleaseRunId,fields){const made=await f.call('/data-services/dapis',{name:'合成版本'+slug,slug,sourceReleaseRunId,fields});assert.equal(made.status,201);
  assert.equal((await f.call(`/data-services/dapis/${made.body.id}/test`,{})).status,200);assert.equal((await f.call(`/data-services/dapis/${made.body.id}/publish`,{configHash:made.body.currentVersion.configHash})).status,200);return made.body;}
 const unrelated=await dapi('bound-unrelated',old.sources[0].id,['client_id','total_assets']),
  holdings=await dapi('bound-current-holdings',sourceBinding.sourceReleaseRunId,['client_id','holding_market_value','security_count']),
  cash=await dapi('bound-current-cash',sourceBinding.sourceReleaseRunId,['client_id','available_cash','total_assets']);
 async function plan(message='基于当前发布结果生成受治理接口',binding=sourceBinding,key=randomUUID(),headers={}){
  const made=await f.call('/data-services/agent/plans',{message,sourceBinding:binding},{headers:{'idempotency-key':key,...headers}});return {made,key};}
 const done=async id=>f.poll('/data-services/agent/plans/'+id,plan=>['SUCCEEDED','FAILED','CANCELLED'].includes(plan.status));
 return {...f,inputs,old,selected,sourceBinding,unrelated,holdings,cash,dapi,plan,done,setNext:value=>{next=value;}};
}

test('source-bound model sees only the exact batch and DAPIs, produces one draft, and recovers application without duplicate services',async t=>{
 const f=await fixture(t),before={...f.counts,apps:f.store.list('service_app',PROJECT).length,calls:f.store.list('service_call',PROJECT).length};
 const {made,key}=await f.plan();assert.equal(made.status,202,JSON.stringify(made.body));const plan=await f.done(made.body.id);assert.equal(plan.status,'SUCCEEDED',plan.error);
 assert.deepEqual(plan.sourceBinding,f.sourceBinding);assert.equal(plan.submittedBy,undefined);assert.equal(plan.scope,'LOCAL_TEST_ONLY');assert.equal(f.inputs.length,1);
 const input=f.inputs[0];assert.deepEqual(input.releaseRuns.map(run=>run.id),[f.sourceBinding.sourceReleaseRunId]);assert.deepEqual(input.services.map(service=>service.id).sort(),[f.holdings.id,f.cash.id].sort());
 assert.equal(input.sourceContext.id,'stock-cash-t1');assert.match(input.sourceContext.definition,/不等于客户全资产/);
 for(const forbidden of ['"rows"','"sql"','CLIENT-001','1000.00','snapshotId','queryTemplate'])assert.equal(JSON.stringify(input).includes(forbidden),false);
 const lookup=await f.call('/data-services/agent/requests/'+key);assert.equal(lookup.body.id,plan.id);
 const list=await f.call(servicePlanSourcePath(f.sourceBinding));assert.equal(list.body.length,1);assert.equal(list.body[0].id,plan.id);
 assert.deepEqual((await f.call('/data-services/agent/plans')).body,[],'unscoped history never mixes a source-bound plan');
 const repeated=await f.plan('基于当前发布结果生成受治理接口',f.sourceBinding,key);assert.equal(repeated.made.body.id,plan.id);assert.equal(f.inputs.length,1);
 const created=await f.call(`/data-services/agent/plans/${plan.id}/apply`,{});assert.equal(created.status,201);assert.equal(created.body.status,'DRAFT');assert.equal(created.body.currentVersion.sourceReleaseRunId,f.sourceBinding.sourceReleaseRunId);
 const applied=await f.call('/data-services/agent/plans/'+plan.id),version=applied.body.version;
 const replay=await f.call(`/data-services/agent/plans/${plan.id}/apply`,{});assert.equal(replay.status,200);assert.equal(replay.body.id,created.body.id);assert.equal((await f.call('/data-services/agent/plans/'+plan.id)).body.version,version);
 assert.equal(f.store.list('data_service',PROJECT).length,4);assert.deepEqual({...f.counts,apps:f.store.list('service_app',PROJECT).length,calls:f.store.list('service_call',PROJECT).length},before);
});

test('model proposals cannot select another batch or another package even when those resources are valid project resources',async t=>{
 const f=await fixture(t),count=f.store.list('data_service',PROJECT).length;
 f.setNext(()=>({serviceType:'DAPI',name:'不应生成',slug:'bound-wrong-source',sourceReleaseRunId:f.old.sources[0].id,fields:['client_id','total_assets']}));
 let value=await f.plan(),plan=await f.done(value.made.body.id);assert.equal(plan.status,'FAILED');assert.match(plan.error,/当前确切发布批次/);
 f.setNext(()=>({serviceType:'XAPI',name:'不应组合',slug:'bound-wrong-combination',steps:[{alias:'current',dapiId:f.holdings.id},{alias:'other',dapiId:f.unrelated.id}]}));
 value=await f.plan('规划同源组合接口');plan=await f.done(value.made.body.id);assert.equal(plan.status,'FAILED');assert.match(plan.error,/固定DAPI版本/);
 assert.equal((await f.call(`/data-services/agent/plans/${plan.id}/apply`,{})).status,409);assert.equal(f.store.list('data_service',PROJECT).length,count);
});

test('XAPI freezes child versions and refuses drift before application while preserving the original plan',async t=>{
 const f=await fixture(t);f.setNext(()=>({serviceType:'XAPI',name:'同源资产组合',slug:'bound-fixed-xapi',steps:[{alias:'holdings',dapiId:f.holdings.id},{alias:'cash',dapiId:f.cash.id}]}));
 const {made}=await f.plan(),plan=await f.done(made.body.id);assert.equal(plan.status,'SUCCEEDED');assert.equal(plan.selectedVersions.length,2);
 const source=f.sourceBinding.sourceReleaseRunId;
 assert.equal((await f.call(`/data-services/dapis/${f.holdings.id}/versions`,{sourceReleaseRunId:source,fields:['client_id','holding_market_value']})).status,201);
 assert.equal((await f.call(`/data-services/dapis/${f.holdings.id}/test`,{})).status,200);
 const current=await f.call(`/data-services/dapis/${f.holdings.id}`);assert.equal((await f.call(`/data-services/dapis/${f.holdings.id}/publish`,{configHash:current.body.currentVersion.configHash})).status,200);
 const old=await f.call('/data-services/agent/plans/'+plan.id);assert.equal(old.body.proposal.steps[0].dapiVersionId,plan.proposal.steps[0].dapiVersionId);
 const result=await f.call(`/data-services/agent/plans/${plan.id}/apply`,{});assert.equal(result.status,409);assert.equal(result.body.code,'SERVICE_PLAN_VERSION_CHANGED');
 assert.equal(f.store.list('data_service',PROJECT).length,3);assert.equal((await f.call('/data-services/agent/plans/'+plan.id)).body.status,'SUCCEEDED');
});

test('application committed before its plan update is recovered by the original plan identity',async t=>{
 const f=await fixture(t),{made}=await f.plan(),plan=await f.done(made.body.id),update=f.store.update.bind(f.store);let dropped=false;
 f.store.update=(kind,id,project,patch,...rest)=>{if(!dropped&&kind==='service_agent_plan'&&id===plan.id&&patch.status==='APPLIED'){dropped=true;throw Error('synthetic plan checkpoint failure');}return update(kind,id,project,patch,...rest);};
 assert.equal((await f.call(`/data-services/agent/plans/${plan.id}/apply`,{})).status,500);assert.equal(dropped,true);assert.equal(f.store.list('data_service',PROJECT).length,4);
 f.store.update=update;const restored=await f.call(`/data-services/agent/plans/${plan.id}/apply`,{});assert.equal(restored.status,200);assert.equal(f.store.list('data_service',PROJECT).length,4);
 assert.equal((await f.call('/data-services/agent/plans/'+plan.id)).body.serviceId,restored.body.id);assert.equal(f.inputs.length,1);
});

test('invalid bindings, unknown fields and owner changes are rejected before model submission',async t=>{
 const f=await fixture(t),before=f.inputs.length;
 for(const binding of [null,{...f.sourceBinding,actorId:'other'},{...f.sourceBinding,sourceReleaseRunId:f.old.sources[0].id},{...f.sourceBinding,sourceReleaseRunId:f.selected.agent.runId},
  {...f.sourceBinding,packageDigest:'f'.repeat(64)},{...f.sourceBinding,taskId:randomUUID()}]){
  const {made}=await f.plan('不应调用模型的非法来源',binding);assert.ok([403,409,422].includes(made.status));
 }
 assert.equal((await f.call('/data-services/agent/plans',{message:'非法附加参数',sourceBinding:f.sourceBinding,sql:'SELECT 1'})).status,422);
 const task=f.store.get('agent',f.selected.agent.id,PROJECT);f.store.update('agent',task.id,PROJECT,{submittedBy:randomUUID()});
 assert.equal((await f.plan()).made.status,403);assert.equal(f.inputs.length,before);
 assert.equal((await f.call(servicePlanSourcePath(f.sourceBinding)+'&actorId=other')).status,422);
});

test('public-invitation mode does not gain source-bound planning or its capability',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-bound-plan-public-')),store=new MetadataStore(':memory:');let model=0;
 const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true'},servicePlanner:async()=>{model++;throw Error('must not run');}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});});
 const password='SyntheticBoundPlan!2026';app.auth.bootstrapAdmin({email:'bound-owner@example.invalid',displayName:'合成管理员',password});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'cli'},body:JSON.stringify({email:'bound-owner@example.invalid',password})}),body=await login.json(),cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const status=await fetch(base+'/status',{headers:{cookie}});assert.equal((await status.json()).dataServices.sourceBoundAgentPlansEnabled,false);
 const result=await fetch(base+'/data-services/agent/plans',{method:'POST',headers:{cookie,'x-csrf-token':body.csrfToken,'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':randomUUID()},
  body:JSON.stringify({message:'不能扩大公网规划边界',sourceBinding:{taskId:randomUUID(),packageDigest:'a'.repeat(64),releaseId:randomUUID(),sourceReleaseRunId:randomUUID()}})});
 assert.equal(result.status,403);assert.equal(model,0);assert.equal(store.list('service_agent_plan',PROJECT).length,0);
});

test('source-bound plans belong to their creator, and source proof failure cannot prevent cancellation of an owned running model',async t=>{
 const f=await fixture(t),password='SyntheticPlanOwner!2026';
 f.auth.bootstrapAdmin({email:'plan-a@example.invalid',displayName:'合成创建者',password});f.auth.bootstrapAdmin({email:'plan-b@example.invalid',displayName:'合成其他人',password});
 async function login(email){const response=await fetch(f.base+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'cli'},body:JSON.stringify({email,password})});
  const value=await response.json();return {cookie:response.headers.getSetCookie().map(cookie=>cookie.split(';')[0]).join('; '),'x-csrf-token':value.csrfToken};}
 const owner=await login('plan-a@example.invalid'),other=await login('plan-b@example.invalid');let releaseModel;
 const wait=new Promise(resolve=>{releaseModel=resolve;});f.setNext(async input=>{await wait;return {serviceType:'DAPI',name:'应取消的方案',slug:'cancel-bound-plan',sourceReleaseRunId:input.releaseRuns[0].id,fields:['client_id','total_assets']};});
 const {made,key}=await f.plan('同源模型任务取消测试',f.sourceBinding,randomUUID(),owner);assert.equal(made.status,202);
 assert.equal((await f.call('/data-services/agent/plans/'+made.body.id,undefined,{headers:other})).status,403);
 assert.equal((await f.call('/data-services/agent/requests/'+key,undefined,{headers:other})).status,404);
 assert.deepEqual((await f.call(servicePlanSourcePath(f.sourceBinding),undefined,{headers:other})).body,[]);
 assert.equal((await f.call('/data-services/agent/plans/'+made.body.id+'/cancel',{sourceBoundOnly:true},{headers:other})).status,403);
 f.store.update('release',f.sourceBinding.releaseId,PROJECT,{health:'NEEDS_ATTENTION'});
 const original=await f.call('/data-services/agent/plans/'+made.body.id,undefined,{headers:owner});assert.equal(original.status,200);assert.equal(original.body.sourceCheck,'UNAVAILABLE');
 const recovered=await f.call('/data-services/agent/requests/'+key,undefined,{headers:owner});assert.equal(recovered.status,200);assert.equal(recovered.body.id,made.body.id);assert.equal(recovered.body.sourceCheck,'UNAVAILABLE');
 assert.equal((await f.call('/data-services/agent/plans/'+made.body.id+'/apply',{}, {headers:owner})).status,409);
 const cancelled=await f.call('/data-services/agent/plans/'+made.body.id+'/cancel',{sourceBoundOnly:true},{headers:owner});assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'CANCELLED');
 releaseModel();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.store.get('service_agent_plan',made.body.id,PROJECT).status,'CANCELLED');
 assert.equal(f.store.list('data_service',PROJECT).length,3);assert.equal(f.inputs.length,1);
});

test('real CLI and MCP transport share the original source plan and apply exactly one local draft',async t=>{
 const f=await fixture(t),source=f.sourceBinding,key=randomUUID(),client=new V2Client({baseUrl:f.base,client:'cli'}),mcpClient=new V2Client({baseUrl:f.base,client:'mcp'});let created;
 assert.equal(await runV2Cli(['services','plan','--message','同源CLI与MCP验收','--request-id',key,'--task-id',source.taskId,'--package-digest',source.packageDigest,
  '--release-id',source.releaseId,'--source-run-id',source.sourceReleaseRunId],{}, {client,output:text=>{created=JSON.parse(text);},error:()=>{}}),0);
 const call=async(name,args)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:mcpClient}));
 const found=await call('service_agent_plan_request',{requestId:key});assert.equal(found.error,undefined);assert.equal(found.result.structuredContent.id,created.id);
 assert.equal((await f.done(created.id)).status,'SUCCEEDED');const applied=await call('service_agent_plan_apply',{planId:created.id});assert.equal(applied.error,undefined);assert.equal(applied.result.structuredContent.status,'DRAFT');
 let repeated;assert.equal(await runV2Cli(['services','apply-plan','--id',created.id],{}, {client,output:text=>{repeated=JSON.parse(text);},error:()=>{}}),0);
 assert.equal(repeated.id,applied.result.structuredContent.id);assert.equal(f.store.list('data_service',PROJECT).length,4);assert.equal(f.inputs.length,1);
 const verified=await f.call(`/data-services/dapis/${repeated.id}/test`,{client_id:'CLIENT-001'});assert.equal(verified.status,200);
 assert.deepEqual(verified.body.response.data,[{client_id:'CLIENT-001',holding_market_value:'1000.00',security_count:1}]);
 assert.equal((await f.call(`/data-services/dapis/${repeated.id}/publish`,{configHash:repeated.currentVersion.configHash})).status,200);
 const issued=await f.call('/data-services/applications',{name:'合成新规划接口消费者',serviceIds:[repeated.id]});assert.equal(issued.status,201);
 const queried=await f.call('/open/dapis/'+repeated.slug+'?client_id=CLIENT-001',undefined,{headers:{authorization:'Bearer '+issued.body.token}});assert.equal(queried.status,200);
 assert.deepEqual(queried.body.data,[{client_id:'CLIENT-001',holding_market_value:'1000.00',security_count:1}]);
 assert.equal((await f.call('/data-services/applications/'+issued.body.application.id+'/revoke',{})).status,200);assert.equal(f.store.get('service_app',issued.body.application.id,PROJECT).status,'REVOKED');
});

test('a published DAPI changed while the model was working cannot be substituted into its frozen generation context',async t=>{
 const f=await fixture(t);let finish;
 const gate=new Promise(resolve=>{finish=resolve;});
 f.setNext(async()=>{await gate;return {serviceType:'XAPI',name:'不能替换的固定版本',slug:'frozen-generation-context',steps:[{alias:'holdings',dapiId:f.holdings.id},{alias:'cash',dapiId:f.cash.id}]};});
 const {made}=await f.plan('生成过程中仍保留最初提供的版本');assert.equal(made.status,202);
 await f.poll('/data-services/agent/plans/'+made.body.id,plan=>plan.status==='RUNNING');assert.equal(f.inputs.length,1);
 assert.equal((await f.call(`/data-services/dapis/${f.holdings.id}/versions`,{sourceReleaseRunId:f.sourceBinding.sourceReleaseRunId,fields:['client_id','holding_market_value']})).status,201);
 assert.equal((await f.call(`/data-services/dapis/${f.holdings.id}/test`,{})).status,200);const current=(await f.call('/data-services/dapis/'+f.holdings.id)).body;
 assert.equal((await f.call(`/data-services/dapis/${f.holdings.id}/publish`,{configHash:current.currentVersion.configHash})).status,200);
 finish();const plan=await f.done(made.body.id);assert.equal(plan.status,'FAILED');assert.match(plan.error,/固定DAPI版本/);
 assert.equal(f.inputs[0].services.find(service=>service.id===f.holdings.id).publishedVersion.id,f.holdings.currentVersion.id);
 assert.equal(f.store.list('data_service',PROJECT).length,3);
});
