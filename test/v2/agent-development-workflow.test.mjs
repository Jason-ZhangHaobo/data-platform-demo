import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LocalArtifactStore } from "../../src/v2/artifact-store.mjs";
import { createDurableAgentDelivery, developmentVerificationReport } from "../../src/v2/agent-development-workflow.mjs";
import { getContext, contextIds, referenceSql, validationContractId } from "../../src/v2/context.mjs";
import { sha256 } from "../../src/v2/delivery.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { BudgetManager } from "../../src/v2/budget.mjs";

function fixture(t) {
  const store = new MetadataStore(":memory:"), project = "synthetic-workflow", root = mkdtempSync(join(tmpdir(), "shuduo-workflow-"));
  t.after(() => store.close());
  const revision = store.create("revision", project, { sql: referenceSql, hash: sha256(referenceSql), contextId: "cash-change" });
  const run = store.create("run", project, { revisionId: revision.id, revisionHash: revision.hash, status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, isolation: "FUNCTION_PROCESS", rows: getContext("cash-change").expected, validation: { passed: true, contractId: validationContractId, regressions: contextIds.map(contextId => ({contextId,passed:true})) } });
  const agent = store.create("agent", project, { contextId: "cash-change", executionMode: "DURABLE_SQL_AGENT_V1", mode: "LIVE_MODEL", status: "SUCCEEDED", submittedBy: "synthetic-owner", attempts: [{ status:"SUCCEEDED", model:"qwen3-coder-plus", revisionId:revision.id, runId:run.id }] });
  const submits = [], receipts = new Map(); let failSubmit = false, persisted = false;
  const runner = { prepare:(input,id) => ({ job: {jobId:id}, input }), submit:async prepared => { assert.ok(persisted); submits.push(prepared.job.jobId); if(failSubmit) {failSubmit=false; throw Error("unconfirmed submit");} }, read:async prepared => receipts.get(prepared.job.jobId), cancel:async prepared => receipts.delete(prepared.job.jobId) };
  const options = { store, project, runner, artifactStore:new LocalArtifactStore(root), persist:async()=>{persisted=true;} };
  const receipt = prepared => ({ status:"SUCCEEDED", engine:"Apache Spark", engineVersion:"3.5.9", mainSqlExecuted:true, testSqlValidation:{passed:true,sqlHash:sha256(prepared.input.testSql)}, validation:run.validation, rows:run.rows, log:"synthetic test receipt" });
  return {store,project,revision,run,agent,options,engine:createDurableAgentDelivery(options),submits,receipts,receipt,failNextSubmit:()=>{failSubmit=true;}};
}

test("verification report rejects duplicate client rows, wrong amounts and stale code even with a green validation flag", t => {
  const f=fixture(t); assert.equal(developmentVerificationReport(f.agent,f.run,f.revision).status,"PASSED");
  for(const rows of [[f.run.rows[0],f.run.rows[0]],[{...f.run.rows[0],available_cash:"799.00"},f.run.rows[1]],[{...f.run.rows[0],available_cash:null},f.run.rows[1]]])
    assert.equal(developmentVerificationReport(f.agent,{...f.run,rows},f.revision).status,"NEEDS_ATTENTION");
  assert.equal(developmentVerificationReport(f.agent,f.run,{...f.revision,sql:"SELECT 1"}).status,"NEEDS_ATTENTION");
});

test("durable delivery persists files before submission and restores the same job after an unconfirmed submit", async t => {
  const f=fixture(t), task=await f.engine.create(f.agent,"create-once");
  assert.equal(f.submits.length,0); assert.equal((await f.engine.create(f.agent,"another-key")).id,task.id);
  f.failNextSubmit(); await assert.rejects(f.engine.advance(task.id,task.version),/unconfirmed/);
  const pending=f.store.get("agent_delivery_task",task.id,f.project), prepared=pending.remoteSubmission.prepared;
  const budget=new BudgetManager({store:f.store,project:f.project,env:{}}).overview();
  assert.equal(budget.remoteSpark.runCount,2); assert.equal(budget.remoteSpark.seconds,30);
  assert.equal(f.store.get("delivery_verification",pending.verificationId,f.project).durationMs,undefined,"reservation is not measured duration");
  f.store.interruptPending(f.project);
  assert.equal(f.store.get("agent_delivery_task",task.id,f.project).status,"RUNNING");
  assert.equal(f.store.get("delivery_verification",pending.verificationId,f.project).status,"RUNNING");
  const restored=createDurableAgentDelivery(f.options);
  await restored.reconcile(task.id); assert.equal(f.submits.length,1,"GET does not submit again");
  const resumed=await restored.advance(task.id,pending.version); assert.equal(resumed.stage,"FILE_REHEARSAL_RUNNING");
  assert.deepEqual(f.submits,[prepared.job.jobId,prepared.job.jobId]);
  assert.equal(f.store.list("delivery_verification",f.project).length,1);
  f.receipts.set(prepared.job.jobId,f.receipt(prepared));
  const finished=await restored.reconcile(task.id); assert.equal(finished.status,"SUCCEEDED"); assert.equal(finished.stage,"AWAITING_ENGINEER_REVIEW");
  assert.equal(finished.publicDeployed,false); assert.equal(finished.fullLifecycleE2E,false); assert.equal(finished.remoteSubmission,undefined);
  assert.equal(f.store.list("release_approval",f.project).length,0); assert.equal(f.store.list("release",f.project).length,0);
});

