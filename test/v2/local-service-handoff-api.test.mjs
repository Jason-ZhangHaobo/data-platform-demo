import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PROJECT} from '../../src/v2/server.mjs';
import {seedLocalServiceSource} from './fixtures/local-service-sources.mjs';
import {createLocalSourceApiFixture,publishLocalAgentFixture} from './fixtures/local-service-api-journey.mjs';

async function appFixture(t){
 const f=await createLocalSourceApiFixture();t.after(()=>f.dispose());return f;
}

// Exercise the actual producer routes and filesystem packaging. Only model and
// Spark receipts are synthetic; this does not establish real compute acceptance.
test('real local HTTP producer, reused package, human-review routes and scheduled receipts feed exact sources without fabricated metadata',async t=>{
 const f=await appFixture(t);
 assert.equal((await f.call('/status')).body.dataServices.localSourcesEnabled,true);
 const {agent,bundle,release}=await publishLocalAgentFixture(f);
 const before={...f.counts},counts={releases:f.store.list('release',PROJECT).length,apps:f.store.list('service_app',PROJECT).length,calls:f.store.list('service_call',PROJECT).length};
 const query=new URLSearchParams({agent_task_id:agent.id,package_digest:bundle.digest,release_id:release.id});
 for(let n=0;n<2;n++){
  const sources=await f.call('/data-services/sources?'+query);assert.equal(sources.status,200);assert.equal(sources.body.length,2);
  assert.ok(sources.body.every(row=>row.scope==='LOCAL_TEST_ONLY'&&row.sourceKind==='AGENT'&&row.sourceAgentTaskId===agent.id&&row.sourceRunId===agent.runId&&row.sourceRevisionId===agent.revisionId&&row.releaseId===release.id&&row.packageDigest===bundle.digest));
  assert.equal(sources.body.some(row=>row.id===agent.runId),false);assert.equal(JSON.stringify(sources.body).includes('CLIENT-001'),false);
 }
 const exact=new URLSearchParams({sourceKind:'AGENT',releaseId:release.id,packageDigest:bundle.digest,sourceRunId:agent.runId});
 assert.equal((await f.call(`/agent/tasks/${agent.id}/publication?`+exact)).body.release.id,release.id);
 exact.set('releaseId',randomUUID());assert.equal((await f.call(`/agent/tasks/${agent.id}/publication?`+exact)).body.release,undefined);
 assert.equal((await f.call('/data-services/task-evidence?'+query)).body.status,'PENDING','no consumer query is invented');
 assert.deepEqual(f.counts,before);assert.deepEqual({releases:f.store.list('release',PROJECT).length,apps:f.store.list('service_app',PROJECT).length,calls:f.store.list('service_call',PROJECT).length},counts);
 assert.deepEqual(before,{syntheticModel:1,syntheticSpark:4});
 f.store.update('agent',agent.id,PROJECT,{runId:undefined});
 const stored=f.store.get('agent',agent.id,PROJECT),read=await f.call(`/agent/tasks/${agent.id}`);
 assert.equal(read.body.runId,agent.runId);assert.deepEqual(f.store.get('agent',agent.id,PROJECT),stored,'old missing pointer is projected, not persisted');
 const run=f.store.get('run',agent.runId,PROJECT);f.store.update('run',run.id,PROJECT,{agentTaskId:'different-task'});
 assert.equal((await f.call(`/agent/tasks/${agent.id}`)).body.runId,undefined,'contradictory history is not guessed');
 f.store.update('run',run.id,PROJECT,run);
});

test('scoped local discovery and publication never fall back to another task, package or release',async t=>{
 const f=await appFixture(t),one=seedLocalServiceSource({store:f.store,project:PROJECT}),other=seedLocalServiceSource({store:f.store,project:PROJECT});
 const query=new URLSearchParams({agent_task_id:one.agent.id,package_digest:one.bundle.digest,release_id:one.release.id});
 assert.equal((await f.call('/data-services/sources?'+query)).body.length,2);
 for(const [key,value] of [['agent_task_id',other.agent.id],['package_digest',other.bundle.digest],['release_id',other.release.id],['release_id',randomUUID()]]){
  const bad=new URLSearchParams(query);bad.set(key,value);assert.deepEqual((await f.call('/data-services/sources?'+bad)).body,[]);
 }
 for(const suffix of ['&extra=true','&release_id='+one.release.id])assert.equal((await f.call('/data-services/sources?'+query+suffix)).status,422);
 assert.equal((await f.call('/data-services/sources?package_digest='+one.bundle.digest)).status,422);
 assert.deepEqual(f.counts,{syntheticModel:0,syntheticSpark:0});
});

test('actual local rollback appends a verified recovery pair while preserving the original successful source batches',async t=>{
 const f=await appFixture(t),first=await publishLocalAgentFixture(f),second=await publishLocalAgentFixture(f,{contextId:'stock-cash-t1'});
 assert.equal(f.store.get('release',first.release.id,PROJECT).status,'SUPERSEDED_LOCAL');
 const restored=await f.call(`/releases/${second.release.id}/rollback`,{targetReleaseId:first.release.id,triggerAfterSeconds:1,intervalSeconds:2,reason:'合成协议验证：恢复已核验版本'});
 assert.equal(restored.status,202);
 const healthy=await f.poll(`/releases/${first.release.id}`,value=>value.health==='HEALTHY'&&value.successfulRunCount===4);
 assert.equal(healthy.id,first.release.id);
 const before={...f.counts},selected=await f.call('/data-services/sources?'+first.query);
 assert.equal(selected.status,200);assert.equal(selected.body.length,4);
 assert.ok(first.sources.every(old=>selected.body.some(row=>row.id===old.id)),'fixed earlier service snapshots keep their source');
 assert.equal(new Set(selected.body.map(row=>row.id)).size,4);assert.ok(selected.body.every(row=>row.scope==='LOCAL_TEST_ONLY'&&row.releaseId===first.release.id&&row.packageDigest===first.bundle.digest));
 assert.deepEqual(f.counts,before);assert.deepEqual(before,{syntheticModel:2,syntheticSpark:10});
});
