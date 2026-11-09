import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {manualSuccessFixture} from './fixtures/manual-success-continuation.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {BusinessQueryStore} from '../../src/v2/data-services.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {readManualContinuation,createManualContinuation} from '../../src/v2/manual-continuation-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
async function setup(t,{local=false}={}){
 const f=manualSuccessFixture({project:PROJECT,autoComplete:true}),businessStore=new BusinessQueryStore();
 const raw=async()=>{throw Error('No blocking engine in protocol tests');};raw.durable=f.runner;raw.descriptor={engine:'Apache Spark',isolation:'REMOTE_FUNCTION',healthVerified:true,publicWriteEnabled:true};
 const app=createV2Server({root:f.root,store:f.store,businessStore,runner:raw,generator:f.generator,artifactStore:f.artifactStore,
   env:{V2_LOCAL_DEVELOPMENT:String(local),V2_DURABLE_SQL_AGENT_ENABLED:'true',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PUBLIC_ORIGIN:'https://fixture.invalid',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));businessStore.close();f.dispose();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,origin=local?base.slice(0,-'/api/v2'.length):'https://fixture.invalid',call=async(path,body,{headers={},key=randomUUID()}={})=>{
   const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};
 };
 const login=await call('/auth/login',{email:f.actor.email,password:'SyntheticManual!2026'});assert.equal(login.status,200);
 const session={cookie:login.cookies.map(v=>v.split(';')[0]).join('; '),'x-csrf-token':login.body.csrfToken},client=new V2Client({baseUrl:base,fetchImpl:(u,o)=>fetch(u,{...o,headers:{...o.headers,...session,origin}})});
 return{...f,app,call,session,client};
}
test('authenticated standalone manual version creates no parent task; exact proof, CSRF, ownership and original request lookup hold',async t=>{
 const f=await setup(t),path=`/runs/${f.run.id}/manual-continuation`,proof=await readManualContinuation(f.client,{sourceRunId:f.run.id});assert.equal(f.store.list('agent',PROJECT).length,0);
 assert.equal((await f.call(path)).status,401);assert.equal((await f.call(path+'?sql=ignored',undefined,{headers:f.session})).status,422);
 const other=f.app.auth.bootstrapAdmin({email:'foreign-manual@example.invalid',displayName:'虚构其他管理员',password:'SyntheticForeign!2026'}),login=await f.call('/auth/login',{email:other.email,password:'SyntheticForeign!2026'});
 assert.equal((await f.call(path,undefined,{headers:{cookie:login.cookies.map(v=>v.split(';')[0]).join('; ')}})).status,403);
 const body={message:'修改这个手工成功的证券SQL',sql:f.revision.sql,contextId:f.context.id,manualContinuation:proof.binding},key=randomUUID();
 assert.equal((await f.call('/agent/tasks',body,{key,headers:{...f.session,'x-csrf-token':'wrong'}})).status,403);
 for(const patch of[{sql:body.sql+' '},{contextId:'stock-cash-t1'},{sourceRunId:f.run.id},{assistedContinuation:{}},{derivation:{}},{repairComparison:{}},{language:'PYTHON'}])assert.notEqual((await f.call('/agent/tasks',{...body,...patch},{key,headers:f.session})).status,202);
 const made=await f.call('/agent/tasks',body,{key,headers:f.session});assert.equal(made.status,202,JSON.stringify(made.body));assert.equal(made.body.sourceKind,'MANUAL');assert.equal(made.body.stage,'READY_FOR_MODEL');
 assert.equal(made.body.manualContinuation.originAgentTaskId,undefined);assert.equal((await f.call('/agent/tasks',body,{key,headers:f.session})).body.id,made.body.id);
 assert.equal((await f.client.request(`/agent/requests/${key}`)).id,made.body.id);assert.equal(f.store.list('agent',PROJECT).length,1);assert.deepEqual(f.counts,{model:0,submits:0});
});
test('classic save and run controller produces an eligible local authenticated version with the same author as the new Agent task',async t=>{
 const f=await setup(t,{local:true}),key=randomUUID(),saved=await f.call('/revisions',{sql:f.revision.sql,contextId:f.context.id},{headers:f.session,key});assert.equal(saved.status,201);
 assert.equal(saved.body.author,f.actor.id);const again=await f.client.request(`/revisions/requests/${key}`);assert.equal(again.revision.id,saved.body.id);
 const started=await f.call('/runs',{revisionId:saved.body.id},{headers:f.session});assert.equal(started.status,202,JSON.stringify(started.body));
 let run=await f.client.request(`/runs/${started.body.id}`);if(run.status!=='SUCCEEDED')run=await f.client.request(`/runs/${started.body.id}`);assert.equal(run.status,'SUCCEEDED');
 const proof=await readManualContinuation(f.client,{sourceRunId:run.id,revisionId:saved.body.id}),made=await f.call('/agent/tasks',{message:'从编辑器成功SQL继续优化',sql:saved.body.sql,contextId:f.context.id,manualContinuation:proof.binding},{headers:f.session});
 assert.equal(made.status,202,JSON.stringify(made.body));assert.equal(f.store.get('agent',made.body.id,PROJECT).submittedBy,f.actor.id);assert.equal(f.counts.model,0);
});
test('CLI/MCP share the manual proof and stable write request, and unknown acknowledgement never auto-retries',async t=>{
 const f=await setup(t);for(const kind of['cli','mcp']){const requestId=randomUUID(),input={sourceRunId:f.run.id,message:'优化已核验的手工证券代码',requestId,confirm:true};let value;
  if(kind==='cli')assert.equal(await runV2Cli(['agent','continue-manual','--source-run-id',input.sourceRunId,'--message',input.message,'--request-id',requestId,'--confirm'],{}, {client:f.client,output:v=>value=JSON.parse(v),error:()=>{}}),0);
  else{const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_continue_manual',arguments:input}},{client:f.client}));assert.equal(reply.error,undefined);value=JSON.parse(reply.result.content[0].text);}
  assert.equal(value.agentIndependentE2E,false);assert.equal((await f.client.request(`/agent/requests/${requestId}`)).id,value.id);
 }
 let posts=0;const requestId=randomUUID(),input={sourceRunId:f.run.id,message:'明确继续修改这个手工版本',requestId,confirm:true},client={request:async(p,o)=>{const value=await f.client.request(p,o);if(o?.method==='POST'){posts++;throw Error('synthetic reply unknown');}return value;}};
 await assert.rejects(createManualContinuation(client,input));assert.equal(posts,1);const original=await f.client.request(`/agent/requests/${requestId}`);assert.equal((await createManualContinuation(f.client,input)).id,original.id);
 const before=f.store.list('agent',PROJECT).length,bad=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agent_continue_manual',arguments:{...input,actorId:'foreign'}}},{client:f.client}));assert(bad.error);assert.equal(f.store.list('agent',PROJECT).length,before);assert.equal(f.counts.model,0);
});
