import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {MetadataStore} from "../../src/v2/store.mjs";
import {createDurableSqlAgent} from "../../src/v2/durable-agent.mjs";
import {createAgentDispatcher} from "../../src/v2/agent-dispatcher.mjs";
import {createAgentEventDriver,AGENT_WAKE_PREFIX,agentEventConfigFromEnvironment,parseAgentObjectEvent} from "../../src/v2/agent-event-driver.mjs";
import {createAgentWakeOssTransport} from "../../src/v2/agent-wake-oss-transport.mjs";
import {createQueuedSparkJob,createQueuedSparkResult,SPARK_QUEUE_PREFIXES} from "../../src/v2/remote-spark-queue.mjs";
import {referenceSql,getContext,contextIds,validationContractId} from "../../src/v2/context.mjs";
const project="project-securities-lab",secret="synthetic-test-secret-".repeat(3);
const config={bucket:"fictional-securities-test",accountId:"111122223333",project,secret,wakePrefix:AGENT_WAKE_PREFIX,resultPrefix:SPARK_QUEUE_PREFIXES.results};
const queueConfig={projectId:project,sharedSecret:"synthetic-worker-key-".repeat(3),jobPrefix:SPARK_QUEUE_PREFIXES.jobs,resultPrefix:SPARK_QUEUE_PREFIXES.results,cancellationPrefix:SPARK_QUEUE_PREFIXES.cancellations,timeoutMs:180000};
const event=key=>({events:[{eventName:"ObjectCreated:PutObject",eventSource:"acs:oss",eventVersion:"1.0",eventTime:new Date().toISOString(),oss:{bucket:{name:config.bucket,ownerIdentity:config.accountId},object:{key}}}]});
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),"shuduo-events-")),path=join(root,"meta.sqlite");
  let store=new MetadataStore(path),clock=Date.now(),models=0,submitted=0,blocked=false,persist=async()=>{},engine,driver;
  const objects=new Map(),events=[];
  const transport={read:async key=>objects.get(key),create:async(key,body)=>{
    if(blocked)throw Object.assign(new Error("synthetic ACK unknown"),{code:"TEST_ACK_UNKNOWN"});
    if(objects.has(key)){assert.equal(objects.get(key),body);return;}
    objects.set(key,body);events.push(event(key));
  }};
  const owner=store.create("auth_user",project,{status:"ACTIVE",memberships:[{projectId:project,role:"ENGINEER"}]});
  const runner={prepare:(input,id)=>{const q=createQueuedSparkJob(input,queueConfig,{now:clock,requestId:id});return{...q,serialized:JSON.stringify(q.job)};},
    submit:async prepared=>{if(!objects.has(prepared.jobKey)){submitted++;objects.set(prepared.jobKey,prepared.serialized);}},
    read:async prepared=>{const raw=objects.get(prepared.resultKey);return raw?JSON.parse(raw).result:undefined;},cancel:async()=>{}};
  const build=()=>{
    engine=createDurableSqlAgent({store,project,runner,persist:()=>persist(),getContext,contextIds,contractId:validationContractId,now:()=>clock,
      generator:async()=>{models++;return{sql:referenceSql,model:"TEST_DOUBLE",usage:{total_tokens:20}};}});
    const dispatcher=createAgentDispatcher({store,project,engine,persist:()=>persist(),now:()=>clock});
    driver=createAgentEventDriver({store,project,dispatcher,transport,config,queueConfig,persist:()=>persist(),now:()=>clock});
  };
  build();t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const create=()=>engine.create({message:"虚构财富客户资产T+1",currentSql:referenceSql,contextId:"holdings-t1",actorId:owner.id,idempotencyKey:randomUUID()});
  return{get store(){return store;},get engine(){return engine;},get driver(){return driver;},owner,objects,events,create,
    get models(){return models;},get submitted(){return submitted;},now:()=>clock,later:ms=>clock+=ms,
    restart:()=>{store.close();store=new MetadataStore(path);build();},persist:fn=>persist=fn,blockPut:v=>blocked=v,
    worker:(taskId,status="SUCCEEDED")=>{
      const task=store.get("agent",taskId,project),run=store.get("run",task.runId,project),prepared=run.remoteSubmission.prepared;
      const result={status,engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,rows:[],validation:{passed:status==="SUCCEEDED",regressions:contextIds.map(contextId=>({contextId,passed:status==="SUCCEEDED"}))}};
      objects.set(prepared.resultKey,JSON.stringify(createQueuedSparkResult(prepared.job,result,queueConfig,clock)));return event(prepared.resultKey);
    }};
}

