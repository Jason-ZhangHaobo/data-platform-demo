import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {LocalArtifactStore} from '../../src/v2/artifact-store.mjs';
import {createDeliveryPackage,loadDeliveryDirectory,sha256} from '../../src/v2/delivery.mjs';
import {checkedAgentPublication} from '../../web/src/agent-delivery-evidence-read.ts';
import {requirementDeliverySource} from './fixtures/requirement-delivery.mjs';

// All execution/model shapes here are synthetic. Real Spark is separately evidenced.
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'distribution-publish-')),store=new MetadataStore(':memory:'),artifactStore=new LocalArtifactStore(root);let now=Date.now(),calls=0,failNext=false,hold;
 const app=createV2Server({root,store,artifactStore,env:{V2_LOCAL_DEVELOPMENT:'true'},now:()=>now,releaseTimeUnitMs:1,setTimer:()=>({unref(){}}),clearTimer:()=>{},releaseRunner:async input=>{
  calls++;if(hold){const current=hold;hold=undefined;current.enter();await current.promise;}const {bundle,plan}=loadDeliveryDirectory(input.directory,input.expectedDigest),passed=!failNext;failNext=false;
  return {status:passed?'SUCCEEDED':'VALIDATION_FAILED',executionEvidenceMode:'TEST_HARNESS',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,testSqlValidation:{passed,sqlHash:sha256(bundle.files['tests.sql'])},rows:plan.fixtures.context.expected,validation:{passed,regressions:plan.fixtures.validationContexts.map(c=>({contextId:c.id,passed}))}};
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.releaseScheduler.shutdown();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,call=async(path,body,key=randomUUID())=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
 async function packageSource(contextId='holdings-asset-class-t1'){
  const f=requirementDeliverySource(store,PROJECT,{contextId,isolation:'LOCAL_PROCESS'}),bundle=createDeliveryPackage(f),artifact=await artifactStore.put('delivery-package',bundle.digest,bundle),pkg=store.create('delivery_package',PROJECT,{...bundle,artifact});
  const verification=store.create('delivery_verification',PROJECT,{packageId:pkg.id,packageDigest:pkg.digest,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,testSqlValidation:{passed:true,sqlHash:sha256(pkg.files['tests.sql'])},validation:f.validation,rows:f.run.rows});
  store.create('agent_delivery_task',PROJECT,{sourceAgentTaskId:f.agent.id,sourceRunId:f.run.id,sourceRevisionId:f.revision.id,sourceSqlHash:f.revision.hash,status:'SUCCEEDED',stage:'AWAITING_ENGINEER_REVIEW',packageId:pkg.id,packageDigest:pkg.digest,verificationId:verification.id});
  const review=(await call(`/delivery/packages/${pkg.id}/review`,{packageDigest:pkg.digest,verificationId:verification.id,reviewNote:'合成本机测试文件审阅',attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}})).body;
  const consent={scope:'LOCAL_TEST_RELEASE',packageDigest:pkg.digest,verificationId:verification.id,metadataHash:pkg.manifest.source.outputContract.metadataHash,scheduleSpec:{triggerAfterSeconds:5,intervalSeconds:30,runCount:2},confirmFrozenFictionalData:true};
  return {...f,pkg,verification,review,consent};
 }
 async function approve(f){const r=await call(`/delivery/packages/${f.pkg.id}/approve`,{packageDigest:f.pkg.digest,reviewId:f.review.id,distributionConsent:f.consent});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
 async function publish(f){const approval=await approve(f),r=await call('/releases',{approvalId:approval.id,...f.consent.scheduleSpec});assert.equal(r.status,201,JSON.stringify(r.body));return{approval,release:r.body};}
 async function runNext(releaseId){const run=store.list('release_run',PROJECT).filter(r=>r.releaseId===releaseId&&r.status==='SCHEDULED').sort((a,b)=>Date.parse(a.scheduledTriggerAt)-Date.parse(b.scheduledTriggerAt))[0];assert(run);now=Math.max(now,Date.parse(run.scheduledTriggerAt));await app.releaseScheduler.enqueue(run.id);return store.get('release_run',run.id,PROJECT);}
 return{store,app,call,packageSource,approve,publish,runNext,holdNext:()=>{let enter,resolve;const entered=new Promise(r=>{enter=r;}),promise=new Promise(r=>{resolve=r;});hold={enter,promise};return{entered,resolve};},failNext:()=>{failNext=true;},calls:()=>calls};
}
test('explicit distribution consent binds metadata/two-batch plan and concurrent release submissions recover one release',async t=>{
 const f=await fixture(t),p=await f.packageSource();
 for(const consent of [undefined,{...p.consent,confirmFrozenFictionalData:false},{...p.consent,metadataHash:'0'.repeat(64)},{...p.consent,scheduleSpec:{...p.consent.scheduleSpec,runCount:3}}])assert.equal((await f.call(`/delivery/packages/${p.pkg.id}/approve`,{packageDigest:p.pkg.digest,reviewId:p.review.id,...(consent?{distributionConsent:consent}:{})})).status,409);
 const approval=await f.approve(p);assert.equal(f.store.list('release',PROJECT).length,0);
 assert.equal((await f.call('/releases',{approvalId:approval.id,...p.consent.scheduleSpec,intervalSeconds:2})).status,409);
 const results=await Promise.all([f.call('/releases',{approvalId:approval.id,...p.consent.scheduleSpec},'client-a'),f.call('/releases',{approvalId:approval.id,...p.consent.scheduleSpec},'client-b')]);
 assert(results.every(r=>[200,201].includes(r.status)));assert.equal(results[0].body.id,results[1].body.id);const id=results[0].body.id;
 assert.equal(f.store.list('release_run',PROJECT).length,2);await f.runNext(id);assert.equal(f.store.get('release',id,PROJECT).health,'OBSERVING');await f.runNext(id);assert.equal(f.store.get('release',id,PROJECT).health,'HEALTHY');assert.equal(f.calls(),2);
});
test('source drift and stopping during directory resolution prevent computation; repeated stop is idempotent',async t=>{
 const f=await fixture(t),p=await f.packageSource(),{release}=await f.publish(p),r=structuredClone(p.agent.requirements);r.interpretation.summary+=' changed';f.store.update('agent',p.agent.id,PROJECT,{requirements:r});
 await f.runNext(release.id);assert.equal(f.calls(),0);assert.equal(f.store.get('release',release.id,PROJECT).health,'CRITICAL');
 const q=await f.packageSource(),next=await f.publish(q);f.app.releaseScheduler.resolveDirectory=async({release})=>{assert.equal((await f.call(`/releases/${release.id}/cancel`,{packageDigest:release.packageDigest})).status,200);return release.artifactDirectory;};
 await f.runNext(next.release.id);assert.equal(f.calls(),0);assert(f.store.list('release_run',PROJECT).filter(r=>r.releaseId===next.release.id).every(r=>r.status==='CANCELLED'));
 assert.equal((await f.call(`/releases/${next.release.id}/cancel`,{packageDigest:q.pkg.digest})).status,200);assert.equal(f.store.list('monitor_event',PROJECT).filter(e=>e.releaseId===next.release.id&&e.type==='RELEASE_CANCELLED').length,1);
});
test('rollback is atomic/idempotent and only two new recovery successes resolve prior alerts; unrelated distribution lanes stay active',async t=>{
 const f=await fixture(t),a=await f.packageSource(),first=await f.publish(a);await f.runNext(first.release.id);await f.runNext(first.release.id);
 const industry=await f.packageSource('holdings-industry-t1'),other=await f.publish(industry);assert.equal(f.store.get('release',first.release.id,PROJECT).status,'ACTIVE_LOCAL');
 const b=await f.packageSource(),second=await f.publish(b);assert.equal(f.store.get('release',other.release.id,PROJECT).status,'ACTIVE_LOCAL');f.failNext();await f.runNext(second.release.id);
 const body={targetReleaseId:first.release.id,reason:'回滚至同族已验证历史包',distributionRollback:{scope:'LOCAL_TEST_RELEASE',targetPackageDigest:a.pkg.digest,metadataHash:a.pkg.manifest.source.outputContract.metadataHash,confirmFrozenFictionalData:true}};
 assert.equal((await f.call(`/releases/${second.release.id}/rollback`,{...body,distributionRollback:{...body.distributionRollback,metadataHash:'0'.repeat(64)}})).status,409);
 const create=f.store.create.bind(f.store);let injected=false;f.store.create=(kind,...args)=>{if(kind==='release_run'&&!injected){injected=true;throw Error('synthetic rollback DB write failure');}return create(kind,...args);};
 const broken=await f.call(`/releases/${second.release.id}/rollback`,body,'rollback-once');assert(broken.status>=500);assert.equal(f.store.get('release',second.release.id,PROJECT).status,'ACTIVE_LOCAL');assert.equal(f.store.get('release',first.release.id,PROJECT).status,'SUPERSEDED_LOCAL');assert.equal(f.store.list('release_rollback',PROJECT).length,0);f.store.create=create;
 const rollback=await f.call(`/releases/${second.release.id}/rollback`,body,'rollback-once');assert.equal(rollback.status,202,JSON.stringify(rollback.body));assert.equal((await f.call(`/releases/${second.release.id}/rollback`,body,'rollback-once')).body.rollback.id,rollback.body.rollback.id);
 assert.equal(f.store.list('release_run',PROJECT).filter(r=>r.rollbackId===rollback.body.rollback.id).length,2);assert.equal(f.store.list('monitor_alert',PROJECT).filter(a=>a.releaseId===second.release.id&&a.status==='OPEN').length,1);
 await f.runNext(first.release.id);assert.equal(f.store.get('release',first.release.id,PROJECT).health,'OBSERVING');assert.equal(f.store.list('monitor_alert',PROJECT).filter(a=>a.releaseId===second.release.id&&a.status==='OPEN').length,1);
 await f.runNext(first.release.id);assert.equal(f.store.get('release',first.release.id,PROJECT).health,'HEALTHY');assert.equal(f.store.get('release_rollback',rollback.body.rollback.id,PROJECT).status,'VERIFIED');assert.equal(f.store.list('monitor_alert',PROJECT).filter(a=>a.releaseId===second.release.id&&a.status==='OPEN').length,0);
 const view=(await f.call(`/agent/tasks/${a.agent.id}/publication`)).body;assert.equal(view.runs.length,2);assert.equal(view.historyRunCount,2);assert(view.runs.every(r=>r.status==='SUCCEEDED'));checkedAgentPublication(view,{taskId:a.agent.id,scope:'LOCAL_TEST_RELEASE'});
});

test('stopping an in-flight distribution batch preserves cancellation instead of reporting a failure or success',async t=>{
 const f=await fixture(t),p=await f.packageSource(),{release}=await f.publish(p),hold=f.holdNext(),running=f.runNext(release.id);await hold.entered;
 assert.equal((await f.call(`/releases/${release.id}/cancel`,{packageDigest:p.pkg.digest})).status,200);hold.resolve();const result=await running;
 assert.equal(result.status,'CANCELLED');assert.equal(f.store.get('release',release.id,PROJECT).health,'STOPPED');assert.equal(f.store.list('monitor_alert',PROJECT).filter(a=>a.releaseId===release.id).length,0);
});
