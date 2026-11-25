import{checkedAgentWorkflow}from'../../web/src/agent-workflow-read.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';import {writeFileSync}from'node:fs';import{join}from'node:path';
import {setup}from'./fixtures/native-sync-agent.mjs';import{PROJECT}from'../../src/v2/server.mjs';import{loadDeliveryDirectory,sha256,resolveDeliverySchedule}from'../../src/v2/delivery.mjs';import{syncSqlOutputColumns}from'../../src/v2/sync-sql-input.mjs';import{readNativeSyncReview}from'../../src/v2/native-sync-review-client.mjs';import{readNativeSyncPublication,submitNativeSyncPublication,nativeSyncReceiptPath,nativePublicationLocation,pendingNativePublication}from'../../src/v2/native-sync-publication-client.mjs';import{publishedReportHash}from'../../src/v2/published-report-source.mjs';import{runV2Cli}from'../../bin/shuduo.mjs';import{handleV2Mcp}from'../../bin/shuduo-mcp.mjs';
// Every execution in this suite is an explicit synthetic protocol fixture, not Spark.
import {prepared}from'./fixtures/native-sync-release.mjs';
import {nativeBatchServiceHref} from '../../web/src/native-sync-service-handoff.ts';
import {serviceSourceFromLocation,serviceSourcesPath,sourceBoundServices,defaultBoundSourceRun} from '../../web/src/service-source-binding.ts';
import {serviceBatchFromLocation} from '../../web/src/service-batch-scope.ts';

