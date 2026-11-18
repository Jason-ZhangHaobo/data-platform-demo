import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../../src/v2/store.mjs';
import {BudgetManager} from '../../src/v2/budget.mjs';
import {runBudgetedPlanning} from '../../src/v2/budgeted-planning.mjs';

const project = 'fictional-securities', kind = 'quality_agent_plan';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'shuduo-planning-usage-'));
  const path = join(root, 'metadata.sqlite');
  let store = new MetadataStore(path);
  const env = {V2_MODEL_TOKEN_BUDGET:'1000', V2_MODEL_MONTHLY_BUDGET_CNY:'0.1'};
  const budget = () => new BudgetManager({store, project, env});
  const task = store.create(kind, project, {mode:'LIVE_MODEL', status:'RUNNING'});
  t.after(() => {store.close(); rmSync(root, {recursive:true, force:true});});
  return {
    get store() {return store;}, task, budget,
    run: invoke => runBudgetedPlanning({store, project, kind, id:task.id,
      signal:new AbortController().signal, budget:budget(), persist:async()=>{}, invoke}),
    reopen() {store.close(); store = new MetadataStore(path);},
  };
}

test('an unknown professional model outcome survives metadata reopen and blocks another paid call', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(f.run(async()=>{
    calls++;
    assert.equal(f.store.get(kind,f.task.id,project).usageUnknown,true);
    throw Error('synthetic lost provider response');
  }), /synthetic lost provider response/);
  f.reopen();
  const saved = f.store.get(kind,f.task.id,project);
  assert.equal(saved.usageUnknown,true); assert.equal(saved.usage.total_tokens,1000);
  assert.equal(f.budget().overview().model.estimatedCostCny,0.2);
  assert.throws(()=>f.budget().assertCanStartModel(),{code:'MONTHLY_MODEL_BUDGET_EXCEEDED'});
  assert.equal(calls,1);
});

test('a successful unmetered professional reply retains its conservative reservation', async t => {
  const f = fixture(t);
  await f.run(async()=>({plan:{kind:'synthetic proposal'}}));
  const saved = f.store.get(kind,f.task.id,project);
  assert.equal(saved.model,'unconfirmed'); assert.equal(saved.usageUnknown,true);
  assert.equal(saved.usageEstimated,true); assert.equal(saved.modelRequestSent,true);
  assert.equal(f.budget().overview().model.recordedCalls,1);
});

test('a recorded but invalid professional model reply settles known usage before its failure', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(async()=>{
    throw Object.assign(Error('synthetic invalid proposal'),{modelResultRecorded:true,
      model:'qwen3.7-plus',usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}});
  }), /synthetic invalid proposal/);
  const saved = f.store.get(kind,f.task.id,project);
  assert.equal(saved.usageUnknown,false); assert.equal(saved.modelRequestSent,true);
  assert.equal(f.budget().overview().model.estimatedCostCny,0.0006);
});
