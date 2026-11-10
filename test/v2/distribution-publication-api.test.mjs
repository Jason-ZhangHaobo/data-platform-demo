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

import {distributionPublicationFixture as fixture} from './fixtures/distribution-publication.mjs';
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
