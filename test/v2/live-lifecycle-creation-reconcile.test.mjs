import test from "node:test";
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createV2Server, PROJECT} from "../../src/v2/server.mjs";
import {MetadataStore} from "../../src/v2/store.mjs";
import {currentLiveLifecycleContract, liveCaseCheckpoint, liveLifecyclePlan} from "../../src/v2/live-lifecycle-evaluation.mjs";
import {createLiveEvaluationAdapter, runLiveLifecycleCli} from "../../scripts/run-live-lifecycle-evaluation.mjs";

const contractId = currentLiveLifecycleContract.id;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "shuduo-creation-reconcile-"));
  const db = join(root, "platform.sqlite");
  const id = randomUUID(), startedAt = new Date(Date.now() - 1000).toISOString();
  const plan = liveLifecyclePlan(3, {contractId});
  const artifactRoot = join(root, ".v2-artifacts", "live-lifecycle");
  const dir = join(artifactRoot, id);
  mkdirSync(dir, {recursive:true, mode:0o700});
  const file = join(dir, "checkpoint.json");
  const metadata = new MetadataStore(db);
  const pending = (definition, phase, actions) => ({
    ...liveCaseCheckpoint(definition, startedAt, plan.caseSetDigest, {contractId,evaluationRunId:id}),
    status:"PAUSED", phase, errorCode:"MUTATION_OUTCOME_UNKNOWN", actions,
  });
  const [first, second, third] = plan.selectedCases;
  function createAgent(definition, key) {
    const item = metadata.deduplicate(`${PROJECT}:agent:${key}`, "synthetic-original-receipt", () =>
      metadata.create("agent", PROJECT, {
        message:definition.request, contextId:definition.contextId, initialSql:definition.seedSql.trim(),
        language:"SPARK_SQL", mode:"LIVE_MODEL", status:"SUCCEEDED", attempts:[], submittedBy:"local-engineer",
      }));
    return item.id;
  }
  const agentKey = randomUUID(), deliveryKey = randomUUID();
  const agentId = createAgent(first, agentKey), parentId = createAgent(second, randomUUID());
  const revisionId = randomUUID(), runId = randomUUID(), revisionHash = "a".repeat(64);
  const delivery = metadata.deduplicate(`${PROJECT}:durable-delivery:${parentId}:${deliveryKey}`, "synthetic-original-receipt", () =>
    metadata.create("agent_delivery_task", PROJECT, {
      mode:"DURABLE_AGENT_DELIVERY_V1", status:"SUCCEEDED",
      sourceAgentTaskId:parentId, sourceRunId:runId, sourceRevisionId:revisionId, sourceSqlHash:revisionHash,
      submittedBy:"local-engineer", remoteSubmission:{privateField:"NOT_FOR_EVALUATION_OUTPUT"},
    }));
  // Reopen the original metadata DB with no generator or Spark authorization.
  metadata.close();
  const store = new MetadataStore(db);
  let executionCalls = 0;
  const forbidden = () => { executionCalls++; throw Error("NO_EXECUTION_IN_RECONCILE"); };
  const app = createV2Server({root, store, env:{V2_LOCAL_DEVELOPMENT:"true", V2_RELEASE_SCHEDULER_MODE:"DISABLED"},
    generator:forbidden, runner:forbidden, deliveryRunner:forbidden});
  await new Promise(resolve => app.server.listen(0,"127.0.0.1",resolve));
  t.after(async () => {
    app.releaseScheduler.shutdown();app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    store.close();rmSync(root,{recursive:true,force:true});
  });
  const origin = "http://127.0.0.1:" + app.server.address().port;
  const unknown = (definition,key) => ({key, status:"UNKNOWN", bodyHash:digest({
    message:definition.request, sql:definition.seedSql, contextId:definition.contextId,
  })});
  const state = {evaluationRunId:id, contract:plan.contract, startedAt, caseSetDigest:plan.caseSetDigest,
    caseLimit:3, origin, outcomes:[
      pending(first,"CODE_AND_DEBUG",{agent:unknown(first,agentKey)}),
      {...pending(second,"DELIVERY_PREPARATION",{
        agent:{id:parentId,status:"CONFIRMED"},delivery:{key:deliveryKey,status:"SUBMITTING",bodyHash:digest({})},
      }),taskId:parentId,code:{taskId:parentId,revisionId,runId,revisionHash}},
      pending(third,"CODE_AND_DEBUG",{agent:unknown(third,randomUUID())}),
    ]};
  const write = () => writeFileSync(file,JSON.stringify(state),{mode:0o600});
  write();
  const requests = [], output = [], errors = [];
  const options = {artifactRoot, testDouble:true, output:text=>output.push(JSON.parse(text)), error:text=>errors.push(text),
    fetchImpl:(url,request)=>{
      requests.push({method:request.method,path:new URL(url).pathname});
      assert.equal(request.method,"GET");
      assert.equal(request.body,undefined);
      return fetch(url,request);
    }};
  return {id, origin, state, file, dir, store, options, requests, output, errors, agentId, delivery, parentId, agentKey, deliveryKey,
    write, executionCalls:()=>executionCalls};
}

