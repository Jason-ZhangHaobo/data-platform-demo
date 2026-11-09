import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {manualSuccessFixture} from './fixtures/manual-success-continuation.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';import {BusinessQueryStore} from '../../src/v2/data-services.mjs';
import {V2Client} from '../../src/v2/client.mjs';import {readStandaloneWorkflow,readStandaloneDetail,prepareStandaloneManual,mutateStandaloneManual} from '../../src/v2/standalone-manual-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
async function setup(t,{window=false,target=false}={}){
 const f=manualSuccessFixture({project:PROJECT,autoComplete:true}),businessStore=new BusinessQueryStore();let clock=Date.now();const raw=async()=>{throw Error('no blocking runner');};raw.durable=f.runner;raw.descriptor={engine:'Apache Spark',isolation:'REMOTE_FUNCTION',healthVerified:true,publicWriteEnabled:true};
 const env={V2_LOCAL_DEVELOPMENT:'false',V2_DURABLE_SQL_AGENT_ENABLED:'false',V2_DURABLE_MANUAL_DELIVERY_ENABLED:'true',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PUBLIC_ORIGIN:'https://fixture.invalid',V2_RELEASE_SCHEDULER_MODE:'DISABLED',...(window?{V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',V2_BOOTSTRAP_ADMIN_EMAIL:f.actor.email,V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(clock-1000).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(clock+60000).toISOString(),...(target?{V2_PUBLIC_DEVELOPMENT_TASK_ID:randomUUID()}:{})}:{})};
 const app=createV2Server({root:f.root,store:f.store,businessStore,runner:raw,generator:f.generator,artifactStore:f.artifactStore,now:()=>clock,env,...(window?{ingress:{assertRequest:()=> 'HTTP',status:{publicReadOnly:false}}}:{})});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));businessStore.close();f.dispose();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,call=async(path,body,headers={})=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://fixture.invalid','content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':randomUUID(),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
 const login=await call('/auth/login',{email:f.actor.email,password:'SyntheticManual!2026'});assert.equal(login.status,200);const session={cookie:login.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':login.body.csrfToken},client=new V2Client({baseUrl:base,fetchImpl:(u,o)=>fetch(u,{...o,headers:{...o.headers,...session,origin:'https://fixture.invalid'}})});
 return{...f,app,call,session,client,later:()=>{clock+=60001;}};
}
test('model-disabled invited API prepares and rehearses a standalone manual version with no Agent task',async t=>{
 const f=await setup(t),source={sourceRunId:f.run.id},before=await readStandaloneWorkflow(f.client,source);assert.equal(before.executionAvailable,true);assert.equal(before.modelRequired,false);assert.equal(before.report.taskId,undefined);
 assert.equal((await f.call(`/delivery/manual/source/${f.run.id}`)).status,401);assert.equal((await f.call(`/delivery/manual/source/${f.run.id}?actorId=ignored`,undefined,f.session)).status,422);
 const body={sourceBinding:before.sourceBinding};assert.equal((await f.call('/delivery/manual',body,{...f.session,'x-csrf-token':'wrong'})).status,403);assert.equal((await f.call('/delivery/manual',{...body,agentTaskId:randomUUID()},f.session)).status,422);
 let task=await prepareStandaloneManual(f.client,{...source,requestId:randomUUID(),confirm:true});assert.equal(f.counts.submits,0);assert.equal((await readStandaloneWorkflow(f.client,source)).delivery.id,task.id);
 assert.equal((await f.call(`/delivery/manual/${task.id}/advance`,{expectedVersion:task.version-1},f.session)).status,409);
 task=await mutateStandaloneManual(f.client,{...source,taskId:task.id,expectedVersion:task.version,operation:'advance',confirm:true});assert.equal(task.status,'SUCCEEDED');
 const detail=await readStandaloneDetail(f.client,{...source,taskId:task.id}),workflow=await readStandaloneWorkflow(f.client,source);assert.equal(detail.verification.id,workflow.verification.id);assert.equal(workflow.package.manifest.source.attribution.kind,'ENGINEER_AUTHORED');assert.equal(workflow.publication.available,false);
 for(const mutate of[v=>{v.verification.validation.regressions=[];},v=>{v.verification.testSqlValidation.sqlHash='a'.repeat(64);},v=>{v.verification.manualDeliveryTaskId=randomUUID();},v=>{v.delivery.publicDeployed=true;}]){const bad=structuredClone(workflow);mutate(bad);await assert.rejects(readStandaloneWorkflow({request:async()=>bad},source));}
 assert.deepEqual(f.counts,{model:0,submits:1});assert.equal(f.store.list('agent',PROJECT).length,0);assert.equal(f.store.list('agent_delivery_task',PROJECT).length,0);assert.equal(f.store.list('release',PROJECT).length,0);
 const foreign=f.app.auth.bootstrapAdmin({email:'foreign-manual@example.invalid',displayName:'虚构其他管理员',password:'SyntheticForeign!2026'}),login=await f.call('/auth/login',{email:foreign.email,password:'SyntheticForeign!2026'}),headers={cookie:login.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':login.body.csrfToken};
 for(const path of[`/delivery/manual/source/${f.run.id}`,`/delivery/manual/${task.id}`])assert.equal((await f.call(path,undefined,headers)).status,403);
 assert.equal((await f.call(`/delivery/manual/${task.id}/cancel`,{expectedVersion:task.version},headers)).status,403);
});
test('CLI and MCP share exact files, stable prepare requests, explicit mutations and recovery reads',async t=>{
 const f=await setup(t),sourceRunId=f.run.id,requestId=randomUUID();let value;
 const cli=async args=>runV2Cli(['manual',...args],{}, {client:f.client,output:v=>value=JSON.parse(v),error:()=>{}}),mcp=async(name,args)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:f.client}));
 assert.equal(await cli(['workflow','--source-run-id',sourceRunId]),0);assert.equal(value.report.status,'PASSED');
 assert.equal(await cli(['prepare','--source-run-id',sourceRunId,'--request-id',requestId,'--confirm']),0);const task=value;
 const reply=await mcp('manual_delivery_prepare',{sourceRunId,requestId,confirm:true});assert.equal(reply.error,undefined);assert.equal(JSON.parse(reply.result.content[0].text).id,task.id);
 assert.equal(await cli(['advance','--source-run-id',sourceRunId,'--id',task.id,'--version',String(task.version),'--confirm']),0);assert.equal(value.status,'SUCCEEDED');
 const read=await mcp('manual_delivery_detail',{sourceRunId,taskId:task.id});assert.equal(read.error,undefined);assert.equal(JSON.parse(read.result.content[0].text).delivery.id,task.id);assert.equal(f.counts.submits,1);
 for(const args of[['prepare','--source-run-id',sourceRunId,'--request-id',randomUUID()],['workflow','--source-run-id',sourceRunId,'--actor-id','forged'],['workflow','--source-run-id',sourceRunId,'--source-run-id',sourceRunId]])assert.equal(await cli(args),1);
 assert((await mcp('manual_delivery_cancel',{sourceRunId,taskId:task.id,expectedVersion:value.version,confirm:false})).error);
 assert.equal(f.counts.model,0);assert.equal(f.store.list('manual_delivery_task',PROJECT).length,1);
});
test('unknown successful preparation reply is recovered read-only; corrupted bindings, attribution or file bytes are rejected',async t=>{
 const f=await setup(t),selection={sourceRunId:f.run.id},input={...selection,requestId:randomUUID(),confirm:true};let posts=0;
 await assert.rejects(prepareStandaloneManual({request:async(p,o)=>{const v=await f.client.request(p,o);if(o?.method==='POST'){posts++;throw Error('synthetic reply unknown');}return v;}},input));
 assert.equal(posts,1);const original=await readStandaloneWorkflow(f.client,selection);assert.equal(f.counts.submits,0);assert.equal((await prepareStandaloneManual(f.client,input)).id,original.delivery.id);
 for(const mutate of[v=>{v.report.checks=[];},v=>{v.developmentReference.sourceRunId=randomUUID();},v=>{v.delivery.sourceAgentTaskId=randomUUID();},v=>{v.delivery.source.runId=randomUUID();},v=>{v.package.files['main.sql']+=' ';},v=>{v.package.manifest.source.attribution.kind='AGENT';},v=>{v.sourceCurrent=false;}]){const wrong=structuredClone(original);mutate(wrong);await assert.rejects(readStandaloneWorkflow({request:async()=>wrong},selection));}
 assert.equal(f.store.list('manual_delivery_task',PROJECT).length,1);assert.equal(f.store.list('release_approval',PROJECT).length,0);
});
test('manual-only development window expires before new computation but keeps original files readable',async t=>{
 const f=await setup(t,{window:true}),source={sourceRunId:f.run.id},task=await prepareStandaloneManual(f.client,{...source,requestId:randomUUID(),confirm:true});f.later();
 assert.equal((await f.call(`/delivery/manual/${task.id}/advance`,{expectedVersion:task.version},f.session)).status,403);assert.equal((await readStandaloneWorkflow(f.client,source)).delivery.id,task.id);assert.equal(f.counts.submits,0);
});
test('an old Agent-target-only window never expands to standalone manual delivery',async t=>{
 const f=await setup(t,{window:true,target:true});await assert.rejects(readStandaloneWorkflow(f.client,{sourceRunId:f.run.id}),e=>e.status===403);
 assert.equal((await f.call('/delivery/manual',{sourceBinding:f.proof().binding},f.session)).status,403);assert.equal(f.store.list('manual_delivery_task',PROJECT).length,0);assert.equal(f.counts.model,0);
});
