import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {referenceSqlForContext} from '../../src/v2/context.mjs';
import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';

test('ordinary local Agent repair receives the exact preceding failed group feedback within the same task',async t=>{
 const store=new MetadataStore(':memory:');let models=0,executions=0;
 const app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'true'},generator:async input=>{
  models++;if(models===2){assert.equal(input.repairFeedback.failedCaseCount,5);assert(input.repairFeedback.checks.every(c=>c.fields.includes('market_value_ratio')));assert(input.error);}
  return {sql:referenceSqlForContext(input.context.id)+(models===1?'\n-- synthetic incorrect ratio candidate':'\n-- synthetic revised candidate'),model:'SYNTHETIC_FEEDBACK_FIXTURE',usage:{total_tokens:100},...syntheticSqlRequirement(input)};
 },runner:async({context,validationContexts})=>{
  executions++;const passed=executions===2;
  return {status:passed?'SUCCEEDED':'VALIDATION_FAILED',engine:'SYNTHETIC_NO_SPARK',mainSqlExecuted:true,rows:context.expected,
   validation:{passed,assertions:[],issues:passed?[]:['分组数值不符：market_value_ratio'],regressions:validationContexts.map(c=>({contextId:c.id,passed,name:c.name,issues:passed?[]:['分组数值不符：market_value_ratio']}))}};
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 const response=await fetch(base+'/agent/tasks',{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':randomUUID()},body:JSON.stringify({contextId:'holdings-industry-t1',message:'按行业分组核验占比',sql:'SELECT client_id FROM accounts'})});
 assert.equal(response.status,202);const created=await response.json();let task;
 for(let n=0;n<100;n++){task=await(await fetch(base+'/agent/tasks/'+created.id)).json();if(['SUCCEEDED','FAILED'].includes(task.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(task.status,'SUCCEEDED');assert.equal(models,2);assert.equal(executions,2);assert.deepEqual(task.attempts.map(a=>a.status),['VALIDATION_FAILED','SUCCEEDED']);
 assert.equal(store.list('agent',PROJECT).length,1);
});

test('local distribution Agent requires understanding, retains clarification and recovers one original creation without extra work',async t=>{
 const store=new MetadataStore(':memory:');let models=0,executions=0,mode='missing';
 const app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'true'},generator:async input=>{models++;return {sql:referenceSqlForContext(input.context.id),model:'SYNTHETIC_API_FIXTURE',usage:{total_tokens:100},...(mode==='missing'?{}:syntheticSqlRequirement(input,{clarification:mode==='clarification'}))};},
 runner:async({context,validationContexts})=>{executions++;return {status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',testDouble:true,mainSqlExecuted:true,rows:context.expected,
 validation:{passed:true,assertions:[],issues:[],regressions:validationContexts.map(c=>({contextId:c.id,passed:true,name:c.name}))}};}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,contextId='holdings-industry-t1';
 const post=(body,key)=>fetch(base+'/agent/tasks',{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':key},body:JSON.stringify(body)});
 for(const choice of ['missing','clarification','proposal']){
  mode=choice;const key=randomUUID(),body={contextId,message:'按行业标签生成持仓分布 '+mode,sql:'SELECT client_id FROM accounts'};
  const response=await post(body,key);assert.equal(response.status,202);const created=await response.json();
  let task;for(let n=0;n<100;n++){task=await(await fetch(base+'/agent/tasks/'+created.id)).json();if(['SUCCEEDED','FAILED'].includes(task.status))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(task.requirements.status,choice==='missing'?'INVALID':choice==='clarification'?'CLARIFICATION_REQUIRED':'MODEL_PROPOSED');
  assert.equal(task.requirements.basis.metrics.length,6);assert.equal(task.requirements.basis.grain,'CLIENT_TRADE_DATE_INDUSTRY');
  assert.equal(task.status,choice==='proposal'?'SUCCEEDED':'FAILED');assert.equal(executions,choice==='proposal'?1:0);
  const before=models;assert.equal((await(await post(body,key)).json()).id,created.id);assert.equal((await(await fetch(base+'/agent/requests/'+key)).json()).id,created.id);assert.equal(models,before);
 }
 assert.equal(models,3);assert.equal(executions,1);assert.equal(store.list('agent',PROJECT).length,3);
});