test("CLI reconciles only existing creation receipts through HTTP after reopening the metadata database",async t=>{
  const x = await fixture(t);
  const unknown = structuredClone(x.state.outcomes[2]);
  const agentBefore = x.store.list("agent",PROJECT);
  const deliveryBefore = x.store.list("agent_delivery_task",PROJECT);
  assert.equal(await runLiveLifecycleCli(["--reconcile",x.id],{},x.options),2);
  assert.deepEqual(x.requests.map(r=>r.path),[
    "/api/v2/agent/requests/"+x.agentKey,
    "/api/v2/agent/tasks/"+x.parentId+"/delivery-requests/"+x.deliveryKey,
    "/api/v2/agent/requests/"+unknown.actions.agent.key,
  ]);
  const result = x.output.at(-1);
  assert.equal(result.recoveredCaseCount,2);
  assert.deepEqual(result.cases.map(row=>row.status),["RECOVERED","RECOVERED","NOT_RECORDED"]);
  assert.match(result.cases[0].taskUrl,new RegExp(x.agentId+"$"));
  assert(!JSON.stringify(result).includes(x.agentKey));
  assert(!JSON.stringify(result).includes(x.deliveryKey));
  const saved = JSON.parse(readFileSync(x.file,"utf8"));
  assert.equal(saved.outcomes[0].status,"PAUSED");
  assert.equal(saved.outcomes[0].actions.agent.id,x.agentId);
  assert.equal(saved.outcomes[1].actions.delivery.id,x.delivery.id);
  assert.equal(saved.outcomes[0].executionEvidenceMode,"TEST_HARNESS");
  assert.deepEqual(saved.outcomes[2],unknown);
  const exactBytes = readFileSync(x.file,"utf8");
  x.requests.length = 0;
  assert.equal(await runLiveLifecycleCli(["--reconcile",x.id],{},x.options),2);
  assert.equal(x.requests.length,1);
  assert.equal(readFileSync(x.file,"utf8"),exactBytes);
  assert.deepEqual(readdirSync(x.dir),["checkpoint.json"]);
  assert.deepEqual(x.store.list("agent",PROJECT),agentBefore);
  assert.deepEqual(x.store.list("agent_delivery_task",PROJECT),deliveryBefore);
  assert.equal(x.executionCalls(),0);
  const overview = await (await fetch(x.origin + "/api/v2/evaluations/live-lifecycle/overview")).json();
  assert.equal(overview.verifiedCaseCount,0);
  assert.equal(overview.cases[0].taskUrl,result.cases[0].taskUrl);
});

test("reconcile fails closed on a changed request, wrong source hash, conflicting ledger and invalid reads",async t=>{
  const x = await fixture(t);
  x.state.outcomes[0].actions.agent.bodyHash = "f".repeat(64);
  x.state.outcomes[1].code.revisionHash = "b".repeat(64);
  x.write();
  const before = readFileSync(x.file,"utf8");
  assert.equal(await runLiveLifecycleCli(["--reconcile",x.id],{},x.options),2);
  assert.deepEqual(x.output.at(-1).cases.map(row=>row.status),["UNCONFIRMED","UNCONFIRMED","NOT_RECORDED"]);
  assert.equal(x.requests.length,2);
  assert.equal(readFileSync(x.file,"utf8"),before);
  x.store.deduplicate(`${PROJECT}:agent-delivery:${x.parentId}:${x.deliveryKey}`,"conflicting-receipt",()=>
    x.store.get("agent_delivery_task",x.delivery.id,PROJECT));
  const route = "/agent/tasks/"+x.parentId+"/delivery-requests/"+x.deliveryKey;
  assert.equal((await fetch(x.origin+"/api/v2"+route)).status,409);
  const adapter = createLiveEvaluationAdapter(x.origin,{receiptOnly:true,outcomes:x.state.outcomes,
    fetchImpl:()=>assert.fail("forbidden path was requested")});
  for (const [path,body,key] of [[route,{}],[route,undefined,"retry"],[route+"?next=true"],["/status"],["/agent/tasks/"+x.agentId+"/advance"]])
    await assert.rejects(adapter.request(path,body,key),{code:"READ_ONLY_CREATION_RECONCILE_REQUIRED"});
  assert.equal(x.executionCalls(),0);
});
