import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {publicCapabilityStatus} from '../../src/v2/public-status.mjs';

test('public fees and identity statistics require an actual administrator session',async t=>{
 const store=new MetadataStore(':memory:'),app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'false',V2_ACCOUNT_MONTHLY_SPEND_CNY:'123.45'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 const get=async(path,headers={})=>{const response=await fetch(base+path,{headers});return{status:response.status,body:await response.json()};};
 const admin=app.auth.bootstrapAdmin({email:'budget-owner@example.test',password:'SyntheticAdmin#2026',displayName:'虚构管理员'});
 const login=app.auth.login({email:'budget-owner@example.test',password:'SyntheticAdmin#2026'});
 const actor=app.auth.sessionFromHeaders({cookie:`shuduo_session=${login.rawToken}`});
 const invited=app.auth.createInvitation(actor,{email:'engineer@example.test',role:'ENGINEER'});
 const engineer=app.auth.redeemInvitation({inviteCode:invited.inviteCode,displayName:'虚构工程师',password:'SyntheticEngineer#2026'});
 const adminHeaders={Cookie:`shuduo_session=${login.rawToken}`};
 const engineerHeaders={Cookie:`shuduo_session=${engineer.rawToken}`};
 for(const headers of [{},{'X-Role':'ADMIN','X-User-Id':admin.id},engineerHeaders]){
  const status=await get('/status',headers);
  assert.equal(status.status,200);assert.equal(status.body.authentication.publicSessionEnforced,true);
  assert.equal(Object.hasOwn(status.body,'budget'),false);
  for(const name of ['users','pendingInvitations','activeSessions'])assert.equal(Object.hasOwn(status.body.authentication,name),false);
  assert.equal(JSON.stringify(status.body).includes('123.45'),false);
  assert.equal((await get('/budget',headers)).status,headers===engineerHeaders?403:401);
 }
 const privileged=await get('/status',adminHeaders);
 assert.equal(privileged.body.budget.account.observedSpendCny,123.45);
 assert.equal(privileged.body.authentication.users,2);
 assert.equal((await get('/budget',adminHeaders)).body.account.observedSpendCny,123.45);
 // Backend membership changes immediately revoke privileged reads, independent
 // of cached UI role labels or caller-controlled headers.
 store.update('auth_user',admin.id,PROJECT,{memberships:[{projectId:PROJECT,role:'VIEWER'}]});
 assert.equal((await get('/budget',adminHeaders)).status,403);
 assert.equal((await get('/status',adminHeaders)).body.budget,undefined);
 app.auth.logout({cookie:adminHeaders.Cookie});
 assert.equal((await get('/budget',adminHeaders)).status,401);
});

