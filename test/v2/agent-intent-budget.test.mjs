import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {generateAgentIntent} from '../../src/v2/model.mjs';
import {modelFailure} from '../../src/v2/model-diagnostics.mjs';
const message='解释虚构证券客户持仓字段';
const route={destinationId:'assets',summary:'解释虚构持仓字段',rationale:'根据已保存元数据核对字段。',confidence:0.9};
const usage={prompt_tokens:100,completion_tokens:50,total_tokens:150};
async function until(read,predicate){
  for(let attempt=0;attempt<100;attempt++){
    const value=await read();
    if(predicate(value))return value;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('INTENT_TEST_DEADLINE');
}
async function fixture(t,planner,{env={},flush}={}){
  const root=mkdtempSync(join(tmpdir(),'shuduo-intent-budget-'));
  const store=new MetadataStore(join(root,'metadata.sqlite'));
  if(flush)store.flush=()=>flush(store);
  const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED',...env},intentPlanner:planner});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    const closed=new Promise(resolve=>app.server.close(resolve));
    app.server.closeAllConnections();await closed;store.close();
  });
  const base='http://127.0.0.1:'+app.server.address().port+'/api/v2';
  const post=(key,path='/agent/intents',body={message})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':key},body:JSON.stringify(body)});
  const finished=id=>until(()=>store.get('agent_intent',id,PROJECT),task=>['SUCCEEDED','FAILED','CANCELLED'].includes(task.status));
  return {app,store,post,finished};
}
test('reported intent usage is charged before an invalid route is rejected',async t=>{
  const f=await fixture(t,async()=>({route:{...route,destinationId:'unknown-module'},model:'qwen3.7-plus',usage}));
  const response=await f.post('invalid-route'),created=await response.json();assert.equal(response.status,202);
  const task=await f.finished(created.id);
  assert.equal(task.status,'FAILED');assert.deepEqual(task.usage,usage);assert.equal(task.usageEstimated,false);
  assert.equal(f.app.budget.overview().model.recordedCalls,1);
  assert.equal(f.app.budget.overview().model.estimatedCostCny,0.0006);
});
test('a provider reply with invalid JSON content still retains its reported usage',async t=>{
  const env={DASHSCOPE_API_KEY:'synthetic-provider-only'};
  const f=await fixture(t,input=>generateAgentIntent(input,env,async()=>Response.json({choices:[{message:{content:'invalid provider route'}}],usage})),{env});
  const created=await (await f.post('invalid-provider-json')).json();
  const task=await f.finished(created.id);
  assert.equal(task.status,'FAILED');assert.equal(task.model,'qwen3.7-plus');assert.deepEqual(task.usage,usage);
  assert.equal(task.usageUnknown,false);assert.equal(f.app.budget.overview().model.estimatedCostCny,0.0006);
  assert.ok(!task.error.includes('invalid provider route'));
});
test('an in-flight cancelled intent retains an unknown reservation and stops new paid work',async t=>{
  let calls=0;const entered=Promise.withResolvers();
  const f=await fixture(t,async({signal})=>{
    calls++;entered.resolve();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('fixture interrupted','AbortError')),{once:true}));
  },{env:{V2_MODEL_MONTHLY_BUDGET_CNY:'1'}});
  const created=await (await f.post('cancel-unknown')).json();await entered.promise;
  assert.equal(f.app.budget.overview().model.recordedCalls,1);
  const cancelled=await f.post('cancel-unknown-now','/agent/intents/'+created.id+'/cancel',{});
  assert.equal(cancelled.status,200);
  const task=await f.finished(created.id);assert.equal(task.status,'CANCELLED');assert.equal(task.usageUnknown,true);
  assert.equal((await f.post('another-paid-intent')).status,429);assert.equal(calls,1);
  assert.equal(f.store.list('agent_intent',PROJECT).length,1);
  const replay=await f.post('cancel-unknown');assert.equal(replay.status,202);assert.equal((await replay.json()).id,created.id);
  assert.equal(calls,1);
});
test('a genuinely unsent preflight is free while a forged matching error code retains the reservation',async t=>{
  for(const trusted of [true,false])await t.test(trusted?'trusted prepare':'provider code imitation',async t=>{
    const f=await fixture(t,async()=>{
      throw trusted?modelFailure('MODEL_CONTEXT_BUDGET','PREPARE'):Object.assign(Error('fixture transport failed'),{code:'MODEL_CONTEXT_BUDGET'});
    });
    const created=await (await f.post('prepare-boundary')).json(),task=await f.finished(created.id);
    assert.equal(task.status,'FAILED');
    assert.equal(f.app.budget.overview().model.recordedCalls,trusted?0:1);
    assert.equal(task.modelRequestSent,trusted?false:undefined);
    assert.equal(task.usageUnknown,!trusted);
  });
});
test('an original successful request is recoverable after another task exhausts the budget',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{calls++;return {route,model:'qwen3.7-plus',usage};},{env:{V2_MODEL_MONTHLY_BUDGET_CNY:'1'}});
  const created=await (await f.post('same-original-key')).json();assert.equal((await f.finished(created.id)).status,'SUCCEEDED');
  f.store.create('agent',PROJECT,{mode:'LIVE_MODEL',model:'qwen3.7-plus',usage:{prompt_tokens:100000,completion_tokens:100000,total_tokens:200000}});
  const replay=await f.post('same-original-key');assert.equal(replay.status,202);assert.equal((await replay.json()).id,created.id);
  assert.equal((await f.post('new-key-after-limit')).status,429);assert.equal(calls,1);
  assert.equal(f.store.list('agent_intent',PROJECT).length,1);
});
test('cancellation before the persisted reservation is released never starts the provider',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let blocked=false,calls=0;
  const f=await fixture(t,async()=>{calls++;return {route,model:'qwen3.7-plus',usage};},{flush:async store=>{
    const task=store.list('agent_intent',PROJECT)[0];
    if(!blocked&&task?.model==='unconfirmed'){blocked=true;entered.resolve();await release.promise;}
  }});
  const creating=f.post('cancel-before-provider');await entered.promise;
  const task=f.store.list('agent_intent',PROJECT)[0];
  assert.equal((await f.post('cancel-before-call','/agent/intents/'+task.id+'/cancel',{})).status,200);
  release.resolve();await creating;
  const final=await until(()=>f.store.get('agent_intent',task.id,PROJECT),value=>value.modelRequestSent===false);
  assert.equal(final.status,'CANCELLED');assert.equal(calls,0);assert.equal(f.app.budget.overview().model.recordedCalls,0);
});
test('a failed reservation flush prevents provider I/O and releases the unsent allowance',async t=>{
  let calls=0,failed=false;
  const f=await fixture(t,async()=>{calls++;return {route,model:'qwen3.7-plus',usage};},{flush:async store=>{
    if(!failed&&store.list('agent_intent',PROJECT)[0]?.model==='unconfirmed'){
      failed=true;throw Error('synthetic reservation persistence failure');
    }
  }});
  await f.post('reservation-flush-failure');
  const task=await until(()=>f.store.list('agent_intent',PROJECT)[0],value=>value?.status==='FAILED');
  assert.equal(failed,true);assert.equal(calls,0);assert.equal(task.modelRequestSent,false);
  assert.equal(task.usageUnknown,false);assert.equal(f.app.budget.overview().model.recordedCalls,0);
});
