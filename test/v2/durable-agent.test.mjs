import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { MetadataStore } from "../../src/v2/store.mjs";
import { MemorySnapshotBackend, ReplicatedMetadataStore } from "../../src/v2/metadata-replica.mjs";
import { createDurableSqlAgent } from "../../src/v2/durable-agent.mjs";
import { referenceSql, getContext, contextIds, validationContractId,validationFamilyForContext } from "../../src/v2/context.mjs";
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult } from "../../src/v2/remote-spark-queue.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { createPasswordHash } from "../../src/v2/auth.mjs";
import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';
import {verifiedSqlRequirementReport} from '../../src/v2/sql-requirements.mjs';
import {readSqlClarificationSource} from '../../src/v2/sql-clarification.mjs';
import {liveEvidenceProvenance} from '../../src/v2/live-lifecycle-provenance.mjs';

function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shuduo-durable-agent-")), path = join(dir, "metadata.sqlite");
  const objects = new Map(), counts = { model: 0, jobs: 0, budget: 0 };
  const config = { projectId: PROJECT, sharedSecret: "synthetic-agent-test-secret-0123456789abcdef",
    jobPrefix: SPARK_QUEUE_PREFIXES.jobs, resultPrefix: SPARK_QUEUE_PREFIXES.results,
    cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations, timeoutMs: 180000 };
  let clock = Date.now(), store = new MetadataStore(path), loseSubmit = false, failCancel = false, persistFault;
  const client = new RemoteSparkQueueClient(config, {
    read: async key => objects.get(key),
    create: async (key, body) => {
      if (key.startsWith(config.cancellationPrefix) && failCancel) { failCancel = false; throw new Error("synthetic cancel outage"); }
      if (objects.has(key)) { assert.equal(objects.get(key), body); return { created: false }; }
      objects.set(key, body);
      if (key.startsWith(config.jobPrefix)) counts.jobs++;
      if (loseSubmit) { loseSubmit = false; throw new Error("synthetic lost response"); }
      return { created: true };
    },
  }, { now: () => clock });
  const runner = { prepare: (input, id) => client.prepare(input, id), submit: q => client.submitPrepared(q), read: q => client.readPreparedResult(q), cancel: q => client.cancelPrepared(q) };
  const generated = { sql: referenceSql, model: "TEST_DOUBLE", usage: { total_tokens: 20 }, explanation: "synthetic fixture" };
  const generator = async input => { counts.model++; return overrides.generator ? overrides.generator(input, counts.model) : generated; };
  const build = () => createDurableSqlAgent({ store, project: PROJECT, runner, generator,
    persist: async () => { if (persistFault) await persistFault(store); }, getContext, contextIds,
    ...(overrides.resolveValidationFamily?{resolveValidationFamily:overrides.resolveValidationFamily}:{}),
    contractId: validationContractId, tokenBudget: overrides.tokenBudget ?? 300, requestTokenLimit: 100, modelLeaseMs: overrides.modelLeaseMs ?? 1000,
    now: () => clock, assertRunBudget: () => { counts.budget++; } });
  let engine = build();
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get engine() { return engine; }, runner, generator, counts, objects, config, generated, path,
    create: (extra = {}) => engine.create({ message: "生成客户资产 SQL", currentSql: referenceSql, contextId: "holdings-t1", actorId: "synthetic-owner", idempotencyKey: "fixture", ...extra }),
    advance: (id, extra = {}) => engine.advance(id, { expectedVersion: engine.get(id).version, ...extra }),
    restart() { store.close(); store = new MetadataStore(path); store.interruptPending(PROJECT); engine = build(); },
    later(ms) { clock += ms; }, lose() { loseSubmit = true; }, cancelOutage() { failCancel = true; }, fault(fn) { persistFault = fn; },
    complete(id, patch = {}) {
      const task = store.get("agent", id, PROJECT), run = store.get("run", task.runId, PROJECT), prepared = run.remoteSubmission.prepared;
      objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, {
        status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
        rows: getContext("holdings-t1").expected, log: "synthetic worker log",
        validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) }, ...patch,
      }, config, clock)));
    },
  };
}

test('structured requirement proposal is bound to the original task/code and survives restart without extra model calls',async t=>{
 const f=setup(t,{generator:async input=>({...f.generated,...syntheticSqlRequirement(input)})});
 let task=await f.create();task=await f.advance(task.id);
 assert.equal(task.stage,'READY_FOR_RUN');assert.equal(task.requirements.status,'MODEL_PROPOSED');
 assert.equal(verifiedSqlRequirementReport(task.requirements,task),true);assert.equal(task.requirements.semanticVerification,'REQUIRES_INDEPENDENT_EXECUTION');
 assert.equal(task.requirements.revisionId,task.revisionId);assert.equal(f.counts.model,1);assert.equal(f.counts.jobs,0);
 const proposal=structuredClone(task.requirements);f.restart();assert.deepEqual(f.engine.get(task.id).requirements,proposal);
 task=await f.advance(task.id);assert.equal(f.counts.jobs,1);assert.equal(f.counts.model,1);f.complete(task.id);task=await f.advance(task.id);
 assert.equal(task.status,'SUCCEEDED');assert.deepEqual(task.requirements,proposal);assert.equal(verifiedSqlRequirementReport(proposal,task),true);
});
test('invalid/missing model understanding stops before Spark and retains the confirmed model usage',async t=>{
 for(const mutate of [g=>{g.requirement=undefined;},g=>{g.requirement.basisDigest='0'.repeat(64);},g=>{g.requirement.metrics[0].sourceFields=['accounts.fake'];},
  g=>{g.requirement.constraints.pop();},g=>{g.requirement.grain='POSITION';}]){
  const f=setup(t,{generator:async input=>{const g={...f.generated,...syntheticSqlRequirement(input)};mutate(g);return g;}});
  const created=await f.create(),task=await f.advance(created.id);
  assert.equal(task.status,'FAILED');assert.equal(task.stage,'REQUIREMENT_EVIDENCE_INVALID');assert.equal(task.requirements.status,'INVALID');
  assert.equal(task.usedTokens,20);assert.equal(task.attempts[0].usage.total_tokens,20);assert.equal(task.attempts[0].computationSkipped,true);
  assert.equal(f.counts.jobs,0);assert.equal(f.store.list('revision',PROJECT).length,0);
  f.restart();await f.advance(task.id);assert.equal(f.counts.model,1);assert.equal(f.counts.jobs,0);
 }
});
test('one clarification question stops SQL development, persists the response and never becomes automatic retry consent',async t=>{
 const f=setup(t,{generator:async input=>({...f.generated,sql:null,...syntheticSqlRequirement(input,{clarification:true})})});
 let task=await f.create();task=await f.advance(task.id);
 assert.equal(task.stage,'REQUIREMENT_CLARIFICATION_REQUIRED');assert.equal(task.requirements.status,'CLARIFICATION_REQUIRED');
 assert.equal(verifiedSqlRequirementReport(task.requirements,task),true);assert.equal(task.usedTokens,20);assert.equal(f.counts.jobs,0);
 const original=structuredClone(task.requirements);f.restart();task=await f.advance(task.id,{confirmModelRetry:true});
 assert.deepEqual(task.requirements,original);assert.equal(f.counts.model,1);assert.equal(f.counts.jobs,0);assert.equal(task.status,'FAILED');
});

