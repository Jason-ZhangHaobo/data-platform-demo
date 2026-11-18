import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {BusinessQueryStore,DataServiceManager} from '../../src/v2/data-services.mjs';
import {localTaskConsumption} from '../../src/v2/local-task-consumption.mjs';
import {privateTaskConsumption} from '../../src/v2/private-task-consumption.mjs';
import {readSyncSqlPaginationCoverage} from '../../src/v2/sync-sql-service-source.mjs';
import {seedLocalServiceSource} from './fixtures/local-service-sources.mjs';

test('local task consumption joins existing source and revoked-app receipts without executing or writing',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-local-consumption-')),store=new MetadataStore(join(root,'meta.sqlite')),businessStore=new BusinessQueryStore(join(root,'business.sqlite'));
 const {revision,codeRun,agent,bundle,release,batches}=seedLocalServiceSource({store,project:PROJECT}),run=batches[0];
 const manager=new DataServiceManager({store,businessStore,project:PROJECT,releaseRunFor:id=>store.get('release_run',id,PROJECT)});
 async function dapi(slug,fields){const s=manager.createDapi({name:'合成证券查询',slug,fields,sourceReleaseRunId:run.id});await manager.test(s.id,{});manager.publish(s.id);return s;}
 const h=await dapi('fixture-holdings',['client_id','holding_market_value','security_count']),c=await dapi('fixture-cash',['client_id','available_cash','total_assets']);
 const x=manager.createXapi({name:'合成资产组合',slug:'fixture-assets',steps:[{alias:'positions',dapiId:h.id},{alias:'cash',dapiId:c.id}]});await manager.test(x.id,{});manager.publish(x.id);
 const read=(patch={})=>localTaskConsumption({store,project:PROJECT,agent,packageDigest:bundle.digest,manager,...patch});
 assert.equal((await read()).status,'PENDING');
 const issued=manager.createApplication({name:'合成消费应用',serviceIds:[x.id]});await manager.invoke('XAPI','fixture-assets','Bearer '+issued.token,{});manager.revokeApplication(issued.application.id);
 const count=store.list('service_call',PROJECT).length;
 for(let i=0;i<2;i++){
  const proof=await read();assert.equal(proof.scope,'LOCAL_TEST_ONLY');assert.equal(proof.status,'VERIFIED');assert.equal(proof.protocol,'shuduo-local-task-consumption/v1');
  assert.equal(proof.services.find(s=>s.serviceId===x.id).call.applicationStatus,'REVOKED');
  assert.equal(JSON.stringify(proof).includes('1800.00'),false);assert.equal(JSON.stringify(proof).includes(issued.token),false);
 }
 assert.equal(store.list('service_call',PROJECT).length,count);assert.equal(manager.listApplications().length,1);
 const exact=await read({releaseId:release.id}),entry=exact.services.find(s=>s.serviceId===x.id);
 assert.equal(exact.releaseId,release.id);assert.equal(exact.sourceKind,'AGENT');assert.equal(exact.externalSystemVerified,false);
 assert.equal(entry.call.configHash,entry.configHash);
 assert.equal(entry.sourceVersions.length,2);assert.equal(new Set(entry.sourceVersions.map(v=>v.versionId)).size,2);
 assert.ok(entry.sourceVersions.every(v=>v.sourceKind==='AGENT'&&v.releaseId===release.id&&v.sourceReleaseRunId===run.id&&v.packageDigest===bundle.digest&&/^[a-f0-9]{64}$/.test(v.configHash)));
 assert.deepEqual([...new Set(entry.sourceVersions.flatMap(v=>v.fields))].sort(),['available_cash','client_id','holding_market_value','security_count','total_assets']);
 const unknown=await read({releaseId:randomUUID()});assert.equal(unknown.status,'PENDING');assert.equal(unknown.services.length,0);
 await assert.rejects(read({releaseId:release.id,batchId:run.id}),{status:422,code:"LOCAL_BATCH_SCOPE_UNSUPPORTED"});
 await assert.rejects(read({agent:{...agent,status:'FAILED'}}),{status:409});
 for(const sourceKind of ['MANUAL','UNKNOWN'])await assert.rejects(read({agent:{...agent,sourceKind}}),{status:409});
 store.update('service_app',issued.application.id,PROJECT,{scope:'PRIVATE_CLOUD_TEST'});assert.equal((await read()).status,'PENDING');
 store.update('service_app',issued.application.id,PROJECT,{scope:'LOCAL_TEST_ONLY'});
 await assert.rejects(read({packageDigest:'0'.repeat(64)}),{status:409});
 await assert.rejects(read({agent:{...agent,id:'foreign-task'}}),{status:409});
 await assert.rejects(read({agent:{...agent,attempts:[{revisionId:revision.id,runId:'different-run'}]}}),{status:409});
 let computations=0;
 const app=createV2Server({root,store,businessStore,env:{V2_LOCAL_DEVELOPMENT:'true'},runner:async()=>{computations++;throw Error('must not run');}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));businessStore.close();store.close();});
 const path=`http://127.0.0.1:${app.server.address().port}/api/v2/data-services/task-evidence?agent_task_id=${agent.id}&package_digest=${bundle.digest}`;
 const response=await fetch(path);assert.equal(response.status,200);assert.equal((await response.json()).status,'VERIFIED');
 const selected=await fetch(path+'&release_id='+release.id);assert.equal(selected.status,200);assert.equal((await selected.json()).releaseId,release.id);
 const absent=await fetch(path+'&release_id='+randomUUID());assert.equal(absent.status,200);assert.equal((await absent.json()).status,'PENDING');
 for(const suffix of ['&release_id=invalid','&release_id='+release.id+'&release_id='+release.id,'&package_digest='+bundle.digest])assert.equal((await fetch(path+suffix)).status,422);
 assert.equal((await fetch(path+'&extra=not-supported')).status,422);
 assert.equal(computations,0);assert.equal(store.list('service_call',PROJECT).length,count);
 const original=store.get('data_service_version',manager.detail(x.id).publishedVersion.id,PROJECT);
 const next=manager.createXapiVersion(x.id,{steps:original.steps,rateLimitPerMinute:45});
 await manager.test(x.id,{});manager.publish(x.id);
 const history=await privateTaskConsumption({store,project:PROJECT,taskId:agent.id,packageDigest:bundle.digest,releaseId:release.id,
   batchId:run.id,includeRetiredBatchVersions:true,scope:'LOCAL_TEST_ONLY',services:manager.list(),
   ownedService:id=>manager.detail(id),getVersion:id=>store.get('data_service_version',id,PROJECT),
   source:id=>store.get('release_run',id,PROJECT),getRelease:id=>id===release.id?{...release,sourceAgentTaskId:agent.id}:undefined,
   application:id=>manager.application(id),calls:id=>manager.listCalls(id),
   recheckCall:(id,callId,options)=>manager.recheckCall(id,callId,options)});
 const variants=history.services.filter(item=>item.serviceId===x.id);
 assert.deepEqual(variants.map(item=>[item.versionId,item.versionStatus,item.status]),
   [[next.id,'PUBLISHED','PENDING'],[original.id,'RETIRED','VERIFIED']]);
 assert.equal(variants[1].call.applicationStatus,'REVOKED');
 assert.equal(store.list('service_call',PROJECT).length,count);
});

