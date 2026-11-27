import test from "node:test";
import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { PROJECT,createV2Server } from "../../src/v2/server.mjs";
import { V2Client } from "../../src/v2/client.mjs";
import { readChatChangeDelivery,prepareChatChangeDelivery } from "../../src/v2/chat-change-delivery-client.mjs";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";
import { createLocalSourceApiFixture } from "./fixtures/local-service-api-journey.mjs";
import { seedContextDerivation } from "./fixtures/agent-context-derivation.mjs";

// The existing derivation fixture models stored protocol records and counts
// synthetic provider/Spark calls; this suite does not claim a live model.
async function fixture(t,{signed=false}={}) {
  const f=await createLocalSourceApiFixture();
  t.after(()=>f.dispose());
  let actor="local-engineer",sessionHeaders={};
  if (signed) {
    const credentials={email:'owner@example.invalid',password:'SyntheticChat#2027'};
    const user=f.auth.bootstrapAdmin({...credentials,displayName:'虚构开发者'});
    const login=f.auth.login(credentials);
    actor=user.id;
    sessionHeaders={cookie:'shuduo_session='+login.rawToken,'x-csrf-token':login.csrfToken};
  }
  const call=(path,body,{headers={}}={})=>f.call(path,body,{headers:{...sessionHeaders,...headers}});
  const parent=seedContextDerivation(f.store,PROJECT,{actorId:actor});
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
  return {...f,call,parent,intent,path,body,submit:(key,input=body)=>call("/agent/tasks",input,{headers:{"idempotency-key":key}})};
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

test('the selected child has one independently rehearsed package; parent and foreign receipts cannot replace it',async t=>{
  const f=await fixture(t);
  const changeId=(await f.call(f.path)).body.nextRequestId;
  const created=await f.submit(changeId);
  const child=await f.poll('/agent/tasks/'+created.body.id,task=>task.status==='SUCCEEDED');
  const path=f.path+'/'+changeId+'/delivery',view=(await f.call(path)).body;
  assert.equal(view.status,'NOT_PREPARED');
  assert.equal(view.source.taskId,child.id);
  assert.equal(view.source.runId,child.runId);
  assert.equal(view.parent.taskId,f.parent.task.id);
  const send=(body={source:view.source,confirm:true},key=view.requestId)=>f.call(path,body,{headers:{'idempotency-key':key}});
  assert.equal((await send({source:view.parent,confirm:true})).status,409);
  assert.equal((await send({source:view.source,confirm:false})).status,422);
  assert.equal((await send(undefined,randomUUID())).status,409);
  assert.equal((await f.call(path+'?taskId='+f.parent.task.id)).status,422);
  assert.equal((await f.call(path,undefined,{headers:{authorization:'Bearer unrelated-example'}})).status,403);
  assert.equal(f.store.list('agent_delivery_task',PROJECT).length,0);
  const client=new V2Client({baseUrl:f.base});
  const input={intentId:view.intentId,changeRequestId:changeId,sourceRunId:child.runId,requestId:view.requestId,confirm:true};
  let lostWrites=0,notifyPost;
  const posting=new Promise(resolve=>{notifyPost=resolve;});
  const lostResponse={request:async(path,options)=>{
    if (options?.method==='POST') notifyPost();
    const answer=await client.request(path,options);
    if (options?.method==='POST') {lostWrites++;throw Error('Simulated missing acknowledgement');}
    return answer;
  }};
  await assert.rejects(prepareChatChangeDelivery(lostResponse,{...input,sourceRunId:view.parent.runId}));
  await assert.rejects(prepareChatChangeDelivery(lostResponse,{...input,confirm:false}));
  assert.equal(lostWrites,0);
  const preparing=prepareChatChangeDelivery(lostResponse,input);
  await Promise.race([posting,preparing]);
  const [recovered,one,two]=await Promise.all([preparing,send(),send()]);
  assert.equal(lostWrites,1);
  assert.equal(recovered.delivery.id,one.body.delivery.id);
  assert.ok([200,202].includes(one.status),one.body.error);
  assert.ok([200,202].includes(two.status),two.body.error);
  assert.equal(one.body.delivery.id,two.body.delivery.id);
  const proof=await f.poll(path,item=>item.status==='SUCCEEDED');
  assert.equal(proof.requestId,view.requestId);
  assert.equal(proof.package.manifest.source.derivation.taskId,f.parent.task.id);
  assert.equal(proof.package.manifest.source.revisionId,child.revisionId);
  assert.equal(proof.package.files['main.sql'],child.sql);
  assert.equal(Object.keys(proof.package.files).length,8);
  assert.deepEqual(JSON.parse(proof.package.files['deployment.json']).runtime.version,'3.5.9');
  assert.equal(proof.verification.validation.regressions.length,5);
  assert.equal(proof.verification.testSqlValidation.sqlHash,proof.package.manifest.files['tests.sql'].sha256);
  assert.equal(proof.verification.businessDate,'2026-09-10');
  let output;
  const command=['agent','chat-delivery','--id',view.intentId,'--change-request-id',changeId];
  assert.equal(await runV2Cli(command,{},{client,output:value=>{output=JSON.parse(value);},error:()=>{}}),0);
  assert.deepEqual(output,proof);
  const rpc=await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{
    name:'agent_prepare_chat_change_delivery',arguments:input}},{client});
  assert.deepEqual(JSON.parse(rpc).result.structuredContent,proof);
  for (const change of [p=>{p.package.files['deployment.json']+=' ';},p=>{p.verification.executionOrder.reverse();},
    p=>{p.verification.businessDate='2026-01-01';},p=>{p.source=p.parent;}]){
    const altered=structuredClone(proof);change(altered);
    await assert.rejects(readChatChangeDelivery({request:async()=>altered},input));
  }
  const schedule=JSON.parse(proof.package.files['schedule.json']);
  assert.deepEqual(proof.verification.executionOrder,schedule.nodes.map(node=>node.id));
  assert.equal(proof.verification.id,proof.delivery.verificationId);
  assert.equal((await send()).body.delivery.id,proof.delivery.id);
  assert.equal(f.store.list('agent_delivery_task',PROJECT).length,1);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,1);
  assert.equal(f.store.list('release',PROJECT).length,0);
  assert.equal(f.store.list('release_approval',PROJECT).length,0);
  const verification=f.store.get('delivery_verification',proof.verification.id,PROJECT);
  f.store.update('delivery_verification',verification.id,PROJECT,{rows:f.parent.run.rows});
  assert.equal((await f.call(path)).status,409);
  assert.equal((await send()).status,409);
  f.store.update('delivery_verification',verification.id,PROJECT,{rows:verification.rows});
  const bundle=f.store.get('delivery_package',proof.package.id,PROJECT);
  f.store.update('delivery_package',bundle.id,PROJECT,{files:{...bundle.files,'schedule.json':'{}'}});
  assert.ok([409,422].includes((await f.call(path)).status));
  assert.deepEqual(f.counts,{syntheticModel:1,syntheticSpark:2});
});