test('a clarification answer creates one source-bound child, preserves root usage and survives SQL/model recovery',async t=>{
 const f=setup(t,{generator:async input=>({...f.generated,...syntheticSqlRequirement(input,{clarification:!input.clarification}),...(input.clarification?{}:{sql:null})})});
 let root=await f.create({idempotencyKey:'original'});root=await f.advance(root.id);assert.equal(root.stage,'REQUIREMENT_CLARIFICATION_REQUIRED');
 const source=readSqlClarificationSource({store:f.store,project:PROJECT,taskId:root.id,actorId:'synthetic-owner'}),before=JSON.stringify(f.store.get('agent',root.id,PROJECT));
 const input={message:'先计算当前五项',currentSql:source.sql,contextId:source.contextId,actorId:'synthetic-owner',idempotencyKey:'answer',clarification:source.binding};
 let child=await f.engine.create(input);assert.notEqual(child.id,root.id);assert.equal((await f.engine.create(input)).id,child.id);
 assert.equal(child.clarification.originalRequest,root.message);assert.equal(child.clarification.turns[0].usedTokens,20);assert.equal(child.humanClarified,true);assert.equal(child.directAutonomousEligible,false);
 assert.equal(child.usedTokens,0);assert.equal(f.counts.model,1);f.restart();child=await f.advance(child.id);assert.equal(child.stage,'READY_FOR_RUN');
 assert.equal(verifiedSqlRequirementReport(child.requirements,child),true);assert.equal(child.requirements.basis.clarificationDigest,child.clarification.digest);
 child=await f.advance(child.id);f.complete(child.id);child=await f.advance(child.id);assert.equal(child.status,'SUCCEEDED');
 assert.equal(JSON.stringify(f.store.get('agent',root.id,PROJECT)),before);assert.equal(f.counts.model,2);assert.equal(f.counts.jobs,1);assert.equal(liveEvidenceProvenance(child).nonNative,true);
});
test('clarification rejects another actor, stale question, substituted code/context and mixed origins before a new model call',async t=>{
 const f=setup(t,{generator:async input=>({...f.generated,sql:null,...syntheticSqlRequirement(input,{clarification:true})})});
 let parent=await f.create();parent=await f.advance(parent.id);const source=readSqlClarificationSource({store:f.store,project:PROJECT,taskId:parent.id,actorId:'synthetic-owner'});
 const base={message:'按当前口径',currentSql:source.sql,contextId:source.contextId,actorId:'synthetic-owner',idempotencyKey:'answer',clarification:source.binding};
 await assert.rejects(f.engine.create({...base,actorId:'other'}),e=>e.status===403);
 for(const patch of [{currentSql:'SELECT 1'},{contextId:'cash-change'},{sourceRunId:'foreign'},{clarification:{...source.binding,evidenceDigest:'0'.repeat(64)}}])await assert.rejects(f.engine.create({...base,...patch}));
 const r=structuredClone(parent.requirements);r.interpretation.question='新的业务问题？';f.store.update('agent',parent.id,PROJECT,{requirements:r});
 await assert.rejects(f.engine.create(base));assert.equal(f.counts.model,1);assert.equal(f.store.list('agent',PROJECT).length,1);
});
test('clarification drift before or during a model step preserves reservations/confirmed usage without Spark',async t=>{
 for(const phase of ['before','persist','model']){
  const f=setup(t,{generator:async input=>{if(input.clarification&&phase==='model')drift();return {...f.generated,...syntheticSqlRequirement(input,{clarification:!input.clarification}),...(input.clarification?{}:{sql:null})};}});
  let parent=await f.create();parent=await f.advance(parent.id);
  const drift=()=>{const r=structuredClone(parent.requirements);r.interpretation.question='新的问题？';f.store.update('agent',parent.id,PROJECT,{requirements:r});};
  const source=readSqlClarificationSource({store:f.store,project:PROJECT,taskId:parent.id,actorId:'synthetic-owner'});
  let child=await f.engine.create({message:'先按当前范围',currentSql:source.sql,contextId:source.contextId,actorId:'synthetic-owner',idempotencyKey:'answer',clarification:source.binding});
  if(phase==='before')drift();if(phase==='persist')f.fault(()=>{if(f.store.get('agent',child.id,PROJECT).stage==='MODEL_IN_FLIGHT')drift();});
  child=await f.advance(child.id);assert.equal(child.status,'FAILED');assert.equal(child.code??child.attempts.at(-1).status,'CLARIFICATION_SOURCE_CHANGED');
  assert.equal(f.counts.model,phase==='model'?2:1);assert.equal(f.counts.jobs,0);assert.equal(f.store.get('agent',parent.id,PROJECT).usedTokens,20);
  assert.equal(child.usedTokens,phase==='before'?0:phase==='model'?20:100);
 }
});
test('a persisted Spark claim whose clarification changed is retained as unknown, not submitted or automatically retried',async t=>{
 const f=setup(t,{generator:async input=>({...f.generated,...syntheticSqlRequirement(input,{clarification:!input.clarification}),...(input.clarification?{}:{sql:null})})});
 let parent=await f.create();parent=await f.advance(parent.id);const source=readSqlClarificationSource({store:f.store,project:PROJECT,taskId:parent.id,actorId:'synthetic-owner'});
 let child=await f.engine.create({message:'先按当前范围',currentSql:source.sql,contextId:source.contextId,actorId:'synthetic-owner',idempotencyKey:'answer',clarification:source.binding});child=await f.advance(child.id);
 f.fault(()=>{if(f.store.list('run',PROJECT).length){const r=structuredClone(parent.requirements);r.interpretation.question='已变化';f.store.update('agent',parent.id,PROJECT,{requirements:r});}});
 child=await f.advance(child.id);assert.equal(child.status,'INTERRUPTED');assert.equal(child.stage,'CLARIFICATION_SOURCE_CHANGED');assert.ok(child.runId);assert.equal(f.counts.jobs,0);assert.equal(f.counts.model,2);
 const run=f.store.get('run',child.runId,PROJECT);assert.ok(run.remoteSubmission.prepared);assert.notEqual(run.status,'FAILED');
 await assert.rejects(f.advance(child.id));assert.equal(f.counts.jobs,0);
});
test('three explicit question/answer turns preserve the original request and stop a fourth continuation',async t=>{
 const f=setup(t,{generator:async input=>({...f.generated,sql:null,...syntheticSqlRequirement(input,{clarification:true})})});
 let parent=await f.create({idempotencyKey:'root'});parent=await f.advance(parent.id);const original=parent.message;
 for(let depth=1;depth<=3;depth++){
  const source=readSqlClarificationSource({store:f.store,project:PROJECT,taskId:parent.id,actorId:'synthetic-owner'});
  parent=await f.engine.create({message:'第'+depth+'次答复',currentSql:source.sql,contextId:source.contextId,actorId:'synthetic-owner',idempotencyKey:'reply-'+depth,clarification:source.binding});
  parent=await f.advance(parent.id);assert.equal(parent.clarification.depth,depth);assert.equal(parent.clarification.originalRequest,original);
 }
 assert.throws(()=>readSqlClarificationSource({store:f.store,project:PROJECT,taskId:parent.id,actorId:'synthetic-owner'}),e=>e.code==='CLARIFICATION_DEPTH_LIMIT');
 assert.equal(f.counts.model,4);assert.equal(f.counts.jobs,0);
});
test('registered context derivation retains a human-clarified origin instead of laundering it into direct autonomy',async t=>{
 const f=setup(t,{resolveValidationFamily:validationFamilyForContext,generator:async input=>({...f.generated,model:'qwen3.7-plus',...syntheticSqlRequirement(input,{clarification:!input.clarification}),...(input.clarification?{}:{sql:null})})});
 let root=await f.create();root=await f.advance(root.id);const source=readSqlClarificationSource({store:f.store,project:PROJECT,taskId:root.id,actorId:'synthetic-owner'});
 let child=await f.engine.create({message:'当前五项即可',currentSql:source.sql,contextId:source.contextId,actorId:'synthetic-owner',idempotencyKey:'reply',clarification:source.binding});
 child=await f.advance(child.id);child=await f.advance(child.id);f.complete(child.id);child=await f.advance(child.id);
 const rev=f.store.get('revision',child.revisionId,PROJECT),derived=await f.engine.create({message:'改为股票持仓加现金',currentSql:rev.sql,contextId:'stock-cash-t1',actorId:'synthetic-owner',idempotencyKey:'derive',
  derivation:{kind:'REGISTERED_CONTEXT_CHANGE',taskId:child.id,revisionId:rev.id,runId:child.runId,revisionHash:rev.hash}});
 assert.equal(derived.humanClarified,true);assert.equal(derived.directAutonomousEligible,false);assert.equal(derived.clarificationOriginTaskId,root.id);assert.equal(derived.clarification,undefined);
 assert.equal(liveEvidenceProvenance(derived).nonNative,true);assert.equal(f.counts.model,2);
});

