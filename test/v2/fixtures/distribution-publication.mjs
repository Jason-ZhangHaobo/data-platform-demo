import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createV2Server,PROJECT} from '../../../src/v2/server.mjs';
import {MetadataStore} from '../../../src/v2/store.mjs';
import {LocalArtifactStore} from '../../../src/v2/artifact-store.mjs';
import {createDeliveryPackage,loadDeliveryDirectory,sha256} from '../../../src/v2/delivery.mjs';
import {requirementDeliverySource} from './requirement-delivery.mjs';

// All execution/model shapes here are synthetic. Real Spark is separately evidenced.
export async function distributionPublicationFixture(t){
 const root=mkdtempSync(join(tmpdir(),'distribution-publish-')),store=new MetadataStore(':memory:'),artifactStore=new LocalArtifactStore(root);let now=Date.now(),calls=0,failNext=false,hold;
 const app=createV2Server({root,store,artifactStore,env:{V2_LOCAL_DEVELOPMENT:'true'},now:()=>now,releaseTimeUnitMs:1,setTimer:()=>({unref(){}}),clearTimer:()=>{},releaseRunner:async input=>{
  calls++;if(hold){const current=hold;hold=undefined;current.enter();await current.promise;}const {bundle,plan}=loadDeliveryDirectory(input.directory,input.expectedDigest),passed=!failNext;failNext=false;
  return {status:passed?'SUCCEEDED':'VALIDATION_FAILED',executionEvidenceMode:'TEST_HARNESS',source:bundle.manifest.source,fileHashes:Object.fromEntries(Object.entries(bundle.manifest.files).map(([k,v])=>[k,v.sha256])),engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,testSqlValidation:{passed,sqlHash:sha256(bundle.files['tests.sql'])},rows:plan.fixtures.context.expected,validation:{passed,regressions:plan.fixtures.validationContexts.map(c=>({contextId:c.id,passed}))}};
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
