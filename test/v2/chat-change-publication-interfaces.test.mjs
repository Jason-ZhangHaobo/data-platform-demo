import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {readChatChangePublication,publishChatChange,reviewedChatChangeInput} from '../../src/v2/chat-change-publication-client.mjs';

test('the CLI and MCP request a short-lived consumer grant only when selected',async()=>{
  const grants=[];
  const client={request:async(path,options)=>{
    assert.equal(path,'/data-services/applications');assert.equal(options.method,'POST');
    grants.push(options.body);return {tokenShownOnce:false};
  }};
  const cli=flags=>runV2Cli(['apps','create','--name','虚构测试方','--service-ids','a,b',...flags],{},
    {client,output:()=>{},error:()=>{}});
  assert.equal(await cli([]),0);
  assert.equal(await cli(['--ttl-seconds','300']),0);
  assert.equal(await cli(['--ttl-seconds','3601']),1);
  const grant={name:'虚构测试方',serviceIds:['a','b']};
  const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',
    params:{name:'service_application_create',arguments:{...grant,ttlSeconds:300}}},{client}));
  assert.equal(reply.error,undefined);
  assert.deepEqual(grants,[grant,{...grant,ttlSeconds:300},{...grant,ttlSeconds:300}]);
});

test('explicit CLI review, MCP publication and read-only monitoring share a single frozen publication',async t=>{
  const ref=contextId=>({taskId:randomUUID(),contextId,runId:randomUUID(),revisionId:randomUUID(),revisionHash:'c'.repeat(64)});
  const base={protocol:'shuduo-chat-change-publication/v1',scope:'LOCAL_TEST_RELEASE',publicDeployed:false,
    intentId:randomUUID(),changeRequestId:'chat-derive-v1-'+'a'.repeat(64),requestId:randomUUID(),reviewDigest:'3'.repeat(64),
    parent:ref('holdings-t1'),source:ref('stock-cash-t1'),packageId:randomUUID(),packageDigest:'2'.repeat(64),verificationId:randomUUID(),
    phase:'READY',canPublish:true,monitoringVerified:false,businessDate:'2026-09-10',scheduleSpec:{triggerAfterSeconds:5,intervalSeconds:30,runCount:2},
    runs:[],events:[],alerts:[]};
  const select={intentId:base.intentId,changeRequestId:base.changeRequestId};
  const confirmed={code:true,assertions:true,deliveryFiles:true,localScope:true};
  const input=reviewedChatChangeInput(base,confirmed,true);
  const directory=mkdtempSync(join(tmpdir(),'shuduo-chat-publication-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=join(directory,'preflight.json');writeFileSync(file,JSON.stringify(base));
  const command=['agent','publish-chat-change','--review-file',file,'--attest-code','--attest-assertions','--attest-delivery-files','--attest-local-scope','--confirm'];
  let snapshot=structuredClone(base),writes=0;
  const client={async request(path,options={}){
    assert.equal(path,'/agent/intents/'+base.intentId+'/development/changes/'+base.changeRequestId+'/publication');
    if (!options.method) return structuredClone(snapshot);
    writes++;
    assert.equal(options.method,'POST');assert.equal(options.idempotencyKey,base.requestId);
    assert.deepEqual(options.body,{source:base.source,packageId:base.packageId,packageDigest:base.packageDigest,verificationId:base.verificationId,
      reviewDigest:base.reviewDigest,attestations:confirmed,confirm:true});
    snapshot={...snapshot,phase:'PUBLISHED',reviewId:randomUUID(),reviewActorScope:'LOCAL_DEVELOPER',approvalId:randomUUID(),release:{id:randomUUID(),status:'ACTIVE_LOCAL',health:'PENDING'},
      runs:['09:00:05','09:00:35'].map((stamp,i)=>({id:randomUUID(),sequence:i+1,status:'SCHEDULED',schedulerTriggered:false,scheduledTriggerAt:'2026-09-11T'+stamp+'+08:00'}))};
    throw Error('SYNTHETIC_ACK_LOST');
  }};
  let result;
  const cli=argv=>runV2Cli(argv,{},{client,output:value=>{result=JSON.parse(value);},error:()=>{}});
  assert.equal(await cli(command.filter(flag=>flag!=='--attest-assertions')),1);
  assert.equal(await cli([...command,'--attest-code']),1);
  assert.equal(await cli([...command,'--actor','someone-else']),1);
  await assert.rejects(publishChatChange(client,{...input,verificationId:randomUUID()}));
  snapshot.canPublish=false;
  await assert.rejects(publishChatChange(client,input));
  snapshot.canPublish=true;
  assert.equal(writes,0);
  assert.equal(await cli(command),0);
  assert.deepEqual(result,snapshot);assert.equal(writes,1);
  const rpc=async(name,args)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client}));
  const {expectedSource,expectedParent,...wire}=input;
  assert.deepEqual((await rpc('agent_publish_chat_change',wire)).result.structuredContent,snapshot);
  assert.equal(writes,1);
  for (const run of snapshot.runs) {
    Object.assign(run,{status:'SUCCEEDED',schedulerTriggered:true,triggeredAt:run.scheduledTriggerAt,finishedAt:run.scheduledTriggerAt,
      engine:'Apache Spark',engineVersion:'3.5.9',testSqlPassed:true,assertionCount:5,rowCount:2,totalAssets:'2250.00'});
    snapshot.events.push({id:randomUUID(),type:'BATCH_SUCCEEDED',releaseRunId:run.id,observedAt:run.finishedAt,status:'SUCCEEDED'});
  }
  snapshot.monitoringVerified=true;snapshot.release.health='HEALTHY';
  assert.deepEqual((await rpc('agent_chat_change_publication',select)).result.structuredContent,snapshot);
  assert.equal(await cli(['agent','chat-publication','--id',base.intentId,'--change-request-id',base.changeRequestId]),0);
  assert.deepEqual(result,snapshot);
  for (const alter of [s=>s.events.pop(),s=>{s.runs[0].schedulerTriggered=false;},s=>{s.scope='PRODUCTION';},
    s=>{s.runs[1].id=s.runs[0].id;},s=>{s.runs[0].totalAssets=null;},s=>{s.alerts.push({id:randomUUID(),status:'OPEN'});}]) {
    const invalid=structuredClone(snapshot);alter(invalid);
    await assert.rejects(readChatChangePublication({request:async()=>invalid},select));
  }
  assert.equal(writes,1);
});