test("task, generated revision and queued run survive distinct store restarts", async t => {
  const f = setup(t);
  let task = await f.create();
  assert.equal(f.counts.model, 0); assert.equal(task.durable, undefined); assert.equal(task.submittedBy, undefined);
  assert.equal(task.recovery.driver, "EXPLICIT_ADVANCE");
  assert.equal((await f.create()).id, task.id);
  await assert.rejects(f.create({ message: "different request" }), { status: 409 });
  f.store.create("agent", PROJECT, { status: "RUNNING", mode: "LEGACY" });
  f.restart();
  assert.equal(f.engine.get(task.id).stage, "READY_FOR_MODEL");
  assert.equal(f.store.list("agent", PROJECT).find(a => a.mode === "LEGACY").status, "INTERRUPTED");
  task = await f.advance(task.id); const revisionId = task.revisionId;
  assert.equal(task.initialSql, referenceSql);
  assert.equal(task.stage, "READY_FOR_RUN"); assert.equal(f.counts.model, 1);
  f.restart(); task = await f.advance(task.id); const runId = task.runId;
  assert.equal(task.stage, "WAITING_FOR_RUN"); assert.equal(f.counts.jobs, 1);
  f.restart(); f.complete(task.id); task = await f.advance(task.id);
  assert.equal(task.status, "SUCCEEDED"); assert.equal(task.revisionId, revisionId); assert.equal(task.runId, runId);
  assert.equal(task.fullLifecycleE2E, false); assert.equal(f.counts.model, 1); assert.equal(f.counts.jobs, 1);
  assert.equal((await f.advance(task.id)).status, "SUCCEEDED");
  assert.equal(f.store.get("run", runId, PROJECT).log, "synthetic worker log");
  assert.equal(f.store.get("run", runId, PROJECT).durationMs, undefined, "budget reservation is not an observed execution duration");
});

test("a repair task retains the bound failed-run context across restart and passes it to generation", async t => {
  let observed;
  const f = setup(t, { generator: async input => { observed = input; return { sql: referenceSql, model: "TEST_DOUBLE", usage: { total_tokens: 20 } }; } });
  let origin = await f.create({idempotencyKey:"original-failed-source"});await f.advance(origin.id);origin=await f.advance(origin.id);
  f.complete(origin.id,{status:"FAILED",error:"stored unresolved column",validation:undefined,mainSqlExecuted:false});await f.advance(origin.id);
  const sourceRunId = origin.runId;
  const created = await f.create({ idempotencyKey:"explicit-repair",sourceRunId, sourceError: "stored unresolved column" });
  f.restart(); await f.advance(created.id);
  assert.equal(observed.error, "stored unresolved column");
  assert.equal(f.engine.get(created.id).sourceRunId, sourceRunId);
  await assert.rejects(f.create({ idempotencyKey:"explicit-repair",sourceRunId, sourceError: "changed stored error" }), { status: 409 });
});

