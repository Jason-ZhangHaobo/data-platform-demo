import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MetadataStore } from "../../src/v2/store.mjs";
import { validateAgentContextDerivation, resolveAgentContextDerivation } from "../../src/v2/agent-context-derivation.mjs";
import { createDurableSqlAgent } from "../../src/v2/durable-agent.mjs";
import { getContext, contextIds, validationContractId, validationFamilyForContext } from "../../src/v2/context.mjs";
import { seedContextDerivation } from "./fixtures/agent-context-derivation.mjs";

function fixture(t, options = {}) {
  const project = "synthetic-context-derivation", store = new MetadataStore(":memory:"); t.after(() => store.close());
  const source = seedContextDerivation(store, project, options);
  const input = { derivation: source.derivation, actorId: source.actorId, targetContextId: source.task.contextId === "stock-cash-t1" ? "holdings-t1" : "stock-cash-t1",
    currentSql: source.sql, project, read: (kind,id) => store.get(kind,id,project) };
  const counts = { model: 0, budget: 0, spark: 0 }, observed = [];
  let scopeBlocked = false;
  const forbidden = async () => { counts.spark++; throw Error("synthetic test must not execute Spark"); };
  const engine = createDurableSqlAgent({ store, project, getContext, contextIds, contractId: validationContractId,
    resolveValidationFamily: validationFamilyForContext, persist: async () => {},
    assertExecutionScope: () => { if (scopeBlocked) throw Object.assign(Error("synthetic closed scope"), {status:403}); },
    assertModelBudget: () => { counts.budget++; }, runner: { prepare: forbidden, submit: forbidden, read: forbidden, cancel: forbidden },
    generator: async value => { counts.model++; observed.push(value); return { sql: value.currentSql, model: "protocol-model-provider", usage: { total_tokens: 20 } }; },
  });
  const create = (patch = {}) => engine.create({ message: "改为另一已登记证券口径", currentSql: source.sql, contextId: input.targetContextId,
    actorId: source.actorId, idempotencyKey: "synthetic-original-derivation", derivation: source.derivation, ...patch });
  return { store, project, ...source, input, engine, create, counts, observed, block: () => { scopeBlocked = true; } };
}

test("successful native sources in both registered families produce only immutable genealogy, including old local run pointers", t => {
  for (const contextId of ["holdings-t1", "stock-cash-t1"]) for (const legacyLocal of [false,true]) {
    const f = fixture(t, {contextId,legacyLocal}), before = f.store.db.prepare("SELECT data FROM documents ORDER BY id").all();
    assert.deepEqual(resolveAgentContextDerivation(f.input), { ...f.derivation, contextId, validationContractId: f.family.id });
    assert.deepEqual(validateAgentContextDerivation(f.derivation), f.derivation);
    assert.deepEqual(f.store.db.prepare("SELECT data FROM documents ORDER BY id").all(), before);
  }
});

test("derivation syntax, target, exact SQL and actor/project boundaries fail before creating any records", t => {
  const f = fixture(t), before = f.store.list("agent", f.project);
  for (const derivation of [null, [], {...f.derivation,extra:true}, {...f.derivation,kind:"REPAIR"}, {...f.derivation,revisionHash:"bad"},
    {...f.derivation,taskId:"../task"}, {...f.derivation,runId:undefined}])
    assert.throws(() => resolveAgentContextDerivation({...f.input,derivation}), {code:"AGENT_CONTEXT_DERIVATION_INVALID"});
  for (const patch of [{targetContextId:f.task.contextId},{targetContextId:"unregistered-context"}])
    assert.throws(() => resolveAgentContextDerivation({...f.input,...patch}), {code:"AGENT_CONTEXT_TARGET_INVALID"});
  for (const patch of [{actorId:"other-owner"},{project:"other-project"},{currentSql:"SELECT 1"},{currentSql:f.sql.trim()},
    {derivation:{...f.derivation,runId:randomUUID()}},{derivation:{...f.derivation,revisionHash:"f".repeat(64)}}])
    assert.throws(() => resolveAgentContextDerivation({...f.input,...patch}), {code:"AGENT_CONTEXT_SOURCE_INVALID"});
  assert.deepEqual(f.store.list("agent",f.project), before);
});

