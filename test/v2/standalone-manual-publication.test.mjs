import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {manualSuccessFixture} from './fixtures/manual-success-continuation.mjs';
import {createStandaloneManualDelivery} from '../../src/v2/agent-development-workflow.mjs';
import {createStandaloneManualPublication,createCloudPublication} from '../../src/v2/cloud-publication.mjs';
import {standaloneManualPublicationSource} from '../../src/v2/standalone-manual-publication-source.mjs';
import {sha256} from '../../src/v2/delivery.mjs';
async function setup(t){
 const f=manualSuccessFixture({autoComplete:true});t.after(f.dispose);let clock=Date.now();const options={...f.options,artifactStore:f.artifactStore,enabled:true,singleRelease:true,now:()=>clock},d=createStandaloneManualDelivery(options);let task=await d.create({actorId:f.actor.id,key:randomUUID(),sourceBinding:f.proof().binding});task=await d.advance(task.id,task.version);
 const selector={sourceKind:'MANUAL',sourceRunId:f.run.id,packageDigest:task.packageDigest,verificationId:task.verificationId,actorId:f.actor.id},input={manualDeliveryTaskId:task.id,...selector,idempotencyKey:randomUUID(),attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true}};
 return{...f,task,options,selector,input,publication:createStandaloneManualPublication(options),advance:()=>clock+=60001,tick:async(p,id,n)=>p.tick({releaseId:id,requestId:sha256('synthetic-manual-publication-'+n),triggerName:'synthetic-manual-release-timer',triggerTime:new Date(clock).toISOString()})};
}
test('standalone publication retains genuine manual identity through review, two durable batches and monitor events',async t=>{
 const f=await setup(t),before={run:structuredClone(f.store.get('run',f.run.id,f.project)),revision:structuredClone(f.revision)},p=createStandaloneManualPublication({...f.options,assertPublicationScope:scope=>{assert.equal(scope.manualDeliveryTaskId,f.task.id);assert.equal(scope.agentId,undefined);},assertExecutionScope:r=>{assert.equal(r.manualDeliveryTaskId,f.task.id);assert.equal(r.sourceAgentTaskId,undefined);}});
 const published=await p.publish(f.input),id=published.release.id;assert.equal(published.release.source.kind,'MANUAL_RUN');assert.equal(published.release.sourceAttribution,'ENGINEER_AUTHORED');assert.equal(published.release.sourceAgentTaskId,undefined);assert.equal(published.release.agentIndependentE2E,false);assert.equal(published.runs.length,2);assert.equal(f.counts.submits,1,'publish only schedules');
 assert.equal((await p.publish(f.input)).release.id,id);assert.equal((await p.publish({...f.input,idempotencyKey:randomUUID()})).release.id,id);
 for(let n=1;n<=3;n++){await f.tick(p,id,n);f.advance();}
 const value=await createStandaloneManualPublication(f.options).detail(f.task.id,{...f.selector,releaseId:id});assert.equal(value.release.health,'HEALTHY');assert.equal(value.release.status,'COMPLETED_CLOUD_TEST');assert(value.runs.every(r=>r.status==='SUCCEEDED'&&r.schedulerTriggered===true&&r.manualDeliveryTaskId===f.task.id&&r.source.kind==='MANUAL_RUN'&&r.sourceAgentTaskId===undefined&&r.agentIndependentE2E===false));assert.equal(value.events.length,2);assert.equal(value.alerts.length,0);assert.equal(f.counts.submits,3);assert.equal(f.counts.model,0);assert.equal(f.store.list('agent',f.project).length,0);assert.equal(f.store.list('agent_delivery_task',f.project).length,0);
 for(const kind of['delivery_review','release_approval']){const records=f.store.list(kind,f.project);assert.equal(records.length,1);assert.equal(records[0].source.kind,'MANUAL_RUN');assert.equal(records[0].sourceAttribution,'ENGINEER_AUTHORED');assert.equal(records[0].manualDeliveryTaskId,f.task.id);}
 assert.deepEqual(f.store.get('run',f.run.id,f.project),before.run);assert.deepEqual(f.store.get('revision',f.revision.id,f.project),before.revision);
});
test('foreign actor, wrong run/package/rehearsal or incomplete attestations cannot approve a manual source',async t=>{
 const f=await setup(t);
 for(const patch of[{actorId:randomUUID()},{sourceRunId:randomUUID()},{packageDigest:'a'.repeat(64)},{verificationId:randomUUID()},{sourceKind:'AGENT'},{attestations:{code:true}}])await assert.rejects(f.publication.publish({...f.input,...patch}));
 assert.equal(f.store.list('release_approval',f.project).length,0);assert.equal(f.counts.submits,1);
});
test('source or window change during artifact verification prevents review and approval records',async t=>{
 for(const boundary of['source','window'])await t.test(boundary,async t=>{const f=await setup(t);let closed=false;const artifactStore={verify:async(...args)=>{await f.artifactStore.verify(...args);if(boundary==='source')f.store.update('run',f.run.id,f.project,{log:'changed source evidence'});else closed=true;}},p=createStandaloneManualPublication({...f.options,artifactStore,assertPublicationScope:()=>{if(closed)throw Error('synthetic expired review window');}});await assert.rejects(p.publish(f.input));assert.equal(f.store.list('delivery_review',f.project).length,0);assert.equal(f.store.list('release_approval',f.project).length,0);assert.equal(f.counts.submits,1);});
});
test('lost publication acknowledgement preserves original request and exact immutable release after engine recovery',async t=>{
 const f=await setup(t);let lost=true;const p=createStandaloneManualPublication({...f.options,persist:async()=>{if(lost&&f.store.list('release',f.project).length){lost=false;throw Error('synthetic ACK unknown');}}});await assert.rejects(p.publish(f.input));const original=f.store.list('release',f.project)[0],ids=f.store.list('release_run',f.project).map(r=>r.id).sort();f.store.interruptPending(f.project);const next=createStandaloneManualPublication(f.options),read=await next.detail(f.task.id,f.selector);assert.equal(read.release.id,original.id);assert.deepEqual(read.runs.map(r=>r.id).sort(),ids);assert.equal((await next.publish(f.input)).release.id,original.id);assert.equal(f.store.list('release_approval',f.project).length,1);assert.equal(f.counts.submits,1);
});
test('cancel does not need an intact source or receipt and cannot cross into native Agent releases',async t=>{
 const f=await setup(t),value=await f.publication.publish(f.input),id=value.release.id;await f.tick(f.publication,id,1);const prepared=f.store.list('release_run',f.project).find(r=>r.status==='RUNNING');
 f.store.update('run',f.run.id,f.project,{log:'source changed after review'});const p=createStandaloneManualPublication({...f.options,runner:{...f.runner,read:async()=>{throw Error('synthetic read failure');}}});const stopped=await p.cancel(f.task.id,{...f.selector,releaseId:id});assert.equal(stopped.release.status,'CANCELLED');assert(stopped.runs.every(r=>r.status==='CANCELLED'));assert(prepared);assert.equal(f.counts.submits,2);
 await assert.rejects(p.detail(f.task.id,{...f.selector,actorId:randomUUID()}));await assert.rejects(createCloudPublication(f.options).tick({releaseId:id,requestId:sha256('wrong-native'),triggerName:'synthetic',triggerTime:new Date().toISOString()}));
});
test('a damaged manual relation or rehearsal cannot be reclassified as a verified standalone source',async t=>{
 const f=await setup(t),get=()=>standaloneManualPublicationSource({...f.options,...f.input});assert.equal(get().delivery.id,f.task.id);
 const original=f.store.get('delivery_verification',f.task.verificationId,f.project);for(const patch of[{manualDeliveryTaskId:randomUUID()},{agentDeliveryTaskId:randomUUID()},{actualExecution:false},{isolation:'LOCAL_PROCESS'},{testDouble:true},{validation:{passed:true,regressions:[]}},{testSqlValidation:{passed:true,sqlHash:'a'.repeat(64)}}]){f.store.update('delivery_verification',original.id,f.project,patch);assert.throws(get);f.store.update('delivery_verification',original.id,f.project,{...original,agentDeliveryTaskId:undefined,testDouble:undefined});}
 assert.equal(f.store.list('release',f.project).length,0);
});
