import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createV2Server, PROJECT} from "../../src/v2/server.mjs";
import {MetadataStore} from "../../src/v2/store.mjs";
import {createFcIngress} from "../../src/v2/fc-ingress.mjs";
import {LocalArtifactStore} from "../../src/v2/artifact-store.mjs";
import {createDeliveryPackage} from "../../src/v2/delivery.mjs";
import {createLiveLifecycleFixture} from "./fixtures/live-lifecycle-case.mjs";

async function fixture(t, readOnly) {
  const root = mkdtempSync(join(tmpdir(),"shuduo-delivery-isolation-"));
  const store = new MetadataStore(join(root,"metadata.sqlite"));
  const artifactStore = new LocalArtifactStore(join(root,"objects"));
  const put = artifactStore.put.bind(artifactStore);
  let artifactWrites = 0, executionCalls = 0;
  artifactStore.put = (...args) => { artifactWrites++; return put(...args); };
  const noExecution = () => { executionCalls++; throw Error("DELIVERY_AUTH_MUST_RUN_BEFORE_EXECUTION"); };
  const app = createV2Server({root, store, artifactStore, runner:noExecution, deliveryRunner:noExecution,
    env:{V2_LOCAL_DEVELOPMENT:"false", V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true", V2_RELEASE_SCHEDULER_MODE:"DISABLED"},
    ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:readOnly})});
  const password = "SyntheticOnly!2026";
  function member(label, role) {
    const email = label + "@example.invalid";
    const user = app.auth.bootstrapAdmin({email,password,displayName:"虚构权限验收"});
    store.update("auth_user",user.id,PROJECT,{memberships:[{projectId:PROJECT,role}]});
    return {email, id:user.id};
  }
  const owner = member("owner","ENGINEER"), other = member("other","ENGINEER");
  const admin = member("reviewer","ADMIN"), viewer = member("viewer","VIEWER");
  function chain(actor, name, manual=false) {
    const f = createLiveLifecycleFixture();
    let agent = manual ? undefined : store.create("agent",PROJECT,{...f.task,submittedBy:actor.id});
    const revision = store.create("revision",PROJECT,{...f.revision,author:actor.id,...(manual?{source:"MANUAL"}:{})});
    const run = store.create("run",PROJECT,{...f.run,agentTaskId:agent?.id,revisionId:revision.id,revisionHash:revision.hash});
    if (agent) agent = store.update("agent",agent.id,PROJECT,{
      attempts:[{...f.task.attempts[0],revisionId:revision.id,runId:run.id}],revisionId:revision.id,runId:run.id,
    });
    const bundle = createDeliveryPackage({name,run,revision,agent});
    const pack = store.create("delivery_package",PROJECT,{...bundle,sourceRunId:run.id,
      artifact:{key:"EXAMPLE_INTERNAL_STORAGE_REFERENCE"}});
    const delivery = store.create(manual ? "manual_delivery_task" : "agent_delivery_task",PROJECT,{
      sourceAgentTaskId:agent?.id, sourceRunId:run.id,sourceRevisionId:revision.id,sourceSqlHash:revision.hash,
      packageId:pack.id,packageDigest:pack.digest,submittedBy:actor.id,status:"SUCCEEDED",
    });
    store.update("delivery_package",pack.id,PROJECT,{[manual?"manualDeliveryTaskId":"agentDeliveryTaskId"]:delivery.id});
    const link = {packageId:pack.id,packageDigest:pack.digest};
    const rehearsal = store.create("delivery_verification",PROJECT,{...link,
      [manual?"manualDeliveryTaskId":"agentDeliveryTaskId"]:delivery.id,status:"SUCCEEDED"});
    store.update(manual?"manual_delivery_task":"agent_delivery_task",delivery.id,PROJECT,{verificationId:rehearsal.id});
    const review = store.create("delivery_review",PROJECT,{...link,verificationId:rehearsal.id,status:"REVIEWED"});
    const approval = store.create("release_approval",PROJECT,{...link,reviewId:review.id,rehearsalId:rehearsal.id,status:"APPROVED"});
    const release = store.create("release",PROJECT,{...link,approvalId:approval.id,status:"ACTIVE_LOCAL"});
    const batch = store.create("release_run",PROJECT,{...link,releaseId:release.id,status:"VALIDATION_FAILED",
      error:manual?"EXAMPLE_OTHER_BATCH_EVIDENCE":"EXAMPLE_PRIVATE_BATCH_EVIDENCE",remoteSubmission:{private:"EXAMPLE_INTERNAL_WORKER_REFERENCE"}});
    const event = store.create("monitor_event",PROJECT,{releaseId:release.id,releaseRunId:batch.id,type:"BATCH_FAILED"});
    const alert = store.create("monitor_alert",PROJECT,{releaseId:release.id,releaseRunId:batch.id,status:"OPEN"});
    const incident = store.create("ops_incident",PROJECT,{sourceKind:"release_run",sourceId:batch.id,resourceType:"release",
      resourceId:release.id,status:"OPEN",message:batch.error});
    return {agent,revision,run,pack,delivery,rehearsal,review,approval,release,batch,event,alert,incident};
  }
  const first = chain(owner,"虚构原属人交付"), second = chain(other,"虚构手工交付",true);
  const orphan = store.create("delivery_package",PROJECT,{name:"孤立虚构记录",files:{"main.sql":"select 1"}});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{
    app.releaseScheduler.shutdown();app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});
  });
  const base = "http://127.0.0.1:"+app.server.address().port+"/api/v2";
  const call = async (path, session, body) => {
    const response = await fetch(base+path,{method:body===undefined?"GET":"POST", headers:{
      "content-type":"application/json","x-shuduo-client":"workbench","idempotency-key":randomUUID(),...session,
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
  };
  const login = async user => {
    const response = await call("/auth/login",undefined,{email:user.email,password});
    assert.equal(response.status,200);
    return {cookie:response.cookies.map(value=>value.split(";")[0]).join("; "),"x-csrf-token":response.body.csrfToken};
  };
  const sessions = {};
  for (const [role,user] of Object.entries({owner,other,admin,viewer})) sessions[role]=await login(user);
  return {store,call,sessions,first,second,orphan,counts:()=>({artifactWrites,executionCalls})};
}

test("invited read-only HTTP keeps package, rehearsal, approval, release and monitoring evidence within the source account",async t=>{
  const f=await fixture(t,true);
  const {owner,other,admin,viewer}=f.sessions;
  const x=f.first;
  for(const [route,id] of [
    ["/delivery/packages",x.pack.id],["/delivery/verifications",x.rehearsal.id],["/delivery/reviews",x.review.id],
    ["/release/approvals",x.approval.id],["/releases",x.release.id],["/release/runs",x.batch.id],
    ["/operations/incidents",x.incident.id],
  ]){
    assert.equal((await f.call(route)).status,401,route);
    assert((await f.call(route,owner)).body.some(row=>row.id===id),route);
    assert(!(await f.call(route,other)).body.some(row=>row.id===id),route);
    assert(!(await f.call(route,viewer)).body.some(row=>row.id===id),route);
    assert((await f.call(route,admin)).body.some(row=>row.id===id),route);
  }
  for(const route of [
    "/delivery/packages/"+x.pack.id,"/delivery/verifications/"+x.rehearsal.id,"/releases/"+x.release.id,
    "/release/runs/"+x.batch.id,"/operations/incidents/"+x.incident.id,
  ]){
    assert.equal((await f.call(route,owner)).status,200,route);
    assert.equal((await f.call(route,other)).status,403,route);
    assert.equal((await f.call(route,admin)).status,200,route);
  }
  const own = await f.call("/delivery/packages/"+x.pack.id,owner);
  assert.equal(own.body.files["main.sql"],x.pack.files["main.sql"]);
  assert.equal(own.body.artifact,undefined);
  const manual = await f.call("/delivery/packages/"+f.second.pack.id,other);
  assert.equal(manual.status,200);
  assert.equal((await f.call("/delivery/packages/"+f.orphan.id,owner)).status,403);
  assert.equal((await f.call("/delivery/packages/"+f.orphan.id,admin)).status,200);
  const allowed = (await f.call("/monitoring/overview",owner)).body;
  assert(allowed.recentRuns.some(row=>row.id===x.batch.id));
  assert(allowed.recentEvents.some(row=>row.id===x.event.id));
  assert(allowed.alerts.some(row=>row.id===x.alert.id));
  assert(!JSON.stringify(allowed).includes("EXAMPLE_INTERNAL_WORKER_REFERENCE"));
  const denied = JSON.stringify((await f.call("/monitoring/overview",other)).body);
  for(const id of [x.release.id,x.batch.id,x.event.id,x.alert.id])assert(!denied.includes(id));
  const ops = JSON.stringify((await f.call("/operations/overview",other)).body);
  assert(!ops.includes(x.batch.id));
  assert(!ops.includes(x.run.id));
  assert(!ops.includes("EXAMPLE_PRIVATE_BATCH_EVIDENCE"));
  assert.equal((await f.call("/agent/tasks/"+x.agent.id+"/workflow",other)).status,403);
  assert.equal((await f.call("/agent/tasks/"+x.agent.id+"/workflow",owner)).body.package.id,x.pack.id);
  assert.deepEqual(f.counts(),{artifactWrites:0,executionCalls:0});
});

test("a foreign source or mismatched attachment is rejected before artifact and execution operations",async t=>{
  const f=await fixture(t,false);
  const {owner,other}=f.sessions;
  const x=f.first;
  const before = f.store.list("delivery_package",PROJECT);
  for(const [route,body] of [
    ["/delivery/packages",{sourceRunId:x.run.id}],
    ["/delivery/packages/"+x.pack.id+"/verify",{}],
    ["/delivery/packages/"+x.pack.id+"/review",{}],
    ["/delivery/packages/"+x.pack.id+"/approve",{}],
    ["/delivery/verifications/"+x.rehearsal.id+"/cancel",{}],
    ["/releases/"+x.release.id+"/rollback",{targetReleaseId:f.second.release.id}],
  ]){
    assert.equal((await f.call(route,other,body)).status,403,route);
  }
  const mixed=await f.call("/delivery/packages/"+x.pack.id+"/review",owner,{
    packageDigest:x.pack.digest,verificationId:f.second.rehearsal.id,reviewNote:"合成证据验收",
    attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true},
  });
  assert.equal(mixed.status,403);
  assert.deepEqual(f.counts(),{artifactWrites:0,executionCalls:0});
  assert.deepEqual(f.store.list("delivery_package",PROJECT),before);
  // Keep the original workflow usable while the source chain agrees.
  f.store.update("delivery_package",x.pack.id,PROJECT,{artifact:undefined});
  const reviewed=await f.call("/delivery/packages/"+x.pack.id+"/review",owner,{
    packageDigest:x.pack.digest,verificationId:x.rehearsal.id,reviewNote:"复核虚构原始交付",
    attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true},
  });
  assert.equal(reviewed.status,201);
  assert.equal(reviewed.body.packageId,x.pack.id);
  const adminReview=await f.call("/delivery/packages/"+x.pack.id+"/review",f.sessions.admin,{
    packageDigest:x.pack.digest,verificationId:x.rehearsal.id,reviewNote:"授权管理员复核同一版本",
    attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true},
  });
  assert.equal(adminReview.status,201);
  assert.equal(adminReview.body.reviewer.role,"ADMIN");
  f.store.update("agent_delivery_task",x.delivery.id,PROJECT,{packageId:f.second.pack.id});
  const alias=await f.call("/agent/tasks/"+x.agent.id+"/workflow",owner);
  assert.equal(alias.status,403);
  assert.equal((await f.call("/agent/deliveries/"+x.delivery.id,owner)).status,403);
  assert(!(await f.call("/agent/deliveries",owner)).body.some(item=>item.id===x.delivery.id));
  assert(!JSON.stringify(alias.body).includes("虚构手工交付"));
  assert.equal(f.counts().executionCalls,0);
});
