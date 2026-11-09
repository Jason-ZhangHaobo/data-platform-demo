import test from 'node:test';
import assert from 'node:assert/strict';
import {assistedDeliveryFixture} from './fixtures/assisted-sql-delivery.mjs';
import {PROJECT,createV2Server} from '../../src/v2/server.mjs';
import {BusinessQueryStore} from '../../src/v2/data-services.mjs';
import {checkedAgentWorkflow} from '../../web/src/agent-workflow-read.ts';

test('invited target-only repair delivery uses existing manual API, CSRF and time window with frozen source proof',async t=>{
  const f=await assistedDeliveryFixture({project:PROJECT}),businessStore=new BusinessQueryStore();let clock=Date.now();
  const deny=async()=>{throw Error('blocking runner must not run');};deny.durable=f.runner;deny.descriptor={engine:'Apache Spark',isolation:'REMOTE_FUNCTION',publicWriteEnabled:true,healthVerified:true};
  const app=createV2Server({root:f.root,store:f.store,businessStore,runner:deny,artifactStore:f.artifactStore,now:()=>clock,ingress:{assertRequest:()=> 'HTTP',status:{publicReadOnly:false}},
    env:{V2_LOCAL_DEVELOPMENT:'false',V2_DURABLE_SQL_AGENT_ENABLED:'true',V2_PUBLIC_ORIGIN:'https://fixture.invalid',V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',V2_BOOTSTRAP_ADMIN_EMAIL:f.actor.email,
      V2_PUBLIC_DEVELOPMENT_TASK_ID:f.agent.id,V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(clock-60000).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(clock+3600000).toISOString()}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));businessStore.close();f.dispose();});
  const call=async(path,body,headers={})=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2`+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://fixture.invalid','x-shuduo-client':'workbench','content-type':'application/json','idempotency-key':'synthetic-original-handoff',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  const login=await call('/auth/login',{email:f.actor.email,password:'SyntheticAssisted!2026'});assert.equal(login.status,200,JSON.stringify({code:login.body.code,message:login.body.message}));
  const session={cookie:login.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':login.body.csrfToken},path=`/runs/${f.run.id}`,
    selection={taskId:f.agent.id,runId:f.run.id,revisionId:f.revision.id,contextId:f.agent.contextId,manual:true,assisted:true};
  assert.equal((await call(path+'/workflow')).status,401);
  const initial=await call(path+'/workflow',undefined,session);assert.equal(initial.status,200);await checkedAgentWorkflow(initial.body,selection);
  assert.equal(initial.body.report.developmentReference.evidenceDigest,f.basis.binding.evidenceDigest);
  assert.equal((await call(path+'/prepare-delivery',{}, {...session,'x-csrf-token':'wrong'})).status,403);
  assert.equal((await call(path+'/prepare-delivery',{sourceRunId:f.source.baseline.run.id},session)).status,422);
  assert.equal((await call(`/agent/tasks/${f.agent.id}/prepare-delivery`,{},session)).status,409,'native preparation remains closed');
  const made=await call(path+'/prepare-delivery',{},session);assert.equal(made.status,202,JSON.stringify(made.body));assert.equal(made.body.sourceKind,'MANUAL');
  assert.equal((await call(path+'/prepare-delivery',{},session)).body.id,made.body.id);assert.equal(f.counts.submits,1);assert.equal(f.store.list('delivery_package',PROJECT).length,1);
  const packaged=await call(path+'/workflow',undefined,session);await checkedAgentWorkflow(packaged.body,selection);assert.deepEqual(packaged.body.package.manifest.source.attribution.developmentReference,initial.body.report.developmentReference);
  for(const mutate of [v=>{delete v.report.developmentReference;},v=>{delete v.package.manifest.source.attribution.developmentReference;},v=>{v.delivery.developmentReference.baselineRunId=f.run.id;},v=>{v.report.sourceKind='AGENT';}]){
    const value=structuredClone(packaged.body);mutate(value);await assert.rejects(checkedAgentWorkflow(value,selection));
  }
  clock+=3600001;
  assert.equal((await call(`/agent/deliveries/${made.body.id}/advance`,{expectedVersion:made.body.version},session)).status,403);assert.equal(f.counts.submits,1);
  assert.equal((await call(path+'/workflow',undefined,session)).status,200,'expiry keeps existing files readable');
  assert.equal(f.store.list('release_approval',PROJECT).length,0);assert.equal(f.store.list('release',PROJECT).length,0);
});
