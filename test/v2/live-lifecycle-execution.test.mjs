import test from "node:test";
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createV2Server, PROJECT} from "../../src/v2/server.mjs";
import {MetadataStore} from "../../src/v2/store.mjs";
import {validationFamilyForContext} from "../../src/v2/context.mjs";
import {currentLiveLifecycleContract, liveCaseCheckpoint, liveLifecyclePlan} from "../../src/v2/live-lifecycle-evaluation.mjs";
import {runLiveLifecycleCli} from "../../scripts/run-live-lifecycle-evaluation.mjs";

const contractId = currentLiveLifecycleContract.id;
const hash = text => createHash("sha256").update(text).digest("hex");
const privateMarker = "EXAMPLE_PRIVATE_PAYLOAD_DO_NOT_RETURN";
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(),"shuduo-execution-snapshot-"));
  const path = join(root,"platform.sqlite");
  let store = new MetadataStore(path);
  const runId = randomUUID(), startedAt = new Date(Date.now()-1000).toISOString();
  const plan = liveLifecyclePlan(3,{contractId});
  function make(definition, kind) {
    const contextId = definition.contextId;
    const validationContractId = validationFamilyForContext(contextId).id;
    const task = store.create("agent",PROJECT,{
      contextId, validationContractId, initialSql:definition.seedSql.trim(), message:definition.request,
      status:"INTERRUPTED", stage:kind === "MODEL_UNKNOWN" ? "MODEL_OUTCOME_UNKNOWN" : "WAITING_FOR_RUN",
      language:"SPARK_SQL", mode:"LIVE_MODEL", executionMode:"DURABLE_SQL_AGENT_V1", submittedBy:"local-engineer",
      usedTokens:120, attempts:[], durable:{leaseToken:privateMarker},
    });
    const revision = store.create("revision",PROJECT,{contextId,source:"LIVE_MODEL",sql:"select 1",hash:hash("select 1")});
    const run = store.create("run",PROJECT,{
      agentTaskId:task.id, contextId, validationContractId, revisionId:revision.id, revisionHash:revision.hash,
      status:kind === "PENDING" ? "QUEUED" : "SUCCEEDED", stage:kind === "PENDING" ? "SUBMITTING" : "COMPLETED",
      mode:"DURABLE_REMOTE_SUBMISSION", rows:[{privateMarker}],
    });
    store.update("run",run.id,PROJECT,{remoteSubmission:{submitted:false,prepared:{job:{jobId:run.id},privateMarker}}});
    const attempt = {attempt:1, revisionId:revision.id, runId:run.id, status:run.status, model:"qwen-plus", usage:{total_tokens:20}};
    let attempts = [attempt], headRevision = revision.id, headRun = run.id;
    if (kind === "MODEL_UNKNOWN") attempts.push({attempt:2,status:"MODEL_OUTCOME_UNKNOWN",model:"unconfirmed",usageEstimated:true,usage:{total_tokens:100}});
    if (kind === "FROZEN") {
      // The head changed after this evaluation froze a successful batch.
      headRevision = randomUUID();headRun = randomUUID();
      attempts.push({attempt:2,revisionId:headRevision,runId:headRun,status:"RUNNING",model:"qwen-plus",usage:{total_tokens:50}});
    }
    store.update("agent",task.id,PROJECT,{revisionId:headRevision,runId:headRun,attempts});
    const entry = liveCaseCheckpoint(definition,startedAt,plan.caseSetDigest,{contractId,evaluationRunId:runId});
    const bodyHash = hash(JSON.stringify({message:definition.request,sql:definition.seedSql,contextId}));
    return {
      entry:{...entry,status:"PAUSED",phase:"CODE_AND_DEBUG",taskId:task.id,
        actions:{agent:{key:randomUUID(),bodyHash,status:"CONFIRMED",id:task.id}},
        ...(kind === "FROZEN" ? {code:{taskId:task.id,revisionId:revision.id,runId:run.id,revisionHash:revision.hash}} : {})},
      task,revision,run,headRun,
    };
  }
  const [unknown,pending,pinned] = plan.selectedCases.map((definition,index)=>make(definition,["MODEL_UNKNOWN","PENDING","FROZEN"][index]));
  store.close();
  store = new MetadataStore(path);
  let compute = 0, workerReads = 0;
  const forbidden = () => { compute++; throw Error("SNAPSHOT_CANNOT_EXECUTE"); };
  const runner = Object.assign(forbidden,{durable:{prepare:forbidden,submit:forbidden,cancel:forbidden,
    read:()=>{workerReads++;throw Error("SNAPSHOT_CANNOT_READ_WORKER");}}});
  const app = createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:"true",V2_RELEASE_SCHEDULER_MODE:"DISABLED"},generator:forbidden,runner});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{
    app.releaseScheduler.shutdown();app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});
  });
  const origin = "http://127.0.0.1:"+app.server.address().port;
  const artifactRoot = join(root,".v2-artifacts","live-lifecycle"), directory = join(artifactRoot,runId);
  mkdirSync(directory,{recursive:true});
  const file = join(directory,"checkpoint.json");
  writeFileSync(file,JSON.stringify({evaluationRunId:runId,startedAt,origin,caseLimit:3,
    contract:plan.contract,caseSetDigest:plan.caseSetDigest,outcomes:[unknown.entry,pending.entry,pinned.entry]}),{mode:0o600});
  return {store,origin,runId,artifactRoot,directory,file,unknown,pending,pinned,counts:()=>({compute,workerReads})};
}

