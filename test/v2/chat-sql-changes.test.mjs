import test from "node:test";
import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { PROJECT,createV2Server } from "../../src/v2/server.mjs";
import { createLocalSourceApiFixture } from "./fixtures/local-service-api-journey.mjs";
import { seedContextDerivation } from "./fixtures/agent-context-derivation.mjs";

// The existing derivation fixture models stored protocol records and counts
// synthetic provider/Spark calls; this suite does not claim a live model.
async function fixture(t) {
  const f=await createLocalSourceApiFixture();
  t.after(()=>f.dispose());
  const actor="local-engineer",parent=seedContextDerivation(f.store,PROJECT,{actorId:actor});
  const objective="按全品类持仓和现金制作测试客户资产表";
  const intent=f.store.create("agent_intent",PROJECT,{submittedBy:actor,status:"SUCCEEDED",approvalMode:"REQUEST_APPROVAL",
    route:{steps:[{destinationId:"development",objective}]}});
  const approval=f.store.create("agent_intent_approval",PROJECT,{submittedBy:actor,intentId:intent.id,destinationId:"development",
    specialistTaskKind:"agent",specialistTaskId:parent.task.id,status:"BOUND",objectiveHash:createHash("sha256").update(objective).digest("hex")});
  f.store.create("agent_intent_handoff",PROJECT,{intentId:intent.id,destinationId:"development",status:"HANDED_OFF",
    specialistTaskKind:"agent",specialistTaskId:parent.task.id,approvalId:approval.id,objective});
  const path="/agent/intents/"+intent.id+"/development/changes";
  const body={message:"请改算股票和可用现金，保留仅有现金的客户",sql:parent.sql,language:"SPARK_SQL",contextId:"stock-cash-t1",
    derivation:parent.derivation,chatChange:{intentId:intent.id}};
  return {...f,parent,intent,path,body,submit:(key,input=body)=>f.call("/agent/tasks",input,{headers:{"idempotency-key":key}})};
}

test("the conversation recovers its submitted scope change, comparison and independent second request",async t=>{
  const f=await fixture(t);
  const initial=await f.call(f.path);
  assert.equal(initial.status,200);
  const {binding,nextRequestId,targets}=initial.body;
  assert.equal(binding.runId,f.parent.run.id);
  assert.deepEqual(targets.filter(a=>a.recommended).map(a=>a.id),["stock-cash-t1"]);
  assert.equal(targets.length,9);
  assert.deepEqual(initial.body.changes,[]);
  const [a,b]=await Promise.all([f.submit(nextRequestId),f.submit(nextRequestId)]);
  assert.deepEqual([a.status,b.status],[202,202]);assert.equal(a.body.id,b.body.id);
  const child=await f.poll("/agent/tasks/"+a.body.id,task=>task.status==="SUCCEEDED");
  const saved=(await f.call(f.path)).body;
  assert.equal(saved.changes.length,1);
  assert.deepEqual(saved.changes[0],{requestId:nextRequestId,taskId:child.id,contextId:child.contextId,message:f.body.message,status:"SUCCEEDED",
    revisionId:child.revisionId,runId:child.runId,revisionHash:f.store.get("revision",child.revisionId,PROJECT).hash});
  assert.equal((await f.call("/agent/requests/"+nextRequestId)).body.id,child.id);
  const compared=await f.call("/agent/tasks/"+child.id+"/derivation-comparison");
  assert.equal(compared.body.state,"MATCHED");
  assert.equal(compared.body.totals.delta.total_assets,"-500.00");
  assert.deepEqual(f.counts,{syntheticModel:1,syntheticSpark:1});
  const second=await f.submit(saved.nextRequestId,{...f.body,message:"再核对现金发生变化时的股票口径",contextId:"stock-cash-cash-change"});
  assert.equal(second.status,202);
  await f.poll("/agent/tasks/"+second.body.id,task=>task.status==="SUCCEEDED");
  assert.deepEqual((await f.call(f.path)).body.changes.map(c=>c.taskId),[child.id,second.body.id]);
  assert.equal((await f.submit(nextRequestId)).body.id,child.id);
  assert.equal((await f.submit(nextRequestId,{...f.body,message:"重用旧请求的其他指令"})).status,409);
  assert.deepEqual(f.counts,{syntheticModel:2,syntheticSpark:2});
  assert.deepEqual(f.store.get("agent",f.parent.task.id,PROJECT),f.parent.task);
  assert.equal(f.store.list("release_approval",PROJECT).length,0);

  // A fresh process shares only persisted metadata, no provider or browser state.
  const cold=createV2Server({store:f.store,root:f.root,env:{V2_LOCAL_DEVELOPMENT:"true",V2_RELEASE_SCHEDULER_MODE:"DISABLED"}});
  await new Promise(resolve=>cold.server.listen(0,"127.0.0.1",resolve));
  try {
    const read=await fetch("http://127.0.0.1:"+cold.server.address().port+"/api/v2"+f.path);
    assert.equal(read.status,200);
    assert.deepEqual((await read.json()).changes.map(c=>c.taskId),[child.id,second.body.id]);
  } finally { cold.server.closeAllConnections();await new Promise(resolve=>cold.server.close(resolve));cold.dispose(); }
});

