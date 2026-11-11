import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runConsumerAcceptance,runConsumerBinding} from '../../scripts/verify-service-consumer.mjs';
import {bindExternalConsumption} from '../../src/v2/external-consumption-binding.mjs';
import {consumerCanonical,consumerDigest} from '../../src/v2/consumer-source.mjs';
import {createLocalSourceApiFixture,publishLocalAgentFixture} from './fixtures/local-service-api-journey.mjs';
import {PROJECT} from '../../src/v2/server.mjs';

// Real standalone HTTP requests, controller/files and SQLite. Upstream model and
// Spark are injected synthetic receipts; no real environment is attested.
test('existing consumer V2 and pure binder join the exact real local API receipt without upgrading fixture evidence',async t=>{
 const f=await createLocalSourceApiFixture();t.after(()=>f.dispose());const selected=await publishLocalAgentFixture(f,{contextId:'stock-cash-t1'});
 async function dapi(name,slug,fields){const made=await f.call('/data-services/dapis',{name,slug,sourceReleaseRunId:selected.sources[0].id,fields,rateLimitPerMinute:12});assert.equal(made.status,201);
  assert.equal((await f.call(`/data-services/dapis/${made.body.id}/test`,{})).status,200);
  assert.equal((await f.call(`/data-services/dapis/${made.body.id}/publish`,{configHash:made.body.currentVersion.configHash})).status,200);return made.body;}
 const holdings=await dapi('独立证券持仓断言','consumer-bound-holdings',['client_id','holding_market_value','security_count']),cash=await dapi('独立证券现金断言','consumer-bound-cash',['client_id','available_cash','total_assets']);
 const made=await f.call('/data-services/xapis',{name:'独立股票现金组合','slug':'consumer-bound-assets',steps:[{alias:'holdings',dapiId:holdings.id},{alias:'cash',dapiId:cash.id}],rateLimitPerMinute:6});assert.equal(made.status,201);const xapi=made.body;
 assert.equal((await f.call(`/data-services/xapis/${xapi.id}/test`,{})).status,200);
 assert.equal((await f.call(`/data-services/xapis/${xapi.id}/publish`,{configHash:xapi.currentVersion.configHash})).status,200);
 const evidencePath='/data-services/task-evidence?'+selected.query;
 const initial=await f.call(evidencePath);assert.equal(initial.body.status,'PENDING');
 const source=initial.body.services.find(entry=>entry.serviceId===xapi.id).source;
 assert.equal(source.taskId,selected.agent.id);assert.equal(source.packageDigest,selected.bundle.digest);assert.equal(source.sourceReleaseRunId,selected.sources[0].id);
 const planFile=join(f.root,'consumer-plan.json'),tokenFile=join(f.root,'consumer-token'),reportFile=join(f.root,'consumer-report.json');
 const descriptor=(service,extra={})=>({id:service.id,slug:service.slug,versionId:service.currentVersion.id,configHash:service.currentVersion.configHash,...extra});
 // Literal business expectations are declared before any consumer response.
 const expectedRows=[{client_id:'CLIENT-002',holding_market_value:'750.00',available_cash:'200.00',total_assets:'950.00',security_count:1},
  {client_id:'CLIENT-001',holding_market_value:'1000.00',available_cash:'300.00',total_assets:'1300.00',security_count:1}];
 const plan={protocol:'SERVICE_CONSUMER_V2',authorized:true,origin:f.origin,approvedOrigin:f.origin,testOnly:true,
  startedAt:new Date(Date.now()-1000).toISOString(),deadline:new Date(Date.now()+60000).toISOString(),timeoutMs:5000,maxRequests:20,reportFile,expectedRows,
  dapis:[descriptor(holdings,{alias:'holdings',fields:holdings.currentVersion.fields,granted:true}),descriptor(cash,{alias:'cash',fields:cash.currentVersion.fields,granted:false})],
  xapi:descriptor(xapi),ungranted:{type:'DAPI',slug:cash.slug},rateLimit:{serviceId:xapi.id,perMinute:6},source};
 writeFileSync(planFile,JSON.stringify(plan),{mode:0o600});
 const issued=await f.call('/data-services/applications',{name:'独立本机断言应用',serviceIds:[holdings.id,xapi.id]});assert.equal(issued.status,201);
 writeFileSync(tokenFile,issued.body.token,{mode:0o600});
 const before={...f.counts};assert.equal((await runConsumerAcceptance({planFile,tokenFile})).requests,0);
 assert.equal((await runConsumerAcceptance({planFile,tokenFile,execute:true})).result,'PASSED');
 assert.equal((await f.call(`/data-services/applications/${issued.body.application.id}/revoke`,{})).status,200);
 assert.equal((await runConsumerAcceptance({planFile,tokenFile,phase:'revoked',execute:true})).result,'PASSED');
 const report=JSON.parse(readFileSync(reportFile,'utf8')),api=await f.call(evidencePath);assert.equal(api.status,200);assert.equal(api.body.status,'VERIFIED');
 const call=api.body.services.find(entry=>entry.serviceId===xapi.id).call;
 const counts={calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length};
 const bound=bindExternalConsumption({expectedSource:source,plan,report,taskEvidence:api.body});
 const sourceFile=join(f.root,'frozen-source.json'),evidenceFile=join(f.root,'task-evidence.json');
 writeFileSync(sourceFile,JSON.stringify(source),{mode:0o600});writeFileSync(evidenceFile,JSON.stringify(api.body),{mode:0o600});
 const originals=[planFile,sourceFile,evidenceFile,reportFile].map(path=>readFileSync(path,'utf8'));
 assert.deepEqual(runConsumerBinding({planFile,sourceFile,evidenceFile}),bound);
 assert.deepEqual([planFile,sourceFile,evidenceFile,reportFile].map(path=>readFileSync(path,'utf8')),originals);
 assert.equal(bound.status,'MATCHED_ONLY',bound.reason);assert.equal(bound.eligibleForExternalAcceptance,false);assert.equal(bound.externalSystemVerified,false);assert.equal(bound.agentIndependentE2E,false);
 assert.equal(bound.callIdDigest,consumerDigest(call.callId));assert.equal(bound.rowsDigest,call.resultHash);
 assert.equal(report.requests.find(entry=>entry.sequence===bound.matchedRequestSequence).rowsDigest,consumerDigest(consumerCanonical([{client_id:'CLIENT-001',holdings:{holding_market_value:'1000.00',security_count:1},cash:{available_cash:'300.00',total_assets:'1300.00'}}])));
 assert.equal(report.requestCount,15);assert.deepEqual(report.phases,{consume:'PASSED',revoked:'PASSED'});
 const wrong=structuredClone(api.body);wrong.services.find(entry=>entry.serviceId===xapi.id).call.callId='a-different-current-call';
 assert.equal(bindExternalConsumption({expectedSource:source,plan,report,taskEvidence:wrong}).reason,'CALL_UNMATCHED');
 assert.deepEqual(f.counts,before);assert.deepEqual({calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length},counts);
 for(const forbidden of [issued.body.token,'CLIENT-001','1000.00',planFile,tokenFile,reportFile,'credentialDigest'])assert.equal(JSON.stringify(bound).includes(forbidden),false);

 const laterApp=await f.call('/data-services/applications',{name:'后续虚构查询',serviceIds:[xapi.id]});
 assert.equal(laterApp.status,201);
 const laterResponse=await f.call('/open/xapis/consumer-bound-assets?page=1&page_size=1',undefined,{headers:{authorization:'Bearer '+laterApp.body.token}});
 assert.equal(laterResponse.status,200);
 assert.equal((await f.call(`/data-services/applications/${laterApp.body.application.id}/revoke`,{})).status,200);
 const latest=await f.call(evidencePath);
 assert.equal(latest.body.services.find(entry=>entry.serviceId===xapi.id).call.callId,laterResponse.body.callId);
 assert.equal(bindExternalConsumption({expectedSource:source,plan,report,taskEvidence:latest.body}).reason,'CALL_UNMATCHED');
 const finalCounts={calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length};
 const pinned=await f.call(evidencePath+'&call_id_digest='+bound.callIdDigest);
 assert.equal(pinned.status,200);
 assert.equal(pinned.body.services.length,1);
 assert.equal(pinned.body.services[0].call.callId,call.callId);
 const restored=bindExternalConsumption({expectedSource:source,plan,report,taskEvidence:pinned.body});
 assert.equal(restored.status,'MATCHED_ONLY',restored.reason);
 assert.equal(restored.callIdDigest,bound.callIdDigest);
 const absent=await f.call(evidencePath+'&call_id_digest='+'0'.repeat(64));
 assert.equal(absent.status,200);assert.equal(absent.body.status,'PENDING');assert.deepEqual(absent.body.services,[]);
 assert.deepEqual(f.counts,before);assert.deepEqual({calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length},finalCounts);
});
