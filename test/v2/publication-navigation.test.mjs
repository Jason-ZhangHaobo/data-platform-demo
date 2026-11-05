import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT} from '../../src/v2/server.mjs';
import {createManualPublicationJourney} from './fixtures/manual-publication-journey.mjs';

async function fixture(t){const f=await createManualPublicationJourney();t.after(()=>f.dispose());return f;}
const target=f=>({taskId:f.agent.id,packageDigest:f.item.digest,verificationId:f.verification.id});

test('login and refresh resolve the exact manual review source, never the failed Agent attempt, without computation',async t=>{
 const f=await fixture(t),before=f.store.get('agent',f.agent.id,PROJECT),originalCounts=f.counts();
 const expected={...target(f),status:'RESOLVED',sourceKind:'MANUAL',revisionId:f.revision.id,runId:f.sourceRun.id};
 assert.deepEqual((await f.login('owner')).publicationSource,expected);
 assert.deepEqual((await f.call('/auth/session')).body.publicationSource,expected);
 for(const identity of [null,'other'])assert.equal((await f.call('/auth/session',undefined,{identity})).body.publicationSource,undefined);
 assert.equal((await f.login('other')).publicationSource,undefined);
 f.expire();await f.restart();const expired=(await f.call('/auth/session')).body;
 assert.equal(expired.readOnly,true);assert.deepEqual(expired.publicationSource,expected,'expired window retains exact read navigation, never write authority');
 assert.deepEqual(f.store.get('agent',f.agent.id,PROJECT),before);assert.deepEqual(f.counts(),originalCounts);
 for(const kind of ['release','release_approval','delivery_review'])assert.equal(f.store.list(kind,PROJECT).length,0);
});

test('missing, ambiguous or changed manual provenance becomes unavailable without leaking or falling back to Agent code',async t=>{
 const f=await fixture(t),unavailable={...target(f),status:'UNAVAILABLE'},originalCounts=f.counts();
 for(const [kind,id,patch] of [
  ['revision',f.revision.id,{sql:'SELECT 1'}],['revision',f.revision.id,{author:f.other.id}],
  ['agent',f.agent.id,{submittedBy:f.other.id}],['run',f.sourceRun.id,{status:'VALIDATION_FAILED'}],
  ['agent_delivery_task',f.delivery.id,{sourceKind:'AGENT'}],['agent_delivery_task',f.delivery.id,{sourceRunId:'missing-run'}],
  ['delivery_verification',f.verification.id,{status:'FAILED'}],['delivery_package',f.item.id,{digest:'a'.repeat(64)}],
 ]){
  const saved=f.store.get(kind,id,PROJECT);f.store.update(kind,id,PROJECT,patch);
  const result=await f.call('/auth/session');assert.equal(result.status,200);assert.deepEqual(result.body.publicationSource,unavailable,kind);
  f.store.update(kind,id,PROJECT,saved);
 }
 // Duplicate metadata matching the frozen review target is ambiguous, even if
 // both records carry identical content; navigation must not choose the first.
 f.store.create('agent_delivery_task',PROJECT,{...f.delivery});
 assert.deepEqual((await f.call('/auth/session')).body.publicationSource,unavailable);
 assert.deepEqual(f.counts(),originalCounts);assert.equal(f.store.list('release',PROJECT).length,0);
});
