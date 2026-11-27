import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createFcIngress} from '../../src/v2/fc-ingress.mjs';
import {seedContextDerivation} from './fixtures/agent-context-derivation.mjs';

// Persisted fictional rows exercise both FC modes. No Worker or provider is
// contacted; assertions below check what this stored data can actually prove.
async function fixture(t,readOnly) {
  const root=mkdtempSync(join(tmpdir(),'invited-context-')),store=new MetadataStore(':memory:');
  const ownerEmail='owner@example.invalid',otherEmail='other@example.invalid',password='SyntheticInvite#2027';
  const now=Date.now(), effects=[];
  const forbidden=async()=>{effects.push('compute');throw Error('Unexpected compute');};
  const runner=Object.assign(forbidden,{durable:{prepare:forbidden,submit:forbidden,read:forbidden,cancel:forbidden}});
  const env={V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_HOST:'127.0.0.1',
    V2_PUBLIC_ORIGIN:'https://fixture.invalid',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',
    ...(!readOnly?{V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',V2_DURABLE_SQL_AGENT_ENABLED:'true',
      V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(now-60000).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(now+3600000).toISOString(),
      V2_BOOTSTRAP_ADMIN_EMAIL:ownerEmail}:{})};
  const app=createV2Server({root,store,env,runner,generator:forbidden,intentPlanner:forbidden,
    ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:readOnly})});
  app.auth.bootstrapAdmin({email:otherEmail,password,displayName:'其他管理员'});
  let owner;
  if (readOnly) {
    const issuerSession=app.auth.login({email:otherEmail,password});
    const issuer=app.auth.sessionFromHeaders({cookie:'shuduo_session='+issuerSession.rawToken});
    const invite=app.auth.createInvitation(issuer,{email:ownerEmail,role:'ENGINEER'});
    owner=app.auth.redeemInvitation({inviteCode:invite.inviteCode,displayName:'原工程师',password}).user;
  } else owner=app.auth.bootstrapAdmin({email:ownerEmail,password,displayName:'原创建者'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.dispose();store.close();rmSync(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port+'/api/v2';
  async function call(path,cookie,body,headers={}) {
    const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:env.V2_PUBLIC_ORIGIN,
      'content-type':'application/json','x-shuduo-client':'workbench',...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json(),cookie:r.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
  }
  const logged=await call('/auth/login',null,{email:ownerEmail,password});
  assert.equal(logged.status,200);
  assert.equal(logged.body.readOnly,readOnly);
  assert.equal(logged.body.role,readOnly?'ENGINEER':'ADMIN');
  const other=await call('/auth/login',null,{email:otherEmail,password});assert.equal(other.status,200);
  function seed(contextId) {
    const f=seedContextDerivation(store,PROJECT,{actorId:owner.id,contextId});
    const task=store.update('agent',f.task.id,PROJECT,{initialSql:'SELECT 1',message:'请按登记口径核对 '+contextId+' 的客户资产',
      executionMode:'DURABLE_SQL_AGENT_V1',stage:'SUCCEEDED',error:'SYNTHETIC_PRIVATE_ERROR_TEXT'});
    const run=store.update('run',f.run.id,PROJECT,{mode:'DURABLE_REMOTE_SUBMISSION',isolation:'FUNCTION_PROCESS',
      stage:'COMPLETED',finishedAt:new Date().toISOString(),remoteSubmission:{prepared:{job:{jobId:f.run.id,privateField:'SYNTHETIC_PRIVATE_JOB'}}}});
    const key=randomUUID();store.deduplicate(PROJECT+':durable-agent:'+owner.id+':'+key,'fixture',()=>task);
    return {...f,task,run,key,path:'/agent/tasks/'+task.id+'/chat-context'};
  }
  return {store,owner,call,seed,cookie:logged.cookie,other:other.cookie,effects};
}

for(const [label,readOnly] of [['FC read-only',true],['development-only FC',false]]){
  test(label+' restores only the creator’s native SQL context without a planning intent or new execution',async t=>{
    const f=await fixture(t,readOnly),a=f.seed('holdings-t1'),b=f.seed('stock-cash-t1');
    const before=f.store.list('agent',PROJECT);
    const r=await f.call(a.path+'?request_id='+a.key,f.cookie);
    assert.equal(r.status,200);
    assert.equal(r.body.evidenceState,'RECORDED');
    assert.equal(r.body.evidenceSource,'STORED_METADATA');
    assert.equal(r.body.taskId,a.task.id);assert.equal(r.body.message,a.task.message);assert.equal(r.body.requestId,a.key);
    assert.equal(r.body.readOnly,true);assert.equal(r.body.fullLifecycleE2E,false);
    assert.deepEqual(r.body.revision,{id:a.revision.id,hash:a.revision.hash,sql:a.sql});
    assert.equal(r.body.run.id,a.run.id);assert.equal(r.body.run.validation.state,'PASSED');
    assert.deepEqual(r.body.run.validation.regressions,a.family.contextIds.map(contextId=>({contextId,passed:true})));
    assert.doesNotMatch(JSON.stringify(r.body),/SYNTHETIC_PRIVATE|"remoteSubmission"|"rows"|"usedTokens"|"submittedBy"|"leaseToken"/);
    const reopened=await f.call(a.path,f.cookie);
    const {requestId,...expected}=r.body;assert.deepEqual(reopened.body,expected);
    assert.equal((await f.call(b.path,f.cookie)).body.run.id,b.run.id);
    assert.equal((await f.call(a.path)).status,401);assert.equal((await f.call(a.path,f.other)).status,404);
    assert.equal((await f.call(a.path+'?request_id='+b.key,f.cookie)).status,404);
    for(const q of ['?request_id='+a.key+'&request_id='+b.key,'?actor=other','?request_id='])assert.equal((await f.call(a.path+q,f.cookie)).status,422);
    assert.equal((await f.call(a.path,f.cookie,undefined,{'x-project-id':'wrong-project'})).status,403);
    assert.equal((await f.call(a.path,f.cookie,undefined,{authorization:'Bearer synthetic-unrelated'})).status,403);
    assert.equal((await f.call('/agent/tasks/'+a.task.id,f.other)).status,200);
    assert.equal((await f.call(a.path,f.cookie,{})).status,403);
    assert.equal((await f.call('/agent/intents',f.cookie,{message:'创建新任务',approvalMode:'REQUEST_APPROVAL'})).status,403);
    assert.deepEqual(f.store.list('agent',PROJECT),before);
    for(const kind of ['agent_intent','agent_intent_handoff','agent_intent_approval'])assert.equal(f.store.list(kind,PROJECT).length,0);
    assert.deepEqual(f.effects,[]);
  });
}

test('the invited creator can reopen the single task that already occupies the active window',async t=>{
  const f=await fixture(t,false);
  const session=async cookie=>(await f.call('/auth/session',cookie)).body;
  assert.equal((await session(f.cookie)).developmentWindowUsed,undefined);
  const a=f.seed('holdings-t1');
  assert.equal((await session(f.cookie)).developmentWindowTaskId,a.task.id);
  const startup=(await f.call('/status?include=session',f.cookie)).body;
  assert.equal(startup.status.agentDevelopment.invitedSqlStartSupported,true);
  assert.equal(startup.session.developmentWindowTaskId,a.task.id);
  assert.equal(startup.session.developmentWindowUsed,true);
  for(const cookie of [f.other,undefined]){
    const other=await session(cookie);
    assert.equal(other.developmentWindowUsed,undefined);
    assert.equal(other.developmentWindowTaskId,undefined);
  }
  f.store.update('agent',a.task.id,PROJECT,{sourceKind:'MANUAL'});
  const manual=await session(f.cookie);
  assert.equal(manual.developmentWindowUsed,true);
  assert.equal(manual.developmentWindowTaskId,undefined);
  f.seed('stock-cash-t1');
  assert.equal((await session(f.cookie)).developmentWindowTaskId,undefined);
  assert.deepEqual(f.effects,[]);
});

test('unlinked, ambiguous and failed runs remain distinct; a mismatched revision cannot supply any SQL',async t=>{
  const f=await fixture(t,true),a=f.seed('holdings-t1'),b=f.seed('stock-cash-t1');
  const current=async()=>(await f.call(a.path,f.cookie)).body;
  f.store.update('agent',a.task.id,PROJECT,{revisionId:b.revision.id});
  let read=await current();assert.equal(read.evidenceState,'UNCONFIRMED');assert.equal(read.revision,undefined);
  f.store.update('agent',a.task.id,PROJECT,{revisionId:a.revision.id});
  f.store.update('revision',a.revision.id,PROJECT,{author:'another-owner'});
  read=await current();assert.equal(read.run,undefined);assert.equal(read.revision,undefined);
  f.store.update('revision',a.revision.id,PROJECT,{author:f.owner.id});
  f.store.update('run',a.run.id,PROJECT,{testDouble:true});
  read=await current();assert.equal(read.evidenceSource,'TEST_HARNESS');assert.equal(read.run.validation.state,'UNCONFIRMED');
  const regressions=a.family.contextIds.map((contextId,i)=>({contextId,passed:i!==0}));
  f.store.update('run',a.run.id,PROJECT,{testDouble:false,status:'VALIDATION_FAILED',validation:{...a.run.validation,passed:false,regressions}});
  f.store.update('agent',a.task.id,PROJECT,{status:'FAILED',stage:'FAILED',attempts:a.task.attempts.map(item=>({...item,status:'VALIDATION_FAILED'}))});
  read=await current();assert.equal(read.evidenceState,'RECORDED');assert.equal(read.run.validation.state,'FAILED');
  f.store.update('run',a.run.id,PROJECT,{code:'REMOTE_SPARK_TIMEOUT'});
  read=await current();assert.equal(read.evidenceState,'UNCONFIRMED');assert.equal(read.run,undefined);
  f.store.update('agent',a.task.id,PROJECT,{status:'RUNNING',stage:'WAITING_FOR_RUN',attempts:a.task.attempts.map(item=>({...item,status:'QUEUED'}))});
  f.store.update('run',a.run.id,PROJECT,{code:undefined,status:'RUNNING',validation:undefined,stage:'WAITING_FOR_WORKER_RESULT',
    remoteSubmission:{prepared:{job:{jobId:a.run.id}},submitted:true}});
  read=await current();assert.equal(read.evidenceState,'PENDING');assert.equal(read.run.status,'RUNNING');
  assert.equal(read.run.validation.state,'UNCONFIRMED');assert.equal(read.revision.sql,a.sql);
  f.store.update('run',a.run.id,PROJECT,{remoteSubmission:{prepared:{job:{jobId:a.run.id}},submitted:false}});
  read=await current();assert.equal(read.evidenceState,'UNCONFIRMED');assert.equal(read.run,undefined);
  f.store.update('agent',a.task.id,PROJECT,{status:'QUEUED',stage:'READY_FOR_MODEL',attempts:[],revisionId:undefined,runId:undefined});
  read=await current();assert.equal(read.evidenceState,'PENDING');assert.equal(read.attemptCount,0);assert.equal(read.run,undefined);
  assert.deepEqual(f.effects,[]);
});
