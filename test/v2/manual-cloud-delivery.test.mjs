import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../../src/v2/store.mjs';
import {LocalArtifactStore} from '../../src/v2/artifact-store.mjs';
import {getContext,referenceSqlForContext,validationFamilyForContext} from '../../src/v2/context.mjs';
import {saveManualRevision} from '../../src/v2/manual-revisions.mjs';
import {createDurableAgentDelivery,manualCloudDeliverySource} from '../../src/v2/agent-development-workflow.mjs';
import {sha256,validateDeliveryPackage,computeManifestDigest} from '../../src/v2/delivery.mjs';
import {createCloudPublication} from '../../src/v2/cloud-publication.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createPasswordHash} from '../../src/v2/auth.mjs';

// All execution and receipts below are synthetic; never calls a cloud or Spark.
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'shuduo-manual-cloud-')),store=new MetadataStore(':memory:');
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const actor=store.create('auth_user',PROJECT,{email:'engineer@example.invalid',passwordHash:createPasswordHash('SyntheticPassword!2026'),status:'ACTIVE',memberships:[{projectId:PROJECT,role:'ADMIN'}]});
  const origin=store.create('agent',PROJECT,{submittedBy:actor.id,language:'SPARK_SQL',contextId:'stock-cash-t1',executionMode:'DURABLE_SQL_AGENT_V1',mode:'LIVE_MODEL',
    status:'FAILED',stage:'FAILED',maxAttempts:3,usedTokens:18000,attempts:[{attempt:1,status:'MODEL_OUTCOME_UNKNOWN',usageEstimated:true},{attempt:2,status:'VALIDATION_FAILED'},{attempt:3,status:'VALIDATION_FAILED'}]});
  const revision=saveManualRevision({store,project:PROJECT,actor:actor.id,key:'manual-save',sql:referenceSqlForContext(origin.contextId),contextId:origin.contextId,originAgentTaskId:origin.id}).revision;
  const family=validationFamilyForContext(origin.contextId),validation={passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))};
  const run=store.create('run',PROJECT,{revisionId:revision.id,revisionHash:revision.hash,contextId:origin.contextId,validationContractId:family.id,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',
    isolation:'FUNCTION_PROCESS',mode:'DURABLE_REMOTE_SUBMISSION',mainSqlExecuted:true,rows:getContext(origin.contextId).expected,validation});
  const prepared=new Map(),receipts=new Map(),submits=[],puts=[],artifacts=new LocalArtifactStore(root);let losePut=false,loseSubmit=false,allowed=true;
  const runner={prepare:(input,id)=>{const p={job:{jobId:id},input};prepared.set(id,p);return p;},submit:async p=>{submits.push(p.job.jobId);if(loseSubmit){loseSubmit=false;throw Error('synthetic lost submit ACK');}},
    read:async p=>receipts.get(p.job.jobId),cancel:async()=>{}};
  const artifactStore={put:async(...args)=>{puts.push({digest:args[1],body:JSON.stringify(args[2])});const v=await artifacts.put(...args);if(losePut){losePut=false;throw Error('synthetic lost artifact ACK');}return v;},verify:(...args)=>artifacts.verify(...args)};
  const options={store,project:PROJECT,runner,artifactStore,persist:async()=>{},assertExecutionScope:a=>{if(!allowed||a?.id!==origin.id)throw Error('closed scope');}};
  const engine=createDurableAgentDelivery(options),input={runId:run.id,actorId:actor.id,key:'manual-delivery'};
  const complete=id=>{const p=prepared.get(id);receipts.set(id,{status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,
    testSqlValidation:{passed:true,sqlHash:sha256(p.input.testSql)},validation,rows:run.rows});};
  return{root,store,actor,origin,revision,run,engine,input,options,runner,artifactStore,puts,submits,prepared,complete,losePut:()=>losePut=true,loseSubmit:()=>loseSubmit=true,closeScope:()=>allowed=false};
}
test('manual cloud handoff binds its own verified source and immutable attribution, preserving failed Agent history',async t=>{
  const f=fixture(t),before=f.store.get('agent',f.origin.id,PROJECT),task=await f.engine.createManual(f.input);
  assert.equal(task.sourceKind,'MANUAL');assert.equal(task.agentIndependentE2E,false);assert.equal(task.sourceRevisionId,f.revision.id);assert.equal(task.sourceRunId,f.run.id);
  assert.equal((await f.engine.createManual({...f.input,key:'another-submit'})).id,task.id);assert.equal(f.store.list('agent_delivery_task',PROJECT).length,1);
  assert.equal(f.submits.length,0);const bundle=f.store.get('delivery_package',task.packageId,PROJECT),plan=validateDeliveryPackage(bundle,bundle.digest);
  assert.deepEqual(plan.source.attribution,{kind:'ENGINEER_ASSISTED',originAgentTaskId:f.origin.id,actorId:f.actor.id,agentIndependentE2E:false});
  const running=await f.engine.advance(task.id,task.version);assert.equal(f.submits.length,1);f.complete(running.verificationId);
  const done=await f.engine.reconcile(task.id);assert.equal(done.status,'SUCCEEDED');assert.equal(done.stage,'AWAITING_ENGINEER_REVIEW');
  assert.deepEqual(f.store.get('agent',f.origin.id,PROJECT),before);assert.equal(f.store.list('release',PROJECT).length,0);assert.equal(f.store.list('release_approval',PROJECT).length,0);
  assert.equal((await f.engine.advance(done.id,done.version)).id,done.id);assert.equal(f.submits.length,1);
});
test('unknown artifact acknowledgement keeps one package and exact immutable contents for explicit recovery',async t=>{
  const f=fixture(t);f.losePut();await assert.rejects(f.engine.createManual(f.input),/lost artifact/);
  const pending=f.store.list('agent_delivery_task',PROJECT)[0],bundle=f.store.get('delivery_package',pending.packageId,PROJECT);
  assert.equal(pending.stage,'PACKAGE_PERSISTING');assert.equal(f.submits.length,0);
  const recovered=await createDurableAgentDelivery(f.options).createManual(f.input);assert.equal(recovered.id,pending.id);
  assert.equal(recovered.packageDigest,bundle.digest);assert.deepEqual(f.puts[0],f.puts[1]);assert.equal(f.store.list('delivery_package',PROJECT).length,1);
});
test('unknown Spark acknowledgement reconciles the same receipt before any explicit resubmission',async t=>{
  const f=fixture(t),task=await f.engine.createManual(f.input);f.loseSubmit();await assert.rejects(f.engine.advance(task.id,task.version),/lost submit/);
  const pending=f.store.get('agent_delivery_task',task.id,PROJECT);f.complete(pending.verificationId);
  const done=await createDurableAgentDelivery(f.options).advance(pending.id,pending.version);assert.equal(done.status,'SUCCEEDED');assert.equal(f.submits.length,1);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,1);
});
test('manual idempotency binds the source even when an active handoff already exists, and persistence precedes OSS',async t=>{
  const f=fixture(t),first=await f.engine.createManual(f.input);
  const otherRun=f.store.create('run',PROJECT,{...f.run});
  const other=await f.engine.createManual({...f.input,runId:otherRun.id,key:'different-source'});assert.notEqual(other.id,first.id);
  await assert.rejects(f.engine.createManual({...f.input,runId:otherRun.id}),e=>e.status===409);
  let saves=0;const engine=createDurableAgentDelivery({...f.options,persist:async()=>{saves++;throw Error('synthetic durable flush rejected');}}),before=f.puts.length;
  await assert.rejects(engine.createManual({...f.input,key:'unconfirmed-checkpoint'}),/durable flush/);
  assert.equal(saves,1);assert.equal(f.puts.length,before);assert.equal(f.submits.length,0);
});
test('foreign actor, wrong origin/context, changed code, unverified and local results cannot create cloud delivery',async t=>{
  const f=fixture(t);
  assert.throws(()=>manualCloudDeliverySource({...f.options,runId:f.run.id,actorId:'foreign'}));
  for(const patch of [{source:'LIVE_MODEL'},{contextId:'holdings-t1'},{hash:'0'.repeat(64)},
    {manualProvenance:{...f.revision.manualProvenance,originAgentTaskId:crypto.randomUUID()}},{manualProvenance:{...f.revision.manualProvenance,actorId:'foreign'}}]){
    f.store.update('revision',f.revision.id,PROJECT,patch);await assert.rejects(f.engine.createManual(f.input));f.store.update('revision',f.revision.id,PROJECT,f.revision);
  }
  for(const patch of [{status:'VALIDATION_FAILED'},{engineVersion:'3.5.7'},{testDouble:true},{isolation:'LOCAL_PROCESS'},
    {validation:{...f.run.validation,regressions:f.run.validation.regressions.slice(1)}}]){
    f.store.update('run',f.run.id,PROJECT,patch);await assert.rejects(f.engine.createManual(f.input));f.store.update('run',f.run.id,PROJECT,{...f.run,testDouble:undefined});
  }
  assert.equal(f.puts.length,0);assert.equal(f.submits.length,0);assert.equal(f.store.list('delivery_package',PROJECT).length,0);
});
test('scope expiry and forged attribution cannot submit a manual rehearsal or use Agent publication approval',async t=>{
  const f=fixture(t),task=await f.engine.createManual(f.input);f.closeScope();await assert.rejects(f.engine.advance(task.id,task.version),/closed scope/);assert.equal(f.submits.length,0);
  const b=f.store.get('delivery_package',task.packageId,PROJECT),bad=structuredClone(b);bad.manifest.source.attribution.agentIndependentE2E=true;bad.digest=computeManifestDigest(bad.manifest);
  assert.throws(()=>validateDeliveryPackage(bad,bad.digest),/归因/);
  const publication=createCloudPublication({...f.options,enabled:true});
  await assert.rejects(publication.publish({agent:f.origin,packageDigest:b.digest,verificationId:'unapproved',actorId:f.actor.id,idempotencyKey:'never-publish',attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true}}),/人工版本|尚未通过/);
  assert.equal(f.store.list('release',PROJECT).length,0);
});
test('invited target-only HTTP handoff enforces login, CSRF, origin and explicit readonly expiry',async t=>{
  const f=fixture(t),at=Date.now(),raw=async()=>{throw Error('blocking runner forbidden');};raw.durable=f.runner;raw.descriptor={engine:'Apache Spark',isolation:'REMOTE_FUNCTION',publicWriteEnabled:true,healthVerified:true};let clock=at;
  const app=createV2Server({root:f.root,store:f.store,runner:raw,artifactStore:f.artifactStore,now:()=>clock,
    ingress:{assertRequest:()=> 'HTTP',status:{publicReadOnly:false}},
    env:{V2_LOCAL_DEVELOPMENT:'false',V2_DURABLE_SQL_AGENT_ENABLED:'true',V2_PUBLIC_ORIGIN:'https://fixture.invalid',V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',
      V2_BOOTSTRAP_ADMIN_EMAIL:f.actor.email,V2_PUBLIC_DEVELOPMENT_TASK_ID:f.origin.id,V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(at-1000).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(at+3600000).toISOString()}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.closeAllConnections();app.server.close(r);}));
  const call=async(path,body,session={})=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2${path}`,{method:body===undefined?'GET':'POST',headers:{origin:'https://fixture.invalid','content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':'manual-http',...session},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  assert.equal((await call(`/runs/${f.run.id}/prepare-delivery`,{})).status,403);
  const login=await call('/auth/login',{email:f.actor.email,password:'SyntheticPassword!2026'});assert.equal(login.status,200);
  const session={cookie:login.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':login.body.csrfToken};
  assert.equal((await call(`/runs/${f.run.id}/prepare-delivery`,{},{cookie:session.cookie})).status,403);
  const before=await call(`/runs/${f.run.id}/workflow`,undefined,session);assert.equal(before.status,200);assert.equal(before.body.report.status,'PASSED');assert.equal(before.body.report.sourceKind,'MANUAL');assert.equal(before.body.publication.available,false);
  assert.equal((await call(`/runs/${f.run.id}/prepare-delivery`,{originAgentTaskId:'forged'},session)).status,422);
  const prepared=await call(`/runs/${f.run.id}/prepare-delivery`,{},session);assert.equal(prepared.status,202);assert.equal(prepared.body.sourceKind,'MANUAL');assert.equal(f.submits.length,0);
  const other=f.store.create('revision',PROJECT,{...f.revision,manualProvenance:{...f.revision.manualProvenance,originAgentTaskId:crypto.randomUUID()}}),otherRun=f.store.create('run',PROJECT,{...f.run,revisionId:other.id});
  assert.equal((await call(`/runs/${otherRun.id}/prepare-delivery`,{},session)).status,403);
  clock=at+3600000;assert.equal((await call(`/agent/deliveries/${prepared.body.id}/advance`,{expectedVersion:prepared.body.version},session)).status,403);
  assert.equal((await call(`/runs/${f.run.id}/workflow`,undefined,session)).status,200);assert.equal(f.submits.length,0);assert.equal(f.store.get('agent',f.origin.id,PROJECT).status,'FAILED');
});
