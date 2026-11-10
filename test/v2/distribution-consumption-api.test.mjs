import {checkedAgentConsumption} from '../../web/src/agent-delivery-evidence-read.ts';
import {serviceHash} from '../../src/v2/data-services.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {distributionPublicationFixture as fixture} from './fixtures/distribution-publication.mjs';
import {certifiedDistributionSource} from '../../src/v2/distribution-service-source.mjs';
import {PROJECT} from '../../src/v2/server.mjs';
import {sourceRunEligible,sourceRunMatches} from '../../web/src/service-source-binding.ts';

test('HTTP distribution DAPI/XAPI consumes only a certified same-version two-batch release, with provenance, pagination, grants and revocation',async t=>{
 const f=await fixture(t),p=await f.packageSource(),{release}=await f.publish(p),query=`?agent_task_id=${p.agent.id}&package_digest=${p.pkg.digest}&release_id=${release.id}`;
 assert.deepEqual((await f.call('/data-services/sources'+query)).body,[]);await f.runNext(release.id);assert.deepEqual((await f.call('/data-services/sources'+query)).body,[]);await f.runNext(release.id);
 certifiedDistributionSource({store:f.store,project:PROJECT,run:f.store.list('release_run',PROJECT)[0]});
 const sources=(await f.call('/data-services/sources'+query)).body;assert.equal(sources.length,2);assert(sources.every(sourceRunEligible));assert(sources.every(r=>r.sourceEvidence.agentIndependentE2E===false&&r.sourceEvidence.engineClassification==='TEST_HARNESS'));
 const binding={taskId:p.agent.id,packageDigest:p.pkg.digest,releaseId:release.id,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',revisionId:p.revision.id,runId:p.run.id};assert(sources.every(r=>sourceRunMatches(r,binding)));
 const source=sources[0];
 async function create(slug,fields){const body={name:'合成分布接口 '+slug,slug,sourceReleaseRunId:source.id,fields};const created=await f.call('/data-services/dapis',body,slug);assert.equal(created.status,201,JSON.stringify(created.body));assert.equal((await f.call('/data-services/dapis',body,slug)).body.id,created.body.id);
  const s=created.body;assert.equal((await f.call(`/data-services/dapis/${s.id}/test`,{pageSize:1})).body.test.status,'PASSED');assert.equal((await f.call(`/data-services/dapis/${s.id}/publish`,{configHash:s.currentVersion.configHash})).status,200);return s;}
 const a=await create('distribution-values',['holding_market_value','security_count']),b=await create('distribution-ratios',['market_value_ratio']);
 const x=await f.call('/data-services/xapis',{name:'合成客户分布组合',slug:'distribution-overview',steps:[{alias:'holdings',dapiId:a.id},{alias:'allocation',dapiId:b.id}]});assert.equal(x.status,201,JSON.stringify(x.body));
 const testResult=await f.call(`/data-services/xapis/${x.body.id}/test`,{page:1,pageSize:1});assert.equal(testResult.body.response.data[0].distributions.length,2);assert.equal(testResult.body.response.pagination.total,2);
 assert.equal((await f.call(`/data-services/xapis/${x.body.id}/publish`,{configHash:x.body.currentVersion.configHash})).status,200);
 const doc=(await f.call(`/data-services/xapis/${x.body.id}/openapi`)).body,op=doc.paths['/api/v2/open/xapis/distribution-overview'].get.responses[200].content['application/json'].schema;
 assert.equal(op.properties.data.items.properties.distributions.type,'array');assert.equal(op.properties.data.items.properties.distributions.items.properties.allocation.properties.market_value_ratio.type,'string');
 const issued=await f.call('/data-services/applications',{name:'合成只读调用方',serviceIds:[a.id,x.body.id]});assert.equal(issued.status,201);const token=issued.body.token;
 const base=`http://127.0.0.1:${f.app.server.address().port}/api/v2/open`;
 async function consume(path){const r=await fetch(base+path,{headers:{authorization:'Bearer '+token}});return{status:r.status,body:await r.json()};}
 assert.equal((await consume('/dapis/distribution-values?page_size=1')).body.resultContract.paginationUnit,'DISTRIBUTION_ROWS');
 assert.equal((await consume('/xapis/distribution-overview?page=2&page_size=1')).body.data[0].client_id,'CLIENT-002');
 assert.equal((await consume('/dapis/distribution-ratios')).status,403);assert.equal((await consume('/xapis/distribution-overview?client_id=CLIENT-003')).body.data.length,0);
 assert.equal((await consume('/xapis/distribution-overview?page_size=101')).status,400);
 const calls=(await f.call('/data-services/calls')).body;assert(calls.some(c=>c.serviceId===x.body.id&&c.resultHash));
 assert.equal((await f.call(`/data-services/applications/${issued.body.application.id}/revoke`,{})).status,200);assert.equal((await consume('/xapis/distribution-overview')).status,401);assert.equal(f.calls(),2);
 const beforeEvidence={calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length,runs:f.store.list('release_run',PROJECT).length};
 const evidence=await f.call('/data-services/task-evidence'+query);assert.equal(evidence.status,200,JSON.stringify(evidence.body));assert.equal(evidence.body.protocol,'shuduo-local-distribution-consumption/v1');assert.equal(evidence.body.status,'VERIFIED');assert.equal(evidence.body.agentIndependentE2E,false);assert.equal(evidence.body.externalSystemVerified,false);
 const expectedContract=p.pkg.manifest.source.outputContract,batches=f.store.list('release_run',PROJECT);assert.equal(checkedAgentConsumption(evidence.body,binding,batches,expectedContract),evidence.body);
 for(const change of [v=>{v.agentIndependentE2E=true},v=>{v.externalSystemVerified=true},v=>{v.metadataHash='a'.repeat(64)},v=>{v.services.find(s=>s.serviceType==='XAPI').sourceVersions[0].fields=['client_id']},v=>{v.services.find(s=>s.serviceType==='XAPI').call.independentResultVerified=false},v=>{v.services.find(s=>s.serviceType==='XAPI').checkedCalls[0].paginationUnit='DISTRIBUTION_ROWS'}]){const bad=structuredClone(evidence.body);change(bad);assert.throws(()=>checkedAgentConsumption(bad,binding,batches,expectedContract));}
 assert.throws(()=>checkedAgentConsumption(evidence.body,binding,batches));
 const malformedAttention=structuredClone(evidence.body);malformedAttention.status='PENDING';malformedAttention.services[0].status='NEEDS_ATTENTION';malformedAttention.services[0].call={callId:{}};assert.throws(()=>checkedAgentConsumption(malformedAttention,binding,batches,expectedContract));
 const consumed=evidence.body.services.find(s=>s.serviceId===x.body.id);assert.equal(consumed.call.applicationStatus,'REVOKED');assert.equal(consumed.call.independentResultVerified,true);assert.equal(consumed.distributionComposition,true);assert(consumed.checkedCalls.some(c=>c.rowCount===0));
 assert.equal(JSON.stringify(evidence.body).includes('CLIENT-001'),false);assert.equal(JSON.stringify(evidence.body).includes(token),false);
 assert.deepEqual({calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length,runs:f.store.list('release_run',PROJECT).length},beforeEvidence);
 const storedCall=f.store.get('service_call',consumed.call.callId,PROJECT);f.store.update('service_call',storedCall.id,PROJECT,{resultHash:'a'.repeat(64)});const bad=await f.call('/data-services/task-evidence'+query);assert.equal(bad.body.status,'PENDING');assert.equal(bad.body.services.find(s=>s.serviceId===x.body.id).status,'NEEDS_ATTENTION');f.store.update('service_call',storedCall.id,PROJECT,{resultHash:storedCall.resultHash});
 const manager=f.app.dataServices,originalExecutor=manager.executeDapi;
 const originalResponse=await manager.test(x.body.id,storedCall.parameters),wrong=structuredClone(originalResponse.response.data);wrong[0].distributions[0].holdings.holding_market_value='999.00';
 manager.executeDapi=async(version,input)=>{const response=await originalExecutor(version,input);return{...response,rows:response.rows.map(r=>r.client_id===wrong[0].client_id&&r.asset_class===wrong[0].distributions[0].asset_class&&r.holding_market_value!==undefined?{...r,holding_market_value:'999.00'}:r)}};
 f.store.update('service_call',storedCall.id,PROJECT,{resultHash:serviceHash(wrong)});const independent=await manager.recheckDistributionCall(x.body.id,storedCall.id);assert.equal(independent.verified,true,'self-consistent hash alone can pass');assert.equal(independent.independentResultVerified,false,'independent business oracle rejects a self-consistent wrong result');manager.executeDapi=originalExecutor;f.store.update('service_call',storedCall.id,PROJECT,{resultHash:storedCall.resultHash});
 // Source certification is independent of the upstream model, without relabeling it.
 f.store.update('agent',p.agent.id,PROJECT,{attempts:[{...p.agent.attempts[0],model:'SYNTHETIC_UPSTREAM'}]});
 assert.throws(()=>certifiedDistributionSource({store:f.store,project:PROJECT,run:f.store.get('release_run',source.id,PROJECT)}),e=>e.code==='REQUIREMENT_DELIVERY_SOURCE_CHANGED');
 f.store.update('agent',p.agent.id,PROJECT,{attempts:p.agent.attempts});
 f.store.update('release_run',source.id,PROJECT,{rows:[{...p.run.rows[0],market_value_ratio:'0.000000'}]});assert.deepEqual((await f.call('/data-services/sources'+query)).body,[]);
 assert.equal((await f.call('/data-services/dapis',{name:'不可发布',slug:'broken-distribution',sourceReleaseRunId:source.id})).status,409);
});

test('evidence bounds history and rejects version or grant drift during replay without manufacturing a replacement call',async t=>{
 const f=await fixture(t),p=await f.packageSource(),{release}=await f.publish(p);await f.runNext(release.id);await f.runNext(release.id);
 const manager=f.app.dataServices,source=f.store.list('release_run',PROJECT)[0];
 async function dapi(slug,fields){const s=manager.createDapi({name:'合成分布 '+slug,slug,sourceReleaseRunId:source.id,fields});await manager.test(s.id);manager.publish(s.id);return s;}
 const a=await dapi('bounded-values',['holding_market_value','security_count']),b=await dapi('bounded-ratio',['market_value_ratio']),x=manager.createXapi({name:'合成分布组合',slug:'bounded-groups',steps:[{alias:'holdings',dapiId:a.id},{alias:'allocation',dapiId:b.id}]});await manager.test(x.id);manager.publish(x.id);
 const app=manager.createApplication({name:'合成有限历史',serviceIds:[x.id]});await manager.invoke('XAPI',x.slug,'Bearer '+app.token,{pageSize:1});manager.revokeApplication(app.application.id);
 const query='?'+new URLSearchParams({agent_task_id:p.agent.id,package_digest:p.pkg.digest,release_id:release.id}),original=manager.recheckDistributionCall;
 let changed=false;manager.recheckDistributionCall=async(...args)=>{const result=await original.apply(manager,args);if(!changed){changed=true;f.store.update('service_app',app.application.id,PROJECT,{serviceIds:[]});}return result;};
 const denied=await f.call('/data-services/task-evidence'+query);assert.equal(denied.body.status,'PENDING');assert.equal(denied.body.services.find(s=>s.serviceId===x.id).status,'NEEDS_ATTENTION');f.store.update('service_app',app.application.id,PROJECT,{serviceIds:[x.id]});manager.recheckDistributionCall=original;
 const call=f.store.list('service_call',PROJECT)[0];for(let i=0;i<10;i++)f.store.create('service_call',PROJECT,{...Object.fromEntries(Object.entries(call).filter(([k])=>!['id','projectId','createdAt','updatedAt','version'].includes(k))),finishedAt:new Date(Date.parse(call.finishedAt)+i+1).toISOString()});
 const before=f.store.list('service_call',PROJECT).length,limited=await f.call('/data-services/task-evidence'+query),entry=limited.body.services.find(s=>s.serviceId===x.id);assert.equal(limited.body.status,'PENDING');assert.equal(entry.callsTruncated,true);assert.equal(entry.checkedCalls.length,10);assert.equal(entry.status,'NEEDS_ATTENTION');assert.equal(f.store.list('service_call',PROJECT).length,before);assert.equal(f.calls(),2);
});