test('a completed native monitor opens services on the chosen original batch', async t=>{
  const f=await prepared(t), origin='http://127.0.0.1/v2/';
  const review=await readNativeSyncReview(f.client,f.binding);
  const started=await submitNativeSyncPublication(f.client,f.request,{confirm:true});
  const [first,second]=started.monitor.runs;
  for (const batch of [first,second]) {
    const pending=await readNativeSyncPublication(f.client,f.request);
    assert.equal(nativeBatchServiceHref(origin,f.binding,review,pending,second.id),undefined);
    f.setClock(Date.parse(batch.scheduledTriggerAt));
    await f.app.releaseScheduler.enqueue(batch.id);
  }
  const done=await readNativeSyncPublication(f.client,f.request);
  for(const batch of [first,second]){
    const path=nativeBatchServiceHref(origin+'?module=agent-center&sync_release=old',f.binding,review,done,batch.id);
    const url=new URL(path,origin);
    assert.equal(url.searchParams.has('sync_release'),false);
    const location=serviceSourceFromLocation(url.href);
    assert.equal(location.status,'VALID');
    assert.deepEqual(location.binding,{sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',taskId:f.binding.taskId,
      packageDigest:f.binding.packageDigest,releaseId:done.monitor.releaseId,revisionId:f.revision.id,runId:f.run.id});
    const pin=serviceBatchFromLocation(url.href,location.binding);
    assert.equal(pin,batch.id);
    const runs=await f.client.request(serviceSourcesPath(location.binding));
    const selected=runs.filter(run=>run.id===pin);
    assert.deepEqual(selected.map(run=>run.sequence),[batch.sequence]);
    assert.equal(defaultBoundSourceRun(location.binding,selected,[]),batch.id);
    assert.equal(defaultBoundSourceRun(location.binding,[],[]),undefined);
    assert.deepEqual(sourceBoundServices([],location.binding,selected),[]);
  }
  assert.equal(nativeBatchServiceHref(origin,f.binding,review,done,randomUUID()),undefined);
  assert.equal(nativeBatchServiceHref(origin,{...f.binding,deliveryId:randomUUID()},review,done,second.id),undefined);
  assert.equal(nativeBatchServiceHref(origin,f.binding,{...review,review:{status:'STALE_REVIEW'}},done,first.id),undefined);
  const duplicate=structuredClone(done);
  duplicate.monitor.runs[1].id=first.id;
  assert.equal(nativeBatchServiceHref(origin,f.binding,review,duplicate,first.id),undefined);
});
test('explicit two-batch publication uses original approval once; exact monitor follows scheduled, successful and terminal evidence',async t=>{
 const f=await prepared(t),before=f.app.store.db.prepare('SELECT total_changes() AS n').get().n;assert.equal((await readNativeSyncPublication(f.client,f.request)).phase,'NOT_FOUND');assert.equal(f.app.store.db.prepare('SELECT total_changes() AS n').get().n,before);await assert.rejects(()=>submitNativeSyncPublication(f.client,f.request,{confirm:false}));assert.equal(f.app.store.list('release_approval',PROJECT).length,0);
 const started=await submitNativeSyncPublication(f.client,f.request,{confirm:true});assert.equal(started.phase,'RELEASED');assert.deepEqual(started.monitor.runs.map(r=>r.status),['SCHEDULED','SCHEDULED']);assert.equal(f.calls(),0);
 for(const batch of f.app.store.list('release_run',PROJECT).sort((a,b)=>a.sequence-b.sequence)){f.setClock(Date.parse(batch.scheduledTriggerAt));await f.app.releaseScheduler.enqueue(batch.id);const value=await readNativeSyncPublication(f.client,f.request);assert.equal(value.monitor.runs[batch.sequence-1].status,'SUCCEEDED');}
 const done=await readNativeSyncPublication(f.client,f.request);assert.equal(done.monitor.completed,true);assert.equal(done.monitor.monitorEventCount,2);assert.equal(done.monitor.openAlertCount,0);assert.equal(f.calls(),2);const replay=await submitNativeSyncPublication(f.client,f.request,{confirm:true});assert.equal(replay.monitor.releaseId,started.monitor.releaseId);assert.equal(f.calls(),2);assert.equal(f.app.store.list('release_approval',PROJECT).length,1);
});
test('lost approval acknowledgement is recovered by original request; activation needs explicit resume and cannot renew silently',async t=>{
 const f=await prepared(t);let lost=false,writes=0;const client={request:async(path,opts)=>{if(opts?.method==='POST')writes++;const result=await f.client.request(path,opts);if(!lost&&path.endsWith('/approve')){lost=true;throw Error('SYNTHETIC_LOST_ACK');}return result;}};
 await assert.rejects(()=>submitNativeSyncPublication(client,f.request,{confirm:true}),/LOST_ACK/);assert.equal(writes,1);const recovered=await readNativeSyncPublication(f.client,f.request);assert.equal(recovered.phase,'APPROVED');assert.equal(f.app.store.list('release_run',PROJECT).length,0);const resumed=await submitNativeSyncPublication(f.client,f.request,{confirm:true,activateOnly:true});assert.equal(resumed.phase,'RELEASED');assert.equal(f.app.store.list('release_approval',PROJECT).length,1);
 const second=await prepared(t);let drop=true;const c={request:async(path,opts)=>{const result=await second.client.request(path,opts);if(path.endsWith('/approve')&&drop){drop=false;throw Error('SYNTHETIC_LOST_ACK');}return result;}};await assert.rejects(()=>submitNativeSyncPublication(c,second.request,{confirm:true}));const approved=await readNativeSyncPublication(second.client,second.request);second.setClock(Date.parse(approved.approval.expiresAt));assert.equal((await readNativeSyncPublication(second.client,second.request)).phase,'EXPIRED');await assert.rejects(()=>submitNativeSyncPublication(second.client,second.request,{confirm:true}),/到期/);assert.equal(second.app.store.list('release_run',PROJECT).length,0);
});
test('lost activation acknowledgement and reopening use original request with no second activation or calculation',async t=>{
 const f=await prepared(t);let writes=0;const c={request:async(path,opts)=>{if(opts?.method==='POST')writes++;const result=await f.client.request(path,opts);if(path==='/releases')throw Error('SYNTHETIC_LOST_ACTIVATION_ACK');return result;}};await assert.rejects(()=>submitNativeSyncPublication(c,f.request,{confirm:true}));const saved=await readNativeSyncPublication(f.client,f.request);assert.equal(saved.phase,'RELEASED');await submitNativeSyncPublication(c,f.request,{confirm:true});assert.equal(writes,2);assert.equal(f.app.store.list('release',PROJECT).length,1);assert.equal(f.app.store.list('release_run',PROJECT).length,2);assert.equal(f.calls(),0);
 const href=new URL(nativePublicationLocation('http://127.0.0.1/v2/?module=agent-center&task='+f.agent.id,f.request),'http://127.0.0.1').href;assert.deepEqual(pendingNativePublication(href,f.binding),f.request);assert.equal(pendingNativePublication(href,{...f.binding,packageDigest:'0'.repeat(64)}),undefined);
});
test('failed batch and cancelled pending batches cannot look like complete execution; bad or missing monitor evidence is rejected',async t=>{
 const f=await prepared(t,{releaseRunner:input=>({...protocolReleaseResult(input),columns:['wrong']})});await submitNativeSyncPublication(f.client,f.request,{confirm:true});const batch=f.app.store.list('release_run',PROJECT).find(b=>b.sequence===1);f.setClock(Date.parse(batch.scheduledTriggerAt));await f.app.releaseScheduler.enqueue(batch.id);const failed=await readNativeSyncPublication(f.client,f.request);assert.equal(failed.monitor.runs[0].status,'FAILED');assert.equal(failed.monitor.health,'FAILED');assert.equal(failed.monitor.openAlertCount,1);assert.equal(failed.monitor.completed,false);const event=f.app.store.list('monitor_event',PROJECT)[0];f.app.store.update('monitor_event',event.id,PROJECT,{snapshotHash:'0'.repeat(64)});await assert.rejects(()=>readNativeSyncPublication(f.client,f.request));assert.equal((await f.http('/agent/tasks/'+f.agent.id+'/publication')).status,409);
 const g=await prepared(t);const active=await submitNativeSyncPublication(g.client,g.request,{confirm:true});assert.equal((await g.http('/releases/'+active.monitor.releaseId+'/cancel',{packageDigest:g.binding.packageDigest})).status,200);const cancelled=await readNativeSyncPublication(g.client,g.request);assert.equal(cancelled.monitor.health,'CANCELLED');assert(cancelled.monitor.runs.every(r=>r.status==='CANCELLED'));assert.equal(g.calls(),0);
});
test('result unknown stays unknown, requires original event and alert, and is never retried by reading',async t=>{
 const f=await prepared(t);await submitNativeSyncPublication(f.client,f.request,{confirm:true});const batch=f.app.store.list('release_run',PROJECT)[0],at=batch.scheduledTriggerAt;f.app.store.update('release_run',batch.id,PROJECT,{status:'INTERRUPTED',schedulerTriggered:true,mode:'LOCAL_SCHEDULED_RELEASE',clockMode:'WALL_CLOCK_TIMER',startedAt:at,triggeredAt:at,resultUnknown:true});f.app.store.create('monitor_event',PROJECT,{type:'BATCH_RESULT_UNKNOWN',releaseId:batch.releaseId,releaseRunId:batch.id,packageDigest:batch.packageDigest,status:'INTERRUPTED',schedulerTriggered:true,observedAt:at});f.app.store.create('monitor_alert',PROJECT,{releaseId:batch.releaseId,releaseRunId:batch.id,status:'OPEN',message:'synthetic interrupted batch'});const value=await readNativeSyncPublication(f.client,f.request);assert.equal(value.monitor.health,'RESULT_UNKNOWN');assert.equal(value.monitor.completed,false);assert.equal(f.calls(),0);assert.equal((await f.http('/releases/'+value.monitor.releaseId+'/cancel',{packageDigest:f.binding.packageDigest})).status,200);const stopped=await readNativeSyncPublication(f.client,f.request);assert.equal(stopped.monitor.status,'CANCELLED');assert.equal(stopped.monitor.health,'RESULT_UNKNOWN');assert(stopped.monitor.runs.some(r=>r.resultUnknown));
});
test('cross-owner, mixed package, changed rehearsal and query duplication cannot resolve an unrelated approval',async t=>{
 const f=await prepared(t),path=nativeSyncReceiptPath(f.request);assert.equal((await f.http(path+'&reviewId='+f.request.reviewId)).status,422);for(const patch of [{requestId:randomUUID(),packageDigest:'0'.repeat(64)},{reviewId:randomUUID()},{syncRehearsalDigest:'0'.repeat(64)}])await assert.rejects(()=>readNativeSyncPublication(f.client,{...f.request,...patch}));f.app.store.update('agent',f.agent.id,PROJECT,{submittedBy:'another-engineer'});assert.equal((await f.http(path)).status,403);
});
test('CLI and MCP require explicit publish confirmation and share readonly original-request monitor',async t=>{
 const f=await prepared(t),file=join(f.root,'request.json');writeFileSync(file,JSON.stringify(f.request));assert.equal(await runV2Cli(['agent','sync-release','--request-file',file],{},{client:f.client,output:()=>{},error:()=>{}}),1);assert.equal(f.app.store.list('release_approval',PROJECT).length,0);const invoked=JSON.parse(await handleV2Mcp({id:1,method:'tools/call',params:{name:'agent_sync_release',arguments:{request:f.request,confirm:true}}},{client:f.client}));assert.equal(invoked.result.structuredContent.phase,'RELEASED');let actual;assert.equal(await runV2Cli(['agent','sync-release-read','--request-file',file],{},{client:f.client,output:s=>actual=JSON.parse(s),error:()=>{}}),0);assert.deepEqual(actual,invoked.result.structuredContent);
 const bad=structuredClone(actual);bad.monitor.completed=true;const{evidenceDigest,...body}=bad;bad.evidenceDigest=publishedReportHash(body);await assert.rejects(()=>readNativeSyncPublication({request:async()=>bad},f.request));
});
test('rehearsal change between readonly preflight and approval POST refuses the original consent without an approval',async t=>{
 const f=await prepared(t);let changed=false;const c={request:async(path,opts)=>{const value=await f.client.request(path,opts);if(!changed&&path.includes('/sync-review-preflight?')){changed=true;const v=f.app.store.get('delivery_verification',f.binding.verificationId,PROJECT);f.app.store.update('delivery_verification',v.id,PROJECT,{durationMs:(v.durationMs??0)+1});}return value;}};await assert.rejects(()=>submitNativeSyncPublication(c,f.request,{confirm:true}));assert.equal(changed,true);assert.equal(f.app.store.list('release_approval',PROJECT).length,0);assert.equal(f.app.store.list('release_run',PROJECT).length,0);
});

