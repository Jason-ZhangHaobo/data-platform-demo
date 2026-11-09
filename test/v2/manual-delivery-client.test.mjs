import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assistedDeliveryFixture} from './fixtures/assisted-sql-delivery.mjs';
import {manualCloudDeliverySource,publicDeliveryTask} from '../../src/v2/agent-development-workflow.mjs';
import {readManualDeliveryWorkflow,prepareManualDelivery} from '../../src/v2/manual-delivery-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

async function setup(t){
 const f=await assistedDeliveryFixture();t.after(f.dispose);const seen=[];let lost=false,wrong=false;
 const client={request:async(path,options)=>{seen.push({path,...options});
  if(path===`/runs/${f.run.id}/workflow`){const {report}=manualCloudDeliverySource({...f.options,...f.input}),delivery=f.store.list('agent_delivery_task',f.project)[0];return{report:{...report,...(wrong?{taskId:randomUUID()}:{})},delivery:publicDeliveryTask(delivery),publication:{scope:'PRIVATE_CLOUD_TEST',sourceKind:'MANUAL',sourceRunId:f.run.id,agentIndependentE2E:false}};}
  if(path===`/runs/${f.run.id}/prepare-delivery`){const result=await f.delivery.createManual({...f.input,key:options.idempotencyKey});if(lost){lost=false;throw Error('synthetic response unknown');}return result;}
  throw Error('unexpected native path');
 }};
 return{...f,client,seen,lose:()=>lost=true,wrong:()=>wrong=true};
}
test('CLI and MCP explicitly select manual source and use one shared API with stable request IDs',async t=>{
 const f=await setup(t),input={taskId:f.agent.id,sourceRunId:f.run.id,sourceKind:'MANUAL',requestId:randomUUID(),confirm:true};let output;
 const args=['agent','prepare-delivery','--id',input.taskId,'--source-kind','MANUAL','--source-run-id',input.sourceRunId,'--request-id',input.requestId,'--confirm'];
 assert.equal(await runV2Cli(args,{}, {client:f.client,output:v=>output=JSON.parse(v),error:()=>{}}),0);assert.equal(output.sourceKind,'MANUAL');
 const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_delivery_prepare',arguments:input}},{client:f.client}));assert.equal(reply.error,undefined);
 assert.equal(JSON.parse(reply.result.content[0].text).id,output.id);assert.deepEqual(f.seen.filter(v=>v.method==='POST').map(v=>v.idempotencyKey),[input.requestId,input.requestId]);
 assert.equal(f.counts.submits,1);assert.equal(f.store.list('delivery_package',f.project).length,1);
 assert.equal((await readManualDeliveryWorkflow(f.client,{taskId:input.taskId,sourceRunId:input.sourceRunId})).report.developmentReference.evidenceDigest,f.basis.binding.evidenceDigest);
});
test('missing intent, wrong source receipt, duplicate flags or actor injection cannot prepare a package',async t=>{
 const f=await setup(t),base={taskId:f.agent.id,sourceRunId:f.run.id,sourceKind:'MANUAL',requestId:randomUUID(),confirm:true},args=['agent','prepare-delivery','--id',base.taskId,'--source-kind','MANUAL','--source-run-id',base.sourceRunId,'--request-id',base.requestId,'--confirm'];
 for(const argv of [[...args,'--confirm'],[...args,'--actor-id','foreign'],args.filter(v=>v!=='--confirm'),['agent','prepare-delivery','--id',base.taskId,'--source-kind','WRONG']])assert.equal(await runV2Cli(argv,{}, {client:f.client,output:()=>{},error:()=>{}}),1);
 for(const input of [{...base,confirm:false},{...base,actorId:'foreign'},{...base,sourceKind:'AGENT'},{taskId:base.taskId,sourceKind:'MANUAL'}]){
  const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_delivery_prepare',arguments:input}},{client:f.client}));assert(reply.error);
 }
 assert.equal(f.seen.length,0);f.wrong();await assert.rejects(prepareManualDelivery(f.client,base));assert.equal(f.seen.length,1);assert.equal(f.counts.puts,0);
});
test('unknown write acknowledgement is not automatically retried, and same request recovers one immutable package',async t=>{
 const f=await setup(t),input={taskId:f.agent.id,sourceRunId:f.run.id,requestId:randomUUID(),confirm:true};f.lose();await assert.rejects(prepareManualDelivery(f.client,input));
 assert.equal(f.seen.filter(v=>v.method==='POST').length,1);assert.equal(f.store.list('agent_delivery_task',f.project).length,1);
 const read=await readManualDeliveryWorkflow(f.client,{taskId:input.taskId,sourceRunId:input.sourceRunId}),again=await prepareManualDelivery(f.client,input);assert.equal(again.id,read.delivery.id);
 assert.equal(f.store.list('delivery_package',f.project).length,1);assert.equal(f.counts.submits,1);
});
