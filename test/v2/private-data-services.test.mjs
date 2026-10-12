import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createDeliveryPackage,sha256} from '../../src/v2/delivery.mjs';
import {getContext,contextIds,referenceSql,validationContractId} from '../../src/v2/context.mjs';
import {privateServiceRoute} from '../../src/v2/private-service-routes.mjs';
import {validatePrivateApplicationRequest} from '../../src/v2/private-application.mjs';

async function setup(t,{offlineCompute=false}={}) {
  let flushes=0;const runner=async()=>{throw Error('must not recompute');};runner.durable={prepare(){throw Error('must not compute');},submit(){throw Error('must not compute');},read(){},cancel(){}};
  const app=createV2Server({root:mkdtempSync(join(tmpdir(),'shuduo-private-service-')),...(offlineCompute?{}:{runner}),stateCoordinator:{refresh:async()=>{},flush:async()=>{flushes++;}},env:{V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_DURABLE_SQL_AGENT_ENABLED:offlineCompute?'false':'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true'}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();});
  const s=app.store;const owner=app.auth.bootstrapAdmin({email:'owner@example.invalid',password:'SyntheticPassword!2026',displayName:'测试工程师'}),other=app.auth.bootstrapAdmin({email:'other@example.invalid',password:'SyntheticPassword!2026',displayName:'另一测试工程师'});
  for(const u of [owner,other])s.update('auth_user',u.id,PROJECT,{memberships:[{projectId:PROJECT,role:'ENGINEER'}]});
  const agent=s.create('agent',PROJECT,{submittedBy:owner.id});
  const revision=s.create('revision',PROJECT,{sql:referenceSql,hash:sha256(referenceSql),contextId:'cash-change'});
  const sourceRun=s.create('run',PROJECT,{revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,isolation:'FUNCTION_PROCESS',rows:getContext('cash-change').expected,validation:{passed:true,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:true}))}});
  const bundle=s.create('delivery_package',PROJECT,createDeliveryPackage({run:sourceRun,revision}));
  const approval=s.create('release_approval',PROJECT,{status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest});
  const release=s.create('release',PROJECT,{mode:'DURABLE_PRIVATE_RELEASE_V1',scope:'PRIVATE_CLOUD_TEST',status:'COMPLETED_CLOUD_TEST',health:'HEALTHY',sourceAgentTaskId:agent.id,sourceCodeHash:bundle.manifest.source.sqlHash,packageId:bundle.id,packageDigest:bundle.digest,approvalId:approval.id,publicDeployed:false});
  const run=s.create('release_run',PROJECT,{releaseId:release.id,mode:release.mode,scope:release.scope,status:'SUCCEEDED',published:true,publicDeployed:false,schedulerTriggered:true,clockMode:'FC_TIMER',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,packageId:bundle.id,packageDigest:bundle.digest,rows:getContext('cash-change').expected,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},validation:{passed:true,regressions:contextIds.map(contextId=>({contextId,passed:true}))}});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,body,headers={},key='synthetic-service-'+path)=>{const r=await fetch(base+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};};
  const login=async email=>{const r=await call('/auth/login',{email,password:'SyntheticPassword!2026'});return{cookie:r.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':r.body.csrfToken};};
  const a=await login('owner@example.invalid'),b=await login('other@example.invalid');
  const create=async(slug,fields)=>{const r=await call('/data-services/dapis',{name:slug,slug,sourceReleaseRunId:run.id,fields,rateLimitPerMinute:2},a,slug);assert.equal(r.status,201,JSON.stringify(r.body));const test=await call(`/data-services/dapis/${r.body.id}/test`,{client_id:'CLIENT-001'},a);assert.equal(test.status,200);const pub=await call(`/data-services/dapis/${r.body.id}/publish`,{configHash:r.body.currentVersion.configHash},a);assert.equal(pub.status,200);return pub.body.service;};
  return{app,s,agent,bundle,release,run,a,b,base,call,create,flushes:()=>flushes};
}

test('private transport uses exact read/write routes and limits bearer forwarding to queries',()=>{
  const good={operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2/open/dapis/customer-assets?client_id=CLIENT-001',headers:{authorization:'Bearer synthetic'}};
  assert.throws(()=>validatePrivateApplicationRequest(good));assert.equal(validatePrivateApplicationRequest(good,{allowDataServices:true}).path,good.path);
  for(const path of ['/api/v2/data-services/agent/plans','/api/v2/open/dapis/customer-assets?sql=SELECT%201','/api/v2/open/dapis/customer-assets?page=1&page=2','/api/v2/data-services/dapis?url=https://example.invalid'])assert.equal(privateServiceRoute('GET',path),false);
  assert.throws(()=>validatePrivateApplicationRequest({...good,path:'/api/v2/data-services/dapis'},{allowDataServices:true}));
});
test('private sources are verified, owned, metadata-only; mutations require CSRF and current config hash',async t=>{
  const f=await setup(t);assert.equal((await f.call('/data-services/sources')).status,401);
  const sources=await f.call('/data-services/sources',undefined,f.a);assert.equal(sources.body.length,1);assert.equal(sources.body[0].rows,undefined);assert.equal(sources.body[0].packageDigest,f.bundle.digest);
  assert.deepEqual((await f.call('/data-services/sources',undefined,f.b)).body,[]);
  const body={name:'资产查询',slug:'customer-assets',sourceReleaseRunId:f.run.id};
  assert.equal((await f.call('/data-services/dapis',body,{cookie:f.a.cookie})).status,403);
  assert.equal((await f.call('/data-services/dapis',body,f.b)).status,403);
  const d=await f.call('/data-services/dapis',body,f.a);assert.equal(d.status,201);assert.equal(d.body.currentVersion.scope,'PRIVATE_CLOUD_TEST');
  assert.equal((await f.call(`/data-services/dapis/${d.body.id}/publish`,{configHash:'wrong'},f.a)).status,409);
  assert.equal((await f.call(`/data-services/dapis/${d.body.id}/test`,{},f.b)).status,403);
  f.s.update('release_run',f.run.id,PROJECT,{packageDigest:'f'.repeat(64)});assert.deepEqual((await f.call('/data-services/sources',undefined,f.a)).body,[]);
  assert.equal((await f.call('/data-services/dapis',{...body,slug:'bad-provenance'},f.a,'bad')).status,409);
});
test('independent bearer-only XAPI client consumes frozen output with grants, rate limits, logs and revocation',async t=>{
  const f=await setup(t),h=await f.create('customer-holdings',['client_id','holding_market_value','security_count']),c=await f.create('customer-cash',['client_id','available_cash','total_assets']);
  const x=await f.call('/data-services/xapis',{name:'客户资产组合',slug:'customer-assets-composed',rateLimitPerMinute:1,steps:[{alias:'holdings',dapiId:h.id},{alias:'cash',dapiId:c.id}]},f.a);
  assert.equal(x.status,201);assert.equal((await f.call(`/data-services/xapis/${x.body.id}/test`,{},f.a)).status,200);
  assert.equal((await f.call(`/data-services/xapis/${x.body.id}/publish`,{configHash:x.body.currentVersion.configHash},f.a)).status,200);
  const app=await f.call('/data-services/applications',{name:'独立财富分析测试客户端',serviceIds:[x.body.id]},f.a,'client');assert.equal(app.status,201);assert.match(app.body.token,/^sz_private_/);
  assert.ok(!JSON.stringify(f.s.list('service_app',PROJECT)).includes(app.body.token));
  const replay=await f.call('/data-services/applications',{name:'独立财富分析测试客户端',serviceIds:[x.body.id]},f.a,'client');assert.equal(replay.body.token,null);
  const headers={authorization:'Bearer '+app.body.token},url='/open/xapis/customer-assets-composed?client_id=CLIENT-001';
  assert.equal((await f.call(url)).status,401);assert.equal((await f.call('/open/dapis/customer-holdings',undefined,headers)).status,403);
  const count=f.flushes(),r=await f.call(url,undefined,headers);assert.equal(r.status,200);assert.deepEqual(r.body.data,[{client_id:'CLIENT-001',holdings:{holding_market_value:'1500.00',security_count:2},cash:{available_cash:'800.00',total_assets:'2300.00'}}]);assert.equal(r.body.scope,'PRIVATE_CLOUD_TEST');assert.equal(r.body.localTestOnly,false);assert.ok(f.flushes()>count);
  assert.equal((await f.call(url,undefined,headers)).status,429);
  assert.deepEqual((await f.call('/data-services/calls',undefined,f.b)).body,[]);
  const logs=(await f.call('/data-services/calls',undefined,f.a)).body;assert.deepEqual(logs.map(l=>l.outcome).sort(),['RATE_LIMITED','SUCCEEDED']);assert.ok(!JSON.stringify(logs).includes(app.body.token));
  assert.equal((await f.call(`/data-services/applications/${app.body.application.id}/revoke`,{},f.b)).status,403);
  assert.equal((await f.call(`/data-services/applications/${app.body.application.id}/revoke`,{},f.a)).status,200);
  assert.equal((await f.call(url,undefined,headers)).status,401);
});
test('draft edits preserve live endpoint and XAPI rejects mixing different release batches',async t=>{
  const f=await setup(t),h=await f.create('holdings-versioned',['client_id','holding_market_value']),c=await f.create('cash-versioned',['client_id','available_cash']);
  const second=f.s.create('release_run',PROJECT,{...f.run,id:undefined});
  const v=await f.call(`/data-services/dapis/${c.id}/versions`,{sourceReleaseRunId:second.id},f.a,'next-version');assert.equal(v.status,201);
  const detail=(await f.call(`/data-services/dapis/${c.id}`,undefined,f.a)).body;assert.equal(detail.status,'PUBLISHED');assert.notEqual(detail.currentVersion.id,detail.publishedVersion.id);
  assert.equal((await f.call(`/data-services/dapis/${c.id}/test`,{},f.a)).status,200);
  assert.equal((await f.call(`/data-services/dapis/${c.id}/publish`,{configHash:v.body.configHash},f.a)).status,200);
  const x=await f.call('/data-services/xapis',{name:'混合版本错误',slug:'mixed-source',steps:[{alias:'holdings',dapiId:h.id},{alias:'cash',dapiId:c.id}]},f.a,'mixed');assert.equal(x.status,409);assert.equal(x.body.code,'MIXED_SOURCE_VERSIONS');
});
test('snapshot querying does not depend on a live compute worker and concurrent calls respect the limit',async t=>{
  const f=await setup(t,{offlineCompute:true}),d=await f.create('isolated-query',['client_id','total_assets']);
  const app=await f.call('/data-services/applications',{name:'只读查询测试应用',serviceIds:[d.id]},f.a,'isolated');
  const headers={authorization:'Bearer '+app.body.token},url='/open/dapis/isolated-query?client_id=CLIENT-001';
  const outcomes=await Promise.all([f.call(url,undefined,headers),f.call(url,undefined,headers),f.call(url,undefined,headers)]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,200,429]);
  const docs=(await f.call(`/data-services/dapis/${d.id}/openapi`,undefined,f.a)).body;assert.equal(docs['x-shuduo-scope'],'PRIVATE_CLOUD_TEST');assert.equal(docs.servers[0].url,'/');
});
test('private query rejects altered snapshot rows even when the stored hash was not changed',async t=>{
  const f=await setup(t,{offlineCompute:true}),d=await f.create('integrity-query',['client_id','total_assets']);
  const app=await f.call('/data-services/applications',{name:'快照完整性测试',serviceIds:[d.id]},f.a,'integrity-client');
  const version=f.s.get('data_service_version',d.publishedVersionId,PROJECT);
  f.app.businessStore.db.prepare('UPDATE customer_assets SET total_assets=? WHERE snapshot_id=? AND client_id=?').run('9999.00',version.snapshotId,'CLIENT-001');
  const response=await f.call('/open/dapis/integrity-query?client_id=CLIENT-001',undefined,{authorization:'Bearer '+app.body.token});
  assert.equal(response.status,409);
  assert.equal(response.body.code,'SOURCE_SNAPSHOT_UNAVAILABLE');
});
test('service recovery evidence is owned, read-only, data-free and detects snapshot loss',async t=>{
  const f=await setup(t,{offlineCompute:true}),d=await f.create('recovery-owned',['client_id','total_assets']);
  const path=`/data-services/dapis/${d.id}/recovery`;
  assert.equal(privateServiceRoute('GET','/api/v2'+path),true);
  assert.equal(privateServiceRoute('POST','/api/v2'+path),false);
  assert.equal(privateServiceRoute('GET','/api/v2'+path+'?sql=SELECT%201'),false);
  assert.equal((await f.call(path)).status,401);assert.equal((await f.call(path,undefined,f.b)).status,403);
  const beforeDocuments=f.s.list('data_service',PROJECT).length;
  const report=(await f.call(path,undefined,f.a)).body;
  assert.equal(report.healthy,true);assert.match(report.bootId,/^[a-f0-9-]{36}$/);
  assert.match(report.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(report.state.evidence[0].snapshot.actualRowCount,2);
  assert.ok(!JSON.stringify(report).includes('CLIENT-001'));
  assert.ok(!JSON.stringify(report).includes('tokenHash'));
  assert.equal(f.s.list('data_service',PROJECT).length,beforeDocuments);
  assert.equal((await f.call(path,undefined,f.a)).body.fingerprint,report.fingerprint);
  f.app.businessStore.db.exec('DELETE FROM customer_assets; DELETE FROM service_snapshots;');
  const missing=(await f.call(path,undefined,f.a)).body;
  assert.equal(missing.healthy,false);assert.equal(missing.state.evidence[0].snapshot,null);
  assert.equal(missing.state.evidence[0].code,'SOURCE_SNAPSHOT_UNAVAILABLE');
});
test('standalone Python client sends only application authorization and verifies real query response',async t=>{
  const f=await setup(t),d=await f.create('python-client-query',['client_id','total_assets']);
  const app=await f.call('/data-services/applications',{name:'独立Python查询客户端',serviceIds:[d.id]},f.a,'python-client');
  const dir=mkdtempSync(join(tmpdir(),'shuduo-app-client-')),path=join(dir,'token');writeFileSync(path,app.body.token,{mode:0o600});
  const {stdout}=await promisify(execFile)('python3',['scripts/query-v2-data-service.py','--base-url',f.base,'--type','dapi','--slug',d.slug,'--token-file',path,'--client-id','CLIENT-001'],{timeout:10000});
  const value=JSON.parse(stdout);assert.equal(value.ok,true);assert.equal(value.authentication,'APPLICATION_BEARER_ONLY');assert.deepEqual(value.response.data,[{client_id:'CLIENT-001',total_assets:'2300.00'}]);assert.ok(!stdout.includes(app.body.token));
});