test("a signed Spark failure without a version is preserved for repair, never upgraded to success", async t => {
  const f = setup(t); let task = await f.create(); await f.advance(task.id); task = await f.advance(task.id);
  f.complete(task.id, { status: "FAILED", engineVersion: undefined, mainSqlExecuted: false, error: "UNRESOLVED_COLUMN: missing_col", validation: undefined });
  task = await f.advance(task.id);
  const failed = f.store.get("run", task.runId, PROJECT);
  assert.equal(failed.status, "FAILED"); assert.equal(failed.engineVersion, undefined);
  assert.match(failed.error, /UNRESOLVED_COLUMN/); assert.equal(task.stage, "READY_FOR_MODEL");
});

test("unknown queue submission reuses exact signed job and never repeats generation", async t => {
  const f = setup(t); let task = await f.create(); task = await f.advance(task.id); f.lose();
  await assert.rejects(f.advance(task.id), /lost response/);
  const runId = f.engine.get(task.id).runId, serialized = f.store.get("run", runId, PROJECT).remoteSubmission.prepared.serialized;
  f.restart(); task = await f.advance(task.id);
  assert.equal(task.runId, runId); assert.equal(f.counts.jobs, 1); assert.equal(f.counts.model, 1); assert.equal(f.counts.budget, 1);
  assert.equal(f.store.get("run", runId, PROJECT).remoteSubmission.prepared.serialized, serialized);
  f.complete(task.id); assert.equal((await f.advance(task.id)).status, "SUCCEEDED");
  const late = await f.create({ idempotencyKey: "receipt-before-expiry" }); await f.advance(late.id); f.lose();
  await assert.rejects(f.advance(late.id), /lost response/);
  f.complete(late.id); f.later(180001); f.restart();
  assert.equal((await f.advance(late.id)).status, "SUCCEEDED"); assert.equal(f.counts.jobs, 2); assert.equal(f.counts.model, 2);
});

test("persisted generated output is reused after checkpoint flush fails", async t => {
  const f = setup(t), task = await f.create();
  f.fault(store => { if (store.get("agent", task.id, PROJECT).stage === "READY_FOR_RUN") throw new Error("synthetic crash after checkpoint"); });
  await assert.rejects(f.advance(task.id), /checkpoint/); f.fault(undefined); f.restart();
  assert.equal(f.engine.get(task.id).stage, "READY_FOR_RUN");
  await f.advance(task.id); assert.equal(f.counts.model, 1); assert.equal(f.counts.jobs, 1);
});

test("a model cannot be called before the attempt and reservation are persisted", async t => {
  const f = setup(t), task = await f.create(); f.fault(() => { throw new Error("synthetic persistence outage"); });
  await assert.rejects(f.advance(task.id), /persistence outage/); assert.equal(f.counts.model, 0);
  const slow = setup(t), delayed = await slow.create(); let advancedClock = false;
  slow.fault(store => { if (!advancedClock && store.get("agent", delayed.id, PROJECT).stage === "MODEL_IN_FLIGHT") { advancedClock = true; slow.later(2000); } });
  assert.equal((await slow.advance(delayed.id)).stage, "MODEL_OUTCOME_UNKNOWN"); assert.equal(slow.counts.model, 0);
});

test("expired model lease requires explicit retry and fences late completion", async t => {
  let resolveOld;
  const f = setup(t, { generator: (_, n) => n === 1 ? new Promise(r => { resolveOld = r; }) : f.generated });
  const created = await f.create(), pending = f.advance(created.id);
  await new Promise(r => setImmediate(r));
  await assert.rejects(f.advance(created.id), { code: "AGENT_STEP_BUSY" });
  f.later(1001); const unknown = await f.advance(created.id);
  assert.equal(unknown.stage, "MODEL_OUTCOME_UNKNOWN"); assert.equal(unknown.usedTokens, 100);
  await f.advance(created.id); assert.equal(f.counts.model, 1);
  resolveOld(f.generated); await pending; assert.equal(f.store.list("revision", PROJECT).length, 0);
  const generated = await f.advance(created.id, { confirmModelRetry: true });
  assert.equal(generated.stage, "READY_FOR_RUN"); assert.equal(generated.usedTokens, 120);
  await assert.rejects(f.engine.advance(created.id, { expectedVersion: unknown.version, confirmModelRetry: true }), { code: "STALE_AGENT_VERSION" });
  assert.equal(f.counts.model, 2); assert.equal(f.counts.jobs, 0);
});

test("validation failure is persisted as repair context without replaying the previous run", async t => {
  let correction;
  const f = setup(t, { generator: (input, attempt) => { correction = input.error; return attempt === 1
    ? { ...f.generated, sql: referenceSql.replace("SELECT DISTINCT position_id", "SELECT position_id") } : f.generated; } });
  let task = await f.create(); await f.advance(task.id); task = await f.advance(task.id);
  const firstRun = task.runId;
  f.complete(task.id, { status: "VALIDATION_FAILED", validation: { passed: false, issues: ["synthetic mismatch"] } });
  task = await f.advance(task.id); assert.equal(task.stage, "READY_FOR_MODEL");
  f.restart(); await f.advance(task.id); assert.equal(correction, "synthetic mismatch");
  task = await f.advance(task.id); assert.notEqual(task.runId, firstRun); assert.equal(f.counts.jobs, 2);
  f.complete(task.id); task = await f.advance(task.id); assert.equal(task.status, "SUCCEEDED"); assert.equal(task.attempts.length, 2);
  const timed = await f.create({ idempotencyKey: "executor-timeout" });
  await f.advance(timed.id); await f.advance(timed.id);
  f.complete(timed.id, { status: "FAILED", code: "REMOTE_SPARK_TIMEOUT", error: "synthetic timeout" });
  assert.equal((await f.advance(timed.id)).status, "FAILED");
  await f.advance(timed.id); assert.equal(f.counts.model, 3);
});

