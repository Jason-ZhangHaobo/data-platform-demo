import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationReader, publicationPollNeeded } from '../../web/src/publication-read.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };

test('publication refresh is single-flight and failures preserve existing data until explicit retry', async () => {
  const first=deferred(), second=deferred(), values=[], errors=[]; let calls=0;
  const reader=createPublicationReader({read:()=> (++calls===1 ? first.promise : second.promise),onValue:v=>values.push(v),onError:e=>errors.push(e.message)});
  const a=reader.refresh(), b=reader.refresh(); assert.equal(a,b);
  first.reject(Error('synthetic outage')); await a;
  assert.equal(calls,1);assert.deepEqual(values,[]);assert.deepEqual(errors,['synthetic outage']);
  const c=reader.refresh();second.resolve({release:'existing'});await c;
  assert.equal(calls,2);assert.deepEqual(values,[{release:'existing'}]);
  reader.close();await reader.refresh();assert.equal(calls,2);
});
test('late reads cannot overwrite a confirmed write or a different task',async()=>{
  const old=deferred(), next=deferred(), values=[], errors=[];let calls=0;
  const reader=createPublicationReader({read:()=> (++calls===1 ? old.promise : next.promise),onValue:v=>values.push(v),onError:e=>errors.push(e)});
  const a=reader.refresh();await Promise.resolve();
  reader.invalidate();const b=reader.refresh();next.resolve('confirmed current');await b;
  old.resolve('obsolete');await a;
  assert.deepEqual(values,['confirmed current']);assert.deepEqual(errors,[]);
  const pending=deferred();const stopped=createPublicationReader({read:()=>pending.promise,onValue:v=>values.push(v),onError:e=>errors.push(e)});
  const c=stopped.refresh();stopped.close();pending.reject(Error('late failure'));await c;
  assert.deepEqual(values,['confirmed current']);assert.deepEqual(errors,[]);
});
test('polling ends for terminal releases, complete batches, and an empty history',()=>{
  assert.equal(publicationPollNeeded({runs:[]}),false);
  for(const status of ['CANCELLED','ROLLED_BACK','FAILED','ROLLED_BACK_LOCAL','SUPERSEDED_LOCAL','FAILED_LOCAL'])assert.equal(publicationPollNeeded({release:{status},runs:[{status:'SCHEDULED'}]}),false);
  assert.equal(publicationPollNeeded({release:{status:'ACTIVE_LOCAL'},runs:[{status:'SUCCEEDED'},{status:'FAILED'}]}),false);
  assert.equal(publicationPollNeeded({release:{status:'ACTIVE_LOCAL'},runs:[{status:'SUCCEEDED'},{status:'RUNNING'}]}),true);
});
