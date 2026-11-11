import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LocalArtifactStore } from "../../src/v2/artifact-store.mjs";
import { createDurableAgentDelivery, developmentVerificationReport } from "../../src/v2/agent-development-workflow.mjs";
import { getContext, contextIds, referenceSql, validationContractId } from "../../src/v2/context.mjs";
import { sha256 } from "../../src/v2/delivery.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { BudgetManager } from "../../src/v2/budget.mjs";
import { currentLiveLifecycleContract, liveCaseCheckpoint, liveLifecyclePlan } from "../../src/v2/live-lifecycle-evaluation.mjs";
import { V2Client } from "../../src/v2/client.mjs";
import { agentReviewEvidencePath } from "../../src/v2/publication-request.mjs";
import { validatePrivateApplicationRequest } from "../../src/v2/private-application.mjs";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";

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

test("delivery reuse binds the exact revision and run, not just unchanged SQL", async t => {
  const f = fixture(t);
  const first = await f.engine.create(f.agent, "original-delivery");
  assert.equal((await f.engine.create(f.agent, "duplicate-click")).id, first.id);
  const rerun = f.store.create("run", f.project, {...f.run, id: undefined});
  // Store.create owns generated ids; never overwrite original records.
  assert.notEqual(rerun.id, f.run.id);
  const rerunAgent = {...f.agent, attempts:[{...f.agent.attempts[0], runId:rerun.id}]};
  const next = await f.engine.create(rerunAgent, "new-run-delivery");
  assert.notEqual(next.id, first.id);
  assert.equal(f.store.get("agent_delivery_task", next.id, f.project).sourceRunId, rerun.id);
  assert.equal((await f.engine.create(rerunAgent, "same-new-run")).id, next.id);
  const revision = f.store.create("revision", f.project, {...f.revision, id:undefined});
  const revisedRun = f.store.create("run", f.project, {...f.run, id:undefined, revisionId:revision.id});
  const revisedAgent = {...f.agent, attempts:[{...f.agent.attempts[0], revisionId:revision.id, runId:revisedRun.id}]};
  const revised = await f.engine.create(revisedAgent, "new-revision-delivery");
  assert.notEqual(revised.id, first.id);
  assert.notEqual(revised.id, next.id);
  assert.equal(f.store.get("agent_delivery_task", first.id, f.project).sourceRunId, f.run.id);
  assert.equal(f.submits.length, 0, "preparing a version does not execute Spark or publish");
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
  const f=fixture(t), store=f.store, runner=async()=>{};
  let workerReads=0;
  runner.durable={...f.options.runner,submit:async prepared=>{f.submits.push(prepared.job.jobId);},
    read:async prepared=>{workerReads++;return f.options.runner.read(prepared);}};
  const app=createV2Server({store,runner,artifactStore:f.options.artifactStore,env:{V2_LOCAL_DEVELOPMENT:"false",V2_HOST:"127.0.0.1",V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true",V2_DURABLE_SQL_AGENT_ENABLED:"true"}});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const password="SyntheticPassword!2026", owner=app.auth.bootstrapAdmin({email:"owner@example.invalid",password,displayName:"测试工程师一"}), other=app.auth.bootstrapAdmin({email:"other@example.invalid",password,displayName:"测试工程师二"});
  for(const user of [owner,other]) store.update("auth_user",user.id,PROJECT,{memberships:[{projectId:PROJECT,role:"ENGINEER"}]});
  // Saved provider/Worker contract fixtures for the exact first v3 request.
  const plan=liveLifecyclePlan(1,{contractId:currentLiveLifecycleContract.id}),first=plan.selectedCases[0];
  const agentKey=randomUUID(), deliveryKey=randomUUID(), evaluationRunId=randomUUID();
  const startedAt=new Date(Date.now()-1000).toISOString();
  const requestBody={message:first.request,sql:first.seedSql,contextId:first.contextId};
  const bodyHash=sha256(JSON.stringify(requestBody));
  const createTask=()=>store.create("agent",PROJECT,{...f.agent,id:undefined,contextId:first.contextId,message:first.request,
    initialSql:first.seedSql.trim(),submittedBy:owner.id,language:"SPARK_SQL",sql:referenceSql,usedTokens:100});
  const task=store.get("agent",store.deduplicate(`${PROJECT}:durable-agent:${owner.id}:${agentKey}`,bodyHash,createTask).id,PROJECT);
  const revision=store.create("revision",PROJECT,{sql:referenceSql,hash:sha256(referenceSql),contextId:first.contextId,source:"LIVE_MODEL",author:owner.id});
  const run=store.create("run",PROJECT,{...f.run,id:undefined,revisionId:revision.id,revisionHash:revision.hash,contextId:first.contextId,
    agentTaskId:task.id,mode:"DURABLE_REMOTE_SUBMISSION",validationContractId:validationContractId,rows:getContext(first.contextId).expected});
  store.update("run",run.id,PROJECT,{remoteSubmission:{prepared:{job:{jobId:run.id}},submitted:true}});
  const agent=store.update("agent",task.id,PROJECT,{attempts:[{...f.agent.attempts[0],revisionId:revision.id,runId:run.id}]});
  const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
  const call=async(path,body,headers={})=>{const r=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-shuduo-client":"workbench","idempotency-key":"http-case",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  const login=async email=>{const r=await call("/auth/login",{email,password});return{cookie:r.cookies.map(c=>c.split(";")[0]).join("; "),"x-csrf-token":r.body.csrfToken};};
  const a=await login("owner@example.invalid"),b=await login("other@example.invalid");
  assert.equal((await call(`/agent/tasks/${agent.id}/workflow`)).status,401);
  assert.equal((await call(`/agent/tasks/${agent.id}/workflow`,undefined,b)).status,403);
  assert.equal((await call(`/agent/tasks/${agent.id}/publication`)).status,401);
  assert.equal((await call(`/agent/tasks/${agent.id}/publication`,undefined,b)).status,403);
  const report=await call(`/agent/tasks/${agent.id}/workflow`,undefined,a);assert.equal(report.status,200);assert.equal(report.body.report.status,"PASSED");assert.equal(report.body.publication.available,false);
  assert.equal((await call(`/agent/tasks/${agent.id}/prepare-delivery`,{}, {cookie:a.cookie})).status,403);
  assert.equal((await call(`/agent/tasks/${agent.id}/prepare-delivery`,{},b)).status,403);
  const started=await call(`/agent/tasks/${agent.id}/prepare-delivery`,{},{...a,"idempotency-key":deliveryKey});assert.equal(started.status,202);
  const oldRevision=store.create("revision",PROJECT,{sql:"SELECT 1",hash:sha256("SELECT 1"),contextId:"cash-change"});
  store.create("agent_delivery_task",PROJECT,{sourceAgentTaskId:agent.id,sourceRevisionId:oldRevision.id,sourceRunId:run.id,status:"SUCCEEDED",stage:"AWAITING_ENGINEER_REVIEW"});
  const currentWorkflow=await call(`/agent/tasks/${agent.id}/workflow`,undefined,a);
  assert.equal(currentWorkflow.body.delivery.id,started.body.id,"a newer historical delivery cannot replace current source evidence");
  assert.equal((await call(`/agent/deliveries/${started.body.id}`,undefined,b)).status,403);
  assert.equal((await call(`/agent/deliveries/${started.body.id}/advance`,{expectedVersion:started.body.version},b)).status,403);
  assert.equal((await call("/releases",{},a)).status,503);assert.equal(store.list("release",PROJECT).length,0);
  const target={taskId:agent.id,deliveryId:started.body.id,requestSha256:sha256(first.request)};
  const evidencePath=agentReviewEvidencePath(target);
  const executionPath=`/agent/requests/${agentKey}/execution-evidence`;
  const deliveryReceiptPath=`/agent/tasks/${agent.id}/delivery-requests/${deliveryKey}`;
  assert.equal((await call(deliveryReceiptPath)).status,401);
  assert.equal((await call(deliveryReceiptPath,undefined,b)).status,403);
  assert.equal((await call(deliveryReceiptPath,undefined,a)).body.id,started.body.id);
  assert.equal((await call(deliveryReceiptPath+"?other=1",undefined,a)).status,422);
  const receiptEnvelope={operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:"/api/v2"+deliveryReceiptPath};
  assert.equal(validatePrivateApplicationRequest(receiptEnvelope,{allowDurableAgentRead:true}).path,receiptEnvelope.path);
  assert.throws(()=>validatePrivateApplicationRequest(receiptEnvelope));
  assert.throws(()=>validatePrivateApplicationRequest({...receiptEnvelope,method:"POST",body:{}},{allowDurableAgent:true}));

  const directory=mkdtempSync(join(tmpdir(),"shuduo-cloud-v3-review-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const checkpointPath=join(directory,"checkpoint.json");
  const item={...liveCaseCheckpoint(first,startedAt,plan.caseSetDigest,{contractId:plan.contract.id,evaluationRunId}),
    taskId:agent.id,status:"PAUSED",phase:"DELIVERY_PREPARATION",
    actions:{agent:{id:agent.id,key:agentKey,status:"CONFIRMED",bodyHash},
      delivery:{id:started.body.id,key:deliveryKey,status:"CONFIRMED",bodyHash:sha256("{}")}},
    code:{taskId:agent.id,revisionId:revision.id,revisionHash:revision.hash,runId:run.id}};
  const checkpoint={evaluationRunId,startedAt,caseLimit:1,caseSetDigest:plan.caseSetDigest,
    contract:plan.contract,origin:new URL(base).origin,outcomes:[item]};
  const writeCheckpoint=()=>writeFileSync(checkpointPath,JSON.stringify(checkpoint),{mode:0o600});
  writeCheckpoint();
  const checkpointReads=[];
  const checkpointClient=new V2Client({baseUrl:base,fetchImpl:(url,request)=>{
    assert.equal(request.method,"GET");
    assert.equal(request.body,undefined);
    const target=new URL(url);
    checkpointReads.push(target.pathname+target.search);
    return fetch(url,{...request,headers:{...request.headers,cookie:a.cookie}});
  }});
  const readBound=async(expectedExit=0)=>{
    const original=readFileSync(checkpointPath,"utf8");
    checkpointReads.length=0;
    let value;
    assert.equal(await runV2Cli(["agent","v3-review","--checkpoint",checkpointPath],{},
      {client:checkpointClient,output:line=>{value=JSON.parse(line);},error:()=>{}}),expectedExit);
    assert.equal(readFileSync(checkpointPath,"utf8"),original);
    return value;
  };
  const executionEnvelope={operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:"/api/v2"+executionPath};
  assert.equal(validatePrivateApplicationRequest(executionEnvelope,{allowDurableAgentRead:true}).path,executionEnvelope.path);
  assert.throws(()=>validatePrivateApplicationRequest(executionEnvelope));
  assert.throws(()=>validatePrivateApplicationRequest({...executionEnvelope,method:"POST",body:{}},{allowDurableAgent:true}));
  assert.equal((await call(executionPath)).status,401);
  assert.equal((await call(executionPath,undefined,b)).status,404);
  assert.equal((await call(executionPath+"?task_id="+agent.id,undefined,a)).status,422);
  const inspectionPath=join(directory,"inspection.json");
  const inspectionCheckpoint={...checkpoint,projectId:PROJECT,reviewedSource:"a".repeat(40),
    submission:{actorId:owner.id},outcomes:[{...item,code:undefined,phase:"CODE_AND_DEBUG",
      actions:{...item.actions,delivery:{...item.actions.delivery,status:"UNKNOWN",id:undefined}}}]};
  writeFileSync(inspectionPath,JSON.stringify(inspectionCheckpoint),{mode:0o600});
  const inspect=async()=>{
    checkpointReads.length=0;
    let value;
    assert.equal(await runV2Cli(["agent","v3-inspect","--checkpoint",inspectionPath],{},
      {client:checkpointClient,output:line=>{value=JSON.parse(line);},error:()=>{}}),0);
    return value;
  };
  const executionWorkerReads=workerReads, executionSubmits=[...f.submits];
  const executionView=(await call(executionPath,undefined,a)).body;
  assert.equal(executionView.status,"EXECUTION_RECORDED");
  assert.equal(executionView.development.runId,run.id);
  assert.equal(executionView.development.regressionCount,5);
  assert.equal(executionView.execution.spark.resultStatus,"SUCCEEDED");
  const mcpExecution=JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",
    params:{name:"agent_execution_evidence",arguments:{requestId:agentKey}}},{client:checkpointClient}));
  assert.deepEqual(mcpExecution.result.structuredContent,executionView);
  for (const secret of [first.request,referenceSql,"CLIENT-001","remoteSubmission",agentKey]) assert.ok(!JSON.stringify(executionView).includes(secret));
  const originalRun=store.get("run",run.id,PROJECT);
  store.update("run",run.id,PROJECT,{status:"RUNNING",stage:"WAITING_FOR_WORKER_RESULT"});
  const waiting=await inspect();
  assert.equal(waiting.execution.spark.state,"WAITING_FOR_RESULT");
  assert.equal(waiting.status,"EXECUTION_RECORDED");
  store.update("run",run.id,PROJECT,{status:originalRun.status,stage:originalRun.stage});
  store.update("run",run.id,PROJECT,{rows:[]});
  const unverifiedBytes=readFileSync(inspectionPath,"utf8");
  assert.equal((await inspect()).status,"EXECUTION_RECORDED");
  assert.equal(readFileSync(inspectionPath,"utf8"),unverifiedBytes);
  store.update("run",run.id,PROJECT,{rows:originalRun.rows});
  const inspected=await inspect();
  assert.equal(inspected.status,"DEVELOPMENT_BOUND");
  assert.equal(inspected.delivery.id,started.body.id);
  assert.equal(inspected.fullLifecycleE2E,false);
  assert.deepEqual(checkpointReads,["/api/v2/auth/session","/api/v2"+executionPath,"/api/v2"+deliveryReceiptPath]);
  const boundBytes=readFileSync(inspectionPath,"utf8"), boundItem=JSON.parse(boundBytes).outcomes[0];
  assert.equal(boundItem.actions.agent.key,agentKey);
  assert.equal(boundItem.actions.delivery.key,deliveryKey);
  assert.equal(boundItem.actions.delivery.status,"CONFIRMED");
  assert.equal(boundItem.phase,"DELIVERY_PREPARATION");
  assert.equal(boundItem.code.runId,run.id);
  assert.equal((await inspect()).delivery.id,started.body.id);
  assert.equal(readFileSync(inspectionPath,"utf8"),boundBytes);
  assert.equal(workerReads,executionWorkerReads);
  assert.deepEqual(f.submits,executionSubmits);
  const firstTwo=["/api/v2/agent/requests/"+agentKey,"/api/v2"+deliveryReceiptPath];
  const envelope={operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:"/api/v2"+evidencePath};
  assert.equal(validatePrivateApplicationRequest(envelope,{allowDurableAgentRead:true}).path,envelope.path);
  assert.throws(()=>validatePrivateApplicationRequest(envelope));
  assert.throws(()=>validatePrivateApplicationRequest({...envelope,method:"POST",body:{}},{allowDurableAgent:true}));
  assert.equal((await call(evidencePath)).status,401);
  assert.equal((await call(evidencePath,undefined,b)).status,403);
  assert.equal((await call(evidencePath+"&delivery_id="+target.deliveryId,undefined,a)).status,422);
  const running=await call(`/agent/deliveries/${target.deliveryId}/advance`,{expectedVersion:started.body.version},a);
  assert.equal(running.body.stage,"FILE_REHEARSAL_RUNNING");
  const prepared=store.get("agent_delivery_task",target.deliveryId,PROJECT).remoteSubmission.prepared;
  f.receipts.set(prepared.job.jobId,f.receipt(prepared));
  const pendingReads=workerReads;
  assert.equal((await call(evidencePath,undefined,a)).body.status,"PENDING");
  assert.equal((await readBound()).reason,"CLOUD_REHEARSAL_PENDING");
  assert.deepEqual(checkpointReads,firstTwo);
  assert.equal(workerReads,pendingReads,"stored evidence must leave the saved Worker receipt unreconciled");
  assert.equal(store.get("agent_delivery_task",target.deliveryId,PROJECT).version,running.body.version);
  const finished=await call(`/agent/deliveries/${target.deliveryId}/advance`,{expectedVersion:running.body.version},a);
  assert.equal(finished.body.stage,"AWAITING_ENGINEER_REVIEW");
  const before=workerReads, submits=[...f.submits];
  const result=await call(evidencePath,undefined,a);
  assert.equal(result.status,200);
  assert.equal(result.body.status,"REVIEW_EVIDENCE_READY",result.body.reason);
  assert.equal(result.body.development.runId,run.id);
  assert.equal(result.body.development.regressionCount,5);
  assert.equal(result.body.delivery.packageDigest,finished.body.packageDigest);
  assert.equal(result.body.delivery.verificationId,finished.body.verificationId);
  assert.equal(Object.keys(result.body.delivery.fileHashes).length,8);
  assert.equal(result.body.fullLifecycleE2E,false);
  const bound=await readBound();
  assert.equal(bound.status,"REVIEW_EVIDENCE_BOUND",bound.reason);
  assert.equal(bound.expectedCaseCount,20);
  assert.equal(bound.fullLifecycleE2E,false);
  assert.equal(bound.packageDigest,finished.body.packageDigest);
  assert.deepEqual(checkpointReads,[...firstTwo,"/api/v2"+evidencePath]);
  assert.ok(!JSON.stringify(bound).includes(agentKey)&&!JSON.stringify(bound).includes(deliveryKey));
  const alternateKey=randomUUID();
  store.deduplicate(`${PROJECT}:durable-agent:${owner.id}:${alternateKey}`,bodyHash,createTask);
  item.actions.agent.key=alternateKey;
  writeCheckpoint();
  assert.equal((await readBound()).reason,"ORIGINAL_AGENT_MISMATCH");
  assert.equal(checkpointReads.length,1);
  item.actions.agent.key=agentKey;
  writeCheckpoint();
  store.update("agent",task.id,PROJECT,{createdAt:new Date(Date.parse(startedAt)-1000).toISOString()});
  assert.equal((await readBound()).reason,"ORIGINAL_AGENT_MISMATCH");
  assert.equal(checkpointReads.length,1);
  store.update("agent",task.id,PROJECT,{createdAt:agent.createdAt});
  item.actions.delivery.status="UNKNOWN";
  writeCheckpoint();
  assert.equal((await readBound()).reason,"ORIGINAL_DELIVERY_RECEIPT_PENDING");
  assert.deepEqual(checkpointReads,[]);
  item.actions.delivery.status="CONFIRMED";
  writeCheckpoint();
  const missingKey=randomUUID();
  item.actions.delivery.key=missingKey;
  writeCheckpoint();
  assert.equal((await readBound()).reason,"ORIGINAL_DELIVERY_NOT_RECORDED");
  assert.equal(checkpointReads.length,2);
  item.actions.delivery.key=deliveryKey;
  writeCheckpoint();
  chmodSync(checkpointPath,0o644);
  await readBound(1);
  assert.deepEqual(checkpointReads,[]);
  chmodSync(checkpointPath,0o600);
  const wrong=await call(agentReviewEvidencePath({...target,requestSha256:"a".repeat(64)}),undefined,a);
  assert.equal(wrong.body.reason,"REQUEST_DIGEST_MISMATCH");
  const client={request:async(path,body)=>{assert.equal(body,undefined);assert.equal(path,evidencePath);return (await call(path,undefined,a)).body;}};
  let cli;
  assert.equal(await runV2Cli(["agent","review-evidence","--id",target.taskId,"--delivery-id",target.deliveryId,"--request-sha256",target.requestSha256],
    {},{client,output:value=>{cli=JSON.parse(value);},error:()=>{}}),0);
  assert.deepEqual(cli,result.body);
  const mcp=JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"agent_review_evidence",arguments:target}},{client}));
  assert.deepEqual(mcp.result.structuredContent,result.body);
  const verification=store.get("delivery_verification",finished.body.verificationId,PROJECT);
  store.update("delivery_verification",verification.id,PROJECT,{testSqlValidation:{passed:true,sqlHash:"0".repeat(64)}});
  assert.equal((await call(evidencePath,undefined,a)).body.reason,"FILE_REHEARSAL_UNCONFIRMED");
  assert.equal((await readBound()).reason,"REVIEW_EVIDENCE_UNCONFIRMED");
  store.update("delivery_verification",verification.id,PROJECT,{testSqlValidation:verification.testSqlValidation});
  store.update("run",run.id,PROJECT,{rows:[null]});
  assert.equal((await call(evidencePath,undefined,a)).body.reason,"DEVELOPMENT_RESULT_UNCONFIRMED");
  store.update("run",run.id,PROJECT,{rows:run.rows});
  store.update("agent",task.id,PROJECT,{testDouble:true});
  assert.equal((await call(evidencePath,undefined,a)).body.reason,"EXECUTION_PROVENANCE_UNCONFIRMED");
  assert.equal(workerReads,before);
  assert.deepEqual(f.submits,submits);
  assert.equal(store.get("agent_delivery_task",target.deliveryId,PROJECT).version,finished.body.version);
  assert.equal(store.list("release_approval",PROJECT).length,0);
  for (const secret of [first.request,referenceSql,"CLIENT-001","remoteSubmission"]) assert.ok(!JSON.stringify(result.body).includes(secret));
});