test("chat scope selection rejects mixed identities, stale bindings and invalid slots before any compute",async t=>{
  const f=await fixture(t),initial=(await f.call(f.path)).body,key=initial.nextRequestId;
  assert.equal((await f.call(f.path+"?runId="+f.parent.run.id)).status,422);
  assert.equal((await f.call(f.path,undefined,{headers:{authorization:"Bearer unrelated-app"}})).status,403);
  const {chatChange,...ordinary}=f.body;
  assert.equal((await f.submit(key,ordinary)).status,422);
  for (const patch of [{contextId:f.parent.task.contextId},{sql:"SELECT 1"},{derivation:{...f.parent.derivation,taskId:randomUUID()}},
    {chatChange:{...chatChange,actor:"someone"}},{approvalId:randomUUID()},{background:true}]) {
    assert.ok([409,422].includes((await f.submit(key,{...f.body,...patch})).status));
  }
  assert.equal((await f.submit("chat-derive-v1-"+"a".repeat(64))).status,409);
  f.store.update("agent_intent",f.intent.id,PROJECT,{submittedBy:"another-user"});
  assert.equal((await f.call(f.path)).status,403);
  assert.equal((await f.submit(key)).status,403);
  f.store.update("agent_intent",f.intent.id,PROJECT,{submittedBy:"local-engineer"});
  f.store.update("agent",f.parent.task.id,PROJECT,{attempts:f.parent.task.attempts.map(a=>({...a,model:"SYNTHETIC_MODEL"}))});
  const invalid=(await f.call(f.path)).body;
  assert.equal(invalid.eligible,false);assert.equal(invalid.nextRequestId,null);
  assert.equal((await f.submit(key)).status,409);
  assert.deepEqual(f.counts,{syntheticModel:0,syntheticSpark:0});
});

test("a measured assertion failure allows an explicit next change; unconfirmed usage or Worker outcome leaves it pending",async t=>{
  const f=await fixture(t),key=(await f.call(f.path)).body.nextRequestId;
  const submitted=await f.submit(key);
  const task=await f.poll("/agent/tasks/"+submitted.body.id,item=>item.status==="SUCCEEDED");
  const run=f.store.get("run",task.runId,PROJECT);
  const validation={...run.validation,passed:false,regressions:run.validation.regressions.map((r,i)=>({...r,passed:i!==0}))};
  const attempts=task.attempts.map(a=>({...a,status:"VALIDATION_FAILED"}));
  f.store.update("run",run.id,PROJECT,{status:"VALIDATION_FAILED",validation});
  f.store.update("agent",task.id,PROJECT,{status:"FAILED",attempts,finishedAt:new Date().toISOString()});
  const settled=(await f.call(f.path)).body;
  assert.ok(settled.nextRequestId);
  assert.equal(settled.changes[0].runId,run.id);
  assert.equal(settled.changes[0].status,"FAILED");
  assert.equal((await f.submit(key)).body.id,task.id);
  f.store.update("agent",task.id,PROJECT,{attempts:attempts.map(a=>({...a,usageEstimated:true}))});
  assert.equal((await f.call(f.path)).body.nextRequestId,null);
  assert.equal((await f.submit(settled.nextRequestId)).status,409);
  f.store.update("agent",task.id,PROJECT,{attempts});
  f.store.update("run",run.id,PROJECT,{code:"REMOTE_SPARK_TIMEOUT"});
  assert.equal((await f.call(f.path)).body.nextRequestId,null);
  assert.deepEqual(f.counts,{syntheticModel:1,syntheticSpark:1});
});

test("a durable child can be recovered while still queued from the normal receipt and chat ledger",async t=>{
  const f=await fixture(t);
  let attempts=0;
  const forbidden=async()=>{attempts++;throw Error("Unexpected paid or remote action");};
  const runner=Object.assign(forbidden,{durable:{prepare:forbidden,submit:forbidden,read:forbidden,cancel:forbidden},
    descriptor:{engine:"Apache Spark",isolation:"REMOTE_FUNCTION",publicWriteEnabled:true,healthVerified:true}});
  const app=createV2Server({root:f.root,store:f.store,env:{V2_LOCAL_DEVELOPMENT:"true",V2_DURABLE_SQL_AGENT_ENABLED:"true"},
    runner,generator:forbidden});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  try {
    const base="http://127.0.0.1:"+app.server.address().port+"/api/v2";
    const key=(await (await fetch(base+f.path)).json()).nextRequestId;
    const post=()=>fetch(base+"/agent/tasks",{method:"POST",headers:{"content-type":"application/json","x-shuduo-client":"cli","idempotency-key":key},body:JSON.stringify(f.body)});
    const response=await post();assert.equal(response.status,202);
    const queued=await response.json();assert.equal(queued.stage,"READY_FOR_MODEL");
    assert.equal((await (await post()).json()).id,queued.id);
    const saved=await (await fetch(base+f.path)).json();
    assert.equal(saved.changes[0].taskId,queued.id);assert.equal(saved.nextRequestId,null);
    assert.equal((await (await fetch(base+"/agent/requests/"+key)).json()).id,queued.id);
    f.store.update("agent",queued.id,PROJECT,{message:"变更了创建时已确认的需求"});
    assert.equal((await fetch(base+f.path)).status,409);
    assert.equal(attempts,0);
  } finally {app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.dispose();}
});
