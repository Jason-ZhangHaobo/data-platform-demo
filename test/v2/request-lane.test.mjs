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
