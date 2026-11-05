import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { validationFamilyForContext } from "../../src/v2/context.mjs";
import { createLocalSourceApiFixture } from "./fixtures/local-service-api-journey.mjs";
import { seedContextDerivation } from "./fixtures/agent-context-derivation.mjs";

// Real controller/loopback with synthetic model/Spark only. No cloud credentials.
async function successfulLocal(t) {
  const f=await createLocalSourceApiFixture();t.after(()=>f.dispose());
  const made=await f.call("/agent/tasks",{message:"原生证券客户资产成功来源",sql:"SELECT 1",contextId:"holdings-t1"});assert.equal(made.status,202);
  const task=await f.poll(`/agent/tasks/${made.body.id}`,value=>["SUCCEEDED","FAILED"].includes(value.status));assert.equal(task.status,"SUCCEEDED");
  const revision=f.store.get("revision",task.revisionId,PROJECT),run=f.store.get("run",task.runId,PROJECT);
  const derivation={kind:"REGISTERED_CONTEXT_CHANGE",taskId:task.id,revisionId:revision.id,runId:run.id,revisionHash:revision.hash};
  const body={message:"将已成功任务变更为股票持仓与现金口径",language:"SPARK_SQL",sql:revision.sql,contextId:"stock-cash-t1",derivation};
  return {...f,task,revision,run,derivation,body};
}

test("local POST derives from the actual producer once, preserves exact SQL and leaves parent execution/publication history unchanged",async t=>{
  const f=await successfulLocal(t),before={task:structuredClone(f.task),run:structuredClone(f.run),revision:structuredClone(f.revision),counts:{...f.counts}};
  const headers={"idempotency-key":"synthetic-context-derive-once"};
  const made=await f.call("/agent/tasks",f.body,{headers});assert.equal(made.status,202);assert.notEqual(made.body.id,f.task.id);
  assert.deepEqual(made.body.derivedFrom,{...f.derivation,contextId:"holdings-t1",validationContractId:validationFamilyForContext("holdings-t1").id});
  assert.deepEqual(Object.keys(made.body.derivedFrom).sort(),["kind","taskId","revisionId","runId","revisionHash","contextId","validationContractId"].sort());
  assert.equal(made.body.initialSql,f.revision.sql);assert.equal(made.body.usedTokens,0);assert.deepEqual(made.body.attempts,[]);
  for(const field of ["revisionId","runId","approvalId","releaseId","sourceRunId","background"])assert.equal(made.body[field],undefined);
  const repeated=await f.call("/agent/tasks",f.body,{headers});assert.equal(repeated.status,202);assert.equal(repeated.body.id,made.body.id);
  assert.equal((await f.call("/agent/tasks",{...f.body,contextId:"cash-change"},{headers})).status,409);
  const child=await f.poll(`/agent/tasks/${made.body.id}`,value=>["SUCCEEDED","FAILED"].includes(value.status));assert.equal(child.status,"SUCCEEDED");
  assert.equal(child.contextId,"stock-cash-t1");assert.notEqual(child.runId,f.run.id);assert.notEqual(child.revisionId,f.revision.id);
  assert.equal(child.validationContractId,validationFamilyForContext("stock-cash-t1").id);assert.equal(child.fullLifecycleE2E,false);
  assert.deepEqual(f.counts,{syntheticModel:before.counts.syntheticModel+1,syntheticSpark:before.counts.syntheticSpark+1});
  assert.deepEqual(f.store.get("agent",f.task.id,PROJECT),before.task);assert.deepEqual(f.store.get("revision",f.revision.id,PROJECT),before.revision);
  assert.deepEqual(f.store.get("run",f.run.id,PROJECT),before.run);
  for(const kind of ["agent_delivery_task","release_approval","release"])assert.equal(f.store.list(kind,PROJECT).length,0);
});

