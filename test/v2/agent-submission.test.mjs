import test from 'node:test';
import assert from 'node:assert/strict';
import {agentDevelopmentReadiness,agentSubmissionLocation,agentSubmissionRequest,createAgentSubmission,agentTaskReceiptValid} from '../../web/src/agent-submission.ts';
const key='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
test('local model/Spark readiness does not require the private cloud durable gate',()=>{
 const ready={mode:'LOCAL_DEVELOPMENT',model:{configured:true},spark:{available:true},agentDevelopment:{durableEnabled:false}};
 assert.equal(agentDevelopmentReadiness(ready).ready,true);
 assert.match(agentDevelopmentReadiness({...ready,model:{configured:false}}).reason,/模型尚未配置/);
 assert.equal(agentDevelopmentReadiness({...ready,mode:'PUBLIC_INVITATION'}).ready,false);
 assert.equal(agentDevelopmentReadiness({...ready,mode:'PUBLIC_INVITATION',agentDevelopment:{durableEnabled:true}}).ready,true);
 assert.equal(agentDevelopmentReadiness({...ready,spark:{available:false}}).ready,false);
 assert.equal(agentDevelopmentReadiness().ready,false);
});
test('recovery URLs retain only the opaque request and module, never source or other old identifiers',()=>{
 const url=agentSubmissionLocation(`http://user:PRIVATE_PASSWORD@127.0.0.1:3100/v2/?task=${id}&sql=PRIVATE_SQL&token=PRIVATE_TOKEN#private-fragment`,key);
 assert.deepEqual([...url.searchParams.keys()].sort(),['agent_request','module']);assert.equal(url.hash,'');
 assert.equal(agentSubmissionRequest(url.href),key);assert(!url.href.includes('PRIVATE'));
 assert.equal(agentSubmissionRequest(url.href+'&agent_request='+key),undefined);
 assert.equal(agentSubmissionRequest('http://127.0.0.1/?agent_request=SECRET'),undefined);
 assert.throws(()=>agentSubmissionLocation(url.href,'PRIVATE_SQL'));
});
test('a partial or wrong-language receipt cannot clear the pending recovery marker',()=>{
 const task={id,version:1,message:'原需求',contextId:'holdings-t1',attempts:[]};assert.equal(agentTaskReceiptValid(task),true);
 for(const change of [{version:undefined},{message:undefined},{attempts:undefined},{attempts:[null]},{language:'PYTHON'},{runId:'other/path'}])assert.equal(agentTaskReceiptValid({...task,...change}),false);
});
test('the request key is recorded before POST and pending submissions cannot allocate a second key',async()=>{
 const seen=[],recorded=[],body={message:'虚构证券需求',sql:'ORIGINAL_SQL',contextId:'holdings-t1'};
 const c=createAgentSubmission({makeKey:()=>key,onPending:value=>recorded.push(value),api:async(path,value,options)=>{assert.equal(recorded[0],key);seen.push({path,value,options});throw Error('reply lost');}});
 const submitted=c.submit(body);body.sql='EDITED_SQL';await assert.rejects(submitted,/reply lost/);
 await assert.rejects(c.submit({message:'different'}),/原提交/);assert.equal(seen.length,1);assert.equal(seen[0].value.sql,'ORIGINAL_SQL');
 assert(!JSON.stringify(c.snapshot()).includes('SQL'));assert.equal(c.snapshot().canRetry,true);
});
test('reloading with only the key performs a read and cannot reconstruct or resend source',async()=>{
 const calls=[];const c=createAgentSubmission({initialKey:key,onPending:()=>{},api:async(path,body)=>{calls.push({path,body});return{id};}});
 assert.equal((await c.recover()).id,id);await assert.rejects(c.retry(),/仅可查询/);
 assert.deepEqual(calls,[{path:`/agent/requests/${key}`,body:undefined}]);c.acknowledge(key);assert.equal(c.snapshot().key,undefined);
});
test('explicit retry first reads then reuses the original body and key only after an exact 404',async()=>{
 const calls=[],body={message:'原需求',sql:'ORIGINAL_SQL'};
 const c=createAgentSubmission({makeKey:()=>key,onPending:()=>{},api:async(path,value,options)=>{
  calls.push({path,value,options});if(calls.length===1)throw Error('reply lost');
  if(value===undefined)throw Object.assign(Error('not found'),{status:404});return{id};
 }});
 await assert.rejects(c.submit(body));body.sql='NEW_EDIT';assert.equal((await c.retry()).id,id);
 assert.equal(calls.length,3);assert.equal(calls[1].path,`/agent/requests/${key}`);assert.equal(calls[2].value.sql,'ORIGINAL_SQL');
 assert.equal(calls[2].options.idempotencyKey,calls[0].options.idempotencyKey);
});
test('a found receipt, access denial, malformed receipt or unconfirmed read never causes a retry POST',async()=>{
 for(const result of [{id},{id:'invalid'},{status:403},{status:500},{}]){
  const calls=[];const c=createAgentSubmission({makeKey:()=>key,onPending:()=>{},api:async(path,body)=>{
   calls.push({path,body});if(body!==undefined)throw Error('lost');if('id'in result)return result;
   throw Object.assign(Error('read unconfirmed'),result);
  }});
  await assert.rejects(c.submit({message:'原需求'}));
  if(result.id===id)assert.equal((await c.retry()).id,id);else await assert.rejects(c.retry());
  assert.equal(calls.filter(call=>call.body!==undefined).length,1);assert.equal(c.snapshot().key,key);
 }
});
test('closing before the send or during a 404 read prevents further writes',async()=>{
 let calls=0;const c=createAgentSubmission({makeKey:()=>key,onPending:()=>{},api:async()=>{calls++;return{id};}});
 const task=c.submit({message:'原需求'});c.close();await assert.rejects(task,/过期/);assert.equal(calls,0);
 let rejectRead;const writes=[];const d=createAgentSubmission({makeKey:()=>key,onPending:()=>{},api:async(path,body)=>{if(body!==undefined){writes.push(body);throw Error('lost');}return new Promise((resolve,reject)=>{rejectRead=reject;});}});
 await assert.rejects(d.submit({message:'原需求'}));const retry=d.retry();await Promise.resolve();d.close();rejectRead(Object.assign(Error('not found'),{status:404}));
 await assert.rejects(retry,/过期/);assert.equal(writes.length,1);
});
test('duplicate recovery reads share one flight and require matching acknowledgement',async()=>{
 let resolveRead,calls=0;const c=createAgentSubmission({initialKey:key,onPending:()=>{},api:async()=>{calls++;return new Promise(resolve=>{resolveRead=resolve;});}});
 const a=c.recover(),b=c.recover();assert.equal(a,b);await Promise.resolve();resolveRead({id});await a;assert.equal(calls,1);
 assert.throws(()=>c.acknowledge(id),/不一致/);assert.equal(c.snapshot().key,key);c.acknowledge(key);assert.equal(c.snapshot().key,undefined);
});