test("the workbench and CLI read the same saved phases after reopen without changing usage or choosing a newer run",async t=>{
  const f = await setup(t);
  const before = readFileSync(f.file,"utf8");
  const records = () => ["agent","revision","run"].map(kind=>f.store.list(kind,PROJECT));
  const original = records();
  const path = "/api/v2/evaluations/live-lifecycle/overview?run_id="+f.runId;
  const response = await fetch(f.origin+path);
  assert.equal(response.status,200);
  const result = await response.json();
  assert(!JSON.stringify(result).includes(privateMarker));
  const [unknown,pending,pinned] = result.cases.map(row=>row.execution);
  assert.equal(unknown.evidence,"STORED_METADATA");
  assert.deepEqual(unknown.model,{state:"OUTCOME_UNKNOWN",attempts:2,ledgerTokens:120,reportedTokens:20,reservedTokens:100,
    unattributedTokens:0,unconfirmedAttempts:1,usage:"PENDING"});
  assert.deepEqual(unknown.spark,{state:"NOT_LINKED"});
  assert.equal(pending.model.unattributedTokens,100);
  assert.equal(pending.spark.state,"SUBMISSION_UNCONFIRMED");
  assert.equal(pending.spark.runId,f.pending.run.id);
  assert.equal(pinned.spark.state,"RESULT_RECORDED");
  assert.equal(pinned.spark.pinned,true);
  assert.equal(pinned.spark.runId,f.pinned.run.id);
  assert.notEqual(pinned.spark.runId,f.pinned.headRun);
  assert.equal(result.verifiedCaseCount,0);

  const output = [], requests = [], errors = [];
  const options = {artifactRoot:f.artifactRoot,output:text=>output.push(JSON.parse(text)),error:text=>errors.push(text),
    fetchImpl:(url,init)=>{
      requests.push({url,method:init.method,body:init.body});
      return fetch(url,init);
    }};
  assert.equal(await runLiveLifecycleCli(["--inspect",f.runId],{},options),0,errors.join("\n"));
  assert.deepEqual(requests,[{url:f.origin+path,method:"GET",body:undefined}]);
  assert.deepEqual(output[0].cases.map(row=>row.execution),[unknown,pending,pinned]);
  assert.deepEqual(records(),original);
  assert.equal(readFileSync(f.file,"utf8"),before);
  assert.deepEqual(readdirSync(f.directory),["checkpoint.json"]);
  assert.deepEqual(f.counts(),{compute:0,workerReads:0});
});

test("changed execution sources are not silently replaced and an incompatible checkpoint response is rejected",async t=>{
  const f = await setup(t);
  f.store.update("run",f.pending.run.id,PROJECT,{revisionHash:"f".repeat(64)});
  f.store.update("agent",f.unknown.task.id,PROJECT,{initialSql:"select 'wrong task'"});
  const response = await (await fetch(f.origin+"/api/v2/evaluations/live-lifecycle/overview?run_id="+f.runId)).json();
  assert.deepEqual(response.cases[0].execution,{state:"UNCONFIRMED"});
  assert.deepEqual(response.cases[1].execution.spark,{state:"UNCONFIRMED"});
  const before = readFileSync(f.file,"utf8");
  const output = [], errors = [];
  assert.equal(await runLiveLifecycleCli(["--inspect",f.runId],{},{
    artifactRoot:f.artifactRoot,output:text=>output.push(text),error:text=>errors.push(text),
    fetchImpl:async()=>Response.json({...response,checkpointDigest:"0".repeat(64)}),
  }),1);
  assert.equal(output.length,0);
  assert.match(errors[0],/检查点不一致/);
  assert.equal(readFileSync(f.file,"utf8"),before);
  assert.deepEqual(f.counts(),{compute:0,workerReads:0});
});
