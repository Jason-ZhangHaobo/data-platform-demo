import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createV2Server,PROJECT } from '../../src/v2/server.mjs';
import { V2Client } from '../../src/v2/client.mjs';
import { getContext,referenceSqlForContext } from '../../src/v2/context.mjs';
import { runSpark,runtimeConfig } from '../../src/v2/spark.mjs';
import { runV2Cli } from '../../bin/shuduo.mjs';
import { handleV2Mcp } from '../../bin/shuduo-mcp.mjs';

test('an older conversation reads its own corrected SQL, assertions and editor binding across interfaces',async t=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-chat-sql-'));
  const first='用全品类持仓与现金编制客户资产表',second='只用股票持仓与现金编制另一份客户资产表';
  const realSpark=process.env.SHUDUO_TEST_CHAT_SQL_SPARK==='true';
  const counters={intent:0,sql:0,spark:0};
  const app=createV2Server({root,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},
    intentPlanner:async({message})=>{
      counters.intent++;
      return {route:{destinationId:'development',summary:message,rationale:'需求需要编写并校验客户资产 SQL',confidence:1,
        steps:[{destinationId:'development',objective:message}]},model:'SYNTHETIC_INTENT',usage:{total_tokens:10}};
    },
    generator:async({context,message,error})=>{
      counters.sql++;
      const sql=referenceSqlForContext(context.id).trim();
      return {sql:message===first && !error ? sql.replace('SELECT DISTINCT position_id','SELECT position_id') : sql,
        model:'SYNTHETIC_SQL',usage:{total_tokens:20},explanation:'虚构证券测试'};
    },
    runner:async input=>{
      counters.spark++;
      if (realSpark) return runSpark(input,{...runtimeConfig(),artifactRoot:root,retainArtifacts:false});
      const checks=input.validationContexts.map(c=>({contextId:c.id,passed:counters.spark!==1||c.id!=='duplicate-position'}));
      const passed=checks.every(check=>check.passed);
      return {status:passed?'SUCCEEDED':'VALIDATION_FAILED',testDouble:true,engine:'Apache Spark',engineVersion:'3.5.9',
        mainSqlExecuted:true,rows:input.context.expected,validation:{passed,regressions:checks,issues:passed?[]:['重复持仓']},durationMs:1};
    }});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.dispose();app.store.close();rmSync(root,{recursive:true,force:true});});
  const client=new V2Client({baseUrl:'http://127.0.0.1:'+app.server.address().port+'/api/v2'});
  const post=(path,body)=>client.request(path,{method:'POST',body,idempotencyKey:randomUUID()});
  const catalog=await client.request('/agent/tools');
  async function settled(path,intentId){
    const deadline=Date.now()+(realSpark?240000:10000);
    for (;;) {
      const response=await client.request(path);
      const current=intentId ? response.find(item=>item.id===intentId) : response;
      if(!['RUNNING','QUEUED'].includes(current.status)) {assert.equal(current.status,'SUCCEEDED');return current;}
      assert.ok(Date.now()<deadline,'Agent task timed out');await delay(realSpark?250:10);
    }
  }
  const cases=[];
  for(const [message,contextId] of [[first,'holdings-t1'],[second,'stock-cash-t1']]){
    const intent=await post('/agent/intents',{message,approvalMode:'REQUEST_APPROVAL'});
    const path='/agent/intents/'+intent.id;
    await settled('/agent/intents',intent.id);
    const approval=await post(path+'/approvals',{destinationId:'development'});
    const invocation=await post(path+'/tools/development/invoke',{input:{message,contextId,language:'SPARK_SQL',code:'SELECT 1'},
      approvalId:approval.id,catalogVersion:catalog.version,contractDigest:catalog.contractDigest});
    const task=await settled('/agent/tasks/'+invocation.specialist.id);
    cases.push({path,intent,task});
  }
  const [{path,intent,task},other]=cases;
  const route=path+'/development';
  // Historic manual navigation added a later handoff note without a specialist.
  await post(path+'/handoffs',{destinationId:'development'});
  const graph=await client.request(path+'/graph');
  assert.equal(graph.steps[0].specialistTaskId,task.id);
  assert.equal(graph.steps[0].specialistLanguage,'SPARK_SQL');
  const evidence=await client.request(route), alternate=await client.request(other.path+'/development');
  assert.deepEqual(evidence.binding,{intentId:intent.id,taskId:task.id,contextId:task.contextId,
    revisionId:task.revisionId,runId:task.runId,revisionHash:app.store.get('revision',task.revisionId,PROJECT).hash});
  assert.equal(evidence.sql,referenceSqlForContext('holdings-t1').trim());
  assert.notEqual(evidence.sql,alternate.sql);
  assert.equal(evidence.testDouble,!realSpark);
  assert.equal(evidence.codeSource,'SYNTHETIC_MODEL');
  assert.equal(evidence.validation.state,'PASSED');
  assert.equal(evidence.validation.regressions.length,5);
  assert.deepEqual(evidence.attempts.map(a=>a.status),['VALIDATION_FAILED','SUCCEEDED']);
  assert.ok(evidence.attempts[0].failedChecks.includes(getContext('duplicate-position').name));
  assert.equal(evidence.validation.regressions.every(check=>check.passed),true);
  assert.doesNotMatch(JSON.stringify(evidence),/"rows":|"expected":|"submittedBy":/);
  let output;
  assert.equal(await runV2Cli(['agent','chat-development','--id',intent.id],{},
    {client,output:value=>{output=JSON.parse(value);},error:()=>{}}),0);
  assert.deepEqual(output,evidence);
  const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_chat_sql_development',arguments:{intentId:intent.id}}},{client}));
  assert.deepEqual(reply.result.structuredContent,evidence);
  await assert.rejects(client.request(route+'?run_id='+other.task.runId),e=>e.status===422);
  await assert.rejects(client.request(route,{authorization:'Bearer fictional-unrelated-application'}),e=>e.status===403);
  app.store.update('agent_intent',intent.id,PROJECT,{submittedBy:'other-owner'});
  await assert.rejects(client.request(route),e=>e.status===403);
  app.store.update('agent_intent',intent.id,PROJECT,{submittedBy:'local-engineer'});
  app.store.update('agent',task.id,PROJECT,{runId:other.task.runId});
  await assert.rejects(client.request(route),e=>e.code==='CHAT_SQL_DEVELOPMENT_UNCONFIRMED');
  // Legacy tasks without a top-level runId can still prove their final saved attempt.
  app.store.update('agent',task.id,PROJECT,{runId:undefined});
  assert.deepEqual(await client.request(route),evidence);
  app.store.update('revision',task.revisionId,PROJECT,{sql:alternate.sql});
  await assert.rejects(client.request(route),e=>e.code==='CHAT_SQL_DEVELOPMENT_UNCONFIRMED');
  assert.deepEqual(counters,{intent:2,sql:3,spark:3});
  t.diagnostic(JSON.stringify({realSpark,attempts:evidence.attempts.map(a=>a.status),checks:evidence.validation.regressions.length,...counters}));
});
