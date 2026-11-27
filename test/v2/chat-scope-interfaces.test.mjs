import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import test from 'node:test';
import { runV2Cli } from '../../bin/shuduo.mjs';
import { handleV2Mcp } from '../../bin/shuduo-mcp.mjs';
import { validationFamilyForContext } from '../../src/v2/context.mjs';
import { submitChatScopeChange } from '../../src/v2/agent-derivation-client.mjs';

test('CLI and MCP recover one reviewed chat scope change after its acknowledgement is lost',async()=>{
  const intentId=randomUUID(), taskId=randomUUID(), revisionId=randomUUID(), runId=randomUUID();
  const sql='SELECT 1 AS fixture_total', revisionHash=createHash('sha256').update(sql).digest('hex');
  const requestId='chat-derive-v1-'+'a'.repeat(64), contextId='stock-cash-t1', message='只统计股票持仓与现金';
  const binding={intentId,taskId,revisionId,runId,revisionHash,contextId:'holdings-t1'};
  const source={id:binding.contextId,name:'全部登记持仓与现金',definition:'按客户核验'};
  const targets=[{id:contextId,name:'股票持仓加现金',definition:'只统计股票持仓和现金',recommended:true}];
  const changes=[],calls=[];
  const snapshot=()=>({protocol:'shuduo-chat-sql-changes/v1',binding,source,eligible:true,targets,
    nextRequestId:changes.length?null:requestId,changes:structuredClone(changes)});
  const review={intentId,sourceRunId:runId,requestId,contextId,message,confirm:true};
  const lookup='/agent/intents/'+intentId+'/development/changes';
  let lose=true;
  const client={async request(path,options={}){
    calls.push([path,options.method??'GET']);
    if(path===lookup) return snapshot();
    if(path==='/revisions/'+revisionId) return {id:revisionId,contextId:binding.contextId,hash:revisionHash,sql};
    assert.equal(path,'/agent/tasks');
    assert.equal(options.method,'POST');
    assert.equal(options.idempotencyKey,requestId);
    const derivation={kind:'REGISTERED_CONTEXT_CHANGE',taskId,revisionId,runId,revisionHash};
    assert.deepEqual(options.body,{message,sql,contextId,language:'SPARK_SQL',derivation,chatChange:{intentId}});
    const id=randomUUID();
    changes.push({taskId:id,requestId,contextId,message,status:'RUNNING'});
    if(lose) throw Error('SYNTHETIC_LOST_RESPONSE');
    return {id,version:1,message,language:'SPARK_SQL',initialSql:sql,contextId,status:'RUNNING',attempts:[],
      derivedFrom:{...derivation,contextId:source.id,validationContractId:validationFamilyForContext(source.id).id}};
  }};
  const mcp=async(name,args)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client}));
  let output;
  const cli=argv=>runV2Cli(argv,{},{client,output:value=>{output=JSON.parse(value);},error:()=>{}});
  assert.equal(await cli(['agent','chat-changes','--id',intentId]),0);
  assert.deepEqual(output,snapshot());
  assert.deepEqual((await mcp('agent_chat_scope_changes',{intentId})).result.structuredContent,snapshot());
  await assert.rejects(submitChatScopeChange(client,{...review,confirm:false}));
  await assert.rejects(submitChatScopeChange(client,{...review,contextId:'unknown-context'}));
  await assert.rejects(submitChatScopeChange(client,{...review,sourceRunId:randomUUID()}));
  const command=['agent','change-chat-scope','--id',intentId,'--source-run-id',runId,'--context',contextId,'--message',message,'--request-id',requestId,'--confirm'];
  assert.equal(await cli(command),0);
  assert.deepEqual(output,changes[0]);
  const written=calls.filter(([,method])=>method==='POST').length;
  assert.equal(written,1);
  assert.equal(await cli(command),0);
  assert.deepEqual(output,changes[0]);
  assert.deepEqual((await mcp('agent_change_chat_scope',review)).result.structuredContent,output);
  await assert.rejects(submitChatScopeChange(client,{...review,message:'另一份修改需求'}));
  assert.equal(calls.filter(([,method])=>method==='POST').length,written);
  // A new isolated caller that receives the acknowledgement can also read back
  // the same result through the original conversation.
  lose=false; changes.length=0;
  assert.deepEqual(await submitChatScopeChange(client,review),changes[0]);
});
