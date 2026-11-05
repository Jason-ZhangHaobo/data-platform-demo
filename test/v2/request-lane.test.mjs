import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestLane} from '../../src/v2/request-lane.mjs';
const latch=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve};};
test('stateful lane waits for asynchronous persistence and releases after failures',async()=>{
 const lane=createRequestLane(),first=latch(),events=[];
 const a=lane.run(async()=>{events.push('a');await first.promise;events.push('flushed');throw Error('synthetic');});
 const rejected=assert.rejects(a,/synthetic/);
 const b=lane.run(()=>events.push('b'));await new Promise(r=>setImmediate(r));
 assert.deepEqual(events,['a']);first.resolve();await rejected;await b;assert.deepEqual(events,['a','flushed','b']);
});
test('queue overflow, timeout and disconnected waiters never execute or block later requests',async()=>{
 const lane=createRequestLane({maxQueued:1,waitMs:25}),hold=latch();let ran=0;
 const active=lane.run(()=>hold.promise),controller=new AbortController();
 const queued=lane.run(()=>ran++,{signal:controller.signal}),cancelled=assert.rejects(queued,/服务正在处理/);
 await assert.rejects(lane.run(()=>ran++),/服务正在处理/);controller.abort();await cancelled;
 const expired=assert.rejects(lane.run(()=>ran++),/服务正在处理/);
 await new Promise(r=>setTimeout(r,35));await expired;hold.resolve();await active;
 await lane.run(()=>ran++);assert.equal(ran,1);
});

test('provider waits release metadata ownership and reacquire after the current persistence finishes',async()=>{
 const lane=createRequestLane(),provider=latch(),started=latch(),flush=latch(),events=[];
 const model=lane.run(async()=>{events.push('reserve');const value=await lane.waitForProvider(()=>{events.push('send');started.resolve();return provider.promise;});events.push('result:'+value);});
 await started.promise;
 const read=lane.run(async()=>{events.push('read');await flush.promise;events.push('read-flushed');});
 await new Promise(r=>setImmediate(r));provider.resolve('ok');await new Promise(r=>setImmediate(r));
 assert.deepEqual(events,['reserve','send','read']);assert.equal(lane.status().active,true);
 flush.resolve();await Promise.all([model,read]);assert.deepEqual(events,['reserve','send','read','read-flushed','result:ok']);
});

test('provider failures resume the original owner; forged or detached waits never start providers',async()=>{
 const lane=createRequestLane(),provider=latch(),started=latch(),hold=latch(),events=[];let sends=0;
 await assert.rejects(lane.waitForProvider(()=>sends++),{code:'REQUEST_LANE_OWNER_REQUIRED'});assert.equal(sends,0);
 const model=lane.run(async()=>{try{await lane.waitForProvider(()=>{sends++;started.resolve();return provider.promise;});}catch(error){events.push(error.message);events.push('unknown-persist');}});
 await started.promise;const read=lane.run(()=>hold.promise);provider.resolve(Promise.reject(Error('synthetic provider failure')));
 await new Promise(r=>setImmediate(r));assert.deepEqual(events,[]);hold.resolve();await Promise.all([model,read]);assert.deepEqual(events,['synthetic provider failure','unknown-persist']);assert.equal(sends,1);
 let late;await lane.run(()=>{late=()=>lane.waitForProvider(()=>sends++);});await assert.rejects(late(),{code:'REQUEST_LANE_OWNER_REQUIRED'});assert.equal(sends,1);
 await lane.run(async()=>{await assert.rejects(lane.waitForProvider(()=>{throw Error('sync failure');}),/sync failure/);assert.equal(lane.status().active,true);});
});

test('an original provider resume survives a disconnected request and a full waiter queue',async()=>{
 const lane=createRequestLane({maxQueued:1,waitMs:100}),provider=latch(),started=latch(),hold=latch(),client=new AbortController(),waiter=new AbortController();let writes=0;
 const model=lane.run(async()=>{await lane.waitForProvider(()=>{started.resolve();return provider.promise;});writes++;},{signal:client.signal});
 await started.promise;const reading=lane.run(()=>hold.promise),queued=lane.run(()=>{throw Error('cancelled waiter executed');},{signal:waiter.signal}),rejected=assert.rejects(queued,{code:'REQUEST_LANE_BUSY'});
 provider.resolve();client.abort();await new Promise(r=>setImmediate(r));assert.equal(writes,0);
 waiter.abort();await rejected;hold.resolve();await Promise.all([model,reading]);assert.equal(writes,1);
});
