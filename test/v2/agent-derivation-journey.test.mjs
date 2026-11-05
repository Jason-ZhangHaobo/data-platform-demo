import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalSourceApiFixture,publishLocalAgentFixture} from './fixtures/local-service-api-journey.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {PROJECT} from '../../src/v2/server.mjs';

// Actual HTTP/controller, SQLite and deliverable files; upstream model and
// Spark are synthetic protocol fixtures. This is not live-model acceptance.
test('context derivation survives an unknown CLI response and MCP replay, then creates a separate verified delivery without inheriting approval',async t=>{
 const f=await createLocalSourceApiFixture();t.after(()=>f.dispose());const parent=await publishLocalAgentFixture(f);
 const revision=f.store.get('revision',parent.agent.revisionId,PROJECT),requestId=randomUUID();
 const derivation={kind:'REGISTERED_CONTEXT_CHANGE',taskId:parent.agent.id,revisionId:revision.id,runId:parent.agent.runId,revisionHash:revision.hash};
 const identities=[['agent',parent.agent.id],['revision',revision.id],['run',parent.agent.runId],['delivery_package',parent.bundle.id],['release',parent.release.id],['release_approval',parent.approval.id]];
 const original=identities.map(([kind,id])=>f.store.get(kind,id,PROJECT));
 assert.equal(original.every(Boolean),true);
 const before={...f.counts},calls=[];let lost=false;
 const cliClient=new V2Client({baseUrl:f.base,client:'cli',fetchImpl:async(url,options)=>{
  calls.push({url,method:options.method});const response=await fetch(url,options);
  if(!lost&&options.method==='POST'&&url.endsWith('/agent/tasks')&&response.ok){lost=true;await response.text();throw Error('synthetic lost response after persisted creation');}
  return response;
 }});
 const options={client:cliClient,output:()=>{},error:()=>{}};
 const args=['agent','derive','--task-id',derivation.taskId,'--revision-id',derivation.revisionId,'--run-id',derivation.runId,'--revision-hash',derivation.revisionHash,
  '--context','stock-cash-t1','--message','改为股票持仓加可用现金，不将其表述为客户全资产','--request-id',requestId,'--confirm'];
 assert.equal(await runV2Cli(args,{},options),1);assert.equal(lost,true);assert.equal(calls.filter(value=>value.method==='POST').length,1);
 let restored;assert.equal(await runV2Cli(['agent','request','--request-id',requestId],{}, {...options,output:value=>{restored=JSON.parse(value);}}),0);
 assert.notEqual(restored.id,parent.agent.id);assert.equal(restored.contextId,'stock-cash-t1');
 const result=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_context_derive',arguments:{derivation,contextId:'stock-cash-t1',
  message:'改为股票持仓加可用现金，不将其表述为客户全资产',requestId,confirm:true}}},{client:new V2Client({baseUrl:f.base,client:'mcp'})}));
 assert.equal(result.error,undefined);assert.equal(result.result.structuredContent.id,restored.id);
 const child=await f.poll(`/agent/tasks/${restored.id}`,task=>['SUCCEEDED','FAILED'].includes(task.status));assert.equal(child.status,'SUCCEEDED');
 assert.deepEqual(child.derivedFrom,{...derivation,contextId:'holdings-t1',validationContractId:parent.bundle.manifest.source.validationContractId});
 assert.equal(child.initialSql,revision.sql);assert.notEqual(child.revisionId,revision.id);assert.notEqual(child.runId,parent.agent.runId);
 assert.equal(child.sourceRunId,undefined);assert.equal(child.approvalId,undefined);assert.equal(child.releaseId,undefined);
 assert.equal(f.counts.syntheticModel,before.syntheticModel+1);assert.equal(f.counts.syntheticSpark,before.syntheticSpark+1);assert.equal(child.usedTokens,100);
 const workflow=await f.call(`/agent/tasks/${child.id}/workflow`);assert.equal(workflow.status,200);assert.equal(workflow.body.report.status,'PASSED');
 const actualRun=(await f.call(`/runs/${child.runId}`)).body;
 assert.equal(actualRun.contextId,'stock-cash-t1');assert.equal(actualRun.validation.contractId,'securities-stock-cash-five-fixtures-v1');
 assert.deepEqual(actualRun.rows,[{client_id:'CLIENT-001',holding_market_value:'1000.00',available_cash:'300.00',total_assets:'1300.00',security_count:1},
  {client_id:'CLIENT-002',holding_market_value:'750.00',available_cash:'200.00',total_assets:'950.00',security_count:1}]);
 const prepared=await f.call(`/agent/tasks/${child.id}/prepare-delivery`,{});assert.equal(prepared.status,202);
 const delivery=await f.poll(`/agent/deliveries/${prepared.body.id}`,value=>['SUCCEEDED','FAILED'].includes(value.status));assert.equal(delivery.status,'SUCCEEDED');
 const bundle=(await f.call(`/delivery/packages/${delivery.packageId}`)).body;
 assert.notEqual(bundle.id,parent.bundle.id);assert.notEqual(bundle.digest,parent.bundle.digest);
 assert.equal(bundle.manifest.source.runId,child.runId);assert.equal(bundle.manifest.source.contextId,'stock-cash-t1');
 assert.equal(bundle.manifest.source.validationContractId,'securities-stock-cash-five-fixtures-v1');
 assert.equal(f.store.list('release',PROJECT).length,1,'new derivation does not publish or inherit the old release');
 assert.equal(f.store.list('delivery_review',PROJECT).filter(value=>value.packageId===bundle.id).length,0);
 assert.equal(f.store.list('release_approval',PROJECT).filter(value=>value.packageId===bundle.id).length,0);
 assert.deepEqual(identities.map(([kind,id])=>f.store.get(kind,id,PROJECT)),original);
 assert.equal(f.counts.syntheticModel,before.syntheticModel+1);assert.equal(f.counts.syntheticSpark,before.syntheticSpark+2);
});
