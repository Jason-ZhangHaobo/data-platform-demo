import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../../src/v2/store.mjs';
import { localTaskPublication } from '../../src/v2/local-task-publication.mjs';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';

function seed(store, project, agent, revisionId='fictional-revision', runId='fictional-run') {
  const bundle=store.create('delivery_package',project,{digest:`digest-${revisionId}-${runId}`,manifest:{source:{revisionId,runId}}});
  store.create('agent_delivery_task',project,{sourceAgentTaskId:agent.id,sourceRevisionId:revisionId,sourceRunId:runId,packageId:bundle.id,packageDigest:bundle.digest});
  const release=store.create('release',project,{packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revisionId,status:'ACTIVE_LOCAL',health:'HEALTHY',scheduleSpec:{runCount:2},artifactDirectory:'PRIVATE_PATH_NOT_FOR_RESPONSE'});
  for(let sequence=1;sequence<=2;sequence++){
    const run=store.create('release_run',project,{releaseId:release.id,status:'SUCCEEDED',sequence,schedulerTriggered:true,rows:[{secret:'DO_NOT_EXPOSE'}],remoteSubmission:{secret:'DO_NOT_EXPOSE'}});
    store.create('monitor_event',project,{type:'BATCH_SUCCEEDED',releaseId:release.id,releaseRunId:run.id,packageDigest:bundle.digest});
  }
  store.create('monitor_alert',project,{releaseId:release.id,status:'RESOLVED',message:'fictional recovered issue'});
  return release;
}
test('incomplete historical source links are skipped rather than crashing the task read',t=>{
  const store=new MetadataStore(':memory:');t.after(()=>store.close());
  const agent=store.create('agent',PROJECT,{attempts:[]});
  const bundle=store.create('delivery_package',PROJECT,{digest:'broken-digest'});
  store.create('agent_delivery_task',PROJECT,{sourceAgentTaskId:agent.id,packageId:bundle.id,packageDigest:bundle.digest});
  store.create('release',PROJECT,{packageId:bundle.id,packageDigest:bundle.digest,status:'ACTIVE_LOCAL'});
  assert.equal(localTaskPublication(store,PROJECT,agent).release,undefined);
  assert.deepEqual(localTaskPublication(store,PROJECT,agent).runs,[]);
});
test('local publication projection follows task and source, keeps history, and omits runtime payloads',t=>{
  const store=new MetadataStore(':memory:');t.after(()=>store.close());
  const agent=store.create('agent',PROJECT,{attempts:[{revisionId:'fictional-revision',runId:'fictional-run'}]});
  const current=seed(store,PROJECT,agent); seed(store,PROJECT,agent,'historical-revision','historical-run');
  seed(store,PROJECT,{id:'unrelated-task'});seed(store,'other-project',agent);
  const result=localTaskPublication(store,PROJECT,agent);
  assert.equal(result.release.id,current.id);assert.equal(result.release.runCount,2);assert.equal(result.runs.length,2);assert.equal(result.events.length,2);assert.equal(result.alerts.length,1);
  assert(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));assert(!JSON.stringify(result).includes('PRIVATE_PATH'));
  assert.deepEqual(localTaskPublication(store,PROJECT,{id:'missing'}).runs,[]);
  assert(localTaskPublication(store,PROJECT,{...agent,attempts:[]}).release,'history remains available');
  store.update('release',current.id,PROJECT,{packageDigest:'mismatched'});
  assert.notEqual(localTaskPublication(store,PROJECT,agent).release.id,current.id);
});
test('reopening metadata and GET task publication restores batches without invoking or republishing',async t=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-publication-read-')),path=join(root,'metadata.sqlite');
  let store=new MetadataStore(path);
  const agent=store.create('agent',PROJECT,{attempts:[{revisionId:'fictional-revision',runId:'fictional-run'}]});
  const release=seed(store,PROJECT,agent);store.close();store=new MetadataStore(path);
  const before=store.list('release',PROJECT).length;let calls=0;
  const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'},runner:async()=>{calls++;throw Error('must not execute');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});
  const url=`http://127.0.0.1:${app.server.address().port}/api/v2/agent/tasks/${agent.id}/publication`;
  for(let i=0;i<2;i++){
    const response=await fetch(url);assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.release.id,release.id);assert.equal(body.runs.length,2);assert.equal(body.events.length,2);assert.equal(body.scope,'LOCAL_TEST_RELEASE');
  }
  assert.equal(calls,0);assert.equal(store.list('release',PROJECT).length,before);
});
