import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {readInvitedSqlContext} from '../../src/v2/invited-sql-context-client.mjs';

function savedContext() {
  const taskId=randomUUID(),requestId='original-invited-request',sql='SELECT 1 AS fixture_result';
  const revision={id:randomUUID(),hash:createHash('sha256').update(sql).digest('hex'),sql};
  const receipt={protocol:'shuduo-invited-sql-context/v1',scope:'INVITED_TASK_READ_ONLY',readOnly:true,fullLifecycleE2E:false,
    taskId,requestId,contextId:'holdings-t1',message:'从本次虚构持仓生成客户资产报告',taskStatus:'SUCCEEDED',taskStage:'SUCCEEDED',attemptCount:1,
    evidenceState:'RECORDED',evidenceSource:'TEST_HARNESS',revision,
    run:{id:randomUUID(),revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',
      validation:{state:'UNCONFIRMED',contractId:'fixture-contract',regressions:[{contextId:'holdings-t1',passed:true}]}}};
  return {taskId,requestId,receipt};
}

test('CLI and MCP use one owner-scoped GET to read a previously created native task',async()=>{
  const {taskId,requestId,receipt}=savedContext(),reads=[];
  const client={request:async(path,options)=>{assert.equal(options,undefined);reads.push(path);return receipt;}};
  let result;
  assert.equal(await runV2Cli(['agent','invited-task-context','--id',taskId,'--request-id',requestId],{},
    {client,output:v=>{result=JSON.parse(v);},error:()=>{}}),0);
  assert.deepEqual(result,receipt);
  const rpc=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{
    name:'agent_invited_task_context',arguments:{taskId,requestId}}},{client}));
  assert.deepEqual(rpc.result.structuredContent,receipt);
  assert.deepEqual(reads,Array(2).fill('/agent/tasks/'+taskId+'/chat-context?request_id='+requestId));
  await assert.rejects(readInvitedSqlContext(client,{taskId:'latest'}));
  await assert.rejects(readInvitedSqlContext(client,{taskId,requestId:'unsafe/selector'}));
  assert.equal(reads.length,2);
});

test('wrong request, changed SQL bytes, a foreign run, extra fields and a synthetic pass are rejected',async()=>{
  const {taskId,requestId,receipt}=savedContext();
  for (const change of [
    r=>{r.taskId=randomUUID();},r=>{r.requestId='other';},r=>{r.revision.sql+=' ';},r=>{r.run.revisionId=randomUUID();},
    r=>{r.run.validation.state='PASSED';},r=>{r.run.rows=[];},r=>{r.submittedBy='other-user';},
  ]){
    const altered=structuredClone(receipt);change(altered);
    await assert.rejects(readInvitedSqlContext({request:async()=>altered},{taskId,requestId}));
  }
  const pending={...receipt,taskStatus:'QUEUED',taskStage:'READY_FOR_MODEL',attemptCount:0,evidenceState:'PENDING'};
  delete pending.requestId;delete pending.revision;delete pending.run;
  assert.deepEqual(await readInvitedSqlContext({request:async()=>pending},{taskId}),pending);
});