test('a prior matching child rehearsal is reused and an interrupted request remains recoverable',async t=>{
  const f=await fixture(t);
  const id=(await f.call(f.path)).body.nextRequestId,created=await f.submit(id);
  const child=await f.poll('/agent/tasks/'+created.body.id,item=>item.status==='SUCCEEDED');
  const made=await f.call('/agent/tasks/'+child.id+'/prepare-delivery',{});
  const delivery=await f.poll('/agent/deliveries/'+made.body.id,item=>item.status==='SUCCEEDED');
  const path=f.path+'/'+id+'/delivery',view=(await f.call(path)).body;
  assert.equal(view.delivery.id,delivery.id);
  const submit=()=>f.call(path,{source:view.source,confirm:true},{headers:{'idempotency-key':view.requestId}});
  const ledger=`${PROJECT}:agent-delivery:${child.id}:${view.requestId}`;
  assert.equal(f.store.deduplicatedId(ledger),undefined);
  assert.equal((await submit()).body.verification.id,delivery.verificationId);
  assert.equal(f.store.deduplicatedId(ledger),delivery.id);
  f.store.update('agent_delivery_task',delivery.id,PROJECT,{status:'INTERRUPTED',stage:'INTERRUPTED'});
  assert.equal((await submit()).body.status,'INTERRUPTED');
  assert.equal(f.store.list('delivery_verification',PROJECT).length,1);
  assert.deepEqual(f.counts,{syntheticModel:1,syntheticSpark:2});
});

