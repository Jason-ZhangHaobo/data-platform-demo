import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalSourceApiFixture} from './fixtures/local-service-api-journey.mjs';
import {seedRunComparison} from './fixtures/run-comparison.mjs';
import {PROJECT,createV2Server} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {BusinessQueryStore} from '../../src/v2/data-services.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

function seed(store,actorId='local-engineer'){
  const f=seedRunComparison({store,project:PROJECT,author:actorId});
  for(const side of [f.current,f.baseline])side.revision=store.update('revision',side.revision.id,PROJECT,{manualProvenance:{kind:'ENGINEER_EDIT',actorId,agentIndependentE2E:false}});
  return f;
}
test('legacy API accepts exact frozen comparison once, preserves source history, and refuses stale evidence or mixed intent',async t=>{
  const app=await createLocalSourceApiFixture();t.after(()=>app.dispose());const f=seed(app.store),original=structuredClone(f.current.run),parent=structuredClone(f.baseline.run);
  const path=`/runs/${f.current.run.id}/repair-comparison?baseline_run_id=${f.baseline.run.id}`,read=await app.call(path);assert.equal(read.status,200);assert.deepEqual(app.counts,{syntheticModel:0,syntheticSpark:0});
  const body={message:'参考该成功基线修正当前证券SQL',sql:f.current.revision.sql,contextId:f.context.id,sourceRunId:f.current.run.id,repairComparison:read.body.binding},headers={'idempotency-key':randomUUID()};
  for(const patch of [{sql:f.current.revision.sql+' '},{language:'PYTHON'},{repairComparison:{...read.body.binding,evidenceDigest:'a'.repeat(64)}},{derivation:{}},{sourceError:'override'}]){
    assert.notEqual((await app.call('/agent/tasks',{...body,...patch},{headers})).status,202);
  }
  assert.deepEqual(app.counts,{syntheticModel:0,syntheticSpark:0});
  const made=await app.call('/agent/tasks',body,{headers});assert.equal(made.status,202,JSON.stringify(made.body));
  assert.equal((await app.call('/agent/tasks',body,{headers})).body.id,made.body.id);
  const completed=await app.poll(`/agent/tasks/${made.body.id}`,v=>['SUCCEEDED','FAILED'].includes(v.status));assert.equal(completed.status,'SUCCEEDED');
  assert.equal(completed.sourceKind,'MANUAL');assert.equal(completed.agentIndependentE2E,false);assert.deepEqual(completed.repairComparison,read.body.binding);
  for(const kind of ['revision','run'])assert.equal(app.store.get(kind,kind==='revision'?completed.revisionId:completed.runId,PROJECT).agentIndependentE2E,false);
  assert.deepEqual(app.counts,{syntheticModel:1,syntheticSpark:1});
  assert.equal((await app.call(`/agent/tasks/${completed.id}/prepare-delivery`,{})).status,409,'assisted result cannot be laundered through native Agent delivery');
  const artifact=await app.call('/delivery/packages',{sourceRunId:completed.runId,name:'虚构人工辅助开发文件'});assert.equal(artifact.status,201,JSON.stringify(artifact.body));
  assert.equal(artifact.body.manifest.source.attribution.kind,'ENGINEER_ASSISTED');assert.equal(artifact.body.manifest.source.attribution.originAgentTaskId,completed.id);
  assert.deepEqual(app.store.get('run',f.current.run.id,PROJECT),original);assert.deepEqual(app.store.get('run',f.baseline.run.id,PROJECT),parent);
  app.store.update('run',f.baseline.run.id,PROJECT,{log:'synthetic saved evidence changed'});
  assert.equal((await app.call('/agent/tasks',body,{headers:{'idempotency-key':randomUUID()}})).status,409);
});
test('invited owner and CSRF are enforced for durable comparison creation, including baseline ownership and no paid GET',async t=>{
  const store=new MetadataStore(':memory:'),businessStore=new BusinessQueryStore();let calls=0;
  const deny=async()=>{calls++;throw Error('NO_EXECUTION');},runner=Object.assign(deny,{durable:{prepare:deny,submit:deny,read:deny,cancel:deny},descriptor:{engine:'Apache Spark',isolation:'REMOTE_FUNCTION',publicWriteEnabled:true,healthVerified:true}});
  const app=createV2Server({store,businessStore,runner,generator:deny,env:{V2_LOCAL_DEVELOPMENT:'false',V2_DURABLE_SQL_AGENT_ENABLED:'true',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));businessStore.close();store.close();});
  const password='SyntheticOwner#2026',admin=app.auth.bootstrapAdmin({email:'comparison-admin@example.invalid',displayName:'虚构管理员',password}),login=app.auth.login({email:admin.email,password}),actor=app.auth.sessionFromHeaders({cookie:`shuduo_session=${login.rawToken}`});
  const invite=app.auth.createInvitation(actor,{email:'owner@example.invalid',role:'ENGINEER'}),owner=app.auth.redeemInvitation({inviteCode:invite.inviteCode,displayName:'虚构工程师',password}),otherInvite=app.auth.createInvitation(actor,{email:'other@example.invalid',role:'ENGINEER'}),other=app.auth.redeemInvitation({inviteCode:otherInvite.inviteCode,displayName:'另一工程师',password});
  const f=seed(store,owner.user.id),base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
  const call=async(path,body,who=owner,csrf=owner.csrfToken)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':'same-original-request',cookie:`shuduo_session=${who.rawToken}`,'x-csrf-token':csrf},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
  const path=`/runs/${f.current.run.id}/repair-comparison?baseline_run_id=${f.baseline.run.id}`,basis=await call(path);assert.equal(basis.status,200);
  assert.equal((await call(path,undefined,other)).status,403);
  const foreign=seed(store,other.user.id);assert.equal((await call(`/runs/${f.current.run.id}/repair-comparison?baseline_run_id=${foreign.baseline.run.id}`)).status,403);
  const body={message:'参考该成功基线修正证券SQL',sql:f.current.revision.sql,contextId:f.context.id,sourceRunId:f.current.run.id,repairComparison:basis.body.binding};
  assert.equal((await call('/agent/tasks',body,owner,'invalid')).status,403);
  const made=await call('/agent/tasks',body);assert.equal(made.status,202,JSON.stringify(made.body));assert.equal(made.body.stage,'READY_FOR_MODEL');
  assert.equal((await call('/agent/tasks',body)).body.id,made.body.id);assert.equal(calls,0);
});
test('CLI and MCP use the same comparison API, preserve caller request ID and refuse missing delegation',async t=>{
  const app=await createLocalSourceApiFixture();t.after(()=>app.dispose());const f=seed(app.store);
  for(const kind of ['cli','mcp']){
    const client=new V2Client({baseUrl:app.base,client:kind}),requestId=randomUUID(),input={sourceRunId:f.current.run.id,baselineRunId:f.baseline.run.id,message:'参考同口径基线修正证券SQL',requestId,confirm:true};let result;
    if(kind==='cli'){
      const args=['agent','repair-compare','--source-run-id',input.sourceRunId,'--baseline-run-id',input.baselineRunId,'--message',input.message,'--request-id',requestId,'--confirm'];
      assert.equal(await runV2Cli(args,{}, {client,output:v=>{result=v;},error:()=>{}}),0);
      assert.equal(await runV2Cli([...args,'--confirm'],{}, {client,output:()=>{},error:()=>{}}),1);
    }else{
      const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_repair_comparison_create',arguments:input}},{client}));assert.equal(reply.error,undefined);
      result=JSON.parse(reply.result.content[0].text);
      const invalid=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agent_repair_comparison_create',arguments:{...input,confirm:false}}},{client}));assert(invalid.error);
    }
    if(typeof result==='string')result=JSON.parse(result);
    assert.equal(result.sourceKind,'MANUAL');assert.equal(result.agentIndependentE2E,false);
    const task=await app.poll(`/agent/tasks/${result.id}`,v=>['SUCCEEDED','FAILED'].includes(v.status));assert.equal(task.status,'SUCCEEDED');
    assert.equal((await app.call(`/agent/requests/${requestId}`)).body.id,task.id);
  }
});
test('logged-in local legacy SQL uses the same account for basis and repair creation',async t=>{
  const app=await createLocalSourceApiFixture();t.after(()=>app.dispose());
  const password='SyntheticLocal#2026',owner=app.auth.bootstrapAdmin({email:'local-owner@example.invalid',displayName:'虚构本机工程师',password}),
    login=app.auth.login({email:owner.email,password}),headers={cookie:`shuduo_session=${login.rawToken}`,'x-csrf-token':login.csrfToken},f=seed(app.store,owner.id);
  const basis=await app.call(`/runs/${f.current.run.id}/repair-comparison?baseline_run_id=${f.baseline.run.id}`,undefined,{headers});assert.equal(basis.status,200);
  const made=await app.call('/agent/tasks',{message:'参考基线修正本机证券SQL',sql:f.current.revision.sql,contextId:f.context.id,sourceRunId:f.current.run.id,repairComparison:basis.body.binding},{headers});
  assert.equal(made.status,202,JSON.stringify(made.body));assert.equal(made.body.submittedBy,owner.id);
  const done=await app.poll(`/agent/tasks/${made.body.id}`,v=>['SUCCEEDED','FAILED'].includes(v.status));assert.equal(done.status,'SUCCEEDED');
  assert.equal(app.store.get('revision',done.revisionId,PROJECT).author,owner.id);
});
