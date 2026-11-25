import assert from "node:assert/strict";
import test from "node:test";
import { MetadataStore } from "../../src/v2/store.mjs";
import { resolveAgentContextDerivation } from "../../src/v2/agent-context-derivation.mjs";
import { readDerivedResultComparison } from "../../src/v2/derived-result-comparison.mjs";
import { seedContextDerivation } from "./fixtures/agent-context-derivation.mjs";

function fixture(t, parentId = "holdings-t1", childId = "cash-change") {
  const store = new MetadataStore(":memory:"), project = "synthetic-derived-report";
  t.after(() => store.close());
  const parent = seedContextDerivation(store, project, { contextId: parentId, legacyLocal: true });
  const child = seedContextDerivation(store, project, { contextId: childId });
  const read = (kind,id) => store.get(kind,id,project);
  const binding = resolveAgentContextDerivation({ derivation: parent.derivation, actorId: parent.actorId,
    currentSql: parent.sql, targetContextId: childId, project, read });
  const patch = (type, id, data) => store.update(type, id, project, data);
  patch("agent",child.task.id,{ initialSql: parent.sql, derivedFrom: binding });
  const compare = (extra = {}) => readDerivedResultComparison({ project, actorId: child.actorId,
    task: read("agent",child.task.id), read, ...extra });
  return {store,parent,child,binding,patch,read,compare};
}

const snapshot = store => store.db.prepare("SELECT data FROM documents ORDER BY id").all();
const pending = result => assert.deepEqual(Object.keys(result).sort(), ["protocol","reason","state","taskId"]);

test("compares the original and derived observed customer rows, normalizes cents, and has no side effects", t => {
  const f = fixture(t);
  const rows = f.child.run.rows.toReversed();
  for (const row of rows) {
    row.total_assets = Number(row.total_assets);
    row.available_cash += "00";
    row.security_count = String(row.security_count) + ".0";
  }
  f.patch("run",f.child.run.id,{ rows });
  const before = snapshot(f.store), result = f.compare();
  assert.deepEqual(snapshot(f.store),before);
  assert.deepEqual(f.compare(), result);
  assert.equal(result.state, "MATCHED");
  for (const [key,source] of [["parent",f.parent],["child",f.child]]) {
    const ref = result[key];
    assert.deepEqual([ref.taskId,ref.runId,ref.revisionId,ref.revisionHash,ref.validationContractId],
      [source.task.id,source.run.id,source.revision.id,source.revision.hash,source.family.id]);
    assert.ok(ref.contextName);
  }
  assert.deepEqual(result.rows.map(row => row.clientId),["CLIENT-001","CLIENT-002"]);
  assert.deepEqual(result.rows[0].delta,{ holding_market_value:"0.00",available_cash:"500.00",total_assets:"500.00",security_count:0 });
  assert.deepEqual(result.rows[1].delta,{ holding_market_value:"0.00",available_cash:"0.00",total_assets:"0.00",security_count:0 });
  assert.deepEqual(result.totals.before,{ holding_market_value:"2250.00",available_cash:"500.00",total_assets:"2750.00",security_count:3 });
  assert.deepEqual(result.totals.after,{ holding_market_value:"2250.00",available_cash:"1000.00",total_assets:"3250.00",security_count:3 });
});

test("stock-only target has its own scope and signed changes, without replacing observed numbers by expectations", t => {
  const f = fixture(t,"holdings-t1","stock-cash-t1");
  const r = f.compare();
  assert.equal(r.state,"MATCHED");
  assert.notEqual(r.parent.validationContractId,r.child.validationContractId);
  assert.match(r.child.contextName,/非客户全资产/);
  assert.deepEqual(r.totals.delta,{ holding_market_value:"-500.00",available_cash:"0.00",total_assets:"-500.00",security_count:-1 });
  const wrong = structuredClone(f.child.run.rows);
  wrong[0].available_cash = "300.01"; wrong[0].total_assets = "1300.01";
  f.patch("run",f.child.run.id,{ rows:wrong });
  assert.equal(f.compare().reason,"CHILD_UNCONFIRMED");
});

test("owner and project checks cover both original and derived records", t => {
  const f = fixture(t), forbidden = { status:403,code:"AGENT_DERIVATION_COMPARISON_FORBIDDEN" };
  assert.throws(() => f.compare({ actorId:"other-member" }), forbidden);
  assert.throws(() => f.compare({ project:"other-project" }), forbidden);
  f.patch("agent",f.parent.task.id,{ submittedBy:"other-member" });
  assert.throws(() => f.compare(), forbidden);
});

test("fresh, pending, cancelled and separately registered customer universes do not yield amounts", t => {
  const f = fixture(t,"holdings-t1","cash-only-client");
  const changed = f.compare();
  assert.equal(changed.reason,"CUSTOMER_SCOPE_CHANGED"); pending(changed);
  f.patch("agent",f.child.task.id,{ status:"QUEUED" });
  assert.equal(f.compare().state,"PENDING"); assert.equal(f.compare().reason,"CHILD_RUNNING"); pending(f.compare());
  f.patch("agent",f.child.task.id,{ status:"FAILED" });
  assert.equal(f.compare().reason,"CHILD_UNCONFIRMED");
  const fresh = f.compare({task:f.parent.task});
  assert.equal(fresh.reason,"NOT_DERIVED"); pending(fresh);
});