test("source success labels cannot replace native provenance, last-attempt identity, hash and independent results", t => {
  const changes = [
    ["agent", "task", {status:"FAILED"}], ["agent", "task", {language:"PYTHON"}], ["agent", "task", {sourceKind:"MANUAL"}],
    ["agent", "task", {sourceKind:"UNKNOWN"}], ["agent", "task", {mode:"TEMPLATE"}], ["agent", "task", {submittedBy:"other-owner"}],
    ["agent", "task", {runId:randomUUID()}], ["agent", "task", {sql:"SELECT changed"}],
    ["revision", "revision", {source:"MANUAL"}], ["revision", "revision", {manualProvenance:{kind:"ENGINEER_EDIT"}}],
    ["revision", "revision", {author:"other-owner"}], ["revision", "revision", {sql:"SELECT changed"}],
    ["run", "run", {agentTaskId:randomUUID()}], ["run", "run", {revisionHash:"f".repeat(64)}], ["run", "run", {contextId:"cash-change"}],
    ["run", "run", {status:"VALIDATION_FAILED"}], ["run", "run", {testDouble:true}], ["run", "run", {mainSqlExecuted:false}],
    ["run", "run", {validation:{passed:true,regressions:[]}}], ["run", "run", {rows:[]}],
  ];
  for (const [kind,key,patch] of changes) {
    const f = fixture(t); f.store.update(kind,f[key].id,f.project,patch);
    assert.throws(() => resolveAgentContextDerivation(f.input), {code:"AGENT_CONTEXT_SOURCE_INVALID"}, `${kind}:${Object.keys(patch)}`);
  }
  const f = fixture(t);
  f.store.update("agent",f.task.id,f.project,{attempts:[...f.task.attempts,{status:"FAILED",revisionId:f.revision.id,runId:f.run.id}]});
  assert.throws(() => resolveAgentContextDerivation(f.input), {code:"AGENT_CONTEXT_SOURCE_INVALID"});
});

test("durable derivation is idempotent, seeds only old SQL and creates a new target-context execution without inheriting history", async t => {
  const f = fixture(t), parent = structuredClone(f.task), run = structuredClone(f.run);
  const created = await f.create(), replay = await f.create(); assert.equal(replay.id,created.id); assert.notEqual(created.id,parent.id);
  assert.deepEqual(created.derivedFrom,{...f.derivation,contextId:f.task.contextId,validationContractId:f.family.id});
  assert.equal(created.contextId,f.input.targetContextId); assert.equal(created.validationContractId,validationFamilyForContext(f.input.targetContextId).id);
  assert.equal(created.initialSql,f.sql); assert.equal(created.sql,f.sql); assert.equal(created.usedTokens,0); assert.deepEqual(created.attempts,[]);
  for(const key of ["revisionId","runId","approvalId","releaseId","background","sourceRunId"]) assert.equal(created[key],undefined);
  assert.equal(created.fullLifecycleE2E,false); assert.deepEqual(f.counts,{model:0,budget:0,spark:0});
  await assert.rejects(f.create({contextId:"cash-change"}), {status:409});
  const other = seedContextDerivation(f.store,f.project);
  await assert.rejects(f.create({derivation:other.derivation,currentSql:other.sql}), {status:409});
  const progressed = await f.engine.advance(created.id,{expectedVersion:created.version});
  assert.equal(progressed.stage,"READY_FOR_RUN"); assert.notEqual(progressed.revisionId,f.revision.id); assert.equal(progressed.runId,undefined);
  assert.equal(progressed.usedTokens,20); assert.equal(f.observed[0].context.id,f.input.targetContextId); assert.equal(f.observed[0].currentSql,f.sql);
  assert.equal(f.observed[0].error,undefined); assert.equal(f.observed[0].repairFeedback,undefined);
  assert.equal(f.store.get("revision",progressed.revisionId,f.project).contextId,f.input.targetContextId);
  assert.deepEqual(f.store.get("agent",parent.id,f.project),parent); assert.deepEqual(f.store.get("run",run.id,f.project),run);
  assert.deepEqual(f.counts,{model:1,budget:1,spark:0});
});

test("durable first generation rechecks source before budget/model mutation and original scope cannot authorize derivation", async t => {
  for (const patch of [{submittedBy:"other-owner"},{status:"FAILED"}]) {
    const f=fixture(t),created=await f.create();f.store.update("agent",f.task.id,f.project,patch);
    await assert.rejects(f.engine.advance(created.id,{expectedVersion:created.version}),{code:"AGENT_CONTEXT_SOURCE_INVALID"});
    assert.deepEqual(f.counts,{model:0,budget:0,spark:0});assert.deepEqual(f.engine.get(created.id).attempts,[]);assert.equal(f.engine.get(created.id).usedTokens,0);
  }
  const f=fixture(t);f.block();await assert.rejects(f.create(),{status:403});assert.equal(f.store.list("agent",f.project).length,1);
});

test("successful derivation is mutually exclusive with failed-run repair and ordinary task creation stays independent",async t=>{
  const f=fixture(t);
  for(const patch of [{sourceRunId:f.run.id},{sourceError:"old failure"}])await assert.rejects(f.create(patch),{code:"AGENT_CONTEXT_DERIVATION_CONFLICT"});
  const plain=await f.create({derivation:undefined,idempotencyKey:"ordinary"});assert.equal(plain.derivedFrom,undefined);assert.equal(plain.status,"QUEUED");
  assert.deepEqual(f.store.get("agent",f.task.id,f.project),f.task);assert.deepEqual(f.counts,{model:0,budget:0,spark:0});
});
