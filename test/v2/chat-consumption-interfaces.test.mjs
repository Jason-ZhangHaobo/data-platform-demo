import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {checkedChatChangeConsumption,readChatChangeConsumption} from '../../src/v2/chat-change-consumption-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

function fixture() {
  const ref=contextId=>({taskId:randomUUID(),revisionId:randomUUID(),revisionHash:'a'.repeat(64),runId:randomUUID(),contextId});
  const batchId=randomUUID(),app=randomUUID();
  const makeVersion=(fields,c)=>({serviceId:randomUUID(),versionId:randomUUID(),sourceReleaseRunId:batchId,configHash:c.repeat(64),fields});
  const holdings=makeVersion(['client_id','holding_market_value','security_count'],'b'),cash=makeVersion(['client_id','available_cash','total_assets'],'c');
  const checked=()=>({call:{callIdDigest:'2'.repeat(64),applicationId:app,applicationStatus:'REVOKED',
    finishedAt:'2026-09-10T01:05:00.000Z',resultHash:'3'.repeat(64),rowCount:1},
    pagination:{status:'COMPLETE',applicationId:app,applicationStatus:'REVOKED',pageSize:1,totalPages:2,verifiedPages:[1,2]}});
  const individual=(v,name,slug)=>({serviceId:v.serviceId,serviceType:'DAPI',versionId:v.versionId,configHash:v.configHash,
    name,slug,versionNumber:1,versionStatus:'PUBLISHED',sourceRunIds:[batchId],sourceVersions:[v],fullAssetComposition:false});
  const services=[{...individual(holdings,'虚构持仓','fixture-holdings'),...checked()},individual(cash,'虚构现金','fixture-cash'),
    {serviceId:randomUUID(),serviceType:'XAPI',versionId:randomUUID(),configHash:'d'.repeat(64),name:'虚构组合',slug:'fixture-combination',
      versionNumber:1,versionStatus:'PUBLISHED',sourceRunIds:[batchId],sourceVersions:[holdings,cash],fullAssetComposition:true,...checked()}];
  services[2].call.callIdDigest='4'.repeat(64);
  const value={protocol:'shuduo-chat-batch-consumption/v1',scope:'LOCAL_TEST_ONLY',evidenceScope:'LOCAL_OR_MANUAL_CONSISTENCY_ONLY',
    publicDeployed:false,externalSystemVerified:false,agentIndependentE2E:false,intentId:randomUUID(),changeRequestId:'chat-derive-v1-'+'0'.repeat(64),
    parent:ref('holdings-t1'),source:ref('stock-cash-t1'),packageId:randomUUID(),packageDigest:'e'.repeat(64),verificationId:randomUUID(),releaseId:randomUUID(),
    batch:{id:batchId,sequence:2,rowCount:2,status:'SUCCEEDED'},status:'MATCHED_ONLY',truncated:false,services};
  return {value,select:{intentId:value.intentId,changeRequestId:value.changeRequestId,batchId,releaseId:value.releaseId}};
}

test('CLI and MCP only read the pinned consumption batch, including the uncalled cash query in the composition',async()=>{
  const {value,select}=fixture(),reads=[];
  const client={request:async(url,options)=>{assert.equal(options,undefined);reads.push(url);return value;}};
  let output;
  const cli=['agent','chat-batch-consumption','--id',select.intentId,'--change-request-id',select.changeRequestId,'--batch-id',select.batchId,'--release-id',select.releaseId];
  assert.equal(await runV2Cli(cli,{},{client,output:v=>{output=JSON.parse(v);},error:()=>{}}),0);
  assert.deepEqual(output,value);
  const rpc=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_chat_batch_consumption',arguments:select}},{client}));
  assert.deepEqual(rpc.result.structuredContent,value);
  assert.deepEqual(reads,Array(2).fill('/agent/intents/'+select.intentId+'/development/changes/'+select.changeRequestId+'/publication/batches/'+select.batchId+'/consumption'));
  await assert.rejects(readChatChangeConsumption(client,{...select,batchId:'latest'}));
  assert.equal(reads.length,2);
});

test('ambiguous applications, incomplete pages, mismatched children and stale selections cannot be displayed as matched',()=>{
  const {value,select}=fixture();
  for(const alter of [
    r=>{r.externalSystemVerified=true;},r=>{r.truncated=true;},r=>{r.batch.id=randomUUID();},
    r=>{r.services[1].sourceVersions[0].sourceReleaseRunId=randomUUID();},
    r=>{r.services[0].call.applicationId=r.services[0].pagination.applicationId=randomUUID();},
    r=>{r.services[0].pagination.verifiedPages=[2,2];},r=>{r.services[2].call.applicationStatus='ACTIVE';},
    r=>{r.services[2].sourceVersions[0]={...r.services[2].sourceVersions[0],versionId:randomUUID()};},
    r=>{r.services[2].sourceVersions[0]={...r.services[2].sourceVersions[0],fields:['client_id']};},
  ]){
    const changed=structuredClone(value);alter(changed);assert.throws(()=>checkedChatChangeConsumption(changed,select));
  }
  assert.throws(()=>checkedChatChangeConsumption(value,{...select,sequence:1}));
  assert.throws(()=>checkedChatChangeConsumption(value,{...select,expectedSource:value.parent}));
  assert.equal(checkedChatChangeConsumption({...value,status:'PENDING',services:[]},select).services.length,0);
});
