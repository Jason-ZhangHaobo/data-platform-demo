import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalSourceApiFixture,publishLocalAgentFixture} from './fixtures/local-service-api-journey.mjs';
import {createManualServiceJourney} from './fixtures/manual-service-journey.mjs';
import {validateConsumerSource} from '../../src/v2/consumer-source.mjs';
import {PROJECT} from '../../src/v2/server.mjs';

test('private manual source projection comes from its approved manifest without changing the failed Agent or consumer calls',async t=>{
 const f=await createManualServiceJourney();t.after(()=>f.dispose());const before=f.counts();
 const result=await f.call(f.evidencePath);assert.equal(result.status,200);
 const entry=result.body.services.find(row=>row.serviceId===f.serviceIds.xapi),source=validateConsumerSource(entry.source);
 assert.deepEqual(source,{schema:'shuduo-service-consumer-source/v1',scope:'PRIVATE_CLOUD_TEST',sourceKind:'MANUAL',taskId:f.agent.id,
  revisionId:f.revision.id,revisionHash:f.revision.hash,developmentRunId:f.sourceRun.id,contextId:f.revision.contextId,
  validationContractId:f.item.manifest.source.validationContractId,packageDigest:f.item.digest,releaseId:f.releaseId,sourceReleaseRunId:f.sourceReleaseRunId});
 assert.equal(entry.agentIndependentE2E,false);assert.equal(entry.sourceAttribution,'ENGINEER_ASSISTED');assert.equal(result.body.externalSystemVerified,false);
 assert.deepEqual(f.counts(),before);assert.deepEqual(f.store.get('agent',f.agent.id,PROJECT),f.originalAgent);
 for(const key of ['sql','rows','token','parameters','actorId','projectId'])assert.equal(Object.hasOwn(source,key),false);
});

test('native local source projection is available for a published DAPI without inventing a consumer call',async t=>{
 const f=await createLocalSourceApiFixture();t.after(()=>f.dispose());const made=await publishLocalAgentFixture(f);
 const created=await f.call('/data-services/dapis',{name:'虚构证券来源对照',slug:'source-projection-fixture',sourceReleaseRunId:made.sources[0].id,fields:['client_id','total_assets']});assert.equal(created.status,201);
 assert.equal((await f.call(`/data-services/dapis/${created.body.id}/test`,{})).status,200);
 assert.equal((await f.call(`/data-services/dapis/${created.body.id}/publish`,{configHash:created.body.currentVersion.configHash})).status,200);
 const before={...f.counts},result=await f.call('/data-services/task-evidence?'+made.query),entry=result.body.services[0];
 assert.equal(result.body.status,'PENDING');assert.equal(entry.call,undefined);assert.equal(entry.status,'PENDING');
 const source=validateConsumerSource(entry.source);assert.equal(source.scope,'LOCAL_TEST_ONLY');assert.equal(source.sourceKind,'AGENT');
 assert.equal(source.revisionHash,made.bundle.manifest.source.sqlHash);assert.equal(source.developmentRunId,made.agent.runId);
 assert.equal(source.sourceReleaseRunId,made.sources[0].id);assert.notEqual(source.sourceReleaseRunId,source.developmentRunId);
 assert.equal(f.store.list('service_call',PROJECT).length,0);assert.deepEqual(f.counts,before);
});