test("file rehearsal rejects missing test SQL hash, missing regressions and test-double receipts", async t => {
  for(const alter of [r=>({...r,testSqlValidation:{passed:true,sqlHash:"x".repeat(64)}}),r=>({...r,validation:{passed:true,regressions:[]}}),r=>({...r,testDouble:true}),r=>({...r,mainSqlExecuted:false})]) {
    const f=fixture(t), task=await f.engine.create(f.agent,"receipt-test"), running=await f.engine.advance(task.id,task.version);
    const prepared=f.store.get("agent_delivery_task",task.id,f.project).remoteSubmission.prepared;
    f.receipts.set(prepared.job.jobId,alter(f.receipt(prepared)));
    assert.equal((await f.engine.reconcile(running.id)).status,"FAILED");
  }
});

test("cancelled rehearsal rejects late success and a modified artifact cannot be resumed", async t => {
  const f=fixture(t), task=await f.engine.create(f.agent,"cancel"), running=await f.engine.advance(task.id,task.version), prepared=f.store.get("agent_delivery_task",task.id,f.project).remoteSubmission.prepared;
  await f.engine.cancel(running.id); f.receipts.set(prepared.job.jobId,f.receipt(prepared));
  assert.equal((await f.engine.reconcile(task.id)).status,"CANCELLED");
  const g=fixture(t), other=await g.engine.create(g.agent,"tamper"), bundle=g.store.get("delivery_package",other.packageId,g.project);
  g.store.update("delivery_package",bundle.id,g.project,{files:{...bundle.files,"main.sql":"SELECT 1"}});
  await assert.rejects(g.engine.advance(other.id,other.version)); assert.equal(g.submits.length,0);
});

test("invited HTTP workflow enforces task owner and CSRF and refuses unconfigured cloud publication", async t => {
  const f=fixture(t), store=f.store, runner=async()=>{}; runner.durable=f.options.runner;
  const app=createV2Server({store,runner,artifactStore:f.options.artifactStore,env:{V2_LOCAL_DEVELOPMENT:"false",V2_HOST:"127.0.0.1",V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true",V2_DURABLE_SQL_AGENT_ENABLED:"true"}});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const password="SyntheticPassword!2026", owner=app.auth.bootstrapAdmin({email:"owner@example.invalid",password,displayName:"测试工程师一"}), other=app.auth.bootstrapAdmin({email:"other@example.invalid",password,displayName:"测试工程师二"});
  for(const user of [owner,other]) store.update("auth_user",user.id,PROJECT,{memberships:[{projectId:PROJECT,role:"ENGINEER"}]});
  const revision=store.create("revision",PROJECT,{sql:referenceSql,hash:sha256(referenceSql),contextId:"cash-change"});
  const run=store.create("run",PROJECT,{...f.run,revisionId:revision.id,revisionHash:revision.hash});
  const agent=store.create("agent",PROJECT,{...f.agent,submittedBy:owner.id,attempts:[{...f.agent.attempts[0],revisionId:revision.id,runId:run.id}]});
  const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
  const call=async(path,body,headers={})=>{const r=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-shuduo-client":"workbench","idempotency-key":"http-case",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  const login=async email=>{const r=await call("/auth/login",{email,password});return{cookie:r.cookies.map(c=>c.split(";")[0]).join("; "),"x-csrf-token":r.body.csrfToken};};
  const a=await login("owner@example.invalid"),b=await login("other@example.invalid");
  assert.equal((await call(`/agent/tasks/${agent.id}/workflow`)).status,403);
  assert.equal((await call(`/agent/tasks/${agent.id}/workflow`,undefined,b)).status,403);
  const report=await call(`/agent/tasks/${agent.id}/workflow`,undefined,a);assert.equal(report.status,200);assert.equal(report.body.report.status,"PASSED");assert.equal(report.body.publication.available,false);
  assert.equal((await call(`/agent/tasks/${agent.id}/prepare-delivery`,{}, {cookie:a.cookie})).status,403);
  assert.equal((await call(`/agent/tasks/${agent.id}/prepare-delivery`,{},b)).status,403);
  const started=await call(`/agent/tasks/${agent.id}/prepare-delivery`,{},a);assert.equal(started.status,202);
  assert.equal((await call(`/agent/deliveries/${started.body.id}`,undefined,b)).status,403);
  assert.equal((await call(`/agent/deliveries/${started.body.id}/advance`,{expectedVersion:started.body.version},b)).status,403);
  assert.equal((await call("/releases",{},a)).status,503);assert.equal(store.list("release",PROJECT).length,0);
});
