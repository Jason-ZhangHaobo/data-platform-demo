import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {manualSuccessFixture} from './fixtures/manual-success-continuation.mjs';
import {createStandaloneManualDelivery} from '../../src/v2/agent-development-workflow.mjs';
import {createDeliveryPackage,validateDeliveryPackage,computeManifestDigest} from '../../src/v2/delivery.mjs';
const setup=t=>{const f=manualSuccessFixture();t.after(f.dispose);const options={...f.options,artifactStore:f.artifactStore},engine=createStandaloneManualDelivery(options),input={actorId:f.actor.id,key:randomUUID(),sourceBinding:f.proof().binding};return{...f,options,engine,input};};
test('standalone manual delivery produces eight immutable files and one rehearsal with no Agent or model dependency',async t=>{
 const f=setup(t),original=structuredClone({run:f.run,revision:f.revision});let task=await f.engine.create(f.input);
 assert.equal(task.mode,'DURABLE_MANUAL_DELIVERY_V1');assert.equal(task.modelRequired,false);assert.equal(task.sourceKind,'MANUAL');assert.equal(task.sourceAttribution,'ENGINEER_AUTHORED');assert.equal(task.sourceAgentTaskId,undefined);assert.equal(task.agentIndependentE2E,false);assert.equal(task.source.runId,f.run.id);
 const pack=f.store.get('delivery_package',task.packageId,f.project),plan=validateDeliveryPackage(pack,pack.digest);
 assert.equal(Object.keys(pack.files).length,8);assert.equal(plan.source.attribution.kind,'ENGINEER_AUTHORED');assert.equal(plan.source.attribution.originAgentTaskId,undefined);assert.equal(plan.source.attribution.actorId,f.actor.id);assert.deepEqual(plan.source.attribution.developmentReference,f.proof().developmentReference);
 for(const key of[f.input.key,randomUUID()])assert.equal((await f.engine.create({...f.input,key})).id,task.id);
 assert.equal(f.counts.submits,0);task=await f.engine.advance(task.id,task.version);assert.equal(f.counts.submits,1);f.store.interruptPending(f.project);assert.equal(f.store.get('delivery_verification',task.verificationId,f.project).status,'RUNNING');assert.equal(f.store.get('manual_delivery_task',task.id,f.project).status,'RUNNING');f.complete(task.verificationId);task=await createStandaloneManualDelivery(f.options).reconcile(task.id);
 assert.equal(task.status,'SUCCEEDED');assert.equal(task.stage,'AWAITING_ENGINEER_REVIEW');const v=f.store.get('delivery_verification',task.verificationId,f.project);assert.equal(v.manualDeliveryTaskId,task.id);assert.equal(v.agentDeliveryTaskId,undefined);
 assert.equal(f.counts.model,0);assert.equal(f.store.list('agent',f.project).length,0);assert.equal(f.store.list('agent_delivery_task',f.project).length,0);assert.equal(f.store.list('manual_delivery_task',f.project).length,1);assert.equal(f.store.list('delivery_package',f.project).length,1);assert.equal(f.store.list('release_approval',f.project).length,0);assert.deepEqual({run:f.store.get('run',f.run.id,f.project),revision:f.store.get('revision',f.revision.id,f.project)},original);
});
test('lost artifact and submit acknowledgements restore original package and job without model or duplicate Spark',async t=>{
 const f=setup(t),put=f.artifactStore.put.bind(f.artifactStore);let lost=true;const artifacts={...f.artifactStore,put:async(...args)=>{const v=await put(...args);if(lost){lost=false;throw Error('synthetic unknown PUT');}return v;},verify:f.artifactStore.verify.bind(f.artifactStore)};
 await assert.rejects(createStandaloneManualDelivery({...f.options,artifactStore:artifacts}).create(f.input));const pending=f.store.list('manual_delivery_task',f.project)[0],task=await f.engine.create(f.input);assert.equal(task.id,pending.id);
 const runner={...f.runner,submit:async p=>{await f.runner.submit(p);f.complete(p.job.jobId);throw Error('synthetic unknown submit');}},engine=createStandaloneManualDelivery({...f.options,runner});
 await assert.rejects(engine.advance(task.id,task.version));const retained=f.store.get('manual_delivery_task',task.id,f.project),restored=await f.engine.advance(task.id,retained.version);assert.equal(restored.status,'SUCCEEDED');assert.equal(f.counts.submits,1);assert.equal(f.store.list('delivery_verification',f.project).length,1);
});
test('changed source, foreign author and invalid provenance cannot prepare a package',async t=>{
 const f=setup(t);await assert.rejects(f.engine.create({...f.input,actorId:randomUUID()}));
 const forged={...f.input.sourceBinding,revisionHash:'a'.repeat(64)};await assert.rejects(f.engine.create({...f.input,sourceBinding:forged}));
 for(const patch of[{status:'FAILED'},{agentTaskId:randomUUID()},{rows:[]},{testDouble:true}]){f.store.update('run',f.run.id,f.project,patch);await assert.rejects(f.engine.create(f.input));f.store.update('run',f.run.id,f.project,{...f.run,agentTaskId:undefined,testDouble:undefined});}
 assert.equal(f.store.list('manual_delivery_task',f.project).length,0);assert.equal(f.counts.submits,0);
});
test('scope and source are rechecked after artifact awaits and durable queue persistence before computation',async t=>{
 for(const boundary of['put','verify','persist'])await t.test(boundary,async t=>{
  const f=setup(t);let armed=false,revoked=false;const drift=()=>{if(armed)revoked=true;},artifacts={put:async(...a)=>{const v=await f.artifactStore.put(...a);if(boundary==='put')drift();return v;},verify:async(...a)=>{const v=await f.artifactStore.verify(...a);if(boundary==='verify')drift();return v;}},options={...f.options,artifactStore:artifacts,assertExecutionScope:()=>{if(revoked)throw Error('synthetic revoked role');},persist:async()=>{if(boundary==='persist')drift();}},engine=createStandaloneManualDelivery(options);
  if(boundary==='put'){armed=true;await assert.rejects(engine.create(f.input));}else{let task=await engine.create(f.input);armed=true;await assert.rejects(engine.advance(task.id,task.version));}
  assert.equal(f.counts.submits,0);assert.equal(f.counts.model,0);
 });
});
test('source drift prevents new computation while original task can be read and cancelled',async t=>{
 const f=setup(t),task=await f.engine.create(f.input);f.store.update('run',f.run.id,f.project,{log:'synthetic source changed'});
 await assert.rejects(f.engine.advance(task.id,task.version));assert.equal((await f.engine.reconcile(task.id)).id,task.id);assert.equal((await f.engine.cancel(task.id)).status,'CANCELLED');assert.equal(f.counts.submits,0);
});
test('saved manual package attribution is immutable and remains manual even outside the new workflow',async t=>{
 const f=setup(t),bundle=createDeliveryPackage({run:f.run,revision:f.revision});assert.equal(bundle.manifest.source.attribution.kind,'ENGINEER_AUTHORED');
 const invalid=structuredClone(bundle);invalid.manifest.source.attribution.agentIndependentE2E=true;invalid.digest=computeManifestDigest(invalid.manifest);assert.throws(()=>validateDeliveryPackage(invalid,invalid.digest));
});
test('cancellation during awaited storage cannot queue an extra verification',async t=>{
 for(const boundary of['verification','persistence'])await t.test(boundary,async t=>{
  const f=setup(t);let stop=false,engine;const artifacts={put:f.artifactStore.put.bind(f.artifactStore),verify:async(...args)=>{const v=await f.artifactStore.verify(...args);if(stop&&boundary==='verification'){stop=false;await engine.cancel(task.id);}return v;}},options={...f.options,artifactStore:artifacts,persist:async()=>{if(stop&&boundary==='persistence'&&f.store.get('manual_delivery_task',task.id,f.project).remoteSubmission){stop=false;await engine.cancel(task.id);}}};
  engine=createStandaloneManualDelivery(options);const task=await engine.create(f.input);stop=true;const result=await engine.advance(task.id,task.version);assert.equal(result.status,'CANCELLED');assert.equal(f.counts.submits,0);assert.equal(f.store.list('delivery_verification',f.project).length,boundary==='verification'?0:1);
 });
});
