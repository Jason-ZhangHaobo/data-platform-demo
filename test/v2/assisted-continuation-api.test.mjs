import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assistedDeliveryFixture} from './fixtures/assisted-sql-delivery.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {BusinessQueryStore} from '../../src/v2/data-services.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {readAssistedContinuation,createAssistedContinuation} from '../../src/v2/assisted-continuation-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

async function setup(t,{targetOnly=false}={}){
 const f=await assistedDeliveryFixture({project:PROJECT}),businessStore=new BusinessQueryStore(),at=Date.now(),received=[];
 const raw=async()=>{throw Error('no blocking execution');};raw.durable=f.runner;raw.descriptor={engine:'Apache Spark',isolation:'REMOTE_FUNCTION',healthVerified:true,publicWriteEnabled:true};
 const app=createV2Server({root:f.root,store:f.store,businessStore,runner:raw,generator:async input=>{received.push(input);return{sql:input.currentSql,model:'protocol-model-provider',usage:{total_tokens:20}};},
   ...(targetOnly?{ingress:{assertRequest:()=> 'HTTP',status:{publicReadOnly:false}}}:{}),
   env:{V2_LOCAL_DEVELOPMENT:'false',V2_DURABLE_SQL_AGENT_ENABLED:'true',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PUBLIC_ORIGIN:'https://fixture.invalid',V2_RELEASE_SCHEDULER_MODE:'DISABLED',
     ...(targetOnly?{V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',V2_BOOTSTRAP_ADMIN_EMAIL:f.actor.email,V2_PUBLIC_DEVELOPMENT_TASK_ID:f.agent.id,V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(at-60000).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(at+3600000).toISOString()}:{})}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));businessStore.close();f.dispose();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,call=async(path,body,{key=randomUUID(),headers={}}={})=>{
   const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',origin:'https://fixture.invalid','x-shuduo-client':'workbench','idempotency-key':key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};
 };
 const login=await call('/auth/login',{email:f.actor.email,password:'SyntheticAssisted!2026'});assert.equal(login.status,200);const session={cookie:login.cookies.map(v=>v.split(';')[0]).join('; '),'x-csrf-token':login.body.csrfToken};
 const client=new V2Client({baseUrl:base,fetchImpl:(url,options)=>fetch(url,{...options,headers:{...options.headers,origin:'https://fixture.invalid',...session}})});
 return{...f,app,call,client,session,received};
}
test('HTTP continuation is read-only until explicit creation; ownership, CSRF, exact bytes and original request lookup remain enforced',async t=>{
 const f=await setup(t),path=`/agent/tasks/${f.agent.id}/assisted-continuation`,proof=await readAssistedContinuation(f.client,{taskId:f.agent.id});assert.equal(f.received.length,0);
 assert.equal((await f.call(path)).status,401);assert.equal((await f.call(path+'?sql=ignored',undefined,{headers:f.session})).status,422);
 const other=f.app.auth.bootstrapAdmin({email:'foreign-owner@example.invalid',displayName:'虚构其他管理员',password:'SyntheticForeign!2026'}),login=await f.call('/auth/login',{email:other.email,password:'SyntheticForeign!2026'});
 assert.equal((await f.call(path,undefined,{headers:{cookie:login.cookies.map(v=>v.split(';')[0]).join('; ')}})).status,403);
 const body={message:'根据成功证券版本继续调整',sql:f.agent.sql,contextId:f.agent.contextId,assistedContinuation:proof.binding},key=randomUUID();
 assert.equal((await f.call('/agent/tasks',body,{key,headers:{...f.session,'x-csrf-token':'wrong'}})).status,403);
 for(const patch of[{sql:body.sql+' '},{sourceRunId:f.source.current.run.id},{repairComparison:f.basis.binding},{derivation:{}},{language:'PYTHON'},{assistedContinuation:{...proof.binding,evidenceDigest:'a'.repeat(64)}}])assert.notEqual((await f.call('/agent/tasks',{...body,...patch},{key,headers:f.session})).status,202);
 const made=await f.call('/agent/tasks',body,{key,headers:f.session});assert.equal(made.status,202,JSON.stringify(made.body));assert.equal(made.body.stage,'READY_FOR_MODEL');assert.equal(made.body.sourceKind,'MANUAL');
 assert.equal((await f.call('/agent/tasks',body,{key,headers:f.session})).body.id,made.body.id);assert.equal((await f.client.request(`/agent/requests/${key}`)).id,made.body.id);
 assert.equal(f.received.length,0);assert.equal(f.counts.submits,1);assert.equal(f.store.list('delivery_package',PROJECT).length,0);
});
test('target-only window can inspect its successful parent but cannot create a new continuation',async t=>{
 const f=await setup(t,{targetOnly:true}),proof=await readAssistedContinuation(f.client,{taskId:f.agent.id});
 const result=await f.call('/agent/tasks',{message:'继续修改这个成功版本',sql:f.agent.sql,contextId:f.agent.contextId,assistedContinuation:proof.binding},{headers:f.session});
 assert.equal(result.status,403);assert.equal(f.received.length,0);assert.equal(f.store.list('agent',PROJECT).length,1);
});
test('CLI and MCP continue the same successful version through shared API with explicit consent and one caller request ID',async t=>{
 const f=await setup(t);
 for(const kind of['cli','mcp']){
   const requestId=randomUUID(),input={taskId:f.agent.id,message:'继续完善虚构证券成功代码',requestId,confirm:true};let created;
   if(kind==='cli')assert.equal(await runV2Cli(['agent','continue-version','--id',input.taskId,'--message',input.message,'--request-id',requestId,'--confirm'],{}, {client:f.client,output:value=>created=JSON.parse(value),error:()=>{}}),0);
   else{const value=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_assisted_continue',arguments:input}},{client:f.client}));assert.equal(value.error,undefined);created=JSON.parse(value.result.content[0].text);}
   assert.equal(created.sourceKind,'MANUAL');assert.equal(created.agentIndependentE2E,false);assert.equal(created.assistedContinuation.taskId,f.agent.id);assert.equal((await f.client.request(`/agent/requests/${requestId}`)).id,created.id);
 }
 const before=f.store.list('agent',PROJECT).length;
 const bad=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agent_assisted_continue',arguments:{taskId:f.agent.id,message:'继续修改代码',requestId:randomUUID(),confirm:true,actorId:'foreign'}}},{client:f.client}));assert(bad.error);assert.equal(f.store.list('agent',PROJECT).length,before);
 assert.equal(f.received.length,0);assert.equal(f.counts.submits,1);
});
test('lost creation acknowledgement is recovered with the same caller request, without automatic re-submission or model execution',async t=>{
 const f=await setup(t),requestId=randomUUID(),input={taskId:f.agent.id,message:'在原成功代码上继续完善',requestId,confirm:true};let posts=0;
 const client={request:async(path,options)=>{const value=await f.client.request(path,options);if(options?.method==='POST'){posts++;throw Error('synthetic response lost');}return value;}};
 await assert.rejects(createAssistedContinuation(client,input));assert.equal(posts,1);assert.equal(f.store.list('agent',PROJECT).length,2);
 const original=await f.client.request(`/agent/requests/${requestId}`),repeated=await createAssistedContinuation(f.client,input);assert.equal(repeated.id,original.id);
 assert.equal(f.store.list('agent',PROJECT).length,2);assert.equal(f.received.length,0);assert.equal(f.counts.submits,1);
});
