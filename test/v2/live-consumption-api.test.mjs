import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLiveLifecycleFixture} from './fixtures/live-lifecycle-case.mjs';
import {advanceLiveLifecycleCase,refreshLiveLifecycleConsumption,verifyLiveCaseEvidence,summarizeLiveLifecycle,liveLifecycleContract} from '../../src/v2/live-lifecycle-evaluation.mjs';
import {runLiveLifecycleCli} from '../../scripts/run-live-lifecycle-evaluation.mjs';
import {m1EvaluationCases} from '../../src/v2/evaluation.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {BusinessQueryStore,DataServiceManager} from '../../src/v2/data-services.mjs';
import {getContext} from '../../src/v2/context.mjs';

// The first seven stages are explicitly synthetic receipts. Only the local
// service SQL and authenticated-by-local-mode HTTP path actually execute here;
// no real model/Spark/cloud or external-system acceptance is claimed.
test('monitor checkpoint advances only after actual local service query evidence, then restores through a GET-only HTTP adapter',async t=>{
 const f=createLiveLifecycleFixture();
 const prepared=await advanceLiveLifecycleCase(f.definition,f.checkpoint,f.adapter,{pause:async()=>{},maxPolls:2});f.reviewNow();
 const waiting=await advanceLiveLifecycleCase(f.definition,prepared,f.adapter,{pause:async()=>{},maxPolls:2});
 assert.equal(waiting.status,'AWAITING_CONSUMPTION');assert.equal(f.mutations.length,2);
 const root=mkdtempSync(join(tmpdir(),'shuduo-live-consumption-api-')),store=new MetadataStore(join(root,'metadata.sqlite')),businessStore=new BusinessQueryStore(join(root,'business.sqlite'));
 const seed=(kind,value)=>{const record={...value,projectId:PROJECT,version:1};store.db.prepare('INSERT INTO documents(kind,id,project,version,data) VALUES(?,?,?,?,?)').run(kind,record.id,PROJECT,1,JSON.stringify(record));return record;};
 for(const [kind,value]of [['agent',f.task],['revision',f.revision],['run',f.run],['delivery_package',f.bundle],['agent_delivery_task',f.delivery],
  ['delivery_verification',f.verification],['delivery_review',f.review],['release_approval',f.approval],['release',f.release]])seed(kind,value);
 const rows=getContext(f.definition.contextId).expected;
 const batches=f.batches.map(batch=>seed('release_run',{...batch,published:true,publicDeployed:false,rows}));
 for(const event of f.events)seed('monitor_event',event);
 const manager=new DataServiceManager({store,businessStore,project:PROJECT,releaseRunFor:id=>store.get('release_run',id,PROJECT)});
 let computations=0;
 const app=createV2Server({root,store,businessStore,env:{V2_LOCAL_DEVELOPMENT:'true'},runner:async()=>{computations++;throw Error('SYNTHETIC_API_MUST_NOT_COMPUTE');},generator:async()=>{computations++;throw Error('SYNTHETIC_API_MUST_NOT_GENERATE');}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));businessStore.close();store.close();rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,requests=[],adapter={testDouble:true,request:async(path,body)=>{
  assert.equal(body,undefined);assert.ok(path.startsWith('/data-services/task-evidence?'));requests.push(path);
  const response=await fetch(base+path,{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return response.json();
 }};
 const before=JSON.stringify(waiting.actions),withoutServices=await refreshLiveLifecycleConsumption(f.definition,waiting,adapter);
 assert.equal(withoutServices.status,'AWAITING_CONSUMPTION');assert.equal(manager.listApplications().length,0);assert.equal(store.list('service_call',PROJECT).length,0);
 const artifactRoot=join(root,'reports'),evaluationRunId=randomUUID(),reportDirectory=join(artifactRoot,evaluationRunId),checkpointPath=join(reportDirectory,'checkpoint.json');
 mkdirSync(reportDirectory,{recursive:true,mode:0o700});
 writeFileSync(checkpointPath,JSON.stringify({evaluationRunId,startedAt:waiting.evaluationStartedAt,caseSetDigest:waiting.caseSetDigest,
  caseLimit:1,origin:base.replace('/api/v2',''),contract:liveLifecycleContract,executionEvidenceMode:'TEST_HARNESS',outcomes:[withoutServices]}),{mode:0o600});
 const output=[],errors=[],http=[];
 const cliOptions={artifactRoot,output:value=>output.push(JSON.parse(value)),error:value=>errors.push(value),fetchImpl:async(url,options)=>{
  assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.ok(url.startsWith(base+'/data-services/task-evidence?'));http.push(url);return fetch(url,options);
 }};
 assert.equal(await runLiveLifecycleCli(['--refresh',evaluationRunId],{},cliOptions),2);
 assert.equal(JSON.parse(readFileSync(checkpointPath,'utf8')).outcomes[0].status,'AWAITING_CONSUMPTION');assert.equal(http.length,1);
 async function dapi(slug,fields){const service=manager.createDapi({name:'虚构证券接口',slug,sourceReleaseRunId:batches[0].id,fields});await manager.test(service.id,{});manager.publish(service.id);return service;}
 const holdings=await dapi('live-fixture-holdings',['client_id','holding_market_value','security_count']),cash=await dapi('live-fixture-cash',['client_id','available_cash','total_assets']);
 const xapi=manager.createXapi({name:'虚构证券资产组合',slug:'live-fixture-assets',steps:[{alias:'holdings',dapiId:holdings.id},{alias:'cash',dapiId:cash.id}]});
 await manager.test(xapi.id,{});manager.publish(xapi.id);
 const beforeCall=await refreshLiveLifecycleConsumption(f.definition,withoutServices,adapter);assert.equal(beforeCall.status,'AWAITING_CONSUMPTION');
 const issued=manager.createApplication({name:'本机合成消费应用',serviceIds:[xapi.id]});
 const response=await manager.invoke('XAPI','live-fixture-assets','Bearer '+issued.token,{client_id:'CLIENT-001'});
 assert.equal(response.data.length,1);assert.equal(response.data[0].client_id,'CLIENT-001');manager.revokeApplication(issued.application.id);
 const saved=[];
 const complete=await refreshLiveLifecycleConsumption(f.definition,JSON.parse(JSON.stringify(beforeCall)),adapter,{save:value=>saved.push(value)});
 assert.equal(complete.status,'SUCCEEDED');assert.equal(verifyLiveCaseEvidence(f.definition,complete),true);
 assert.equal(complete.consumptionStage.evidence.services[0].call.callId,response.callId);
 assert.equal(complete.consumptionStage.evidence.services[0].call.applicationStatus,'REVOKED');
 assert.equal(complete.consumptionStage.evidence.services[0].sourceRunIds[0],batches[0].id);
 assert.ok(complete.consumptionStage.evidence.services[0].sourceVersions.every(v=>v.sourceReleaseRunId===batches[0].id));
 assert.equal(complete.consumptionStage.externalSystemVerified,false);assert.equal(JSON.stringify(complete.actions),before);
 assert.equal(await runLiveLifecycleCli(['--refresh',evaluationRunId],{},cliOptions),0);
 const persisted=JSON.parse(readFileSync(checkpointPath,'utf8'));
 assert.equal(persisted.outcomes[0].status,'SUCCEEDED');assert.equal(persisted.succeededCaseCount,0,'synthetic history cannot gain real score through actual SQLite');
 assert.equal(persisted.targetMet,false);assert.equal(http.length,2);assert.deepEqual(errors,[]);
 const frozenBytes=readFileSync(checkpointPath,'utf8');
 assert.equal(await runLiveLifecycleCli(['--report',evaluationRunId],{},cliOptions),0);assert.equal(readFileSync(checkpointPath,'utf8'),frozenBytes);
 assert.equal(output.at(-1).recorded,true);assert.equal(output.at(-1).currentContractTargetMet,false);assert.equal(http.length,2);
 const requestCount=requests.length,again=await refreshLiveLifecycleConsumption(f.definition,JSON.parse(JSON.stringify(complete)),adapter);
 assert.deepEqual(again,complete);assert.equal(requests.length,requestCount,'terminal restore verifies saved evidence without another query');
 assert.equal(saved.length,1);assert.equal(store.list('service_call',PROJECT).length,1);assert.equal(manager.listApplications().length,1);assert.equal(computations,0);assert.equal(f.mutations.length,2);
 const score=summarizeLiveLifecycle(m1EvaluationCases(),[complete]);assert.equal(score.succeededCaseCount,0);assert.equal(score.targetMet,false);assert.equal(score.executionEvidenceMode,'TEST_HARNESS');
 assert.equal(JSON.stringify(complete).includes(issued.token),false);assert.equal(JSON.stringify(complete.consumptionStage).includes('CLIENT-001'),false);
});