test('frozen pagination requires distinct verified pages from one application and one version',async()=>{
 const entry={serviceId:'service',versionId:'version',configHash:'a'.repeat(64),status:'VERIFIED',sourceRunIds:['batch']};
 const saved=(id,page,applicationId='a',patch={})=>({id,serviceId:entry.serviceId,serviceVersionId:entry.versionId,
   outcome:'SUCCEEDED',statusCode:200,applicationId,rowCount:1,parameters:{page,pageSize:1},...patch});
 const read=calls=>readSyncSqlPaginationCoverage({entry,calls,expectedRows:2,
   application:()=>({scope:'LOCAL_TEST_ONLY',status:'REVOKED',versionGrants:{service:'version'}}),
   recheckCall:async(serviceId,callId,{pinnedVersionId})=>{
     assert.equal(serviceId,'service');assert.equal(pinnedVersionId,'version');
     return {callId,versionId:entry.versionId,configHash:entry.configHash,rowCount:1,verified:callId!=='bad',independentResultVerified:true};
   }});
 const first=saved('first',1),second=saved('second',2);
 for (const other of [saved('other-app',2,'b'),saved('wrong-version',2,'a',{serviceVersionId:'new'}),
   saved('filtered',2,'a',{parameters:{page:2,pageSize:1,clientId:'CLIENT-001'}}),saved('bad',2)]) {
   const partial=await read([first,saved('duplicate',1),other]);
   assert.equal(partial.status,'INCOMPLETE');
   assert.equal(partial.verifiedPages.length,1);
 }
 assert.deepEqual(await read([saved('bad',2),second,saved('duplicate',1),first]),
   {status:'COMPLETE',applicationId:'a',pageSize:1,totalPages:2,verifiedPages:[1,2]});
});
