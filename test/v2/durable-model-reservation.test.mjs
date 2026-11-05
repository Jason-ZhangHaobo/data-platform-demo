import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../../src/v2/store.mjs';
import { BudgetManager } from '../../src/v2/budget.mjs';
import { createDurableSqlAgent } from '../../src/v2/durable-agent.mjs';
import { getContext,contextIds,validationContractId,referenceSql } from '../../src/v2/context.mjs';
import { safeModelDiagnostic } from '../../src/v2/model-diagnostics.mjs';
import { generateSql } from '../../src/v2/model.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const now=Date.parse('2026-10-20T08:00:00Z'), project='fictional-budget-project';
function setup(t,env={}) {
  const root=mkdtempSync(join(tmpdir(),'shuduo-reservation-')),store=new MetadataStore(join(root,'metadata.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  // MetadataStore uses the wall clock; the budget and engine below use October.
  // Apply the same fixture clock to engine-created records too, not only seeds.
  const createRecord=store.create.bind(store);
  store.create=(kind,owner,value)=>{const item=createRecord(kind,owner,value);return store.update(kind,item.id,owner,{createdAt:new Date(now).toISOString()});};
  const budget=new BudgetManager({store,project,env:{V2_MODEL:'qwen3.7-plus',V2_MODEL_MONTHLY_BUDGET_CNY:'1.5',...env},now:()=>now});
  const create=(kind,value)=>store.create(kind,project,value);
  // A pre-existing unknown call remains conservatively reserved at CNY 0.5.
  create('agent',{mode:'LIVE_MODEL',attempts:[{model:'unconfirmed',usage:{total_tokens:2500},status:'MODEL_OUTCOME_UNKNOWN',usageEstimated:true}]});
  return {store,budget,create};
}
test('narrow budget permits one owned durable reservation without charging it twice',async t=>{
  const f=setup(t);let requests=0,reservation;
  const runner=Object.fromEntries(['prepare','submit','read','cancel'].map(k=>[k,async()=>{throw Error('synthetic runner must not execute');}]));
  const engine=createDurableSqlAgent({store:f.store,project,runner,persist:async()=>{},getContext,contextIds,contractId:validationContractId,
    now:()=>now,assertModelBudget:()=>f.budget.assertCanStartModel(),generator:async input=>{
      reservation=input.modelBudgetReservation;f.budget.assertCanStartModel(reservation);requests++;
      return {sql:referenceSql,model:'qwen3.7-plus',usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}};
    }});
  const task=await engine.create({message:'虚构证券资产加工',contextId:'holdings-t1',currentSql:'SELECT 1 AS pending',actorId:'fixture-engineer',idempotencyKey:'fixture-one'});
  assert.equal(task.createdAt,new Date(now).toISOString(),'engine-created records share the fixture budget month');
  const generated=await engine.advance(task.id,{expectedVersion:task.version});
  assert.equal(requests,1);assert.equal(generated.stage,'READY_FOR_RUN');
  assert.equal(reservation.taskId,task.id);assert.equal(reservation.attempt,1);assert.match(reservation.leaseToken,/^[a-f0-9-]{36}$/);
  assert.equal(generated.durable,undefined,'internal ownership is not a public task field');
  assert.ok(f.budget.overview().model.estimatedCostCny>=0.5,'the unrelated unknown call must remain reserved');
  assert.ok(f.budget.overview().model.estimatedCostCny<0.51);
});
test('an unowned pending/unknown reservation still blocks the ordinary guard',t=>{
  const f=setup(t);f.create('agent',{mode:'LIVE_MODEL',status:'RUNNING',stage:'MODEL_IN_FLIGHT',attempts:[{model:'unconfirmed',usage:{total_tokens:12000},status:'MODEL_IN_FLIGHT'}]});
  assert.throws(()=>f.budget.assertCanStartModel(),{code:'MONTHLY_MODEL_BUDGET_EXCEEDED'});
});
function pending(f){
  const leaseToken=randomUUID(),task=f.create('agent',{mode:'LIVE_MODEL',executionMode:'DURABLE_SQL_AGENT_V1',status:'RUNNING',stage:'MODEL_IN_FLIGHT',
    requestTokenLimit:12000,usedTokens:12000,tokenBudget:32000,durable:{leaseToken,leaseExpiresAt:new Date(now+90000).toISOString()},
    attempts:[{attempt:1,model:'unconfirmed',usage:{total_tokens:12000},usageEstimated:true,status:'MODEL_IN_FLIGHT'}]});
  return {task,reservation:{taskId:task.id,attempt:1,leaseToken}};
}
test('forged, foreign, stale or terminal ownership never discounts any reservation',t=>{
  const changes=[(f,r)=>r.reservation.leaseToken=randomUUID(),(f,r)=>r.reservation.taskId=randomUUID(),(f,r)=>r.reservation.attempt=2,
    (f,r)=>r.reservation.skip=true,(f,r)=>r.reservation.leaseToken='',
    ...[{mode:'LEGACY'},{executionMode:'OTHER'},{stage:'MODEL_OUTCOME_UNKNOWN'},{status:'CANCELLED'},
      {requestTokenLimit:undefined},{usedTokens:40000},{createdAt:'2025-01-01'},
      {attempts:[{attempt:1,model:'qwen3.7-plus',usage:{total_tokens:12000},usageEstimated:true,status:'MODEL_IN_FLIGHT'}]}].map(patch=>(f,r)=>f.store.update('agent',r.task.id,project,patch)),
    (f,r)=>f.store.update('agent',r.task.id,project,{durable:{leaseToken:r.reservation.leaseToken,leaseExpiresAt:new Date(now).toISOString()}})];
  for(const change of changes){const f=setup(t),r=pending(f);change(f,r);
    assert.throws(()=>f.budget.assertCanStartModel(r.reservation),{code:'MODEL_RESERVATION_INVALID'});
  }
  const f=setup(t),r=pending(f);const other=new BudgetManager({store:f.store,project:'another-project',env:{V2_MODEL:'qwen3.7-plus'},now:()=>now});
  assert.throws(()=>other.assertCanStartModel(r.reservation),{code:'MODEL_RESERVATION_INVALID'});
});
test('unrelated unknown costs, unsupported model rates and account ceiling remain enforced',t=>{
  const f=setup(t),r=pending(f);
  f.budget.assertCanStartModel(r.reservation);
  f.create('agent',{mode:'LIVE_MODEL',attempts:[{model:'unconfirmed',usage:{total_tokens:5000},status:'MODEL_OUTCOME_UNKNOWN'}]});
  assert.throws(()=>f.budget.assertCanStartModel(r.reservation),{code:'MONTHLY_MODEL_BUDGET_EXCEEDED'});
  const unsupported=setup(t,{V2_MODEL:'unknown-expensive-model'}),u=pending(unsupported);
  assert.throws(()=>unsupported.budget.assertCanStartModel(u.reservation),{code:'MONTHLY_MODEL_BUDGET_EXCEEDED'});
  const account=setup(t,{V2_ACCOUNT_MONTHLY_SPEND_CNY:'200'}),a=pending(account);
  assert.throws(()=>account.budget.assertCanStartModel(a.reservation),{code:'MONTHLY_HARD_BUDGET_EXCEEDED'});
});
test('unknown provider outcome retains the original full reservation and cannot reuse an old lease',async t=>{
  const f=setup(t);let reservation,requests=0;
  const runner=Object.fromEntries(['prepare','submit','read','cancel'].map(k=>[k,async()=>{throw Error('must not execute');}]));
  const engine=createDurableSqlAgent({store:f.store,project,runner,persist:async()=>{},getContext,contextIds,contractId:validationContractId,now:()=>now,
    assertModelBudget:()=>f.budget.assertCanStartModel(),generator:async input=>{
      reservation=input.modelBudgetReservation;f.budget.assertCanStartModel(reservation);requests++;throw new TypeError('synthetic lost response');
    }});
  let task=await engine.create({message:'虚构证券加工',contextId:'holdings-t1',currentSql:'SELECT 1 AS pending',actorId:'fixture',idempotencyKey:'unknown'});
  task=await engine.advance(task.id,{expectedVersion:task.version});
  assert.equal(task.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(requests,1);assert.equal(task.usedTokens,12000);
  assert.equal(f.budget.overview().model.estimatedCostCny,2.9);
  assert.throws(()=>f.budget.assertCanStartModel(reservation),{code:'MODEL_RESERVATION_INVALID'});
  const unchanged=await engine.advance(task.id,{expectedVersion:task.version});
  assert.equal(unchanged.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(requests,1);
  await assert.rejects(engine.prepareResume(task.id,{expectedVersion:task.version,confirmModelRetry:false}),{code:'AGENT_RETRY_CONFIRMATION_REQUIRED'});
});
test('an inner pre-request budget rejection is marked not sent without discounting its reserve or prior unknown costs',async t=>{
  const f=setup(t),before=f.store.list('agent',project)[0];let requests=0;
  const runner=Object.fromEntries(['prepare','submit','read','cancel'].map(key=>[key,()=>{throw Error('Spark must not execute');}]));
  const engine=createDurableSqlAgent({store:f.store,project,runner,persist:async()=>{},getContext,contextIds,contractId:validationContractId,now:()=>now,
    assertModelBudget:()=>f.budget.assertCanStartModel(),generator:async input=>{
      f.budget.assertCanStartModel({...input.modelBudgetReservation,leaseToken:randomUUID()});requests++;throw Error('provider must not execute');
    }});
  let task=await engine.create({message:'虚构证券加工',contextId:'holdings-t1',currentSql:'SELECT 1 AS pending',actorId:'fixture',idempotencyKey:'not-sent-reservation'});
  task=await engine.advance(task.id,{expectedVersion:task.version});
  assert.equal(task.stage,'MODEL_NOT_SENT');assert.equal(task.recovery.confirmationRequired,false);assert.equal(requests,0);assert.equal(task.usedTokens,12000);
  assert.equal(task.attempts[0].usage.total_tokens,12000);assert.equal(task.attempts[0].diagnostic.code,'MODEL_RESERVATION_INVALID');
  assert.equal(f.budget.overview().model.estimatedCostCny,2.9);assert.deepEqual(f.store.get('agent',before.id,project),before);
  await assert.rejects(engine.prepareResume(task.id,{expectedVersion:task.version,confirmModelRetry:false}),{code:'MONTHLY_MODEL_BUDGET_EXCEEDED'});
  assert.equal(engine.get(task.id).stage,'MODEL_NOT_SENT');assert.equal(engine.get(task.id).usedTokens,12000);assert.equal(requests,0);
});
test('reservation rejection is a safe pre-request diagnostic; internal lease is not sent in the SQL prompt',async t=>{
  const f=setup(t),r=pending(f);let actual;
  try{f.budget.assertCanStartModel({...r.reservation,leaseToken:randomUUID()});}catch(error){actual=error;}
  const d=safeModelDiagnostic(actual);
  assert.equal(d.phase,'PREPARE');assert.equal(d.requestMayHaveBeenSent,false);assert.ok(!JSON.stringify(d).includes('private'));
  const server=readFileSync(new URL('../../src/v2/server.mjs',import.meta.url),'utf8');
  assert.match(server,/budget\.assertCanStartModel\(input\.modelBudgetReservation\)/);
  const internal={taskId:randomUUID(),attempt:1,leaseToken:randomUUID()};let body;
  await generateSql({message:'虚构证券加工',context:getContext('holdings-t1'),currentSql:'SELECT 1 AS pending',remainingBudget:12000,
    modelBudgetReservation:internal},{DASHSCOPE_API_KEY:'synthetic-fixture-key'},async(_url,options)=>{
      body=options.body;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:referenceSql,explanation:'synthetic'})}}],usage:{total_tokens:20}}));
    });
  assert.ok(!body.includes(internal.taskId));assert.ok(!body.includes(internal.leaseToken));assert.ok(!body.includes('modelBudgetReservation'));
});
test('only actual model budget failures carry a trusted unsent diagnostic; original messages and HTTP status remain intact',t=>{
  const cases=[
    {fixture:setup(t),call:f=>f.budget.assertCanStartModel({}),code:'MODEL_RESERVATION_INVALID',message:'模型预算预留与当前持久任务租约不一致'},
    {fixture:setup(t,{V2_MODEL_MONTHLY_BUDGET_CNY:'0.1'}),call:f=>f.budget.assertCanStartModel(),code:'MONTHLY_MODEL_BUDGET_EXCEEDED',message:'本月模型预算不足以启动下一次最坏情况任务'},
    {fixture:setup(t,{V2_ACCOUNT_MONTHLY_SPEND_CNY:'200'}),call:f=>f.budget.assertCanStartModel(),code:'MONTHLY_HARD_BUDGET_EXCEEDED',message:'账号本月支出已达到硬上限，收费操作已停止'},
  ];
  for(const sample of cases){
    let actual;try{sample.call(sample.fixture);}catch(error){actual=error;}
    assert.equal(actual?.code,sample.code);assert.equal(actual.status,429);assert.equal(actual.message,sample.message);
    assert.equal(safeModelDiagnostic(actual).phase,'PREPARE');assert.equal(safeModelDiagnostic(actual).requestMayHaveBeenSent,false);
    const collision=Object.assign(Error('SYNTHETIC_REMOTE_FAILURE'),{code:sample.code,status:429});
    assert.equal(safeModelDiagnostic(collision).code,'MODEL_STEP_ERROR');assert.equal(safeModelDiagnostic(collision).requestMayHaveBeenSent,true);
  }
  let sparkError;try{cases[2].fixture.budget.assertCanStartRemoteSpark();}catch(error){sparkError=error;}
  assert.equal(sparkError.code,'MONTHLY_HARD_BUDGET_EXCEEDED');assert.equal(safeModelDiagnostic(sparkError).requestMayHaveBeenSent,true,'a non-model budget gate does not manufacture model-send provenance');
});
