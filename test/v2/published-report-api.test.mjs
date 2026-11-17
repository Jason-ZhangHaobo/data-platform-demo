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
 const reportPath='/reports/published/requests/'+first.requestId, base='http://127.0.0.1:'+app.server.address().port+'/api/v2';
 const read=(path,headers={})=>fetch(base+path,{headers});
 const bearer={authorization:'Bearer sz_local_'+ 'a'.repeat(32)};
 for(const path of [reportPath,reportPath+'/result',reportPath+'/export',reportPath+'/lineage',
  '/reports/overview','/reports/'+first.reportId+'/export']){
  const blocked=await read(path,bearer);
  assert.equal(blocked.status,403);
  assert.equal((await blocked.json()).code,'REPORT_SERVICE_CREDENTIAL_FORBIDDEN');
 }
 const named={email:'report-reader@example.invalid',password:'SyntheticReader!2026',displayName:'虚构其他报表工程师'};
 app.auth.bootstrapAdmin(named);
 const login=app.auth.sessionResponse(app.auth.login(named),false);
 const headers={cookie:login.cookies.map(line=>line.split(';',1)[0]).join('; ')};
 for(const path of [reportPath,reportPath+'/result',reportPath+'/export',
  '/reports/'+first.reportId,'/reports/'+first.reportId+'/export','/reports/datasets/'+first.datasetId]){
  assert.equal((await read(path,headers)).status,404);
 }
 const overview=await (await read('/reports/overview',headers)).json();
 assert.ok(!overview.reports.some(report=>report.id===first.reportId));
 assert.ok(!overview.datasets.some(dataset=>dataset.id===first.datasetId));
 const stale=await read(reportPath+'/export',{cookie:'shuduo_session=expired-fixture'});
 assert.equal(stale.status,401);
 const csv=await (await read(reportPath+'/export')).json();
 assert.equal(csv.runId,first.reportRunId);
 assert.match(csv.content,/widget_id,title,group,value/);
 assert.doesNotMatch(csv.content,/CLIENT-00[12]/);
 const owner=app.auth.bootstrapAdmin({email:'report-owner@example.invalid',password:named.password,displayName:'虚构报表所有人'});
 const ownedSource=seedLocalServiceSource({store,project:PROJECT});
 store.update('agent',ownedSource.agent.id,PROJECT,{submittedBy:owner.id});
 const ownerSession=app.auth.sessionResponse(app.auth.login({email:owner.email,password:named.password}),false);
 const ownerHeaders={cookie:ownerSession.cookies.map(line=>line.split(';',1)[0]).join('; ')};
 const ownerRequest=randomUUID(), created=await fetch(base+'/reports/published',{
  method:'POST',headers:{...ownerHeaders,'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':ownerRequest},
  body:JSON.stringify({name:'虚构实名会话归属报表',source:{kind:'AGENT',taskId:ownedSource.agent.id,
   releaseId:ownedSource.release.id,packageDigest:ownedSource.bundle.digest,revisionId:ownedSource.revision.id,
   runId:ownedSource.codeRun.id,batchId:ownedSource.batches[0].id}}),
 });
 assert.equal(created.status,200);
 const owned=await created.json();
 const protectedExport='/reports/published/requests/'+ownerRequest+'/export';
 assert.equal((await read(protectedExport)).status,404);
 assert.equal((await read(protectedExport,headers)).status,404);
 const ownerCsv=await read(protectedExport,ownerHeaders);
 assert.equal(ownerCsv.status,200);
 assert.equal((await ownerCsv.json()).runId,owned.reportRunId);
 const ownerRecord=store.list('auth_session',PROJECT).find(session=>session.userId===owner.id);
 store.refresh=async()=>{store.update('auth_session',ownerRecord.id,PROJECT,{status:'REVOKED'});};
 try{
  const revoked=await read('/reports/overview',ownerHeaders);
  assert.equal(revoked.status,401);
  assert.equal((await revoked.json()).code,'AUTHENTICATION_REQUIRED');
 }finally{delete store.refresh;}
 const refreshKey=randomUUID(),path='/reports/datasets/'+first.datasetId+'/refresh',snapshot=await client.request(path,{method:'POST',body:{},idempotencyKey:refreshKey});
 seedLocalServiceSource({store,project:PROJECT,contextId:'stock-cash-t1'});
 const replay=await client.request(path,{method:'POST',body:{},idempotencyKey:refreshKey});assert.equal(replay.currentSnapshotId,snapshot.currentSnapshotId);assert.equal(replay.currentSnapshot.assetVersionId,source.batchId);
 await assert.rejects(submitPublishedReport(client,{...args,name:'替换原请求'}),e=>e.status===409);
});
