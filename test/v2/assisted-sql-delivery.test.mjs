import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assistedDeliveryFixture} from './fixtures/assisted-sql-delivery.mjs';
import {manualCloudDeliverySource,createDurableAgentDelivery} from '../../src/v2/agent-development-workflow.mjs';
import {checkedAssistedDevelopmentReference,sameAssistedDevelopmentReference} from '../../src/v2/assisted-development-reference.mjs';
import {validateDeliveryPackage,computeManifestDigest} from '../../src/v2/delivery.mjs';
import {createCloudPublication} from '../../src/v2/cloud-publication.mjs';
import {sha256} from '../../src/v2/delivery.mjs';

const source=f=>manualCloudDeliverySource({...f.options,...f.input});
test('actual durable repair producer keeps model generation, engineer attribution and frozen references through file rehearsal',async t=>{
  const f=await assistedDeliveryFixture();t.after(f.dispose);const before=[f.agent,f.source.current.run,f.source.baseline.run].map(v=>structuredClone(v)),resolved=source(f);
  assert.equal(f.agent.status,'SUCCEEDED');assert.equal(f.revision.source,'LIVE_MODEL');assert.equal(f.revision.manualProvenance,undefined);
  const ref=resolved.developmentReference;assert.equal(ref.baselineRunId,f.source.baseline.run.id);assert.equal(ref.sourceRunId,f.source.current.run.id);assert.equal(ref.evidenceDigest,f.basis.binding.evidenceDigest);
  let task=await f.delivery.createManual(f.input);assert.equal(task.sourceKind,'MANUAL');assert.equal(task.agentIndependentE2E,false);assert.deepEqual(task.developmentReference,ref);
  const bundle=f.store.get('delivery_package',task.packageId,f.project),plan=validateDeliveryPackage(bundle,bundle.digest);
  assert.deepEqual(plan.source.attribution.developmentReference,ref);assert.equal(plan.source.runId,f.run.id);assert.equal(plan.source.revisionId,f.revision.id);
  assert.equal((await f.delivery.createManual({...f.input,key:'second-click'})).id,task.id);assert.equal(f.store.list('delivery_package',f.project).length,1);
  task=await f.delivery.advance(task.id,task.version);f.complete(task.verificationId);task=await f.delivery.reconcile(task.id);
  assert.equal(task.status,'SUCCEEDED');assert.equal(task.stage,'AWAITING_ENGINEER_REVIEW');assert.equal(f.counts.syntheticModel,1);assert.equal(f.counts.submits,2);
  assert.deepEqual(f.store.get('agent',f.agent.id,f.project),before[0]);assert.deepEqual(f.store.get('run',f.source.current.run.id,f.project),before[1]);assert.deepEqual(f.store.get('run',f.source.baseline.run.id,f.project),before[2]);
  assert.equal(f.store.list('release_approval',f.project).length,0);assert.equal(f.store.list('release',f.project).length,0);
});
test('ordinary explicit failed-run repair uses its own source reference without inventing a comparison baseline',async t=>{
  const f=await assistedDeliveryFixture({comparison:false});t.after(f.dispose);const resolved=source(f);assert.equal(resolved.developmentReference.kind,'FAILED_RUN_REFERENCE');assert.equal(resolved.developmentReference.baselineRunId,undefined);
  const task=await f.delivery.createManual(f.input),bundle=f.store.get('delivery_package',task.packageId,f.project);assert.deepEqual(bundle.manifest.source.attribution.developmentReference,resolved.developmentReference);
});
test('foreign owner, mismatched terminal attempt, attribution and changed reference cannot create an artifact',async t=>{
  const f=await assistedDeliveryFixture();t.after(f.dispose);
  assert.throws(()=>manualCloudDeliverySource({...f.options,...f.input,actorId:'foreign'}));
  for(const [kind,id,original,patches] of [
    ['agent',f.agent.id,f.agent,[{status:'FAILED'},{runId:randomUUID()},{sourceKind:'AGENT'},{attempts:[{...f.agent.attempts.at(-1),model:'TEST_DOUBLE'}]},{sourceAttribution:{...f.agent.sourceAttribution,baselineRunId:randomUUID()}}]],
    ['revision',f.revision.id,f.revision,[{sourceKind:'AGENT'},{sourceAttribution:{...f.revision.sourceAttribution,actorId:'foreign'}},{sql:'SELECT 1'},{manualProvenance:{kind:'ENGINEER_EDIT'}}]],
    ['run',f.run.id,f.run,[{agentTaskId:randomUUID()},{sourceAttribution:undefined},{agentIndependentE2E:true},{testDouble:true},{isolation:'LOCAL_PROCESS'}]]]){
    for(const patch of patches){f.store.update(kind,id,f.project,patch);await assert.rejects(f.delivery.createManual(f.input));f.store.update(kind,id,f.project,{...original,manualProvenance:original.manualProvenance,testDouble:original.testDouble});}
  }
  f.store.update('run',f.source.baseline.run.id,f.project,{log:'changed original basis'});await assert.rejects(f.delivery.createManual(f.input));
  assert.equal(f.counts.puts,0);assert.equal(f.counts.submits,1);assert.equal(f.store.list('delivery_package',f.project).length,0);
});
test('reference is part of immutable package digest and cannot be removed or changed after artifact creation',async t=>{
  const f=await assistedDeliveryFixture();t.after(f.dispose);const task=await f.delivery.createManual(f.input),bundle=f.store.get('delivery_package',task.packageId,f.project);
  const changed=structuredClone(bundle);changed.manifest.source.attribution.developmentReference.baselineRevisionHash='a'.repeat(64);assert.throws(()=>validateDeliveryPackage(changed,bundle.digest));
  const invalid=structuredClone(bundle);invalid.manifest.source.attribution.developmentReference.initialSqlHash='b'.repeat(64);invalid.digest=computeManifestDigest(invalid.manifest);assert.throws(()=>validateDeliveryPackage(invalid,invalid.digest));
  for(const attribution of [null,[],0,'invalid']){const malformed=structuredClone(bundle);malformed.manifest.source.attribution=attribution;malformed.digest=computeManifestDigest(malformed.manifest);assert.throws(()=>validateDeliveryPackage(malformed,malformed.digest),e=>e.status===422);}
  const changedTask=f.store.update('agent_delivery_task',task.id,f.project,{developmentReference:undefined});await assert.rejects(f.delivery.advance(task.id,changedTask.version),/人工交付来源/);assert.equal(f.counts.submits,1);
});
test('unknown artifact and Spark acknowledgement recover the same package and job without duplicate computation',async t=>{
  const f=await assistedDeliveryFixture();t.after(f.dispose);f.losePut();await assert.rejects(f.delivery.createManual(f.input));
  const pending=f.store.list('agent_delivery_task',f.project)[0],engine=createDurableAgentDelivery(f.options),saved=await engine.createManual(f.input);assert.equal(saved.id,pending.id);assert.equal(f.store.list('delivery_package',f.project).length,1);
  f.loseSubmit();await assert.rejects(engine.advance(saved.id,saved.version));const queued=f.store.get('agent_delivery_task',saved.id,f.project);f.complete(queued.verificationId);
  const recovered=await createDurableAgentDelivery(f.options).advance(queued.id,queued.version);assert.equal(recovered.status,'SUCCEEDED');assert.equal(f.counts.submits,2);assert.equal(f.store.list('delivery_verification',f.project).length,1);
});
test('native Agent publication cannot use an assisted package; exact MANUAL review creates only its new test release',async t=>{
  const f=await assistedDeliveryFixture();t.after(f.dispose);let task=await f.delivery.createManual(f.input);task=await f.delivery.advance(task.id,task.version);f.complete(task.verificationId);task=await f.delivery.reconcile(task.id);
  const publication=createCloudPublication({...f.options,enabled:true,now:f.now,assertExecutionScope:r=>{assert(r.id===f.agent.id||r.sourceAgentTaskId===f.agent.id&&r.sourceKind==='MANUAL'&&r.sourceRunId===f.run.id);}}),selector={sourceKind:'MANUAL',sourceRunId:f.run.id,packageDigest:task.packageDigest,verificationId:task.verificationId},
    request={agent:f.agent,actorId:f.actor.id,idempotencyKey:'synthetic-new-review',attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true},...selector};
  await assert.rejects(publication.publish({...request,sourceKind:'AGENT'}));await assert.rejects(publication.publish({...request,sourceRunId:f.source.baseline.run.id}));await assert.rejects(publication.publish({...request,packageDigest:'a'.repeat(64)}));
  assert.equal(f.store.list('release_approval',f.project).length,0);
  const result=await publication.publish(request),release=result.release;assert.equal(release.sourceKind,'MANUAL');assert.equal(release.agentIndependentE2E,false);assert.equal(release.sourceRevisionId,f.revision.id);
  assert.equal(f.store.list('release_approval',f.project).length,1);assert.equal(f.store.list('release_run',f.project).length,2);assert.equal(f.counts.submits,2,'publication schedules but does not run a job');
  for(let n=1;n<=3;n++){
    await publication.tick({releaseId:release.id,requestId:sha256('synthetic-assisted-event-'+n),triggerName:'synthetic-assisted-timer',triggerTime:new Date(f.now()).toISOString()});
    for(const batch of f.store.list('release_run',f.project).filter(r=>r.releaseId===release.id&&r.status==='RUNNING'))f.complete(batch.id);
    f.later(60000);
  }
  const done=await publication.detail(f.agent.id,{...selector,releaseId:release.id,actorId:f.actor.id});assert.equal(done.release.status,'COMPLETED_CLOUD_TEST');
  assert.equal(done.runs.length,2);assert(done.runs.every(r=>r.status==='SUCCEEDED'&&r.schedulerTriggered===true&&r.sourceKind==='MANUAL'&&r.agentIndependentE2E===false));
});
test('shared reference schema rejects extra fields, wrong hashes and source/baseline aliasing',()=>{
  const good={kind:'RUN_COMPARISON_REFERENCE',sourceRunId:randomUUID(),sourceRevisionId:randomUUID(),sourceRevisionHash:'a'.repeat(64),initialSqlHash:'a'.repeat(64),baselineRunId:randomUUID(),baselineRevisionHash:'b'.repeat(64),evidenceDigest:'c'.repeat(64)};
  assert.deepEqual(checkedAssistedDevelopmentReference(good),good);assert(sameAssistedDevelopmentReference(good,{...good}));
  for(const value of [{...good,sql:'private'},{...good,baselineRunId:good.sourceRunId},{...good,evidenceDigest:'wrong'},{...good,kind:'AGENT'},{...good,initialSqlHash:'b'.repeat(64)}])assert.throws(()=>checkedAssistedDevelopmentReference(value));
});
