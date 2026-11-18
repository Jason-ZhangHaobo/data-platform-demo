import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverManualRun} from '../../web/src/manual-run-confirmation.ts';
import {manualRunLocation} from '../../web/src/manual-run-recovery.ts';

const revisionId='11111111-1111-4111-8111-111111111111',key='22222222-2222-4222-8222-222222222222';
const originTaskId='33333333-3333-4333-8333-333333333333',runId='44444444-4444-4444-8444-444444444444';
const pending=Object.freeze({revisionId,key});
const saved={id:revisionId,sql:'SELECT client_id FROM accounts',contextId:'stock-cash-t1',source:'MANUAL',
  manualProvenance:{kind:'ENGINEER_EDIT',originAgentTaskId:originTaskId,agentIndependentE2E:false}};
const href=manualRunLocation('http://127.0.0.1/v2/?module=agent-center',{revisionId,requestKey:key,originTaskId}).href;
const run={id:runId,revisionId};

test('a recovery action waits for its source receipt then submits only the original revision and key',async()=>{
  const gate=Promise.withResolvers(),calls=[];
  const result=recoverManualRun(pending,{href,isCurrent:()=>true,
    readRevision:async id=>{calls.push(['read',id]);return gate.promise;},
    acceptRevision:(version,origin)=>calls.push(['accepted',version.id,origin]),
    submitRun:async(id,key)=>{calls.push(['submit',id,key]);return run;}});
  assert.deepEqual(calls,[['read',revisionId]]);
  gate.resolve(saved);
  const restored=await result;
  assert.equal(restored.originTaskId,originTaskId);
  assert.deepEqual(calls,[['read',revisionId],['accepted',revisionId,originTaskId],['submit',revisionId,key]]);
  assert.deepEqual(pending,{revisionId,key});
});

test('wrong revision, source, attribution or origin stops before a recovery POST',async t=>{
  for(const mutate of [
    value=>({...value,id:runId}),value=>({...value,source:'LIVE_MODEL'}),
    value=>({...value,manualProvenance:undefined}),
    value=>({...value,manualProvenance:{...value.manualProvenance,agentIndependentE2E:true}}),
    value=>({...value,manualProvenance:{...value.manualProvenance,originAgentTaskId:runId}}),
  ])await t.test('unverified saved source',async()=>{
    let posts=0;
    await assert.rejects(recoverManualRun(pending,{href,isCurrent:()=>true,readRevision:async()=>mutate(saved),submitRun:async()=>{posts++;return run;}}));
    assert.equal(posts,0);
  });
});

test('changed original request identifiers are rejected before any I/O',async()=>{
  let calls=0;
  const wrong=manualRunLocation(href,{revisionId,requestKey:runId,originTaskId}).href;
  await assert.rejects(recoverManualRun(pending,{href:wrong,isCurrent:()=>true,readRevision:async()=>{calls++;return saved;},submitRun:async()=>{calls++;return run;}}),/原提交编号/);
  assert.equal(calls,0);
});

test('navigation during metadata read cannot submit a stale recovery request',async()=>{
  let current=true,posts=0;
  const result=await recoverManualRun(pending,{href,isCurrent:()=>current,readRevision:async()=>{current=false;return saved;},submitRun:async()=>{posts++;return run;}});
  assert.equal(result,undefined);assert.equal(posts,0);
});

test('navigation after a recovery POST keeps the late receipt from replacing the current view',async()=>{
  let current=true,posts=0;
  const result=await recoverManualRun(pending,{href,isCurrent:()=>current,readRevision:async()=>saved,
    submitRun:async()=>{posts++;current=false;return run;}});
  assert.equal(result,undefined);assert.equal(posts,1);
  assert.deepEqual(pending,{revisionId,key});
});

test('a lost submission response keeps the original request unchanged and never retries automatically',async()=>{
  const calls=[];
  const options={href,isCurrent:()=>true,readRevision:async()=>saved,submitRun:async(id,key)=>{calls.push({id,key});throw Error('synthetic response lost');}};
  await assert.rejects(recoverManualRun(pending,options),/synthetic response lost/);
  assert.equal(calls.length,1);
  await assert.rejects(recoverManualRun(pending,options),/synthetic response lost/);
  assert.deepEqual(calls,[{id:revisionId,key},{id:revisionId,key}]);
});

test('another batch receipt cannot clear the original recovery',async()=>{
  await assert.rejects(recoverManualRun(pending,{href,isCurrent:()=>true,readRevision:async()=>saved,submitRun:async()=>({...run,revisionId:runId})}),/原版本不一致/);
});

test('a standalone manual source does not acquire an Agent origin',async()=>{
  const standalone={...saved,manualProvenance:{kind:'ENGINEER_EDIT',agentIndependentE2E:false}};
  const location=manualRunLocation(href,{revisionId,requestKey:key}).href;
  const result=await recoverManualRun(pending,{href:location,isCurrent:()=>true,readRevision:async()=>standalone,submitRun:async()=>run});
  assert.equal(result.originTaskId,undefined);
});