test("an unchanged repair keeps its exact failed evidence and model cost but creates no new revision or Spark run", async t => {
  for (const status of ["VALIDATION_FAILED", "FAILED"]) for (const formatted of [false, true]) await t.test(`${status} / ${formatted ? "layout" : "exact"}`, async t => {
    const f = setup(t, { generator: (_input, attempt) => ({ ...f.generated,
      sql: attempt > 1 && formatted ? referenceSql.replaceAll("\n  ", "\n      ") : referenceSql }) });
    let task = await f.create(); await f.advance(task.id); task = await f.advance(task.id);
    f.complete(task.id, status === "VALIDATION_FAILED"
      ? { status, validation: { passed: false, issues: ["重复持仓：holding_market_value 结果不符"] } }
      : { status, engineVersion: undefined, mainSqlExecuted: false, validation: undefined, error: "UNRESOLVED_COLUMN: fictional_column" });
    task = await f.advance(task.id); const prior = structuredClone(task), run = f.store.get("run", task.runId, PROJECT), revision = f.store.get("revision", task.revisionId, PROJECT);
    f.restart(); task = await f.advance(task.id);
    assert.equal(task.status, "FAILED"); assert.equal(task.code, "AGENT_SQL_UNCHANGED_AFTER_FAILURE"); assert.match(task.error, /未对已失败的 SQL 作出有效修改/);
    assert.equal(task.runId, prior.runId); assert.equal(task.revisionId, prior.revisionId); assert.equal(task.sql, prior.sql);
    assert.deepEqual(task.attempts[0], prior.attempts[0]); assert.equal(task.attempts.length, 2); assert.equal(task.maxAttempts, 3); assert.equal(task.usedTokens, 40);
    const last = task.attempts.at(-1); assert.equal(last.status, "NO_SQL_CHANGE"); assert.equal(last.code, task.code); assert.equal(last.computationSkipped, true);
    assert.equal(last.sourceRunId, run.id); assert.equal(last.sourceRevisionId, revision.id); assert.equal(last.runId, undefined); assert.equal(last.revisionId, undefined);
    assert.equal(f.counts.model, 2); assert.equal(f.counts.jobs, 1); assert.equal(f.counts.budget, 1);
    assert.equal(f.store.list("revision", PROJECT).length, 1); assert.equal(f.store.list("run", PROJECT).length, 1);
    assert.deepEqual(f.store.get("run", run.id, PROJECT), run); assert.deepEqual(f.store.get("revision", revision.id, PROJECT), revision);
    f.restart(); assert.equal((await f.advance(task.id)).code, task.code); assert.equal(f.counts.model, 2); assert.equal(f.counts.jobs, 1);
    await assert.rejects(f.engine.prepareResume(task.id, { expectedVersion: f.engine.get(task.id).version, confirmModelRetry: true }), { code: "AGENT_STAGE_INVALID" });
  });
});

test("a no-change repair after an unknown model result retains that reservation and all three attempts", async t => {
  const f = setup(t, { generator: (_input, attempt) => { if (attempt === 2) throw Error("synthetic unknown model outcome"); return f.generated; } });
  let task = await f.create(); await f.advance(task.id); task = await f.advance(task.id);
  f.complete(task.id, { status: "VALIDATION_FAILED", validation: { passed: false, issues: ["synthetic duplicate position"] } });
  task = await f.advance(task.id); const failedRunId = task.runId;
  task = await f.advance(task.id); const unknown = structuredClone(task.attempts[1]);
  assert.equal(task.stage, "MODEL_OUTCOME_UNKNOWN"); assert.equal(task.usedTokens, 120); f.restart();
  task = await f.advance(task.id, { confirmModelRetry: true });
  assert.equal(task.code, "AGENT_SQL_UNCHANGED_AFTER_FAILURE"); assert.equal(task.attempts.length, 3); assert.equal(task.usedTokens, 140);
  assert.deepEqual(task.attempts[1], unknown); assert.equal(task.attempts[2].sourceRunId, failedRunId);
  assert.equal(f.counts.jobs, 1); assert.equal(f.counts.model, 3); await f.advance(task.id); assert.equal(f.counts.model, 3);
});

test("generation receives bounded registered regression feedback only from this task's last matching run", async t => {
  for (const foreign of [false, true]) await t.test(foreign ? "foreign run rejected" : "same-source failure feedback survives restart", async t => {
    let received;
    const f = setup(t, { generator: (input, attempt) => { received = input.repairFeedback; return attempt === 1
      ? { ...f.generated, sql: referenceSql.replace("SELECT DISTINCT position_id", "SELECT position_id") } : f.generated; } });
    let task = await f.create(); await f.advance(task.id); assert.equal(received, undefined); task = await f.advance(task.id);
    f.complete(task.id, { status: "VALIDATION_FAILED", validation: { passed: false, issues: ["重复持仓：holding_market_value 结果不符"],
      regressions: contextIds.map(contextId => ({ contextId, passed: contextId !== "duplicate-position",
        issues: contextId === "duplicate-position" ? ["SYNTHETIC-CLIENT.holding_market_value 结果不符"] : [],
        expected: "SYNTHETIC_PRIVATE_ANSWER", rows: ["SYNTHETIC_RAW_ROW"] })) } });
    task = await f.advance(task.id);
    if (foreign) f.store.update("run", task.runId, PROJECT, { agentTaskId: "another-task" });
    f.restart(); task = await f.advance(task.id); assert.equal(task.stage, "READY_FOR_RUN");
    if (foreign) assert.equal(received, undefined);
    else {
      assert.equal(received.protocol, "SECURITIES_SQL_REPAIR_FEEDBACK_V1"); assert.equal(received.passedCaseCount, 4); assert.equal(received.failedCaseCount, 1);
      assert.deepEqual(received.checks.find(row => !row.passed), { contextId: "duplicate-position", passed: false, fields: ["holding_market_value"], issueKinds: ["VALUE_MISMATCH"] });
      assert.doesNotMatch(JSON.stringify(received), /SYNTHETIC_PRIVATE_ANSWER|SYNTHETIC_RAW_ROW|SYNTHETIC-CLIENT/);
    }
    assert.equal(f.counts.model, 2); assert.equal(f.counts.jobs, 1, "feedback preparation itself does not submit another Spark run");
  });
});

