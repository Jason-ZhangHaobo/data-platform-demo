import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {createContextDerivedTask} from '../../src/v2/agent-derivation-client.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sql='SELECT client_id FROM accounts\n';
const derivation={kind:'REGISTERED_CONTEXT_CHANGE',taskId:id(1),revisionId:id(2),runId:id(3),revisionHash:createHash('sha256').update(sql).digest('hex')};
const input={derivation,contextId:'stock-cash-t1',message:'改为股票持仓加可用现金，并保留仅有现金客户',requestId:id(4),confirm:true};
const flags=['--task-id',id(1),'--revision-id',id(2),'--run-id',id(3),'--revision-hash',derivation.revisionHash,'--context',input.contextId,'--message',input.message,'--request-id',id(4),'--confirm'];
function transport({kind='cli',patch={},failure,receipt}={}){
 const seen=[],revision={id:id(2),hash:derivation.revisionHash,sql,contextId:'holdings-t1',...patch};
 const client=new V2Client({client:kind,baseUrl:'https://synthetic.invalid/api/v2',fetchImpl:async(url,options)=>{
  seen.push({url,method:options.method,headers:options.headers,body:options.body&&JSON.parse(options.body)});
  if(failure===options.method)throw Error('synthetic transport outcome unknown');
  return new Response(JSON.stringify(options.method==='GET'?revision:receipt??{id:id(5),status:'QUEUED',version:1,message:input.message,initialSql:sql,attempts:[],language:'SPARK_SQL',contextId:input.contextId,
   derivedFrom:{...derivation,contextId:'holdings-t1',validationContractId:'securities-assets-five-fixtures-2026-09-14'}}),{status:200,headers:{'content-type':'application/json'}});
 }});return {client,seen};
}
const cli=(f,args=['agent','derive',...flags])=>runV2Cli(args,{}, {client:f.client,output:()=>{},error:()=>{}});
const mcp=(f,args=input)=>handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_context_derive',arguments:args}},{client:f.client}).then(JSON.parse);

test('CLI and MCP read the exact source then send one same-API request with original SQL bytes and stable idempotency',async()=>{
 for(const kind of ['cli','mcp']){
  const f=transport({kind});if(kind==='cli')assert.equal(await cli(f),0);else assert.equal((await mcp(f)).error,undefined);
  assert.equal(f.seen.length,2);assert.equal(f.seen[0].method,'GET');assert.equal(f.seen[0].url,`https://synthetic.invalid/api/v2/revisions/${id(2)}`);
  assert.equal(f.seen[1].url,'https://synthetic.invalid/api/v2/agent/tasks');assert.equal(f.seen[1].method,'POST');
  assert.deepEqual(f.seen[1].body,{message:input.message,sql,contextId:input.contextId,language:'SPARK_SQL',derivation});
  assert.equal(f.seen[1].headers['Idempotency-Key'],id(4));assert.equal(f.seen[1].headers['X-Shuduo-Client'],kind);
  assert.equal(f.seen[1].headers['X-Actor-Id'],undefined);assert.equal(f.seen[1].body.sourceRunId,undefined);
 }
});

test('derivation clients reject malformed source, missing intent, actor injection and duplicate CLI flags before transport',async()=>{
 const f=transport();
 for(const value of [{...input,confirm:false},{...input,requestId:'changed/unsafe'},{...input,actorId:'another-user'},
  {...input,derivation:{...derivation,revisionHash:'a'.repeat(63)}},{...input,derivation:{...derivation,sourceRunId:id(8)}},{...input,contextId:'unsafe/context'},
  {...input,derivation:{...derivation,kind:'FAILED_REPAIR'}}])assert.ok((await mcp(f,value)).error);
 for(const args of [['agent','derive',...flags,'--confirm'],['agent','derive',...flags,'--actor-id','another-user'],['agent','derive',...flags.slice(0,-1)],
  ['agent','derive',...flags,'--source-run-id',id(8)],['agent','derive','extra',...flags]])assert.equal(await cli(f,args),1);
 assert.equal(f.seen.length,0);
});

test('immutable code mismatch or same target prevents POST; unknown read/write outcomes are not retried',async()=>{
 for(const patch of [{id:id(8)},{sql:'SELECT 0'},{hash:'a'.repeat(64)},{contextId:input.contextId}]){
  const f=transport({patch});await assert.rejects(createContextDerivedTask(f.client,input));assert.equal(f.seen.length,1);assert.equal(f.seen[0].method,'GET');
 }
 for(const failure of ['GET','POST']){const f=transport({failure});await assert.rejects(createContextDerivedTask(f.client,input));assert.equal(f.seen.length,failure==='GET'?1:2);}
});

test('MCP exposes strict context derivation contract without pretending source-read is the new task approval',async()=>{
 const listing=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/list'})),tool=listing.result.tools.find(value=>value.name==='agent_context_derive');
 assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.inputSchema.properties.derivation.additionalProperties,false);
 assert.deepEqual(tool.inputSchema.properties.derivation.required,['kind','taskId','revisionId','runId','revisionHash']);
 assert.deepEqual(tool.inputSchema.properties.confirm,{const:true});assert.ok(tool.inputSchema.required.includes('requestId'));
 assert.notEqual(tool.annotations?.readOnlyHint,true);
});

test('HTTP 200 without the exact new task receipt remains unknown and retains the original request id without extra calls',async()=>{
 const valid={id:id(5),status:'RUNNING',version:2,message:input.message,initialSql:sql,attempts:[],language:'SPARK_SQL',contextId:input.contextId,
  derivedFrom:{...derivation,contextId:'holdings-t1',validationContractId:'securities-assets-five-fixtures-2026-09-14'}};
 for(const receipt of [{},{...valid,id:derivation.taskId},{...valid,contextId:'holdings-t1'},{...valid,sql:123},{...valid,initialSql:'SELECT wrong'},{...valid,derivedFrom:{...valid.derivedFrom,runId:id(8)}},
  {...valid,derivedFrom:{...valid.derivedFrom,contextId:'stock-cash-t1'}},{...valid,derivedFrom:{...valid.derivedFrom,approvalId:'copied'}}]){
  const f=transport({receipt});await assert.rejects(createContextDerivedTask(f.client,input),error=>error.message.includes(id(4))&&error.message.includes('尚未确认'));
  assert.deepEqual(f.seen.map(value=>value.method),['GET','POST']);
 }
 const running=transport({receipt:valid});assert.equal((await createContextDerivedTask(running.client,input)).status,'RUNNING');
});
