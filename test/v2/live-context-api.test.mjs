import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLocalSourceApiFixture} from './fixtures/local-service-api-journey.mjs';
import {PROJECT} from '../../src/v2/server.mjs';
import {currentLiveLifecycleContract,liveLifecyclePlan,liveCaseCheckpoint,advanceLiveLifecycleCase,verifyLiveCaseEvidence} from '../../src/v2/live-lifecycle-evaluation.mjs';
import {createLiveEvaluationAdapter,runLiveLifecycleCli} from '../../scripts/run-live-lifecycle-evaluation.mjs';

// Real HTTP, controller, wall-clock timer, immutable files and SQLite queries.
// Model and Spark results are injected synthetic receipts, never live scores.
test('fresh and derived v3 cases each publish and consume their own result, recovering a lost child submission and a read-only CLI checkpoint',async t=>{
 const f=await createLocalSourceApiFixture();t.after(()=>f.dispose());const contractId=currentLiveLifecycleContract.id,plan=liveLifecyclePlan(20,{contractId}),
  parentDefinition=plan.selectedCases[0],childDefinition=plan.selectedCases.find(value=>value.sourceCaseId===parentDefinition.id),startedAt=new Date().toISOString(),runId=randomUUID();
 let lost=false,lostLookup=false,originalRequestId;const requests=[];
 const fetchImpl=async(url,options)=>{
  const path=new URL(url).pathname,body=options.body&&JSON.parse(options.body);requests.push({path,method:options.method});
  if(lost&&!lostLookup&&path.includes('/agent/requests/')){lostLookup=true;throw Error('synthetic lookup unavailable after lost child submission');}
  const response=await fetch(url,options);
  if(!lost&&options.method==='POST'&&path==='/api/v2/agent/tasks'&&body?.derivation&&response.ok){lost=true;originalRequestId=options.headers['idempotency-key'];await response.text();throw Error('synthetic lost child creation response');}
  return response;
 };
 const adapter=createLiveEvaluationAdapter(f.origin,{testDouble:true,fetchImpl}),advance=(definition,state,parent)=>advanceLiveLifecycleCase(definition,state,adapter,
  {maxPolls:100,pause:()=>new Promise(resolve=>setTimeout(resolve,5)),sourceCheckpoint:parent});
 async function operatorPublishAndConsume(state,label){
  const {packageId,packageDigest,verificationId}=state.delivery;
  const review=await f.call(`/delivery/packages/${packageId}/review`,{packageDigest,verificationId,reviewNote:'本机合成验收：独立核对本版本，不是生产发布批准',
   attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}});assert.equal(review.status,201);
  const approved=await f.call(`/delivery/packages/${packageId}/approve`,{packageDigest,reviewId:review.body.id});assert.equal(approved.status,201);
  const published=await f.call('/releases',{approvalId:approved.body.id,triggerAfterSeconds:1,intervalSeconds:2,runCount:2});assert.equal(published.status,201);
  await f.poll(`/releases/${published.body.id}`,value=>value.health==='HEALTHY');
  const query=new URLSearchParams({agent_task_id:state.taskId,package_digest:packageDigest,release_id:published.body.id}),sources=await f.call('/data-services/sources?'+query);assert.equal(sources.status,200);assert.equal(sources.body.length,2);
  async function dapi(suffix,fields){const made=await f.call('/data-services/dapis',{name:'合成独立证券查询'+suffix,slug:`v3-${label}-${suffix}`,sourceReleaseRunId:sources.body[0].id,fields});assert.equal(made.status,201);
   assert.equal((await f.call(`/data-services/dapis/${made.body.id}/test`,{})).status,200);assert.equal((await f.call(`/data-services/dapis/${made.body.id}/publish`,{configHash:made.body.currentVersion.configHash})).status,200);return made.body;}
  const holdings=await dapi('holdings',['client_id','holding_market_value','security_count']),cash=await dapi('cash',['client_id','available_cash','total_assets']);
  const xapi=await f.call('/data-services/xapis',{name:'合成组合查询',slug:`v3-${label}-overview`,steps:[{alias:'holdings',dapiId:holdings.id},{alias:'cash',dapiId:cash.id}]});assert.equal(xapi.status,201);
  assert.equal((await f.call(`/data-services/xapis/${xapi.body.id}/test`,{})).status,200);assert.equal((await f.call(`/data-services/xapis/${xapi.body.id}/publish`,{configHash:xapi.body.currentVersion.configHash})).status,200);
  const app=await f.call('/data-services/applications',{name:'合成单接口消费',serviceIds:[xapi.body.id]});assert.equal(app.status,201);
  const result=await f.call(`/open/xapis/v3-${label}-overview?client_id=CLIENT-001`,undefined,{headers:{authorization:'Bearer '+app.body.token}});assert.equal(result.status,200);
  assert.equal((await f.call(`/data-services/applications/${app.body.application.id}/revoke`,{})).status,200);
  return {releaseId:published.body.id,reviewId:review.body.id,approvalId:approved.body.id,query,result:result.body.data};
 }
 let parent=await advance(parentDefinition,liveCaseCheckpoint(parentDefinition,startedAt,plan.caseSetDigest,{contractId,evaluationRunId:runId}));assert.equal(parent.status,'AWAITING_ENGINEER_REVIEW',parent.errorCode);
 const parentPublication=await operatorPublishAndConsume(parent,'parent');parent=await advance(parentDefinition,parent);assert.equal(parent.status,'SUCCEEDED',parent.errorCode);
 assert.equal(verifyLiveCaseEvidence(parentDefinition,parent),true);
 const parentTaskBefore=structuredClone(f.store.get('agent',parent.taskId,PROJECT)),parentApprovalBefore=structuredClone(f.store.get('release_approval',parentPublication.approvalId,PROJECT));
 let child=await advance(childDefinition,liveCaseCheckpoint(childDefinition,startedAt,plan.caseSetDigest,{contractId,evaluationRunId:runId}),parent);
 assert.equal(child.status,'PAUSED',child.errorCode);assert.equal(child.errorCode,'MUTATION_OUTCOME_UNKNOWN');assert.equal(child.actions.agent.key,originalRequestId);
 const source=structuredClone(child.derivationSource),submittedCount=requests.filter(item=>item.method==='POST'&&item.path==='/api/v2/agent/tasks').length;
 const root=mkdtempSync(join(tmpdir(),'shuduo-v3-live-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const directory=join(root,runId);mkdirSync(directory,{mode:0o700});
 const checkpointPath=join(directory,'checkpoint.json');
 const checkpointFor=child=>({evaluationRunId:runId,contract:currentLiveLifecycleContract,startedAt,origin:f.origin,
  caseSetDigest:plan.caseSetDigest,caseLimit:11,outcomes:[parent,child],executionEvidenceMode:'TEST_HARNESS'});
 writeFileSync(checkpointPath,JSON.stringify(checkpointFor(child)),{mode:0o600});
 const beforeLookup={...f.counts},lookupRequests=[],lookupOutput=[],lookupErrors=[];
 const lookupOptions={artifactRoot:root,output:text=>lookupOutput.push(JSON.parse(text)),error:text=>lookupErrors.push(text),
  fetchImpl:(url,request)=>{lookupRequests.push({method:request.method,path:new URL(url).pathname});return fetch(url,request);}};
 assert.equal(await runLiveLifecycleCli(['--reconcile',runId],{},lookupOptions),0,lookupErrors.join('\n'));
 assert.deepEqual(lookupRequests,[{method:'GET',path:'/api/v2/agent/requests/'+originalRequestId}]);
 assert.equal(lookupOutput[0].cases[0].status,'RECOVERED');
 assert.deepEqual(f.counts,beforeLookup);
 child=JSON.parse(readFileSync(checkpointPath,'utf8')).outcomes[1];
 assert.equal(child.status,'PAUSED');
 assert.equal(child.actions.agent.status,'CONFIRMED');
 assert.deepEqual(child.derivationSource,source);
 child=await advance(childDefinition,child,parent);assert.equal(child.status,'AWAITING_ENGINEER_REVIEW',child.errorCode);assert.deepEqual(child.derivationSource,source);
 assert.equal(requests.filter(item=>item.method==='POST'&&item.path==='/api/v2/agent/tasks').length,submittedCount);assert.equal(f.counts.syntheticModel,2);
 const childPublication=await operatorPublishAndConsume(child,'child');
 assert.deepEqual(childPublication.result,[{client_id:'CLIENT-001',holdings:{holding_market_value:'1000.00',security_count:1},cash:{available_cash:'300.00',total_assets:'1300.00'}}]);
 assert.notEqual(childPublication.approvalId,parentPublication.approvalId);assert.notEqual(child.delivery.packageDigest,parent.delivery.packageDigest);
 // Persist the monitor/consumption boundary with consumption temporarily
 // unavailable, then let the actual CLI perform only the original exact GET.
 const withoutConsumption={testDouble:true,request:async(path,body,key)=>path.startsWith('/data-services/task-evidence?')?{protocol:'shuduo-local-task-consumption/v1',scope:'LOCAL_TEST_ONLY',
  sourceKind:'AGENT',taskId:child.taskId,packageDigest:child.delivery.packageDigest,releaseId:childPublication.releaseId,status:'PENDING',checkedAt:new Date().toISOString(),services:[],matchingCount:0,
  truncated:false,externalSystemVerified:false,agentIndependentE2E:false,publicDeployed:false}:adapter.request(path,body,key)};
 child=await advanceLiveLifecycleCase(childDefinition,child,withoutConsumption,{sourceCheckpoint:parent,pause:async()=>{},maxPolls:2});assert.equal(child.status,'AWAITING_CONSUMPTION',child.errorCode);
 writeFileSync(checkpointPath,JSON.stringify(checkpointFor(child)),{mode:0o600});
 const before={...f.counts,calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length},reads=[],output=[],errors=[];
 const options={artifactRoot:root,output:text=>output.push(JSON.parse(text)),error:text=>errors.push(text),fetchImpl:async(url,request)=>{reads.push({url,method:request.method});return fetch(url,request);}};
 assert.equal(await runLiveLifecycleCli(['--refresh',runId],{},options),0,errors.join('\n'));
 assert.equal(reads.length,1);assert.equal(reads[0].method,'GET');assert.equal(new URL(reads[0].url).searchParams.get('agent_task_id'),child.taskId);
 const saved=JSON.parse(readFileSync(checkpointPath,'utf8')),completed=saved.outcomes.find(item=>item.caseId===childDefinition.id);
 assert.equal(completed.status,'SUCCEEDED');assert.equal(verifyLiveCaseEvidence(childDefinition,completed,{sourceCheckpoint:parent}),true);
 assert.equal(saved.frozenCaseCount,20);assert.equal(saved.succeededCaseCount,0);assert.equal(saved.targetMet,false);
 const bytes=readFileSync(checkpointPath,'utf8');assert.equal(await runLiveLifecycleCli(['--report',runId],{},options),0);assert.equal(readFileSync(checkpointPath,'utf8'),bytes);assert.equal(reads.length,1);
 const childLink=output.at(-1).cases.find(item=>item.caseId===childDefinition.id);assert.equal(new URL(childLink.servicesUrl).searchParams.get('source_task'),child.taskId);
 assert.deepEqual({...f.counts,calls:f.store.list('service_call',PROJECT).length,apps:f.store.list('service_app',PROJECT).length},before);
 assert.deepEqual(f.store.get('agent',parent.taskId,PROJECT),parentTaskBefore);assert.deepEqual(f.store.get('release_approval',parentPublication.approvalId,PROJECT),parentApprovalBefore);
 assert.equal(f.counts.syntheticModel,2);assert.equal(f.counts.syntheticSpark,8);
});

test('new CLI execution chooses v3, stops for real per-package review and resumes the same task without new computation',async t=>{
 const f=await createLocalSourceApiFixture({readyForUi:true});t.after(()=>f.dispose());
 const artifactRoot=mkdtempSync(join(tmpdir(),'shuduo-v3-cli-execution-'));t.after(()=>rmSync(artifactRoot,{recursive:true,force:true}));
 const runId=randomUUID(),output=[],errors=[],env={V2_LIVE_EVALUATION_ORIGIN:f.origin,V2_LIVE_EVALUATION_CASE_LIMIT:'1',
  V2_LIVE_EVALUATION_AUTHORIZED:'LOCAL_FRESH_MODEL_WITH_HUMAN_REVIEW',V2_LIVE_EVALUATION_AUTHORIZED_CASES:'1'};
 const options={artifactRoot,runId,testDouble:true,output:text=>output.push(JSON.parse(text)),error:text=>errors.push(text)};
 assert.equal(await runLiveLifecycleCli(['--execute'],env,options),2,errors.join('\n'));
 const path=join(artifactRoot,runId,'checkpoint.json'),initial=JSON.parse(readFileSync(path,'utf8'));
 assert.equal(initial.contract.id,currentLiveLifecycleContract.id);assert.equal(initial.outcomes.length,1);assert.equal(initial.outcomes[0].status,'AWAITING_ENGINEER_REVIEW');
 assert.equal(initial.frozenCaseCount,20);assert.equal(initial.succeededCaseCount,0);assert.equal(initial.targetMet,false);
 const counts={...f.counts};assert.equal(await runLiveLifecycleCli(['--resume',runId],env,options),2,errors.join('\n'));
 const restored=JSON.parse(readFileSync(path,'utf8'));assert.equal(restored.outcomes[0].taskId,initial.outcomes[0].taskId);assert.deepEqual(f.counts,counts);
 assert.equal(f.store.list('release_approval',PROJECT).length,0);assert.equal(f.store.list('release',PROJECT).length,0);
 assert.equal(f.store.list('agent',PROJECT).length,1);assert.equal(f.counts.syntheticModel,1);assert.equal(f.counts.syntheticSpark,2);
 const reuseKey=randomUUID(), prior=restored.outcomes[0];
 const reused=await f.call(`/agent/tasks/${prior.taskId}/prepare-delivery`,{}, {headers:{"idempotency-key":reuseKey}});
 assert.equal(reused.status,200);
 assert.equal(reused.body.id,prior.actions.delivery.id);
 const expected=prior.actions.delivery.id;
 prior.status='PAUSED';prior.phase='DELIVERY_PREPARATION';
 prior.actions.delivery={key:reuseKey,bodyHash:prior.actions.delivery.bodyHash,status:'UNKNOWN'};
 writeFileSync(path,JSON.stringify(restored),{mode:0o600});
 assert.equal(await runLiveLifecycleCli(['--reconcile',runId],{},options),0,errors.join('\n'));
 const reconciled=JSON.parse(readFileSync(path,'utf8')).outcomes[0];
 assert.equal(reconciled.actions.delivery.id,expected);
 assert.equal(reconciled.status,'PAUSED');
 assert.deepEqual(f.counts,counts);
 assert.equal(f.store.list('agent_delivery_task',PROJECT).length,1);
 const bytes=readFileSync(path,'utf8');assert.equal(await runLiveLifecycleCli(['--report',runId],{},options),0);assert.equal(readFileSync(path,'utf8'),bytes);
});
