import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {MetadataStore} from "../../src/v2/store.mjs";
import {LocalArtifactStore} from "../../src/v2/artifact-store.mjs";
import {createDeliveryPackage,sha256} from "../../src/v2/delivery.mjs";
import {getContext,contextIds,referenceSql,validationContractId} from "../../src/v2/context.mjs";
import {createCloudPublication} from "../../src/v2/cloud-publication.mjs";
import {privateReleaseConfig,validatePrivateReleaseTimer} from "../../src/v2/private-release-timer.mjs";
import {signSchedulerTick} from "../../src/v2/scheduler-tick.mjs";
import {createV2Server,PROJECT} from "../../src/v2/server.mjs";
const cryptoHash=s=>sha256(s);
async function fixture(t,{enabled=true}={}) {
  const store=new MetadataStore(":memory:"),project=PROJECT,artifactStore=new LocalArtifactStore(mkdtempSync(join(tmpdir(),"shuduo-cloud-pub-")));
  t.after(()=>store.close());let time=Date.parse("2026-10-12T01:00:00Z"),failSubmit=false,persisted=0,flushed=[];
  const revision=store.create("revision",project,{sql:referenceSql,hash:sha256(referenceSql),contextId:"cash-change"});
  const validation={passed:true,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:true}))};
  const sourceRun=store.create("run",project,{revisionId:revision.id,revisionHash:revision.hash,status:"SUCCEEDED",engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,isolation:"FUNCTION_PROCESS",validation,rows:getContext("cash-change").expected});
  const agent=store.create("agent",project,{status:"SUCCEEDED",mode:"LIVE_MODEL",executionMode:"DURABLE_SQL_AGENT_V1",attempts:[{status:"SUCCEEDED",model:"qwen3-coder-plus",revisionId:revision.id,runId:sourceRun.id}]});
  const bundle=createDeliveryPackage({run:sourceRun,revision}),artifact=await artifactStore.put("delivery-package",bundle.digest,bundle);
  const item=store.create("delivery_package",project,{...bundle,artifact,sourceRunId:sourceRun.id});
  const verification=store.create("delivery_verification",project,{packageId:item.id,packageDigest:item.digest,status:"SUCCEEDED",engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,testSqlValidation:{passed:true,sqlHash:sha256(item.files["tests.sql"])},validation});
  store.create("agent_delivery_task",project,{sourceAgentTaskId:agent.id,packageId:item.id,packageDigest:item.digest,status:"SUCCEEDED",actualExecution:true,verificationId:verification.id});
  const submits=[],receipts=new Map(),runner={prepare:(input,id)=>({job:{jobId:id},input}),submit:async p=>{assert.ok(persisted);assert.ok(flushed.some(r=>r.remoteSubmission?.prepared?.job?.jobId===p.job.jobId),"job must be flushed before submission");submits.push(p.job.jobId);if(failSubmit){failSubmit=false;throw Error("submission unknown");}},read:async p=>receipts.get(p.job.jobId),cancel:async()=>{}};
  const options={store,project,runner,artifactStore,enabled,persist:async()=>{persisted++;flushed=store.list("release_run",project);},now:()=>time};
  const input={agent,packageDigest:item.digest,verificationId:verification.id,attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true},actorId:"synthetic-engineer",idempotencyKey:"same-version"};
  const receipt=p=>({status:"SUCCEEDED",engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,testSqlValidation:{passed:true,sqlHash:sha256(p.input.testSql)},validation,durationMs:9,rows:sourceRun.rows,log:"SYNTHETIC TEST RECEIPT"});
  return{store,project,agent,item,verification,input,options,engine:createCloudPublication(options),submits,receipts,receipt,advance:()=>{time+=60000;},now:()=>time,failNext:()=>{failSubmit=true;}};
}
const event=(f,id,n)=>({releaseId:id,requestId:cryptoHash("synthetic-event-"+n),triggerName:"shuduo-release-test-"+n,triggerTime:new Date(f.now()).toISOString()});
test("cloud publication stays disabled and rejects missing review, stale digest and fake receipts",async t=>{
  const disabled=await fixture(t,{enabled:false});await assert.rejects(disabled.engine.publish(disabled.input),e=>e.status===503);assert.equal(disabled.submits.length,0);
  const f=await fixture(t);for(const input of [{...f.input,attestations:{code:true}},{...f.input,packageDigest:"f".repeat(64)}])await assert.rejects(f.engine.publish(input));
  f.store.update("delivery_verification",f.verification.id,f.project,{testDouble:true});await assert.rejects(f.engine.publish(f.input));assert.equal(f.store.list("release",f.project).length,0);
});
test("two external ticks submit stable jobs and a third produces healthy monitoring without browser advancement",async t=>{
  const f=await fixture(t),created=await f.engine.publish(f.input),id=created.release.id;
  assert.equal(created.release.status,"WAITING_SCHEDULER");assert.equal(f.submits.length,0);assert.equal((await f.engine.publish(f.input)).release.id,id);
  await f.engine.tick(event(f,id,1));let run=f.store.list("release_run",f.project).find(r=>r.status==="RUNNING");f.receipts.set(run.id,f.receipt(run.remoteSubmission.prepared));
  f.advance();await f.engine.tick(event(f,id,2));run=f.store.list("release_run",f.project).find(r=>r.status==="RUNNING");f.receipts.set(run.id,f.receipt(run.remoteSubmission.prepared));
  f.advance();const third=event(f,id,3);await f.engine.tick(third);const result=await f.engine.detail(f.agent.id);
  assert.equal(result.release.health,"HEALTHY");assert.ok(result.runs.every(r=>r.status==="SUCCEEDED"&&r.schedulerTriggered&&r.clockMode==="FC_TIMER"));assert.equal(result.events.length,2);assert.equal(result.alerts.length,0);
  await f.engine.tick(third);assert.equal(f.submits.length,2);assert.equal(result.runs[0].remoteSubmission,undefined);assert.equal(result.runs[0].rows,undefined);assert.equal(result.release.publicDeployed,false);
});
test("restart after unknown submission restores its original job and cancellation wins over a late result",async t=>{
  const f=await fixture(t),id=(await f.engine.publish(f.input)).release.id,first=event(f,id,1);f.failNext();await assert.rejects(f.engine.tick(first),/submission unknown/);
  const run=f.store.list("release_run",f.project).find(r=>r.status==="RUNNING");f.store.interruptPending(f.project);assert.equal(f.store.get("release_run",run.id,f.project).status,"RUNNING");
  const restored=createCloudPublication(f.options);await restored.tick(first);assert.deepEqual(f.submits,[run.id,run.id]);assert.equal(f.store.list("release_run",f.project).length,2);
  await restored.cancel(f.agent.id);f.receipts.set(run.id,f.receipt(run.remoteSubmission.prepared));assert.ok((await restored.detail(f.agent.id)).runs.every(r=>r.status==="CANCELLED"));
});
test("failed batch raises an alert and later independently verified batch resolves it",async t=>{
  const f=await fixture(t),id=(await f.engine.publish(f.input)).release.id;await f.engine.tick(event(f,id,1));let run=f.store.list("release_run",f.project).find(r=>r.status==="RUNNING");f.receipts.set(run.id,{status:"FAILED",engine:"Apache Spark"});
  f.advance();await f.engine.tick(event(f,id,2));let view=await f.engine.detail(f.agent.id);assert.equal(view.release.health,"CRITICAL");assert.equal(view.alerts[0].status,"OPEN");
  run=f.store.list("release_run",f.project).find(r=>r.status==="RUNNING");f.receipts.set(run.id,f.receipt(run.remoteSubmission.prepared));f.advance();await f.engine.tick(event(f,id,3));view=await f.engine.detail(f.agent.id);assert.equal(view.alerts[0].status,"RESOLVED");assert.equal(view.alerts[0].recoveryRunId,run.id);assert.notEqual(view.release.health,"HEALTHY");
});
test("cancellation during artifact verification cannot resurrect or submit a scheduled batch",async t=>{
  const f=await fixture(t),id=(await f.engine.publish(f.input)).release.id,original=f.options.artifactStore.verify.bind(f.options.artifactStore);
  let cancelDuringVerification=true;
  f.options.artifactStore.verify=async(...args)=>{await original(...args);if(cancelDuringVerification){cancelDuringVerification=false;await f.engine.cancel(f.agent.id);}};
  await f.engine.tick(event(f,id,1));
  assert.equal(f.submits.length,0);assert.equal((await f.engine.detail(f.agent.id)).release.status,"CANCELLED");
  assert.ok(f.store.list("release_run",f.project).every(r=>r.status==="CANCELLED"));
});
test("timer validates exact trigger, time, release binding, expiry and signature",()=>{
  const time=Date.parse("2026-10-12T01:00:00Z"),secret="synthetic-timer-secret-"+"a".repeat(40),name="shuduo-release-test-1",nonce="n".repeat(24),body=JSON.stringify({releaseId:"00000000-0000-4000-8000-000000000001",triggerName:name,expiresAt:time+300000});
  const envelope={operation:"PRIVATE_RELEASE_TIMER_V1",timestamp:String(time),nonce,body,signature:signSchedulerTick({sharedSecret:secret,timestamp:String(time),nonce,body})},evt={triggerName:name,triggerTime:new Date(time).toISOString(),payload:JSON.stringify(envelope)},config=privateReleaseConfig({V2_PRIVATE_RELEASE_ENABLED:"true",V2_SCHEDULER_TICK_SECRET:secret,V2_PRIVATE_RELEASE_TRIGGER_NAMES:name});
  assert.equal(validatePrivateReleaseTimer(evt,config,time).releaseId,"00000000-0000-4000-8000-000000000001");
  assert.equal(validatePrivateReleaseTimer({...evt,triggerTime:new Date(time+1000).toISOString()},config,time+1000).triggerName,name);
  assert.throws(()=>validatePrivateReleaseTimer(evt,config,time-2000));
  for(const value of [{...evt,triggerName:"unknown"},{...evt,triggerTime:"bad"},{...evt,payload:JSON.stringify({...envelope,signature:"bad"})}])assert.throws(()=>validatePrivateReleaseTimer(value,config,time));
  assert.throws(()=>validatePrivateReleaseTimer(evt,config,time+600000));assert.equal(privateReleaseConfig({}),undefined);
});
test("HTTP publication keeps owner and CSRF controls; only a signed private timer can submit a batch",async t=>{
  const f=await fixture(t),secret="synthetic-http-timer-key-"+"b".repeat(40),name="shuduo-release-http-test",runner=async()=>{};runner.durable=f.options.runner;
  const app=createV2Server({store:f.store,stateCoordinator:{refresh:async()=>{},flush:f.options.persist},artifactStore:f.options.artifactStore,runner,now:f.now,env:{V2_LOCAL_DEVELOPMENT:"false",V2_HOST:"127.0.0.1",V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true",V2_PROVISIONING_ONLY:"true",V2_PRIVATE_SMOKE_ENABLED:"true",V2_DURABLE_SQL_AGENT_ENABLED:"true",V2_PRIVATE_RELEASE_ENABLED:"true",V2_SCHEDULER_TICK_SECRET:secret,V2_PRIVATE_RELEASE_TRIGGER_NAMES:name}});
  await new Promise(r=>app.server.listen(0,"127.0.0.1",r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const owner=app.auth.bootstrapAdmin({email:"owner@example.invalid",password:"SyntheticPassword!2026",displayName:"测试工程师一"}),other=app.auth.bootstrapAdmin({email:"other@example.invalid",password:"SyntheticPassword!2026",displayName:"测试工程师二"});
  for(const u of [owner,other])f.store.update("auth_user",u.id,PROJECT,{memberships:[{projectId:PROJECT,role:"ENGINEER"}]});
  f.store.update("agent",f.agent.id,PROJECT,{submittedBy:owner.id});
  const base=`http://127.0.0.1:${app.server.address().port}`,call=async(path,body,headers={})=>{const r=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-shuduo-client":"workbench","idempotency-key":"http-pub",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  const login=async email=>{const r=await call("/api/v2/auth/login",{email,password:"SyntheticPassword!2026"});return{cookie:r.cookies.map(c=>c.split(";")[0]).join("; "),"x-csrf-token":r.body.csrfToken};};
  const a=await login("owner@example.invalid"),b=await login("other@example.invalid"),path=`/api/v2/agent/tasks/${f.agent.id}/publication`,body={packageDigest:f.item.digest,verificationId:f.verification.id,attestations:f.input.attestations};
  assert.equal((await call(path)).status,401);assert.equal((await call(path,body,{cookie:a.cookie})).status,403);assert.equal((await call(path,body,b)).status,403);
  const pub=await call(path,body,a);assert.equal(pub.status,202);assert.equal(f.submits.length,0);
  const raw=JSON.stringify({releaseId:pub.body.release.id,triggerName:name,expiresAt:f.now()+300000}),timestamp=String(f.now()),nonce="x".repeat(24),envelope={operation:"PRIVATE_RELEASE_TIMER_V1",timestamp,nonce,body:raw,signature:signSchedulerTick({sharedSecret:secret,timestamp,nonce,body:raw})};
  const evt={triggerName:name,triggerTime:new Date(f.now()).toISOString(),payload:JSON.stringify(envelope)};
  assert.equal((await call("/invoke",{...evt,payload:JSON.stringify({...envelope,signature:"bad"})},{"content-type":"application/octet-stream"})).status,401);
  assert.equal((await call("/invoke",evt,{"content-type":"application/octet-stream"})).status,200);assert.equal(f.submits.length,1);
  assert.equal((await call("/invoke",evt,{"content-type":"application/octet-stream"})).status,200);assert.equal(f.submits.length,1);
  assert.equal((await call(path+"/cancel",{},b)).status,403);assert.equal((await call(path+"/cancel",{},a)).status,200);
});