test("local derivation rejects unsupported or contradictory sources before new model tasks or runs",async t=>{
  const f=await successfulLocal(t),counts={...f.counts};
  for(const patch of [{derivation:null},{derivation:{...f.derivation,extra:true}},{language:"PYTHON"},
    {sourceRunId:f.run.id},{sourceError:"must not borrow failure"},{sql:"SELECT changed"},{sql:f.revision.sql.trim()},
    {code:"SELECT changed"},{contextId:"holdings-t1"},{contextId:"unknown-context"},{derivation:{...f.derivation,revisionHash:"f".repeat(64)}},
    {derivation:{...f.derivation,runId:randomUUID()}}]){
    const response=await f.call("/agent/tasks",{...f.body,...patch});assert.ok([400,409,422].includes(response.status),JSON.stringify(patch));
  }
  const other=seedContextDerivation(f.store,PROJECT,{actorId:"other-owner"});
  assert.equal((await f.call("/agent/tasks",{...f.body,sql:other.sql,derivation:other.derivation})).status,409);
  const outside=seedContextDerivation(f.store,"different-project",{actorId:"local-engineer"});
  assert.equal((await f.call("/agent/tasks",{...f.body,sql:outside.sql,derivation:outside.derivation})).status,409);
  f.store.update("agent",f.task.id,PROJECT,{status:"FAILED"});assert.equal((await f.call("/agent/tasks",f.body)).status,409);
  assert.deepEqual(f.counts,counts);assert.equal(f.store.list("agent",PROJECT).length,2);assert.equal(f.store.list("run",PROJECT).length,2);
});

test("logged-in local durable and invited durable creation use the same actor for source validation and the new task",async t=>{
  for(const local of [true,false]){
    const root=mkdtempSync(join(tmpdir(),"shuduo-derive-actor-")),store=new MetadataStore(":memory:");let calls=0;
    const forbidden=async()=>{calls++;throw Error("synthetic metadata creation must not execute");};
    const runner=Object.assign(forbidden,{durable:{prepare:forbidden,submit:forbidden,read:forbidden,cancel:forbidden},
      descriptor:{engine:"Apache Spark",isolation:"REMOTE_FUNCTION",publicWriteEnabled:true,healthVerified:true}});
    const app=createV2Server({root,store,runner,generator:forbidden,env:{V2_LOCAL_DEVELOPMENT:String(local),V2_DURABLE_SQL_AGENT_ENABLED:"true",V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true"}});
    await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
    t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});});
    const password="SyntheticDerivation!2026",owner=app.auth.bootstrapAdmin({email:"derive-owner@example.invalid",displayName:"合成创建者",password});
    app.auth.bootstrapAdmin({email:"derive-other@example.invalid",displayName:"合成其他管理员",password});
    const call=async(path,body,session={},key="synthetic-actor-derivation")=>{
      const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2${path}`,{method:body===undefined?"GET":"POST",signal:AbortSignal.timeout(5000),
        headers:{"content-type":"application/json","x-shuduo-client":"cli","idempotency-key":key,...session},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
    };
    const login=async email=>{const value=await call("/auth/login",{email,password});assert.equal(value.status,200);return {cookie:value.cookies.map(cookie=>cookie.split(";")[0]).join("; "),"x-csrf-token":value.body.csrfToken};};
    const session=await login("derive-owner@example.invalid"),otherSession=await login("derive-other@example.invalid");
    const source=seedContextDerivation(store,PROJECT,{actorId:owner.id}),parent=structuredClone(source.task);
    const body={message:"变更成功原生任务的证券口径",sql:source.sql,contextId:"stock-cash-t1",derivation:source.derivation};
    assert.equal((await call("/agent/tasks",body,otherSession,"other-owner")).status,409,"ADMIN read authority does not confer another owner's derivation");
    if(!local)assert.equal((await call("/agent/tasks",body,{...session,"x-csrf-token":"invalid"},"wrong-csrf")).status,403);
    const made=await call("/agent/tasks",body,session);assert.equal(made.status,202,JSON.stringify(made.body));
    assert.equal(store.get("agent",made.body.id,PROJECT).submittedBy,owner.id);assert.equal(made.body.stage,"READY_FOR_MODEL");
    assert.deepEqual(made.body.derivedFrom,{...source.derivation,contextId:"holdings-t1",validationContractId:source.family.id});
    assert.equal((await call("/agent/tasks",body,session)).body.id,made.body.id);assert.equal(calls,0);
    assert.deepEqual(store.get("agent",source.task.id,PROJECT),parent);
  }
});