test("stale pointers, SQL drift, unsupported grain and explicit contradictory provenance fail closed", t => {
  const variants = [
    ["SOURCE_UNCONFIRMED",f=>f.patch("agent",f.child.task.id,{ initialSql:f.parent.sql + " " })],
    ["SOURCE_UNCONFIRMED",f=>f.patch("agent",f.child.task.id,{ derivedFrom:{...f.binding,revisionHash:"a".repeat(64)} })],
    ["SOURCE_UNCONFIRMED",f=>f.patch("agent",f.parent.task.id,{ runId:f.child.run.id })],
    ["SOURCE_UNCONFIRMED",f=>f.patch("agent",f.parent.task.id,{ derivedFrom:{} })],
    ["CHILD_UNCONFIRMED",f=>f.patch("agent",f.child.task.id,{ sourceRunId:f.parent.run.id })],
    ["CHILD_UNCONFIRMED",f=>f.patch("run",f.child.run.id,{ submittedBy:"other-owner" })],
    ["CHILD_UNCONFIRMED",f=>f.patch("run",f.child.run.id,{ remoteSubmission:{prepared:{job:{projectId:"other-project"}}} })],
    ["SOURCE_UNCONFIRMED",f=>f.patch("agent",f.parent.task.id,{ attempts:[{...f.parent.task.attempts[0],model:"fixture"}] })],
    ["CHILD_UNCONFIRMED",f=>f.patch("agent",f.child.task.id,{ revisionId:f.parent.revision.id })],
    ["CHILD_UNCONFIRMED",f=>f.patch("run",f.child.run.id,{ testDouble:true })],
    ["CHILD_UNCONFIRMED",f=>f.patch("run",f.child.run.id,{ validation:{...f.child.run.validation,regressions:[]} })],
    ["CHILD_UNCONFIRMED",f=>f.patch("run",f.child.run.id,{ validation:{...f.child.run.validation,selectedPassed:false} })],
    ["CHILD_UNCONFIRMED",f=>f.patch("agent",f.child.task.id,{ manualContinuation:{} })],
    ["CHILD_UNCONFIRMED",f=>f.patch("agent",f.child.task.id,{ executionMode:"DURABLE_SQL_AGENT_V1" })],
    ["UNSUPPORTED_GRAIN",f=>f.patch("agent",f.child.task.id,{ contextId:"custom-output" })],
    ["SCOPE_CHANGED",f=>f.patch("run",f.child.run.id,{ businessDate:"2026-09-11" })],
    ["SCOPE_CHANGED",f=>f.patch("revision",f.parent.revision.id,{ advisorId:"other-advisor" })],
  ];
  for (const [expected,modify] of variants) {
    const f = fixture(t); modify(f);
    const report = f.compare();
    assert.equal(report.reason,expected); pending(report);
  }
});

test("a missing, duplicate, oversized, imprecise or non-customer row cannot turn into a signed delta", t => {
  for (const mutate of [
    () => [], r => [r[0],r[0]], r=>Array(1001).fill(r[0]),
    r=>[{...r[0],other_dimension:"X"},r[1]], r=>[{...r[0],client_id:"x/y"},r[1]],
    r=>[{...r[0],available_cash:"800.001"},r[1]], r=>[{...r[0],available_cash:null},r[1]],
    r=>[{...r[0],available_cash:Number.MAX_SAFE_INTEGER},r[1]], r=>[{...r[0],total_assets:"700.00"},r[1]],
    r=>[{...r[0],security_count:-1},r[1]], r=>[{...r[0],security_count:"1.5"},r[1]],
  ]) {
    const f = fixture(t);
    f.patch("run",f.child.run.id,{ rows:mutate(f.child.run.rows) });
    const report = f.compare();
    assert.equal(report.reason,"INVALID_ROWS"); pending(report);
  }
});

test("unchanged verified results give explicit zero deltas, including validated durable-worker metadata", t => {
  const f = fixture(t,"holdings-t1","duplicate-position");
  for (const source of [f.parent,f.child]) {
    f.patch("agent",source.task.id,{ executionMode:"DURABLE_SQL_AGENT_V1", runId:source.run.id });
    f.patch("run",source.run.id,{ mode:"DURABLE_REMOTE_SUBMISSION", isolation:"FUNCTION_PROCESS",
      remoteSubmission:{ prepared:{ job:{ jobId:source.run.id, projectId:source.task.projectId } } } });
  }
  const r = f.compare();
  assert.equal(r.state,"MATCHED");
  assert.deepEqual(r.totals.delta,{holding_market_value:"0.00",available_cash:"0.00",total_assets:"0.00",security_count:0});
  f.patch("run", f.child.run.id,{ remoteSubmission:{prepared:{job:{jobId:f.parent.run.id}}} });
  assert.equal(f.compare().reason,"CHILD_UNCONFIRMED");
});
