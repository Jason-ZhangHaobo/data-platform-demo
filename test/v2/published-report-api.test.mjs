import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';
import{MetadataStore}from'../../src/v2/store.mjs';import{ReportDataStore}from'../../src/v2/reports.mjs';import{createV2Server,PROJECT}from'../../src/v2/server.mjs';import{V2Client}from'../../src/v2/client.mjs';import{submitPublishedReport,lookupPublishedReport,resumePublishedReport}from'../../src/v2/published-report-client.mjs';import{seedLocalServiceSource}from'./fixtures/local-service-sources.mjs';
test('HTTP and shared client create, reconcile and resume the same exact-source report with no engine calls',async t=>{
 const store=new MetadataStore(':memory:'),reportStore=new ReportDataStore(),f=seedLocalServiceSource({store,project:PROJECT});let computes=0;
 const forbidden=()=>{computes++;throw Error('NO_ENGINE_CALLS');};
 const app=createV2Server({store,reportStore,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},runner:forbidden,modelRunner:forbidden});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));reportStore.close();store.close();});
 const client=new V2Client({baseUrl:'http://127.0.0.1:'+app.server.address().port+'/api/v2'}),source={kind:'AGENT',taskId:f.agent.id,releaseId:f.release.id,packageDigest:f.bundle.digest,revisionId:f.revision.id,runId:f.codeRun.id,batchId:f.batches[0].id},args={name:'虚构HTTP客户资产报表',source,requestId:randomUUID()};
 const first=await submitPublishedReport(client,args);assert.equal(first.status,'SUCCEEDED');assert.equal(first.rowCount,2);
 assert.deepEqual(await lookupPublishedReport(client,args),first);assert.deepEqual(await submitPublishedReport(client,args),first);assert.deepEqual(await resumePublishedReport(client,{id:first.id,...args}),first);
 assert.equal(store.list('report_run',PROJECT).length,1);assert.equal(computes,0);
 const refreshKey=randomUUID(),path='/reports/datasets/'+first.datasetId+'/refresh',snapshot=await client.request(path,{method:'POST',body:{},idempotencyKey:refreshKey});
 seedLocalServiceSource({store,project:PROJECT,contextId:'stock-cash-t1'});
 const replay=await client.request(path,{method:'POST',body:{},idempotencyKey:refreshKey});assert.equal(replay.currentSnapshotId,snapshot.currentSnapshotId);assert.equal(replay.currentSnapshot.assetVersionId,source.batchId);
 await assert.rejects(submitPublishedReport(client,{...args,name:'替换原请求'}),e=>e.status===409);
});
