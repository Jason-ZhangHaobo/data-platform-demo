import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createV2Server} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {modelFailure} from '../../src/v2/model-diagnostics.mjs';

for (const sent of [true,false]) test(`local model failure preserves diagnosis and ${sent?'reserves uncertain usage':'records no provider usage before sending'}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-local-model-failure-'));
 const store=new MetadataStore(join(root,'platform.sqlite'));
 let calls=0,runs=0;
 const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'},generator:async()=>{
  calls++;
  const error=modelFailure(sent?'MODEL_TRANSPORT_ERROR':'MODEL_CONFIG_INVALID',sent?'REQUEST':'PREPARE',{networkCode:'ECONNRESET',elapsedMs:12});
  error.privateProviderBody='synthetic-secret-never-persist';
  throw error;
 },runner:async()=>{runs++;throw Error('no computation expected');}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 try {
  const body={message:'虚构证券客户资产加工',sql:'SELECT client_id FROM accounts',contextId:'holdings-t1'};
  const post=()=>fetch(base+'/agent/tasks',{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':'same-request'},body:JSON.stringify(body)});
  const response=await post();assert.equal(response.status,202);
  const created=await response.json();
  let task;
  for(let i=0;i<50;i++){
   task=await (await fetch(base+`/agent/tasks/${created.id}`)).json();
   if(task.status==='FAILED')break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(task.status,'FAILED');assert.equal(task.attempts.length,1);
  assert.equal(task.attempts[0].diagnostic.requestMayHaveBeenSent,sent);
  assert.equal(task.attempts[0].diagnostic.code,sent?'MODEL_TRANSPORT_ERROR':'MODEL_CONFIG_INVALID');
  assert.equal(task.usedTokens,sent?32000:0);
  assert.equal(JSON.stringify(task).includes('synthetic-secret-never-persist'),false);
  assert.equal((await (await post()).json()).id,created.id);
  assert.equal((await (await fetch(base+'/agent/requests/same-request')).json()).id,created.id);
  const budget=await (await fetch(base+'/budget')).json();
  assert.equal(budget.model.recordedCalls,sent?1:0);
  assert.equal(budget.model.estimatedCostCny,sent?0.256:0);
  assert.equal(calls,1);assert.equal(runs,0);
 }finally{await new Promise(resolve=>app.server.close(resolve));store.close();}
});
