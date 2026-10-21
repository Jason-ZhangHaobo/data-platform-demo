import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore} from '../../src/v2/store.mjs';
import {saveManualRevision,savedManualRevision} from '../../src/v2/manual-revisions.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {referenceSql} from '../../src/v2/context.mjs';

test('manual save is atomic, actor scoped, conflict safe and survives reopening metadata',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'manual-revision-')),'state.sqlite');
  let store=new MetadataStore(path);
  const input={project:PROJECT,actor:'fictional-engineer-a',key:'request-one',sql:referenceSql,contextId:'holdings-t1',originAgentTaskId:'fictional-agent'};
  const first=saveManualRevision({...input,store});
  assert.equal(first.replayed,false);
  assert.equal(saveManualRevision({...input,store}).revision.id,first.revision.id);
  assert.throws(()=>saveManualRevision({...input,store,sql:'SELECT 2'}),e=>e.status===409);
  assert.throws(()=>saveManualRevision({...input,store,originAgentTaskId:'other'}),e=>e.status===409);
  assert.equal(savedManualRevision({...input,store,actor:'other-engineer'}),undefined);
  assert.equal(savedManualRevision({...input,store,project:'other-project'}),undefined);
  store.close();store=new MetadataStore(path);
  try {
    const restored=savedManualRevision({...input,store});
    assert.equal(restored.id,first.revision.id);assert.equal(restored.source,'MANUAL');
    assert.equal(restored.manualProvenance.originAgentTaskId,input.originAgentTaskId);
    assert.equal(restored.manualProvenance.agentIndependentE2E,false);
    assert.equal(store.list('revision',PROJECT).length,1);
    const other=saveManualRevision({...input,store,actor:'other-engineer'});
    assert.notEqual(other.revision.id,restored.id);
    assert.equal(store.list('run',PROJECT).length,0);
  } finally {store.close();}
});

test('failed durable metadata save cannot be reported recovered until persistence succeeds',async t=>{
  const store=new MetadataStore(':memory:'),root=mkdtempSync(join(tmpdir(),'manual-save-flush-'));let fail=true;
  const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'},stateCoordinator:{flush:async()=>{if(fail)throw Error('synthetic persistence failure');}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
  const post=()=>fetch(base+'/revisions',{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':'lost-save'},body:JSON.stringify({sql:referenceSql,contextId:'holdings-t1'})});
  assert.equal((await post()).status,503);
  const failedRead=await fetch(base+'/revisions/requests/lost-save');assert(failedRead.status>=500);assert.notEqual((await failedRead.json()).status,'SAVED');
  fail=false;
  const read=await fetch(base+'/revisions/requests/lost-save');assert.equal(read.status,200);
  const recovered=await read.json();assert.equal(recovered.status,'SAVED');
  assert.equal((await(await post()).json()).id,recovered.revision.id);
  assert.equal(store.list('revision',PROJECT).length,1);assert.equal(store.list('run',PROJECT).length,0);
});

test('invited save recovery enforces identity, CSRF, source ownership and context without execution',async t=>{
  const root=mkdtempSync(join(tmpdir(),'manual-revision-http-')),store=new MetadataStore(':memory:');
  const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'false',V2_HOST:'127.0.0.1',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,password='Fictional-Test!2026';
  const owners=['first','second'].map(name=>app.auth.bootstrapAdmin({email:`${name}@example.invalid`,password,displayName:name}));
  for(const user of owners)store.update('auth_user',user.id,PROJECT,{memberships:[{projectId:PROJECT,role:'ENGINEER'}]});
  const call=async(path,body,headers={})=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':'save-one',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  const login=async email=>{const r=await call('/auth/login',{email,password});return{cookie:r.cookies.map(x=>x.split(';')[0]).join('; '),'x-csrf-token':r.body.csrfToken};};
  const a=await login('first@example.invalid'),b=await login('second@example.invalid');
  const agent=store.create('agent',PROJECT,{submittedBy:owners[0].id,contextId:'holdings-t1',executionMode:'DURABLE_SQL_AGENT_V1',status:'FAILED'});
  const input={sql:referenceSql,contextId:'holdings-t1',originAgentTaskId:agent.id};
  assert.equal((await call('/revisions',input,{cookie:a.cookie})).status,403);
  assert.equal((await call('/revisions',input,b)).status,403);
  assert.equal((await call('/revisions',{...input,contextId:'cash-change'},a)).status,409);
  assert.equal((await call('/revisions',{...input,manualProvenance:{actorId:'forged'}},a)).status,400);
  const first=await call('/revisions',input,a);assert.equal(first.status,201);
  const repeat=await call('/revisions',input,a);assert.equal(repeat.status,200);assert.equal(repeat.body.id,first.body.id);
  assert.equal((await call('/revisions',{...input,sql:'SELECT 1'},a)).status,409);
  const recovered=await call('/revisions/requests/save-one',undefined,a);assert.equal(recovered.status,200);assert.equal(recovered.body.revision.id,first.body.id);
  assert.equal(recovered.body.revision.manualProvenance.actorId,owners[0].id);
  const other=await call('/revisions/requests/save-one',undefined,b);assert.equal(other.body.status,'NOT_FOUND');assert.equal(other.body.revision,undefined);
  assert.equal((await call('/revisions/requests/save-one')).status,401);
  assert.equal(store.list('revision',PROJECT).length,1);assert.equal(store.list('run',PROJECT).length,0);assert.equal(store.get('agent',agent.id,PROJECT).status,'FAILED');
});