test('identity changes discard private view state and cannot be overwritten by an earlier reload',()=>{
 const main=readFileSync('web/src/main.tsx','utf8');
 // Core and module requests now share the behavior-tested epoch/generation
 // guard; checking the old inline return would reject the equivalent wiring.
 assert.match(main,/const current = \(\) => startupReadCurrent\(\{ authEpoch: epoch, coreRequest: request \}, \{ authEpoch: authEpoch.current, coreRequest: coreRequest.current \}\)/);
 assert.match(main,/loadStartupCore<Status, AuthSession>\(\{ read: api, isCurrent: current,/);
 assert.match(main,/loadModuleStartup<Context, Run, Revision, AgentTask, AgentDeliveryTask>\(\{ read: api, module, privatePreview, isCurrent: current,/);
 assert.match(main,/const currentView = \(\) => active && startupReadCurrent\(identity, \{ authEpoch: authEpoch.current,/);
 assert.match(main,/acceptedEpoch = \+\+authEpoch.current; clearPersonalView\(\)/);
 assert.match(main,/await api\("\/auth\/logout", \{\}\);\s+authEpoch.current\+\+;\s+setStatus\(undefined\);\s+clearPersonalView\(\)/);
 assert.match(main,/setRuns\(\[\]\); setRun\(undefined\); setRevisions\(\[\]\)/);
 assert.match(main,/<Suspense key=\{session.user\?\.id \?\? "public-visitor"\}/);
 assert.match(main,/费用与用量仅项目管理员可见；未读取到数据时不展示金额/);
});
test('public status is an explicit capability projection, not a snapshot or deployment report',()=>{
 const projected=publicCapabilityStatus({mode:'PUBLIC_INVITATION',capabilities:[],model:{configured:true,model:'fixture-model',endpoint:'private-endpoint'},spark:{engine:'Apache Spark',workerFunctionName:'private-worker'},metadata:{driver:'mysql',cloudVerified:true,remoteRevision:123},persistence:{mode:'cloud',healthy:true,dataState:{driver:'oss',healthy:true,bucket:'private-bucket',rowCounts:{positions:123},contentHash:'private-hash'}},authentication:{publicSessionEnforced:true,users:42},budget:{account:{observedSpendCny:123.45}},operations:{privateJob:'private-run'}});
 const encoded=JSON.stringify(projected);
 for(const value of ['private-endpoint','private-worker','private-bucket','private-hash','private-run','observedSpendCny','rowCounts','remoteRevision','"users"'])assert.equal(encoded.includes(value),false,value);
 assert.equal(projected.model.configured,true);assert.equal(projected.persistence.dataState.healthy,true);
});

test('anonymous bootstrap exposes only built-in examples; development records enforce owner checks before reconciliation or execution',async t=>{
 const store=new MetadataStore(':memory:');let reads=0,submits=0,cancels=0,models=0;
 const runner=async()=>{throw Error('must not execute');};
 runner.durable={read:async()=>{reads++;return undefined;},submit:async()=>{submits++;},cancel:async()=>{cancels++;}};
 const app=createV2Server({store,runner,generator:async()=>{models++;throw Error('must not generate');},env:{V2_LOCAL_DEVELOPMENT:'false'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 const admin=app.auth.bootstrapAdmin({email:'owner@example.test',password:'SyntheticAdmin#2026',displayName:'虚构管理员'});
 const login=app.auth.login({email:'owner@example.test',password:'SyntheticAdmin#2026'});
 const actor=app.auth.sessionFromHeaders({cookie:`shuduo_session=${login.rawToken}`});
 const invite=app.auth.createInvitation(actor,{email:'reader@example.test',role:'ENGINEER'});
 const engineer=app.auth.redeemInvitation({inviteCode:invite.inviteCode,displayName:'虚构工程师',password:'SyntheticEngineer#2026'});
 const hidden=store.create('revision',PROJECT,{author:admin.id,sql:'SELECT 1 AS private_draft',contextId:'holdings-t1'});
 const owned=store.create('revision',PROJECT,{author:engineer.user.id,sql:'SELECT 1 AS own_draft',contextId:'holdings-t1'});
 const hiddenRun=store.create('run',PROJECT,{revisionId:hidden.id,status:'QUEUED',remoteSubmission:{prepared:{},submitted:false}});
 const ownRun=store.create('run',PROJECT,{revisionId:owned.id,status:'QUEUED',remoteSubmission:{prepared:{},submitted:false}});
 const ownTask=store.create('agent',PROJECT,{submittedBy:engineer.user.id,mode:'LIVE_MODEL',status:'FAILED',sql:'SELECT 1'});
 const hiddenTask=store.create('agent',PROJECT,{submittedBy:admin.id,mode:'LIVE_MODEL',status:'FAILED',sql:'SELECT 2'});
 const headers={Cookie:`shuduo_session=${engineer.rawToken}`};
 const get=async(path,h={})=>{const r=await fetch(base+path,{headers:h});return{status:r.status,body:await r.json()};};
 for(const path of ['/runs','/revisions','/agent/tasks','/agent/deliveries','/python/revisions','/python/runs'])assert.deepEqual((await get(path)).body,[]);
 assert.equal((await get('/contexts')).status,200);
 assert.equal((await get('/sources')).status,401);
 assert.equal((await get('/runs/'+hiddenRun.id)).status,401);
 assert.equal(reads,0);assert.equal(submits,0);
 assert.deepEqual((await get('/revisions',headers)).body.map(v=>v.id),[owned.id]);
 assert.deepEqual((await get('/runs',headers)).body.map(v=>v.id),[ownRun.id]);
 assert.equal(reads,1);assert.equal(submits,0,'GET must never resubmit a pending Spark job');
 assert.deepEqual((await get('/agent/tasks',headers)).body.map(v=>v.id),[ownTask.id]);
 for(const path of ['/runs/'+hiddenRun.id,'/runs/'+hiddenRun.id+'/bundle','/revisions/'+hidden.id,'/agent/tasks/'+hiddenTask.id])assert.equal((await get(path,headers)).status,403);
 assert.equal(reads,1);
 for(const [path,body] of [['/runs',{revisionId:hidden.id}],['/runs/'+hiddenRun.id+'/cancel',{}]]){
  const r=await fetch(base+path,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Shuduo-Client':'workbench','X-CSRF-Token':engineer.csrfToken,'Idempotency-Key':'foreign-run-probe'},body:JSON.stringify(body)});
  assert.equal(r.status,403);
 }
 assert.equal(submits,0);assert.equal(cancels,0);assert.equal(store.get('run',hiddenRun.id,PROJECT).status,'QUEUED');
 store.deduplicate(PROJECT+':agent:collision-key','unrelated-signature',()=>hiddenTask);
 const replay=await fetch(base+'/agent/tasks',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Shuduo-Client':'workbench','X-CSRF-Token':engineer.csrfToken,'Idempotency-Key':'collision-key'},body:JSON.stringify({message:'虚构用户的新请求',sql:'SELECT 1',contextId:'holdings-t1'})});
 assert.equal(replay.status,403);assert.equal(models,0);
});
