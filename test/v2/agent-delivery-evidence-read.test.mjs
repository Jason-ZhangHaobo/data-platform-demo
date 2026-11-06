import test from'node:test';import assert from'node:assert/strict';
import{MetadataStore}from'../../src/v2/store.mjs';import{BusinessQueryStore,DataServiceManager}from'../../src/v2/data-services.mjs';
import{createV2Server,PROJECT}from'../../src/v2/server.mjs';import{localTaskPublication}from'../../src/v2/local-task-publication.mjs';import{localTaskConsumption}from'../../src/v2/local-task-consumption.mjs';
import{seedLocalServiceSource}from'./fixtures/local-service-sources.mjs';import{checkedAgentPublication,checkedAgentConsumption}from'../../web/src/agent-delivery-evidence-read.ts';
const foreign='99999999-9999-4999-8999-999999999999';
async function fixture(t){
 const store=new MetadataStore(':memory:'),businessStore=new BusinessQueryStore(':memory:');t.after(()=>{businessStore.close();store.close();});
 // Persisted engine/release receipts are synthetic. SQL service materialization
 // and read-only projections use actual isolated SQLite; no Spark/model runs.
 const f=seedLocalServiceSource({store,project:PROJECT}),manager=new DataServiceManager({store,businessStore,project:PROJECT,releaseRunFor:id=>store.get('release_run',id,PROJECT)});
 async function dapi(slug,fields){const s=manager.createDapi({name:'虚构证券查询',slug,fields,sourceReleaseRunId:f.batches[0].id});await manager.test(s.id,{});manager.publish(s.id);return s;}
 const h=await dapi('proof-holdings',['client_id','holding_market_value','security_count']),c=await dapi('proof-cash',['client_id','available_cash','total_assets']);
 const x=manager.createXapi({name:'虚构客户资产组合',slug:'proof-assets',steps:[{alias:'positions',dapiId:h.id},{alias:'cash',dapiId:c.id}]});await manager.test(x.id,{});manager.publish(x.id);
 const app=manager.createApplication({name:'隔离测试应用',serviceIds:[x.id]});await manager.invoke('XAPI','proof-assets','Bearer '+app.token,{});manager.revokeApplication(app.application.id);
 const selector={sourceKind:'AGENT',packageDigest:f.bundle.digest,verificationId:f.verification.id},publication=localTaskPublication(store,PROJECT,f.agent,{...selector,releaseId:f.release.id});
 const consumption=await localTaskConsumption({store,project:PROJECT,agent:f.agent,packageDigest:f.bundle.digest,releaseId:f.release.id,manager});
 return{...f,store,businessStore,manager,selector,publication,consumption,binding:{taskId:f.agent.id,packageDigest:f.bundle.digest,releaseId:f.release.id,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',revisionId:f.revision.id,runId:f.codeRun.id},options:{taskId:f.agent.id,scope:'LOCAL_TEST_RELEASE',selector,releaseId:f.release.id}};
}
test('actual local projections retain exact publication and revoked-app historical consumption',async t=>{
 const f=await fixture(t),before=f.store.list('service_call',PROJECT).length;
 assert.equal(checkedAgentPublication(f.publication,f.options),f.publication);assert.equal(checkedAgentConsumption(f.consumption,f.binding,f.publication.runs),f.consumption);
 assert.equal(f.consumption.status,'VERIFIED');assert.equal(f.consumption.services.find(s=>s.serviceType==='XAPI').call.applicationStatus,'REVOKED');assert.equal(f.store.list('service_call',PROJECT).length,before);
});
test('publication rejects malformed arrays, unsafe rendered records and mixed batches or events',async t=>{
 const f=await fixture(t);for(const mutate of [v=>null,v=>({}),v=>({...v,runs:null}),v=>({...v,release:{...v.release,health:{}}}),v=>({...v,runs:[v.runs[0],v.runs[0]]}),v=>({...v,runs:[{...v.runs[0],releaseId:foreign}]}),v=>({...v,alerts:[{id:foreign,status:'OPEN',message:{}}]}),v=>({...v,events:[{...v.events[0],packageDigest:'a'.repeat(64)}]}),v=>({...v,events:[{...v.events[0],releaseRunId:foreign}]})])assert.throws(()=>checkedAgentPublication(mutate(structuredClone(f.publication)),f.options),/未确认|不一致/);
});
test('exact local and private selectors reject another task, package, release or manual source',async t=>{
 const f=await fixture(t);for(const mutate of [v=>{v.release.sourceAgentTaskId=foreign},v=>{v.release.packageDigest='a'.repeat(64)},v=>{v.release.id=foreign},v=>{v.release.sourceKind='MANUAL'},v=>{v.release.verificationId=foreign}]){const value=structuredClone(f.publication);mutate(value);assert.throws(()=>checkedAgentPublication(value,f.options),/未确认|不一致/);}
 assert.throws(()=>checkedAgentPublication(f.publication,{...f.options,scope:'PRIVATE_CLOUD_TEST'}),/未确认/);
 assert.deepEqual(checkedAgentPublication({runs:[],alerts:[],events:[]},{taskId:f.agent.id,scope:'PRIVATE_CLOUD_TEST'}),{runs:[],alerts:[],events:[]});
 assert.throws(()=>checkedAgentPublication({runs:[],alerts:[],events:[]},f.options),/未确认/);
});
test('consumer envelopes and call records reject invalid shape, source and false external claims',async t=>{
 const f=await fixture(t);for(const mutate of [v=>null,v=>({...v,services:null}),v=>({...v,taskId:foreign}),v=>({...v,releaseId:foreign}),v=>({...v,externalSystemVerified:true}),v=>({...v,agentIndependentE2E:true}),v=>({...v,services:[null]}),v=>({...v,services:[v.services[0],v.services[0]],matchingCount:2}),v=>({...v,checkedAt:{}})])assert.throws(()=>checkedAgentConsumption(mutate(structuredClone(f.consumption)),f.binding,f.publication.runs),/未确认/);
 for(const mutate of [e=>{e.call.resultHash={}},e=>{e.call.versionId=foreign},e=>{e.call.configHash='b'.repeat(64)},e=>{e.sourceRunIds=[f.codeRun.id]},e=>{e.source.releaseId=foreign},e=>{e.sourceVersions[0].sourceReleaseRunId=foreign},e=>{e.sourceVersions.forEach(v=>{v.fields=['client_id']})}]){const value=structuredClone(f.consumption);mutate(value.services.find(s=>s.serviceType==='XAPI'));assert.throws(()=>checkedAgentConsumption(value,f.binding,f.publication.runs),/未确认/);}
});
test('pending and failed evidence remains readable without inventing successful calls',async t=>{
 const f=await fixture(t),empty={...f.consumption,status:'PENDING',services:[],matchingCount:0,truncated:false};assert.equal(checkedAgentConsumption(empty,f.binding,f.publication.runs),empty);
 const failed={...empty,services:[{serviceId:foreign,versionId:foreign,serviceType:'XAPI',name:'虚构接口',configHash:'a'.repeat(64),status:'NEEDS_ATTENTION',sourceRunIds:[],notice:'版本未核验',code:'SOURCE_MISMATCH'}],matchingCount:1};assert.equal(checkedAgentConsumption(failed,f.binding,f.publication.runs),failed);
 assert.throws(()=>checkedAgentConsumption({...empty,status:'VERIFIED'},f.binding,f.publication.runs),/未确认/);
 assert.throws(()=>checkedAgentConsumption({...f.consumption,truncated:true},f.binding,f.publication.runs),/未确认/);
});
test('manual private projections preserve attribution and require published batches rather than development runs',async t=>{
 const f=await fixture(t),value=structuredClone(f.consumption),binding={...f.binding,sourceKind:'MANUAL',scope:'PRIVATE_CLOUD_TEST'};
 Object.assign(value,{protocol:'shuduo-private-task-consumption/v1',scope:'PRIVATE_CLOUD_TEST',sourceKind:'MANUAL'});
 for(const e of value.services){if(e.sourceKind)e.sourceKind='MANUAL';if(e.source){e.source.sourceKind='MANUAL';e.source.scope='PRIVATE_CLOUD_TEST';}for(const v of e.sourceVersions??[])v.sourceKind='MANUAL';}
 assert.equal(checkedAgentConsumption(value,binding,f.publication.runs),value);
 const publication=structuredClone(f.publication);publication.scope='PRIVATE_CLOUD_TEST';Object.assign(publication.release,{scope:'PRIVATE_CLOUD_TEST',sourceKind:'MANUAL',sourceRunId:f.codeRun.id,agentIndependentE2E:false,status:'COMPLETED_CLOUD_TEST'});
 assert.equal(checkedAgentPublication(publication,{...f.options,scope:'PRIVATE_CLOUD_TEST',selector:{...f.selector,sourceKind:'MANUAL',sourceRunId:f.codeRun.id}}),publication);
 assert.throws(()=>checkedAgentConsumption(value,{...binding,runId:f.batches[0].id},f.publication.runs),/未确认/);
 value.sourceKind='AGENT';assert.throws(()=>checkedAgentConsumption(value,binding,f.publication.runs),/未确认/);
});
test('actual HTTP exact reads match the client contract without new computations or calls',async t=>{
 const f=await fixture(t);let computations=0;const app=createV2Server({store:f.store,businessStore:f.businessStore,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},runner:async()=>{computations++;throw Error('No computation permitted');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const base='http://127.0.0.1:'+app.server.address().port+'/api/v2',calls=f.store.list('service_call',PROJECT).length;
 const pub=await fetch(base+'/agent/tasks/'+f.agent.id+'/publication?'+new URLSearchParams({...f.selector,releaseId:f.release.id}));assert.equal(pub.status,200);const p=checkedAgentPublication(await pub.json(),f.options);
 const proof=await fetch(base+'/data-services/task-evidence?'+new URLSearchParams({agent_task_id:f.agent.id,package_digest:f.bundle.digest,release_id:f.release.id}));assert.equal(proof.status,200);assert.equal(checkedAgentConsumption(await proof.json(),f.binding,p.runs).status,'VERIFIED');
 assert.equal(computations,0);assert.equal(f.store.list('service_call',PROJECT).length,calls);
});