test('reopening a native holding workflow accepts its exact file-review metadata without treating it as release approval',async t=>{const f=await prepared(t),v=(await f.http('/agent/tasks/'+f.agent.id+'/workflow?deliveryId='+f.binding.deliveryId)).value;const value=await checkedAgentWorkflow(v,{taskId:f.agent.id,contextId:'holdings-t1',revisionId:f.revision.id,runId:f.run.id,manual:false,deliveryId:f.binding.deliveryId});assert.equal(value.fileReview.id,f.request.reviewId);assert.equal(value.publication.available,false);const bad=structuredClone(v);bad.fileReview.verificationId=randomUUID();await assert.rejects(()=>checkedAgentWorkflow(bad,{taskId:f.agent.id,contextId:'holdings-t1',revisionId:f.revision.id,runId:f.run.id,manual:false,deliveryId:f.binding.deliveryId}));});
test('another new UUID cannot borrow the existing exact-version approval or create extra batches',async t=>{const f=await prepared(t);await submitNativeSyncPublication(f.client,f.request,{confirm:true});await assert.rejects(()=>submitNativeSyncPublication(f.client,{...f.request,requestId:randomUUID()},{confirm:true}),/原发布请求/);assert.equal(f.app.store.list('release_approval',PROJECT).length,1);assert.equal(f.app.store.list('release_run',PROJECT).length,2);assert.equal(f.calls(),0);});
