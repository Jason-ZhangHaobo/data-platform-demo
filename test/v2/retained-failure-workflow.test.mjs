import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MetadataStore} from "../../src/v2/store.mjs";
import {resolveEvidenceSource,developmentVerificationReport} from "../../src/v2/agent-development-workflow.mjs";
import {getContext,referenceSql,contextIds,validationContractId} from "../../src/v2/context.mjs";
import {createPasswordHash} from "../../src/v2/auth.mjs";
import {sha256} from "../../src/v2/delivery.mjs";
import {createV2Server,PROJECT} from "../../src/v2/server.mjs";

// Only synthetic persistent records and loopback HTTP; no model or Spark.
const code="AGENT_SQL_UNCHANGED_AFTER_FAILURE",password="SyntheticPassword!2026";
function fixture(t){
  const store=new MetadataStore(":memory:"),root=mkdtempSync(join(tmpdir(),"shuduo-retained-failure-"));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const user=email=>store.create("auth_user",PROJECT,{email,passwordHash:createPasswordHash(password),status:"ACTIVE",memberships:[{projectId:PROJECT,role:"ENGINEER"}]});
  const owner=user("owner@example.invalid"),other=user("other@example.invalid");
  const revision=store.create("revision",PROJECT,{source:"LIVE_MODEL",author:owner.id,sql:referenceSql,hash:sha256(referenceSql),contextId:"holdings-t1"});
  let agent=store.create("agent",PROJECT,{submittedBy:owner.id,status:"FAILED",code,mode:"LIVE_MODEL",executionMode:"DURABLE_SQL_AGENT_V1",language:"SPARK_SQL",
    contextId:revision.contextId,validationContractId,sql:revision.sql,revisionId:revision.id,attempts:[]});
  let run=store.create("run",PROJECT,{agentTaskId:agent.id,status:"VALIDATION_FAILED",contextId:agent.contextId,validationContractId,revisionId:revision.id,revisionHash:revision.hash,
    engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,rows:getContext(agent.contextId).expected,
    validation:{passed:false,contractId:validationContractId,issues:["重复持仓场景未通过"],regressions:contextIds.map(contextId=>({contextId,passed:contextId!=="duplicate-position"}))}});
  run=store.update("run",run.id,PROJECT,{remoteSubmission:{prepared:{job:{jobId:run.id}},submitted:true}});
  agent=store.update("agent",agent.id,PROJECT,{runId:run.id,attempts:[{attempt:1,status:run.status,revisionId:revision.id,runId:run.id},
    {attempt:2,status:"NO_SQL_CHANGE",code,computationSkipped:true,sourceRevisionId:revision.id,sourceRunId:run.id}]});
  return{store,root,owner,other,revision,run,agent,read:(kind,id)=>store.get(kind,id,PROJECT)};
}
test("retained evidence resolves the exact prior failure, while ordinary successful source selection stays unchanged",t=>{
  const f=fixture(t),resolved=resolveEvidenceSource(f.agent,f.read);
  assert.equal(resolved.retainedFailure,true);assert.deepEqual(resolved.run,f.run);assert.deepEqual(resolved.revision,f.revision);
  assert.equal(developmentVerificationReport(f.agent,resolved.run,resolved.revision).status,"NEEDS_ATTENTION");
  const normal={...f.agent,code:undefined,status:"SUCCEEDED",attempts:[{status:"SUCCEEDED",revisionId:f.revision.id,runId:f.run.id}]};
  assert.deepEqual(resolveEvidenceSource(normal,f.read),{revision:f.revision,run:f.run,retainedFailure:false});
  assert.deepEqual(resolveEvidenceSource({...normal,attempts:[]},f.read),{revision:undefined,run:undefined,retainedFailure:false});
});
test("partial no-change markers, foreign provenance, changed code, successful or untrusted receipts cannot become retained evidence",t=>{
  const f=fixture(t);
  for(const change of [
    (a)=>{a.code=undefined;},(a)=>{a.attempts[1].code="OTHER";},(a)=>{a.attempts[1].computationSkipped=false;},(a)=>{a.status="SUCCEEDED";},
    (a)=>{a.attempts[1].runId=f.run.id;},(a)=>{a.attempts[1].sourceRunId="foreign-run";},(a)=>{a.attempts[0].runId="foreign-run";},
    (a)=>{a.contextId="cash-change";},(a)=>{a.sql="SELECT 1";},(a)=>{a.submittedBy=f.other.id;},
    (_a,r)=>{r.agentTaskId="foreign-task";},(_a,r)=>{r.status="SUCCEEDED";},(_a,r)=>{r.contextId="cash-change";},
    (_a,r)=>{r.revisionHash="0".repeat(64);},(_a,r)=>{r.testDouble=true;},(_a,r)=>{r.remoteSubmission.prepared.job.jobId="other";},
    (_a,_r,v)=>{v.sql="SELECT 1";},(_a,_r,v)=>{v.author=f.other.id;},
  ]){
    const agent=structuredClone(f.agent),run=structuredClone(f.run),revision=structuredClone(f.revision);change(agent,run,revision);
    assert.throws(()=>resolveEvidenceSource(agent,(kind,id)=>kind==="run"&&id===f.run.id?run:kind==="revision"&&id===f.revision.id?revision:undefined),
      {status:409,code:"AGENT_RETAINED_FAILURE_SOURCE_INVALID"});
  }
});
test("first explicit repair displays only its declared same-owner failed source, never arbitrary foreign run evidence",t=>{
  const f=fixture(t),explicit={...f.agent,id:"44444444-4444-4444-8444-444444444444",sourceRunId:f.run.id,
    attempts:[{...f.agent.attempts[1],attempt:1,sourceKind:"EXPLICIT_FAILED_RUN"}]};
  const source=resolveEvidenceSource(explicit,f.read);assert.equal(source.sourceKind,"EXPLICIT_FAILED_RUN");assert.equal(source.run.id,f.run.id);
  for(const mutate of [a=>{a.sourceRunId="other-run";},a=>{a.submittedBy=f.other.id;},a=>{delete a.attempts[0].sourceKind;},
    a=>{a.contextId="cash-change";},a=>{a.attempts.unshift({runId:f.run.id,revisionId:f.revision.id,status:"FAILED"});}]){
    const agent=structuredClone(explicit);mutate(agent);assert.throws(()=>resolveEvidenceSource(agent,f.read),{code:"AGENT_RETAINED_FAILURE_SOURCE_INVALID"});
  }
});
test("HTTP workflow retains failed report and denies foreign evidence without executing or exposing a delivery",async t=>{
  const f=fixture(t);let executionCalls=0;
  const raw=async()=>{executionCalls++;throw Error("synthetic execution forbidden");};
  raw.durable=Object.fromEntries(["prepare","submit","read","cancel"].map(name=>[name,()=>{executionCalls++;throw Error("synthetic remote operation forbidden");}]));
  const app=createV2Server({root:f.root,store:f.store,runner:raw,env:{V2_LOCAL_DEVELOPMENT:"false",V2_HOST:"127.0.0.1",V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true",V2_DURABLE_SQL_AGENT_ENABLED:"true"}});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const call=async(path,body,headers={})=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2${path}`,{
    method:body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-shuduo-client":"workbench","idempotency-key":"retained-source",...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  const login=async email=>{const r=await call("/auth/login",{email,password});assert.equal(r.status,200);return{cookie:r.cookies.map(c=>c.split(";")[0]).join("; "),"x-csrf-token":r.body.csrfToken};};
  const owner=await login(f.owner.email),other=await login(f.other.email),path=`/agent/tasks/${f.agent.id}/workflow`;
  const response=await call(path,undefined,owner);assert.equal(response.status,200);const {report}=response.body;
  assert.equal(report.status,"NEEDS_ATTENTION");assert.equal(report.retainedFailure,true);assert.equal(report.computationSkipped,true);
  assert.equal(report.retainedRunStatus,"VALIDATION_FAILED");assert.equal(report.runId,f.run.id);assert.equal(report.revisionId,f.revision.id);
  assert.match(report.notice,/此前同一任务、版本和批次的失败记录/);assert.equal(response.body.publication.available,false);
  assert.equal(response.body.delivery,undefined);assert.equal(response.body.package,undefined);
  const explicit=f.store.create("agent",PROJECT,{...f.agent,sourceRunId:f.run.id,attempts:[{...f.agent.attempts[1],attempt:1,sourceKind:"EXPLICIT_FAILED_RUN"}]});
  const explicitResponse=await call(`/agent/tasks/${explicit.id}/workflow`,undefined,owner);
  assert.equal(explicitResponse.status,200);assert.equal(explicitResponse.body.report.status,"NEEDS_ATTENTION");
  assert.equal(explicitResponse.body.report.taskId,explicit.id);assert.equal(explicitResponse.body.report.runId,f.run.id);
  assert.equal(explicitResponse.body.report.retainedFailureSourceKind,"EXPLICIT_FAILED_RUN");assert.match(explicitResponse.body.report.notice,/当前账号明确引用/);
  assert.equal(explicitResponse.body.publication.available,false);assert.equal((await call(`/agent/tasks/${explicit.id}/prepare-delivery`,{},owner)).status,409);
  assert.equal((await call(path,undefined,other)).status,403);assert.equal((await call(path)).status,401);
  const original=f.read("run",f.run.id);f.store.update("run",f.run.id,PROJECT,{agentTaskId:"another-task"});
  const refused=await call(path,undefined,owner);assert.equal(refused.status,409);assert.equal(refused.body.code,"AGENT_RETAINED_FAILURE_SOURCE_INVALID");
  f.store.update("run",f.run.id,PROJECT,original);
  const denied=await call(`/agent/tasks/${f.agent.id}/prepare-delivery`,{},owner);assert.equal(denied.status,409);
  assert.equal(executionCalls,0);assert.equal(f.store.list("delivery_package",PROJECT).length,0);assert.equal(f.store.list("release",PROJECT).length,0);
  assert.equal(f.store.list("revision",PROJECT).length,1);assert.equal(f.store.list("run",PROJECT).length,1);
});
