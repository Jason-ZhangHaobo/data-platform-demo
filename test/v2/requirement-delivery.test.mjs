import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MetadataStore} from '../../src/v2/store.mjs';import {LocalArtifactStore} from '../../src/v2/artifact-store.mjs';
import {createDeliveryPackage,validateDeliveryPackage,computeManifestDigest,sha256,deliveryFiles,unpackDeliveryPackage,loadDeliveryDirectory} from '../../src/v2/delivery.mjs';
import {assertSqlRequirementPackageSource,sqlRequirementBinding} from '../../src/v2/sql-requirements.mjs';
import {createDurableAgentDelivery} from '../../src/v2/agent-development-workflow.mjs';import {createCloudPublication} from '../../src/v2/cloud-publication.mjs';
import {requirementDeliverySource,requirementPublicationFixture} from './fixtures/requirement-delivery.mjs';
import {checkedAgentWorkflow,frozenRequirementProposal} from '../../web/src/agent-workflow-read.ts';
import {developmentVerificationReport} from '../../src/v2/agent-development-workflow.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';

function setup(t,project='synthetic-securities'){const root=mkdtempSync(join(tmpdir(),'shuduo-frozen-requirement-'));let store=new MetadataStore(join(root,'metadata.sqlite'));
 const artifactStore=new LocalArtifactStore(join(root,'artifacts'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,get store(){return store;},project,artifactStore,reopen(){store.close();store=new MetadataStore(join(root,'metadata.sqlite'));}};}
const resign=b=>{for(const name of deliveryFiles)b.manifest.files[name]={sha256:sha256(b.files[name]),bytes:Buffer.byteLength(b.files[name])};b.digest=computeManifestDigest(b.manifest);return b;};
const changeReport=(store,project,agent)=>{const r=structuredClone(store.get('agent',agent.id,project).requirements);r.interpretation.summary+=' 已变更';store.update('agent',agent.id,project,{requirements:r});};

test('new evidence freezes into the original eight files and survives file/digest roundtrip; legacy and manual provenance stay separate',t=>{
 const f=setup(t),source=requirementDeliverySource(f.store,f.project),bundle=createDeliveryPackage(source),plan=validateDeliveryPackage(bundle,bundle.digest);
 assert.deepEqual(Object.keys(bundle.files).sort(),[...deliveryFiles].sort());assert.equal(Object.keys(bundle.files).length,8);
 assert.deepEqual(plan.requirements,source.agent.requirements);assert.deepEqual(bundle.manifest.source.requirement,sqlRequirementBinding(plan.requirements));
 const dir=join(f.root,'package');unpackDeliveryPackage(bundle,dir,bundle.digest);assert.deepEqual(loadDeliveryDirectory(dir,bundle.digest).bundle,bundle);
 source.agent.requirements.interpretation.summary='changed in memory';assert.notEqual(JSON.parse(bundle.files['validation.json']).requirements.interpretation.summary,source.agent.requirements.interpretation.summary);
 const assisted=requirementDeliverySource(f.store,f.project,{assisted:true}),manual=createDeliveryPackage(assisted);
 assert.equal(manual.manifest.source.attribution.kind,'ENGINEER_ASSISTED');assert.equal(validateDeliveryPackage(manual,manual.digest).requirements.taskId,assisted.agent.id);
 const legacy={run:source.run,revision:{...source.revision}};delete legacy.revision.requirementBinding;
 const old=createDeliveryPackage(legacy);assert.equal(old.manifest.source.requirement,undefined);assert.equal(validateDeliveryPackage(old,old.digest).requirements,undefined);
});
test('dropping, substituting or adding unknown requirement fields cannot pass even after all inner hashes are recomputed',t=>{
 const f=setup(t),source=requirementDeliverySource(f.store,f.project),original=createDeliveryPackage(source);
 for(const mutate of [
  (b,p)=>{delete p.requirements;},(b,p)=>{delete b.manifest.source.requirement;},
  (b,p)=>{p.requirements.basis.digest='0'.repeat(64);},(b,p)=>{p.requirements.request+='changed';},
  (b,p)=>{p.requirements.interpretation.metrics[0].sourceFields=['accounts.fake'];},
  (b,p)=>{p.requirements.debugSecret='must-not-be-archived';b.manifest.source.requirement=sqlRequirementBinding(p.requirements);},
  (b,p)=>{b.manifest.source.requirement.extra=true;},
  (b,p)=>{b.manifest.source.attribution={kind:'ENGINEER_AUTHORED',actorId:source.actor,agentIndependentE2E:false};},
 ]){const b=structuredClone(original),p=JSON.parse(b.files['validation.json']);mutate(b,p);b.files['validation.json']=JSON.stringify(p);resign(b);assert.throws(()=>validateDeliveryPackage(b,b.digest));}
 assert.throws(()=>createDeliveryPackage({run:source.run,revision:source.revision}),e=>e.code==='REQUIREMENT_DELIVERY_SOURCE_CHANGED');
 changeReport(f.store,f.project,source.agent);const latest=f.store.get('agent',source.agent.id,f.project);
 assert.throws(()=>createDeliveryPackage({...source,agent:latest}),e=>e.code==='REQUIREMENT_DELIVERY_SOURCE_CHANGED');
 assert.throws(()=>assertSqlRequirementPackageSource(original,{...source,agent:{...latest,requirements:undefined},revision:{...source.revision,requirementBinding:undefined}}));
});
test('durable preparation checks evidence after artifact I/O and before resuming or queue submission',async t=>{
 for(const phase of ['put','resume','persist']){
  const f=setup(t),source=requirementDeliverySource(f.store,f.project);let submits=0;
  const runner={prepare:(_input,id)=>({job:{jobId:id}}),submit:async()=>{submits++;},read:async()=>undefined,cancel:async()=>{}};
  const put=f.artifactStore.put.bind(f.artifactStore);if(phase==='put')f.artifactStore.put=async(...args)=>{const r=await put(...args);changeReport(f.store,f.project,source.agent);return r;};
  let persisted=false;
  const engine=createDurableAgentDelivery({...f,runner,persist:async()=>{if(phase==='persist'&&!persisted&&f.store.list('delivery_verification',f.project).length){persisted=true;changeReport(f.store,f.project,source.agent);}}});
  if(phase==='put'){await assert.rejects(engine.create(source.agent,'same-request'));assert.equal(f.store.list('agent_delivery_task',f.project).length,0);}
  else {const created=await engine.create(source.agent,'same-request');assert.deepEqual(created.sourceRequirementBinding,sqlRequirementBinding(source.agent.requirements));
   if(phase==='resume')changeReport(f.store,f.project,source.agent);
   await assert.rejects(engine.advance(created.id,created.version));assert.equal(f.store.list('agent_delivery_task',f.project).length,1);}
  assert.equal(submits,0);
 }
});
test('cloud review rechecks requirements after verification; changed understanding never creates approval or submits a frozen job',async t=>{
 for(const phase of ['review','submit']){
  const f=setup(t),source=await requirementPublicationFixture(f);let submissions=0,clock=Date.now(),persistChanged=false;
  const verify=f.artifactStore.verify.bind(f.artifactStore);if(phase==='review')f.artifactStore.verify=async(...args)=>{await verify(...args);changeReport(f.store,f.project,source.agent);};
  const engine=createCloudPublication({...f,enabled:true,now:()=>clock,runner:{prepare:(_input,id)=>({job:{jobId:id}}),submit:async()=>{submissions++;},read:async()=>undefined,cancel:async()=>{}},
   persist:async()=>{if(phase==='submit'&&!persistChanged&&f.store.list('release_run',f.project).some(r=>r.remoteSubmission)){persistChanged=true;changeReport(f.store,f.project,source.agent);}}});
  const input={agent:source.agent,actorId:source.actor,packageDigest:source.item.digest,verificationId:source.verification.id,idempotencyKey:'same-version',attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true}};
  if(phase==='review'){await assert.rejects(engine.publish(input));assert.equal(f.store.list('release_approval',f.project).length,0);}
  else {const result=await engine.publish(input);assert.equal(f.store.list('release_approval',f.project).length,1);
   await assert.rejects(engine.tick({releaseId:result.release.id,requestId:sha256('event'),triggerName:'synthetic-only',triggerTime:new Date(clock).toISOString()}));}
  assert.equal(submissions,0);
 }
});
test('the browser reader checks frozen report/basis hashes and shows exact same-task evidence, without changing files',async t=>{
 const f=setup(t),source=await requirementPublicationFixture(f),value={report:developmentVerificationReport(source.agent,source.run,source.revision),delivery:source.delivery,
  package:source.item,verification:source.verification,publication:{available:false,scope:'LOCAL_TEST_RELEASE',reason:'synthetic UI receipt'}};
 const selection={taskId:source.agent.id,contextId:source.agent.contextId,manual:false},before=JSON.stringify(value);
 await checkedAgentWorkflow(value,selection);assert.deepEqual(frozenRequirementProposal(value.package,source.agent.id),source.agent.requirements);assert.equal(JSON.stringify(value),before);
 const bad=structuredClone(value),p=JSON.parse(bad.package.files['validation.json']);p.requirements.interpretation.summary+='changed';bad.package.files['validation.json']=JSON.stringify(p);resign(bad.package);
 bad.delivery.packageDigest=bad.package.digest;await assert.rejects(checkedAgentWorkflow(bad,selection),/未确认/);
});
test('SQLite/controller recovery retains the same frozen package and submits one rehearsal without regenerating evidence',async t=>{
 const f=setup(t),source=requirementDeliverySource(f.store,f.project);let puts=0,submitted=0,prepared=0;
 const put=f.artifactStore.put.bind(f.artifactStore);f.artifactStore.put=async(...args)=>{puts++;return put(...args);};
 const runner={prepare:(input,id)=>{prepared++;return {job:{jobId:id},input};},submit:async()=>{submitted++;},cancel:async()=>{},
  read:async p=>submitted?{status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,validation:source.validation,
   testSqlValidation:{passed:true,sqlHash:sha256(p.input.testSql)}}:undefined};
 let engine=createDurableAgentDelivery({...f,runner,persist:async()=>{}}),task=await engine.create(source.agent,'original-request');
 const original={id:task.id,packageId:task.packageId,digest:task.packageDigest,binding:task.sourceRequirementBinding};
 f.reopen();engine=createDurableAgentDelivery({...f,runner,persist:async()=>{}});
 const restored=await engine.create(f.store.get('agent',source.agent.id,f.project),'original-request');assert.equal(restored.id,original.id);assert.equal(restored.packageId,original.packageId);
 task=await engine.advance(restored.id,restored.version);assert.equal(task.status,'SUCCEEDED');assert.equal(task.packageDigest,original.digest);assert.deepEqual(task.sourceRequirementBinding,original.binding);
 assert.equal(puts,1);assert.equal(prepared,1);assert.equal(submitted,1);assert.equal((await engine.advance(task.id,task.version)).status,'SUCCEEDED');assert.equal(submitted,1);
});
test('an original verified task may prepare a new frozen package without reusing a legacy package or its approval',async t=>{
 const f=setup(t),source=requirementDeliverySource(f.store,f.project),revision={...source.revision};delete revision.requirementBinding;
 const old=f.store.create('delivery_package',f.project,createDeliveryPackage({run:source.run,revision}));
 const oldTask=f.store.create('agent_delivery_task',f.project,{mode:'DURABLE_AGENT_DELIVERY_V1',sourceAgentTaskId:source.agent.id,sourceRevisionId:revision.id,sourceRunId:source.run.id,
  sourceSqlHash:revision.hash,status:'SUCCEEDED',packageId:old.id,packageDigest:old.digest});
 f.store.create('release_approval',f.project,{packageId:old.id,packageDigest:old.digest,status:'APPROVED'});
 let submissions=0;const engine=createDurableAgentDelivery({...f,persist:async()=>{},runner:{prepare:()=>{},submit:async()=>{submissions++;},read:async()=>{},cancel:async()=>{}}});
 const current=await engine.create(source.agent,'explicit-new-preparation');assert.notEqual(current.id,oldTask.id);assert.notEqual(current.packageId,old.id);
 assert.ok(current.sourceRequirementBinding);assert.equal(f.store.get('delivery_package',old.id,f.project).digest,old.digest);
 assert.equal(f.store.list('release_approval',f.project).length,1);assert.equal(submissions,0);
});
test('actual HTTP creation/review freezes requirements and cannot approve changed understanding or a new package with an old review',async t=>{
 const f=setup(t,PROJECT),source=requirementDeliverySource(f.store,f.project),app=createV2Server({store:f.store,artifactStore:f.artifactStore,
  env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},runner:async()=>{assert.fail('this HTTP test must not run Spark');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 const post=async(path,body)=>{const r=await fetch(origin+'/api/v2'+path,{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const first=await post('/delivery/packages',{sourceRunId:source.run.id});assert.equal(first.status,201);const bundle=first.body;
 assert.deepEqual(validateDeliveryPackage(bundle,bundle.digest).requirements,source.agent.requirements);
 const verification=f.store.create('delivery_verification',f.project,{packageId:bundle.id,packageDigest:bundle.digest,status:'SUCCEEDED'});
 const reviewed=await post(`/delivery/packages/${bundle.id}/review`,{packageDigest:bundle.digest,verificationId:verification.id,reviewNote:'合成HTTP审阅，非真实业务批准',attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}});assert.equal(reviewed.status,201);
 changeReport(f.store,f.project,source.agent);
 const rejected=await post(`/delivery/packages/${bundle.id}/approve`,{packageDigest:bundle.digest,reviewId:reviewed.body.id});assert.equal(rejected.status,409);assert.equal(f.store.list('release_approval',f.project).length,0);
 f.store.update('agent',source.agent.id,f.project,{requirements:source.agent.requirements});
 const approved=await post(`/delivery/packages/${bundle.id}/approve`,{packageDigest:bundle.digest,reviewId:reviewed.body.id});assert.equal(approved.status,201);
 const changed=requirementDeliverySource(f.store,f.project,{message:'【合成口径意图变更】再次核对股票与现金的独立聚合'}),next=await post('/delivery/packages',{sourceRunId:changed.run.id});assert.equal(next.status,201);assert.notEqual(next.body.digest,bundle.digest);
 const borrowed=await post(`/delivery/packages/${next.body.id}/approve`,{packageDigest:next.body.digest,reviewId:reviewed.body.id});assert.equal(borrowed.status,409);assert.equal(f.store.list('release_approval',f.project).length,1);
});