test('signed chat delivery requires the original development write privilege even when the user still owns the conversation',async t=>{
  const f=await fixture(t,{signed:true});
  const changeId=(await f.call(f.path)).body.nextRequestId;
  const child=(await f.submit(changeId)).body;
  await f.poll('/agent/tasks/'+child.id,task=>task.status==='SUCCEEDED');
  const path=f.path+'/'+changeId+'/delivery', current=(await f.call(path)).body;
  const actor=f.parent.actorId;
  f.store.update('auth_user',actor,PROJECT,{memberships:[{projectId:PROJECT,role:'PRODUCT_MANAGER'}]});
  assert.equal((await f.call(path)).body.status,'NOT_PREPARED');
  const rejected=await f.call(path,{source:current.source,confirm:true},{headers:{'idempotency-key':current.requestId}});
  assert.equal(rejected.status,403);
  assert.equal(f.store.list('agent_delivery_task',PROJECT).length,0);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,0);
});

async function readyChatPublication(t,options) {
  const f=await fixture(t,options);
  const changeId=(await f.call(f.path)).body.nextRequestId,child=(await f.submit(changeId)).body;
  await f.poll('/agent/tasks/'+child.id,row=>row.status==='SUCCEEDED');
  const deliveryPath=f.path+'/'+changeId+'/delivery',path=f.path+'/'+changeId+'/publication';
  assert.equal((await f.call(path)).status,409);
  const draft=(await f.call(deliveryPath)).body;
  await f.call(deliveryPath,{source:draft.source,confirm:true},{headers:{'idempotency-key':draft.requestId}});
  for(let n=0;;n++){
    const saved=await f.call(deliveryPath);assert.equal(saved.status,200);
    if(saved.body.status==='SUCCEEDED')break;
    assert.ok(n<100);await new Promise(resolve=>setTimeout(resolve,10));
  }
  const initial=await f.call(path);assert.equal(initial.status,200,JSON.stringify(initial.body));
  const ready=initial.body;
  const body={source:ready.source,packageId:ready.packageId,packageDigest:ready.packageDigest,verificationId:ready.verificationId,
    reviewDigest:ready.reviewDigest,confirm:true,attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}};
  const publish=(args=body,key=ready.requestId,headers={})=>f.call(path,args,{headers:{'idempotency-key':key,...headers}});
  return {...f,path,child,ready,body,publish};
}