test("an explicit repair's first model receives source feedback and unchanged SQL reuses only its reviewed failure",async t=>{
  for(const changed of [false,true])await t.test(changed?"actual change can be executed":"unchanged source is not executed twice",async t=>{
    const bad=referenceSql.replace("SELECT DISTINCT position_id","SELECT position_id");let feedback;
    const f=setup(t,{generator:(input,attempt)=>{feedback=input.repairFeedback;return{...f.generated,sql:attempt===1||!changed?bad:referenceSql};}});
    let origin=await f.create({idempotencyKey:"origin"});await f.advance(origin.id);origin=await f.advance(origin.id);
    f.complete(origin.id,{status:"VALIDATION_FAILED",validation:{passed:false,issues:["重复持仓：holding_market_value 结果不符"],
      regressions:contextIds.map(contextId=>({contextId,passed:contextId!=="duplicate-position",issues:contextId==="duplicate-position"?["holding_market_value 结果不符"]:[]}))}});
    origin=await f.advance(origin.id);const oldAgent=f.store.get("agent",origin.id,PROJECT),oldRun=f.store.get("run",origin.runId,PROJECT),oldRevision=f.store.get("revision",origin.revisionId,PROJECT);
    let repair=await f.create({idempotencyKey:"repair",sourceRunId:oldRun.id,sourceError:oldRun.validation.issues.join("；"),currentSql:oldRevision.sql});
    f.restart();repair=await f.advance(repair.id);assert.equal(feedback.passedCaseCount,4);assert.equal(feedback.failedCaseCount,1);
    assert.equal(repair.usedTokens,20);assert.equal(repair.attempts.length,1);assert.equal(f.counts.model,2);
    if(changed){assert.equal(repair.stage,"READY_FOR_RUN");assert.notEqual(repair.revisionId,oldRevision.id);await f.advance(repair.id);assert.equal(f.counts.jobs,2);}
    else{
      assert.equal(repair.code,"AGENT_SQL_UNCHANGED_AFTER_FAILURE");assert.equal(repair.status,"FAILED");assert.equal(repair.runId,oldRun.id);assert.equal(repair.revisionId,oldRevision.id);
      assert.equal(repair.attempts[0].sourceKind,"EXPLICIT_FAILED_RUN");assert.equal(repair.attempts[0].runId,undefined);assert.equal(repair.attempts[0].computationSkipped,true);
      assert.equal(f.counts.jobs,1);assert.equal(f.store.list("run",PROJECT).length,1);assert.equal(f.store.list("revision",PROJECT).length,1);
    }
    assert.deepEqual(f.store.get("agent",origin.id,PROJECT),oldAgent);assert.deepEqual(f.store.get("run",oldRun.id,PROJECT),oldRun);assert.deepEqual(f.store.get("revision",oldRevision.id,PROJECT),oldRevision);
  });
});

test("explicit repair creation rejects foreign, mismatched or timeout sources before creating a task or reserving model tokens",async t=>{
  const f=setup(t);let origin=await f.create({idempotencyKey:"origin"});await f.advance(origin.id);origin=await f.advance(origin.id);
  f.complete(origin.id,{status:"FAILED",error:"stored unresolved column",validation:undefined,mainSqlExecuted:false});await f.advance(origin.id);
  const source=f.store.get("run",origin.runId,PROJECT),revision=f.store.get("revision",source.revisionId,PROJECT),before=f.store.list("agent",PROJECT).length;
  for(const patch of [{actorId:"other-user"},{contextId:"cash-change"},{currentSql:"SELECT 1"},{sourceError:"untrusted replacement"},{sourceRunId:"00000000-0000-4000-8000-000000000001"}]){
    await assert.rejects(f.create({idempotencyKey:"foreign",sourceRunId:source.id,sourceError:source.error,currentSql:revision.sql,...patch}),{code:"AGENT_REPAIR_SOURCE_INVALID"});
    assert.equal(f.store.list("agent",PROJECT).length,before);
  }
  f.store.update("run",source.id,PROJECT,{code:"REMOTE_SPARK_TIMEOUT"});
  await assert.rejects(f.create({idempotencyKey:"timeout",sourceRunId:source.id,sourceError:source.error,currentSql:revision.sql}),{code:"AGENT_REPAIR_SOURCE_INVALID"});
  assert.equal(f.store.list("agent",PROJECT).length,before);assert.equal(f.counts.model,1);assert.equal(f.counts.jobs,1);
});

test("known failure reuse never applies to another task, another context, an untrusted result or changed quoted content", async t => {
  for (const mutate of [
    (f, run) => f.store.update("run", run.id, PROJECT, { agentTaskId: "another-task" }),
    (f, run) => f.store.update("run", run.id, PROJECT, { contextId: "cash-change" }),
    (f, run) => f.store.update("run", run.id, PROJECT, { testDouble: true }),
    (f, run) => f.store.update("run", run.id, PROJECT, { revisionHash: "0".repeat(64) }),
  ]) await t.test("unbound failure is not reused", async t => {
    const f = setup(t); let task = await f.create(); await f.advance(task.id); task = await f.advance(task.id);
    f.complete(task.id, { status: "VALIDATION_FAILED", validation: { passed: false, issues: ["synthetic mismatch"] } });
    task = await f.advance(task.id); mutate(f, f.store.get("run", task.runId, PROJECT));
    task = await f.advance(task.id); assert.equal(task.stage, "READY_FOR_RUN"); assert.equal(task.code, undefined);
  });
  const f = setup(t, { generator: (_input, attempt) => ({ ...f.generated, sql: attempt === 2 ? referenceSql.replace("'{{advisor_id}}'", "'ANOTHER-ADVISOR'") : referenceSql }) });
  let task = await f.create(); await f.advance(task.id); task = await f.advance(task.id);
  f.complete(task.id, { status: "VALIDATION_FAILED", validation: { passed: false, issues: ["synthetic mismatch"] } });
  await f.advance(task.id); task = await f.advance(task.id); assert.equal(task.stage, "READY_FOR_RUN"); await f.advance(task.id);
  assert.equal(f.counts.jobs, 2, "changed literal must reach independent validation, not be mistaken for an identical query");
  const other = await f.create({ idempotencyKey: "independent-task-same-sql" }); await f.advance(other.id); await f.advance(other.id);
  assert.equal(f.counts.jobs, 3, "a new task is not suppressed because another task failed the same SQL");
});

test("cancellation persists intent and can retry its marker; late success stays cancelled", async t => {
  const f = setup(t); const task = await f.create(); await f.advance(task.id); await f.advance(task.id);
  f.cancelOutage(); await assert.rejects(f.engine.cancel(task.id), /cancel outage/);
  assert.equal(f.engine.get(task.id).stage, "CANCELLING"); f.restart();
  assert.equal((await f.advance(task.id)).status, "CANCELLED");
  f.complete(task.id); assert.equal((await f.advance(task.id)).status, "CANCELLED"); assert.equal(f.counts.model, 1);
});