test("event chain progresses without browser or CLI driver, survives reopen, waits only for a signed result",async t=>{
  const f=fixture(t),task=await f.create();await f.driver.enable(task.id,f.owner.id,{expectedVersion:task.version});
  assert.equal(f.models,0);assert.equal(f.events.length,1);
  f.restart();await f.driver.consume(f.events[0]);assert.equal(f.models,1);assert.equal(f.events.length,2);
  f.restart();await f.driver.consume(f.events[1]);assert.equal(f.submitted,1);assert.equal(f.driver.status(task.id).state,"WAITING_FOR_RESULT");
  assert.equal(f.events.length,2,"no idle polling or self-trigger while waiting for worker");
  const callback=f.worker(task.id);f.restart();await f.driver.consume(callback);assert.equal(f.events.length,3);
  await f.driver.consume(f.events[2]);assert.equal(f.store.get("agent",task.id,project).status,"SUCCEEDED");
  assert.equal(f.driver.status(task.id).status,"COMPLETED");assert.equal(f.models,1);assert.equal(f.submitted,1);
  await f.driver.consume(f.events[0]);await f.driver.consume(callback);assert.equal(f.models,1);assert.equal(f.events.length,3);
});
test("event scope cannot pick another pending task, revoked owners or expired grants cannot execute",async t=>{
  const f=fixture(t),other=await f.create(),task=await f.create();await f.driver.enable(task.id,f.owner.id,{expectedVersion:task.version,durationMs:60000});
  await f.driver.consume(f.events[0]);assert.equal(f.store.get("agent",other.id,project).stage,"READY_FOR_MODEL");
  assert.equal(f.models,1);f.store.update("auth_user",f.owner.id,project,{status:"DISABLED"});
  await f.driver.consume(f.events[1]);assert.equal(f.submitted,0);assert.equal(f.driver.status(task.id).status,"PAUSED");
  const g=fixture(t),expired=await g.create();await g.driver.enable(expired.id,g.owner.id,{expectedVersion:expired.version,durationMs:60000});
  g.later(60001);await g.driver.consume(g.events[0]);assert.equal(g.models,0);assert.equal(g.driver.status(expired.id).status,"EXPIRED");
});
test("unknown model outcomes, cancellation and event caps halt instead of calling model again",async t=>{
  const f=fixture(t),task=await f.create();await f.driver.enable(task.id,f.owner.id,{expectedVersion:task.version,maxEvents:1});
  await f.driver.consume(f.events[0]);assert.equal(f.models,1);assert.equal(f.events.length,1);assert.equal(f.driver.status(task.id).code,"AGENT_BACKGROUND_EVENT_LIMIT");
  const g=fixture(t),u=await g.create();await g.driver.enable(u.id,g.owner.id,{expectedVersion:u.version});
  g.store.update("agent",u.id,project,{status:"INTERRUPTED",stage:"MODEL_OUTCOME_UNKNOWN"});
  await g.driver.consume(g.events[0]);assert.equal(g.models,0);assert.equal(g.driver.status(u.id).status,"NEEDS_CONFIRMATION");
  const c=fixture(t),x=await c.create();await c.driver.enable(x.id,c.owner.id,{expectedVersion:x.version});await c.driver.cancel(x.id,c.owner.id);
  await c.driver.consume(c.events[0]);assert.equal(c.models,0);
});
test("outbox unknown ACK retains exact object; recovered event never repeats the model step",async t=>{
  const f=fixture(t),task=await f.create();f.blockPut(true);
  assert.equal((await f.driver.enable(task.id,f.owner.id,{expectedVersion:task.version})).delivery,"UNCONFIRMED");
  const original=f.store.list("agent_wake",project)[0];f.restart();f.blockPut(false);
  await f.driver.enable(task.id,f.owner.id,{expectedVersion:task.version});assert.equal(f.store.list("agent_wake",project).length,1);
  assert.equal(JSON.parse(f.objects.get(`${AGENT_WAKE_PREFIX}/${original.id}.json`)).body.wakeId,original.id);
  f.blockPut(true);await assert.rejects(f.driver.consume(f.events[0]),{code:"AGENT_WAKE_DELIVERY_UNCONFIRMED"});assert.equal(f.models,1);
  f.restart();f.blockPut(false);await f.driver.consume(f.events[0]);assert.equal(f.models,1);assert.equal(f.events.length,2);
});
test("unregistered, foreign, malformed and tampered objects never execute",async t=>{
  const f=fixture(t),task=await f.create();await f.driver.enable(task.id,f.owner.id,{expectedVersion:task.version});
  assert.equal((await f.driver.consume(event(`${AGENT_WAKE_PREFIX}/${randomUUID()}.json`))).state,"IGNORED_UNREGISTERED");
  for(const key of [".env",`${AGENT_WAKE_PREFIX}/../key.json`,`${AGENT_WAKE_PREFIX}/%2e%2e.json`])assert.throws(()=>parseAgentObjectEvent(event(key),config));
  const foreign=event(`${AGENT_WAKE_PREFIX}/${randomUUID()}.json`);foreign.events[0].oss.bucket.ownerIdentity="999900001111";
  await assert.rejects(f.driver.consume(foreign),{code:"AGENT_OBJECT_SOURCE_INVALID"});
  const key=f.events[0].events[0].oss.object.key;f.objects.set(key,JSON.stringify({body:{taskId:task.id},signature:"forged"}));
  await assert.rejects(f.driver.consume(f.events[0]),{code:"AGENT_WAKE_BODY_MISMATCH"});assert.equal(f.models,0);
});
test("worker result is signed and bound to the registered run; duplicates cannot generate new work",async t=>{
  const f=fixture(t),task=await f.create();await f.driver.enable(task.id,f.owner.id,{expectedVersion:task.version});await f.driver.consume(f.events[0]);await f.driver.consume(f.events[1]);
  const callback=f.worker(task.id),key=callback.events[0].oss.object.key,original=f.objects.get(key),bad=JSON.parse(original);
  bad.signature="v1="+"a".repeat(64);f.objects.set(key,JSON.stringify(bad));await assert.rejects(f.driver.consume(callback));
  assert.equal(f.events.length,2);f.objects.set(key,original);await f.driver.consume(callback);await f.driver.consume(callback);assert.equal(f.events.length,3);
});
test("event configuration defaults off and fails closed for incomplete or overlapping runtime scope",()=>{
  assert.equal(agentEventConfigFromEnvironment({}),undefined);
  assert.throws(()=>agentEventConfigFromEnvironment({V2_AGENT_DRIVER_MODE:"OSS_EVENTS"}));
  assert.throws(()=>agentEventConfigFromEnvironment({V2_AGENT_DRIVER_MODE:"OSS_EVENTS",OSS_BUCKET:config.bucket,V2_AGENT_EVENT_ACCOUNT_ID:config.accountId,V2_SCHEDULER_TICK_SECRET:secret,V2_SPARK_QUEUE_RESULT_PREFIX:AGENT_WAKE_PREFIX}));
  const derived=agentEventConfigFromEnvironment({V2_AGENT_DRIVER_MODE:"OSS_EVENTS",OSS_BUCKET:config.bucket,V2_AGENT_EVENT_ACCOUNT_ID:config.accountId,V2_SPARK_EXECUTOR_SECRET:secret});
  assert.match(derived.secret,/^[a-f0-9]{64}$/);assert.notEqual(derived.secret,secret);
  assert.equal(derived.secret,agentEventConfigFromEnvironment({V2_AGENT_DRIVER_MODE:"OSS_EVENTS",OSS_BUCKET:config.bucket,V2_AGENT_EVENT_ACCOUNT_ID:config.accountId,V2_SCHEDULER_TICK_SECRET:secret}).secret);
});
test("OSS adapter signs exact safe prefixes, rejects redirects and verifies immutable unknown-ACK retries",async()=>{
  const calls=[],data=new Map(),transport=createAgentWakeOssTransport({bucket:config.bucket,endpoint:"oss-cn-hangzhou-internal.aliyuncs.com",wakePrefix:config.wakePrefix,resultPrefix:config.resultPrefix,
    credentialsProvider:async()=>({accessKeyId:"TEST_ID",accessKeySecret:secret,securityToken:"TEST_STS"}),fetchImpl:async(url,options)=>{
      calls.push({url,options});const key=new URL(url).pathname.slice(1);
      if(options.method==="PUT"){if(data.has(key))return new Response("",{status:409});data.set(key,options.body);return new Response("",{status:200});}
      return data.has(key)?new Response(data.get(key),{status:200}):new Response("",{status:404});
    }});
  const key=`${AGENT_WAKE_PREFIX}/${randomUUID()}.json`;await transport.create(key,"{}");await transport.create(key,"{}");
  assert.equal(calls[0].options.headers["x-oss-forbid-overwrite"],"true");assert.match(calls[0].options.headers.Authorization,/^OSS TEST_ID:/);assert.equal(calls[0].options.redirect,"error");
  await assert.rejects(transport.create(`${SPARK_QUEUE_PREFIXES.results}/${randomUUID()}.json`,"{}"),{code:"AGENT_WAKE_OBJECT_DENIED"});
  await assert.rejects(transport.read(".env"),{code:"AGENT_WAKE_OBJECT_DENIED"});
});