test('one explicit reviewed chat publication allocates two timed child batches and recovers original evidence',async t=>{
  const f=await readyChatPublication(t);
  assert.equal(f.ready.phase,'READY');assert.equal(f.ready.canPublish,true);assert.deepEqual(f.ready.runs,[]);
  assert.equal((await f.publish({...f.body,attestations:{...f.body.attestations,assertions:false}})).status,422);
  assert.equal((await f.publish({...f.body,source:f.ready.parent})).status,409);
  assert.equal((await f.publish({...f.body,verificationId:randomUUID()})).status,409);
  assert.equal((await f.publish({...f.body,reviewDigest:'a'.repeat(64)})).status,409);
  assert.equal((await f.publish(f.body,randomUUID())).status,409);
  assert.equal((await f.call(f.path,undefined,{headers:{authorization:'Bearer unrelated'}})).status,403);
  assert.equal(f.store.list('delivery_review',PROJECT).length,0);
  const [first,replay]=await Promise.all([f.publish(),f.publish()]);
  for(const v of [first,replay])assert.ok([200,201].includes(v.status),JSON.stringify(v.body));
  assert.equal(first.body.release.id,replay.body.release.id);
  assert.deepEqual(first.body.runs.map(r=>r.id),replay.body.runs.map(r=>r.id));
  const done=await f.poll(f.path,row=>row.monitoringVerified);
  assert.equal(done.phase,'PUBLISHED');assert.equal(done.release.health,'HEALTHY');
  assert.equal(done.release.status,'ACTIVE_LOCAL');assert.equal(done.reviewActorScope,'LOCAL_DEVELOPER');
  assert.deepEqual(done.runs.map(r=>[r.sequence,r.totalAssets,r.status,r.assertionCount,r.schedulerTriggered,r.testSqlPassed]),
    [[1,'2250.00','SUCCEEDED',5,true,true],[2,'2250.00','SUCCEEDED',5,true,true]]);
  assert.deepEqual(new Set(done.events.map(e=>e.releaseRunId)),new Set(done.runs.map(r=>r.id)));
  assert.equal(done.events.filter(e=>e.type==='BATCH_SUCCEEDED').length,2);
  for(const kind of ['release','release_approval','delivery_review'])assert.equal(f.store.list(kind,PROJECT).length,1);
  assert.equal(f.store.list('release_run',PROJECT).length,2);
  assert.equal((await f.publish()).body.monitoringVerified,true);
  const original=f.store.get('release_run',done.runs[0].id,PROJECT);
  f.store.update('release_run',original.id,PROJECT,{rows:f.parent.run.rows});
  assert.equal((await f.call(f.path)).status,409);
  assert.equal((await f.publish()).status,409);
  f.store.update('release_run',original.id,PROJECT,{rows:original.rows});
  const selection=new URLSearchParams({agent_task_id:f.child.id,package_digest:done.packageDigest,release_id:done.release.id});
  const services=await f.call('/data-services/sources?'+selection);
  assert.equal(services.status,200);
  assert.deepEqual(new Set(services.body.map(s=>s.releaseRunId??s.id)),new Set(done.runs.map(r=>r.id)));

  const readonly=createV2Server({root:f.root,store:f.store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_EXECUTION_UNAVAILABLE:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
  await new Promise(resolve=>readonly.server.listen(0,'127.0.0.1',resolve));
  try {
    const client=new V2Client({baseUrl:'http://127.0.0.1:'+readonly.server.address().port+'/api/v2'});
    const reopened=await client.request(f.path);
    assert.deepEqual(reopened,{...done,canPublish:false});
    await assert.rejects(client.request(f.path,{method:'POST',body:f.body,idempotencyKey:done.requestId}),err=>err.status===503);
  } finally {readonly.server.closeAllConnections();await new Promise(resolve=>readonly.server.close(resolve));readonly.dispose();}
  assert.deepEqual(f.counts,{syntheticModel:1,syntheticSpark:4});
});

test('a read-only role, unrelated prior publication, or interrupted registration cannot authorize additional runs',async t=>{
  const f=await readyChatPublication(t,{signed:true});
  const actor=f.parent.actorId;
  f.store.update('auth_user',actor,PROJECT,{memberships:[{projectId:PROJECT,role:'PRODUCT_MANAGER'}]});
  assert.equal((await f.call(f.path)).body.canPublish,false);
  assert.equal((await f.publish()).status,403);
  f.store.update('auth_user',actor,PROJECT,{memberships:[{projectId:PROJECT,role:'ADMIN'}]});
  assert.equal((await f.publish(f.body,f.ready.requestId,{'x-csrf-token':''})).status,403);
  const create=f.store.create.bind(f.store);
  f.store.create=(kind,project,data)=>{
    if(kind==='release_run'&&data.sequence===2)throw Error('Injected transaction interruption');
    return create(kind,project,data);
  };
  try {assert.equal((await f.publish()).status,500);} finally {f.store.create=create;}
  for(const kind of ['release','release_run','release_approval','delivery_review'])assert.equal(f.store.list(kind,PROJECT).length,0);
  assert.equal((await f.call(f.path)).body.phase,'READY');
  const external=f.store.create('release',PROJECT,{packageId:f.ready.packageId,packageDigest:f.ready.packageDigest});
  const blocked=await f.publish();assert.equal(blocked.status,409);assert.equal(blocked.body.code,'CHAT_PACKAGE_ALREADY_PUBLISHED');
  assert.deepEqual(f.store.list('release',PROJECT).map(r=>r.id),[external.id]);
  assert.deepEqual(f.counts,{syntheticModel:1,syntheticSpark:2});
});