test("cancellation fences an in-flight model, and stale document writes are rejected", async t => {
  let resolve;
  const f = setup(t, { generator: () => new Promise(r => { resolve = r; }) }), task = await f.create();
  const pending = f.advance(task.id); await new Promise(r => setImmediate(r));
  await f.engine.cancel(task.id); resolve(f.generated); assert.equal((await pending).status, "CANCELLED");
  assert.equal(f.store.list("revision", PROJECT).length, 0);
  assert.throws(() => f.store.update("agent", task.id, PROJECT, { status: "RUNNING" }, { expectedVersion: task.version }), { code: "STALE_DOCUMENT_VERSION" });
});

test("model watchdog returns an explicit unknown result without automatically retrying", async t => {
  const f = setup(t, { modelLeaseMs: 10, generator: () => new Promise(() => {}) }), task = await f.create();
  const pending = f.advance(task.id);
  await new Promise(r => setTimeout(r, 25));
  assert.equal((await pending).stage, "MODEL_OUTCOME_UNKNOWN");
  assert.equal(f.engine.get(task.id).usedTokens, 100); assert.equal(f.counts.model, 1);
  const sync = createDurableSqlAgent({ store: f.store, project: PROJECT, runner: f.runner,
    generator: () => { throw new Error("synthetic synchronous provider failure"); }, persist: async () => {},
    getContext, contextIds, contractId: validationContractId });
  const syncTask = await sync.create({ message: "同步错误测试", currentSql: referenceSql, contextId: "holdings-t1", actorId: "owner", idempotencyKey: "sync-failure" });
  assert.equal((await sync.advance(syncTask.id, { expectedVersion: syncTask.version })).stage, "MODEL_OUTCOME_UNKNOWN");
});

test("budget exhaustion and context drift cannot start extra model or Spark work", async t => {
  const f = setup(t, { tokenBudget: 100, generator: async () => { throw new Error("unknown outcome"); } }), task = await f.create();
  await f.advance(task.id); assert.equal((await f.advance(task.id, { confirmModelRetry: true })).status, "FAILED");
  assert.equal(f.counts.model, 1); assert.equal(f.counts.jobs, 0);
  await assert.rejects(f.advance(task.id, { confirmModelRetry: "true" }), { code: "AGENT_RETRY_CONFIRMATION_INVALID" });
  const other = await f.create({ idempotencyKey: "changed-context" });
  f.store.update("agent", other.id, PROJECT, { durable: { contextDigest: "stale-context" } });
  await assert.rejects(f.advance(other.id), { code: "AGENT_CONTEXT_CHANGED" }); assert.equal(f.counts.model, 1);
});

test("replicated snapshot conflict prevents a competing model call before external effects", async t => {
  const f = setup(t), backend = new MemorySnapshotBackend();
  const a = await ReplicatedMetadataStore.open({ backend, project: PROJECT, autoFlush: false });
  const make = store => createDurableSqlAgent({ store, project: PROJECT, runner: f.runner, generator: f.generator,
    persist: () => store.flush(), getContext, contextIds, contractId: validationContractId });
  const first = make(a), task = await first.create({ message: "生成客户资产 SQL", currentSql: referenceSql, contextId: "holdings-t1", actorId: "owner", idempotencyKey: "snapshot" });
  const b = await ReplicatedMetadataStore.open({ backend, project: PROJECT, autoFlush: false }), stale = make(b);
  try {
    await first.advance(task.id, { expectedVersion: task.version });
    await assert.rejects(stale.advance(task.id, { expectedVersion: task.version }), { code: "CLOUD_METADATA_CONFLICT" });
    assert.equal(f.counts.model, 1);
    await b.refresh(); assert.equal(stale.get(task.id).stage, "READY_FOR_RUN");
    assert.throws(() => b.update("agent", task.id, PROJECT, { status: "QUEUED" }, { expectedVersion: task.version }), { code: "STALE_DOCUMENT_VERSION" });
  } finally { await b.closeReplicated(); await a.closeReplicated(); }
});

test("separate OS processes recover after forced exit following generation and queue acceptance", t => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-agent-process-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleUrl = relative => JSON.stringify(new URL(relative, import.meta.url).href);
  const code = `
    import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
    import {join} from 'node:path';
    import {createHash} from 'node:crypto';
    import {MetadataStore} from ${moduleUrl("../../src/v2/store.mjs")};
    import {createDurableSqlAgent} from ${moduleUrl("../../src/v2/durable-agent.mjs")};
    import {referenceSql,getContext,contextIds,validationContractId} from ${moduleUrl("../../src/v2/context.mjs")};
    import {RemoteSparkQueueClient,SPARK_QUEUE_PREFIXES,createQueuedSparkResult} from ${moduleUrl("../../src/v2/remote-spark-queue.mjs")};
    const [root,phase]=process.argv.slice(1),project='project-securities-lab';
    const store=new MetadataStore(join(root,'store.sqlite'));store.interruptPending(project);
    const objectPath=k=>join(root,createHash('sha256').update(k).digest('hex')+'.json');
    const config={projectId:project,sharedSecret:'synthetic-process-recovery-secret-0123456789',jobPrefix:SPARK_QUEUE_PREFIXES.jobs,resultPrefix:SPARK_QUEUE_PREFIXES.results,cancellationPrefix:SPARK_QUEUE_PREFIXES.cancellations,timeoutMs:180000};
    const client=new RemoteSparkQueueClient(config,{
      read:async k=>existsSync(objectPath(k))?readFileSync(objectPath(k),'utf8'):undefined,
      create:async(k,body)=>{
        if(existsSync(objectPath(k))){if(readFileSync(objectPath(k),'utf8')!==body)throw Error('payload drift');return {created:false};}
        writeFileSync(objectPath(k),body,{flag:'wx'});
        if(k.startsWith(config.jobPrefix)){appendFileSync(join(root,'job-events'),'created\\n');if(phase==='submit-crash')process.exit(24);}
        return {created:true};
      }
    });
    const runner={prepare:(p,id)=>client.prepare(p,id),submit:p=>client.submitPrepared(p),read:p=>client.readPreparedResult(p),cancel:p=>client.cancelPrepared(p)};
    const engine=createDurableSqlAgent({store,project,runner,getContext,contextIds,contractId:validationContractId,persist:async()=>{},generator:async()=>{
      if(phase!=='generate-crash')throw Error('model must not be called during recovery');
      appendFileSync(join(root,'model-events'),'called\\n');return {sql:referenceSql,model:'TEST_DOUBLE',usage:{total_tokens:20}};
    }});
    let task=store.list('agent',project)[0];
    if(phase==='generate-crash'){
      task=await engine.create({message:'生成客户资产 SQL',currentSql:referenceSql,contextId:'holdings-t1',actorId:'synthetic-owner',idempotencyKey:'process-fixture'});
      await engine.advance(task.id,{expectedVersion:task.version});process.exit(23);
    }
    if(phase==='recover'){
      const run=store.get('run',task.runId,project),prepared=run.remoteSubmission.prepared;
      writeFileSync(objectPath(prepared.resultKey),JSON.stringify(createQueuedSparkResult(prepared.job,{status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,rows:getContext('holdings-t1').expected,validation:{passed:true,regressions:contextIds.map(contextId=>({contextId,passed:true}))}},config)));
    }
    const result=await engine.advance(task.id,{expectedVersion:task.version});
    console.log(JSON.stringify({status:result.status,models:readFileSync(join(root,'model-events'),'utf8').trim().split('\\n').length,jobs:readFileSync(join(root,'job-events'),'utf8').trim().split('\\n').length,revisions:store.list('revision',project).length,runs:store.list('run',project).length}));store.close();
  `;
  const run = phase => spawnSync(process.execPath, ["--input-type=module", "-e", code, root, phase], { encoding: "utf8", timeout: 15000 });
  const first = run("generate-crash"); assert.equal(first.status, 23, first.stderr);
  const second = run("submit-crash"); assert.equal(second.status, 24, second.stderr);
  const recovered = run("recover"); assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout), { status: "SUCCEEDED", models: 1, jobs: 1, revisions: 1, runs: 1 });
});

