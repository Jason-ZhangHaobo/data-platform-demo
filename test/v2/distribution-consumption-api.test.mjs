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
 // Source certification is independent of the upstream model, without relabeling it.
 f.store.update('agent',p.agent.id,PROJECT,{attempts:[{...p.agent.attempts[0],model:'SYNTHETIC_UPSTREAM'}]});
 assert.throws(()=>certifiedDistributionSource({store:f.store,project:PROJECT,run:f.store.get('release_run',source.id,PROJECT)}),e=>e.code==='REQUIREMENT_DELIVERY_SOURCE_CHANGED');
 f.store.update('agent',p.agent.id,PROJECT,{attempts:p.agent.attempts});
 f.store.update('release_run',source.id,PROJECT,{rows:[{...p.run.rows[0],market_value_ratio:'0.000000'}]});assert.deepEqual((await f.call('/data-services/sources'+query)).body,[]);
 assert.equal((await f.call('/data-services/dapis',{name:'不可发布',slug:'broken-distribution',sourceReleaseRunId:source.id})).status,409);
});
