import test from 'node:test';
import assert from 'node:assert/strict';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {callServicePlan} from '../../src/v2/service-plan-client.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,source={taskId:id(1),packageDigest:'a'.repeat(64),releaseId:id(2),sourceReleaseRunId:id(3)};
const request={message:'规划当前发布批次的持仓查询接口',sourceBinding:source,requestId:id(5)},
 plan={id:id(4),...request,status:'SUCCEEDED',scope:'LOCAL_TEST_ONLY',completionScope:'DATA_SERVICE_DESIGN',fullLifecycleE2E:false,agentIndependentE2E:false,publicDeployed:false,
  proposal:{serviceType:'DAPI',name:'合成同源查询',slug:'plan-client-test',sourceReleaseRunId:id(3),fields:['client_id','holding_market_value'],timeoutMs:1500,rateLimitPerMinute:60}},
 service={id:id(6),name:plan.proposal.name,slug:plan.proposal.slug,serviceType:'DAPI',status:'DRAFT',currentVersion:{id:id(7),scope:'LOCAL_TEST_ONLY',configHash:'c'.repeat(64),
  sourceReleaseRunId:id(3),sourceReleaseId:id(2),sourcePackageDigest:source.packageDigest,fields:plan.proposal.fields,timeoutMs:1500,rateLimitPerMinute:60}};
const flags=['--task-id',id(1),'--package-digest',source.packageDigest,'--release-id',id(2),'--source-run-id',id(3)];
function transport(kind='cli',override){const seen=[],client=new V2Client({client:kind,baseUrl:'https://synthetic.invalid/api/v2',fetchImpl:async(url,options)=>{
 seen.push({url,method:options.method,headers:options.headers,body:options.body&&JSON.parse(options.body)});
 if(override)return override(url,options);
 const path=new URL(url).pathname;return new Response(JSON.stringify(path.endsWith('/apply')?service:path.endsWith('/cancel')?{...plan,status:'CANCELLED'}:
  options.method==='GET'&&path.endsWith('/plans')?[plan]:plan),{status:200});}});return {seen,client};}
const cli=(f,args)=>runV2Cli(args,{}, {client:f.client,output:()=>{},error:()=>{}}),
 mcp=(f,name,args)=>handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:f.client}).then(JSON.parse);
test('CLI and MCP create the same source-bound request with an explicit original identifier and no actor override',async()=>{
 for(const kind of ['cli','mcp']){
  const f=transport(kind);if(kind==='cli')assert.equal(await cli(f,['services','plan',...flags,'--message',request.message,'--request-id',id(5)]),0);
  else assert.equal((await mcp(f,'service_agent_plan_create',request)).error,undefined);
  assert.equal(f.seen.length,1);assert.equal(f.seen[0].method,'POST');assert.equal(f.seen[0].headers['Idempotency-Key'],id(5));assert.equal(f.seen[0].headers['X-Actor-Id'],undefined);
  assert.deepEqual(f.seen[0].body,{message:request.message,sourceBinding:source});
 }
});
test('uniform tools list exact sources, read by original ids, apply one plan and cancel without source-proof reads',async()=>{
 const f=transport('mcp');
 assert.equal((await mcp(f,'service_agent_plan_list',{sourceBinding:source})).error,undefined);assert.equal(new URL(f.seen[0].url).searchParams.get('source_release_run_id'),id(3));
 assert.equal((await mcp(f,'service_agent_plan_detail',{planId:id(4)})).error,undefined);assert.equal((await mcp(f,'service_agent_plan_request',{requestId:id(5)})).error,undefined);
 const before=f.seen.length;assert.equal((await mcp(f,'service_agent_plan_apply',{planId:id(4)})).error,undefined);assert.deepEqual(f.seen.slice(before).map(call=>call.method),['GET','POST']);
 const count=f.seen.length;assert.equal((await mcp(f,'service_agent_plan_cancel',{planId:id(4)})).error,undefined);assert.equal(f.seen.length,count+1);assert.deepEqual(f.seen.at(-1).body,{sourceBoundOnly:true});
});
test('unknown or malformed mutation replies keep their original identity and never cause automatic retries',async()=>{
 const failure=transport('cli',()=>{throw Error('synthetic transport unknown');});await assert.rejects(callServicePlan(failure.client,'create',request));assert.equal(failure.seen.length,1);
 for(const value of [{},{...plan,requestId:id(9)},{...plan,sourceBinding:{...source,releaseId:id(8)}}]){
  const f=transport('cli',()=>new Response(JSON.stringify(value)));await assert.rejects(callServicePlan(f.client,'create',request),error=>error.message.includes(id(5)));assert.equal(f.seen.length,1);
 }
 const badApply=transport('cli',(url)=>new Response(JSON.stringify(url.endsWith('/apply')?{}:plan)));
 await assert.rejects(callServicePlan(badApply.client,'apply',{planId:id(4)}),/草稿回执尚未/);assert.equal(badApply.seen.length,2);
 const pending=transport('cli',()=>new Response(JSON.stringify({...plan,status:'RUNNING',proposal:undefined})));
 await assert.rejects(callServicePlan(pending.client,'apply',{planId:id(4)}),/尚未核验/);assert.equal(pending.seen.length,1);
 const unavailable=transport('cli',()=>new Response(JSON.stringify({...plan,sourceCheck:'UNAVAILABLE'})));
 assert.equal((await callServicePlan(unavailable.client,'request',{requestId:id(5)})).id,id(4));
 await assert.rejects(callServicePlan(unavailable.client,'apply',{planId:id(4)}),/当前未通过复核/);assert.equal(unavailable.seen.every(call=>call.method==='GET'),true);
});
test('CLI duplicates and raw MCP source/actor injection are rejected before any network request',async()=>{
 const f=transport();
 for(const args of [['services','plan',...flags,'--message',request.message,'--request-id',id(5),'--actor-id','other'],
  ['services','plans',...flags,'--release-id',id(2)],['services','apply-plan','--id',id(4),'--source-run-id',id(3)]])assert.equal(await cli(f,args),1);
 for(const [name,args] of [['service_agent_plan_create',{...request,actorId:'other'}],['service_agent_plan_create',{...request,sourceBinding:{...source,rows:[]}}],
  ['service_agent_plan_apply',{planId:id(4),fields:['client_id']}],['service_agent_plan_cancel',{planId:'unsafe/path'}]])assert.ok((await mcp(f,name,args)).error);
 assert.equal(f.seen.length,0);
 const listing=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/list'}));
 assert.equal(listing.result.tools.find(tool=>tool.name==='service_agent_plan_request').annotations.readOnlyHint,true);
 assert.equal(listing.result.tools.find(tool=>tool.name==='service_agent_plan_create').inputSchema.properties.sourceBinding.additionalProperties,false);
});
