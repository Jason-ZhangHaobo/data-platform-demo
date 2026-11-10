import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {loadDeliveryDirectory,sha256,createDeliveryPackage} from '../../src/v2/delivery.mjs';
import {LocalArtifactStore} from '../../src/v2/artifact-store.mjs';
import {requirementDeliverySource} from './fixtures/requirement-delivery.mjs';
import {checkedAgentWorkflow} from '../../web/src/agent-workflow-read.ts';

test('an imported synthetic approval cannot bypass distribution consent and source verification',async t=>{
 const root=mkdtempSync(join(tmpdir(),'distribution-release-deny-')),store=new MetadataStore(':memory:'),artifactStore=new LocalArtifactStore(root);
 const f=requirementDeliverySource(store,PROJECT,{contextId:'holdings-industry-t1',isolation:'LOCAL_PROCESS'}),bundle=createDeliveryPackage(f),artifact=await artifactStore.put('delivery-package',bundle.digest,bundle);
 const item=store.create('delivery_package',PROJECT,{...bundle,artifact});
 const approval=store.create('release_approval',PROJECT,{packageId:item.id,packageDigest:item.digest,sourceSqlHash:f.revision.hash,status:'APPROVED',executionEvidenceMode:'TEST_HARNESS'});
 const app=createV2Server({root,store,artifactStore,env:{V2_LOCAL_DEVELOPMENT:'true'},runner:async()=>{throw Error('No execution is allowed');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
 const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/releases`,{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':'closed-distribution-release'},body:JSON.stringify({approvalId:approval.id})});
 assert.equal(response.status,409);assert.equal((await response.json()).code,'DISTRIBUTION_PUBLICATION_SOURCE_CHANGED');assert.equal(store.list('release',PROJECT).length,0);
});

// Protocol/SQLite tests only: the file runner below is synthetic, not Spark evidence.
test('local distribution preparation, recovery and review bind one exact metadata/package/rehearsal; publication stays closed',async t=>{
 const root=mkdtempSync(join(tmpdir(),'distribution-files-')),store=new MetadataStore(join(root,'metadata.sqlite'));
 const f=requirementDeliverySource(store,PROJECT,{contextId:'holdings-asset-class-t1',isolation:'LOCAL_PROCESS'});
 store.update('agent',f.agent.id,PROJECT,{executionMode:'ORDINARY_LOCAL_FIXTURE'});let rehearsals=0;
 const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'},deliveryRunner:async({directory,expectedDigest})=>{
  rehearsals++;const {bundle,plan}=loadDeliveryDirectory(directory,expectedDigest);assert.equal(plan.fixtures.outputContract.fields.length,6);
  return {status:'SUCCEEDED',executionEvidenceMode:'TEST_HARNESS',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,
   rows:plan.fixtures.context.expected,validation:f.validation,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])}};
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 const call=async(path,body,key=randomUUID())=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 const first=await call(`/agent/tasks/${f.agent.id}/prepare-delivery`,{},'prepare-once');assert.equal(first.status,202);
 let workflow;for(let n=0;n<100;n++){workflow=(await call(`/agent/tasks/${f.agent.id}/workflow`)).body;if(workflow.delivery?.status==='SUCCEEDED')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(workflow.delivery.status,'SUCCEEDED',workflow.delivery.error);assert.equal(rehearsals,1);assert.equal(workflow.publication.available,true);
 const checked=await checkedAgentWorkflow(workflow,{taskId:f.agent.id,contextId:f.agent.contextId,revisionId:f.revision.id,runId:f.run.id,manual:false});assert.equal(checked.report.status,'PASSED');
 assert.equal((await call(`/agent/tasks/${f.agent.id}/prepare-delivery`,{},'prepare-once')).body.id,first.body.id);assert.equal(rehearsals,1);
 const pkg=workflow.package,verification=workflow.verification;
 const body={packageDigest:pkg.digest,verificationId:verification.id,reviewNote:'本机虚构分布文件审阅，不代表发布批准',attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}};
 assert.equal((await call(`/delivery/packages/${pkg.id}/review`,{...body,packageDigest:'0'.repeat(64)})).status,409);
 const other=store.create('delivery_verification',PROJECT,{packageId:'other',packageDigest:pkg.digest,status:'SUCCEEDED'});
 assert.equal((await call(`/delivery/packages/${pkg.id}/review`,{...body,verificationId:other.id})).status,409);
 const review=await call(`/delivery/packages/${pkg.id}/review`,body,'review-once');assert.equal(review.status,201);assert.equal(review.body.scope,'LOCAL_FILE_REVIEW');
 assert.equal((await call(`/delivery/packages/${pkg.id}/review`,body,'review-once')).body.id,review.body.id);
 workflow=(await call(`/agent/tasks/${f.agent.id}/workflow`)).body;assert.equal(workflow.fileReview.id,review.body.id);await checkedAgentWorkflow(workflow,{taskId:f.agent.id,contextId:f.agent.contextId,revisionId:f.revision.id,runId:f.run.id,manual:false});
 const swapped=structuredClone(workflow);swapped.fileReview.packageDigest='0'.repeat(64);await assert.rejects(checkedAgentWorkflow(swapped,{taskId:f.agent.id,manual:false}));
 const approval=await call(`/delivery/packages/${pkg.id}/approve`,{packageDigest:pkg.digest,reviewId:review.body.id});assert.equal(approval.status,409);
 const task=store.get('agent',f.agent.id,PROJECT),requirements=structuredClone(task.requirements);requirements.interpretation.summary+=' 已变化';store.update('agent',task.id,PROJECT,{requirements});
 assert.equal((await call(`/delivery/packages/${pkg.id}/review`,body)).status,409);
 assert.equal(store.list('delivery_review',PROJECT).length,1);assert.equal(store.list('release_approval',PROJECT).length,0);assert.equal(store.list('release',PROJECT).length,0);assert.equal(rehearsals,1);
});