test("API persists creation without execution; enforces owner, CSRF, stale version and opt-in", async t => {
  const f = setup(t), raw = async () => { throw new Error("blocking runner not permitted"); };
  raw.durable = f.runner;
  raw.descriptor = { engine: "Apache Spark", isolation: "REMOTE_FUNCTION", publicWriteEnabled: true, healthVerified: true };
  for (const [name, role] of [["owner", "ENGINEER"], ["other", "ENGINEER"], ["viewer", "VIEWER"]])
    f.store.create("auth_user", PROJECT, { email: `${name}@example.invalid`, displayName: name,
      passwordHash: createPasswordHash("SyntheticPassword!2026"), status: "ACTIVE", memberships: [{ projectId: PROJECT, role }] });
  const app = createV2Server({ store: f.store, runner: raw, generator: f.generator,
    env: { V2_LOCAL_DEVELOPMENT: "false", V2_PUBLIC_ORIGIN: "https://fixture.invalid", V2_DURABLE_SQL_AGENT_ENABLED: "true" } });
  await new Promise(r => app.server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => app.server.close(r)));
  const call = async (path, body, session, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-shuduo-client": "workbench", "idempotency-key": "api-fixture", origin: "https://fixture.invalid", ...session, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  };
  const login = async name => { const r = await call("/auth/login", { email: `${name}@example.invalid`, password: "SyntheticPassword!2026" }); assert.equal(r.status, 200); return { cookie: r.cookies.map(c => c.split(";")[0]).join("; "), "x-csrf-token": r.body.csrfToken }; };
  const owner = await login("owner"), other = await login("other"), viewer = await login("viewer");
  const body = { message: "生成客户资产 SQL", sql: referenceSql, contextId: "holdings-t1" };
  assert.equal((await call("/agent/tasks", body)).status, 401);
  assert.equal((await call("/agent/tasks", body, viewer)).status, 403);
  const created = await call("/agent/tasks", body, owner); assert.equal(created.status, 202); assert.equal(f.counts.model, 0);
  const id = created.body.id;
  assert.equal((await call("/agent/tasks", body, owner)).body.id, id);
  const outside = f.store.create("agent", "synthetic-other-project", { executionMode: "DURABLE_SQL_AGENT_V1" });
  assert.equal((await call(`/agent/tasks/${outside.id}`, undefined, owner)).status, 404);
  assert.equal((await call(`/agent/tasks/${id}/advance`, {}, owner)).status, 422);
  assert.equal((await call(`/agent/tasks/${id}/advance`, { expectedVersion: created.body.version, stage: "SUCCEEDED" }, owner)).status, 422);
  assert.equal((await call(`/agent/tasks/${id}`, undefined, other)).status, 403);
  assert.deepEqual((await call("/agent/tasks", undefined, other)).body, []);
  assert.equal((await call(`/agent/tasks/${id}/advance`, { expectedVersion: created.body.version }, owner, { "x-csrf-token": "invalid" })).status, 403);
  assert.equal((await call(`/agent/tasks/${id}/advance`, { expectedVersion: created.body.version }, other)).status, 403);
  const advanced = await call(`/agent/tasks/${id}/advance`, { expectedVersion: created.body.version }, owner);
  assert.equal(advanced.status, 200); assert.equal(advanced.body.stage, "READY_FOR_RUN"); assert.equal(advanced.body.durable, undefined);
  assert.equal((await call(`/agent/tasks/${id}/advance`, { expectedVersion: created.body.version }, owner)).status, 409);
  assert.equal(f.counts.model, 1); assert.equal(f.counts.jobs, 0);
  assert.equal((await call(`/agent/tasks/${id}/cancel`, {}, owner)).body.status, "CANCELLED");
  const disabled = createV2Server({ store: f.store, runner: raw, generator: f.generator, env: { V2_LOCAL_DEVELOPMENT: "true" } });
  await new Promise(r => disabled.server.listen(0, "127.0.0.1", r));
  try {
    const response = await fetch(`http://127.0.0.1:${disabled.server.address().port}/api/v2/agent/tasks/${id}/advance`, {
      method: "POST", headers: { "content-type": "application/json", "x-shuduo-client": "cli" }, body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(response.status, 503); assert.equal(f.counts.model, 1);
  } finally { await new Promise(r => disabled.server.close(r)); }
});
