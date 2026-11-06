import test from'node:test';import assert from'node:assert/strict';
import{MetadataStore}from'../../src/v2/store.mjs';import{createV2Server,PROJECT}from'../../src/v2/server.mjs';
import{getContext,contextIds,referenceSql,validationContractId}from'../../src/v2/context.mjs';
import{createDeliveryPackage,sha256}from'../../src/v2/delivery.mjs';
import{developmentVerificationReport}from'../../src/v2/agent-development-workflow.mjs';
import{checkedAgentWorkflow}from'../../web/src/agent-workflow-read.ts';import{agentJourney}from'../../web/src/agent-journey.ts';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(t,{manual=false}={}){
 const store=new MetadataStore(':memory:');t.after(()=>store.close());
 const task=store.create('agent',PROJECT,{message:'虚构证券持仓加工',contextId:'cash-change',mode:'LIVE_MODEL',language:'SPARK_SQL',status:'SUCCEEDED',attempts:[]});
 const revision=store.create('revision',PROJECT,{sql:referenceSql,hash:sha256(referenceSql),contextId:task.contextId,...(manual?{source:'MANUAL',manualProvenance:{kind:'ENGINEER_EDIT',originAgentTaskId:task.id,actorId:'synthetic-owner',agentIndependentE2E:false}}:{})});
 // Synthetic persisted engine evidence tests the read contract; no engine/model
 // runs here and these rows never contribute to live E2E acceptance.
 const run=store.create('run',PROJECT,{agentTaskId:task.id,contextId:task.contextId,revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,rows:getContext(task.contextId).expected,validation:{passed:true,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:true}))}});
 const bundle=store.create('delivery_package',PROJECT,createDeliveryPackage({run,revision}));
 const delivery=store.create('agent_delivery_task',PROJECT,{sourceAgentTaskId:task.id,sourceRevisionId:revision.id,sourceRunId:run.id,sourceSqlHash:revision.hash,status:'SUCCEEDED',stage:'AWAITING_ENGINEER_REVIEW',packageId:bundle.id,packageDigest:bundle.digest,...(manual?{sourceKind:'MANUAL'}:{})});
 const verification=store.create('delivery_verification',PROJECT,{status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,testSqlValidation:{passed:true},validation:run.validation});
 const saved=store.update('agent_delivery_task',delivery.id,PROJECT,{verificationId:verification.id});
 store.update('agent',task.id,PROJECT,{sql:revision.sql,revisionId:revision.id,runId:run.id,attempts:[{attempt:1,status:'SUCCEEDED',revisionId:revision.id,runId:run.id}]});
 const report={...developmentVerificationReport(task,run,revision),...(manual?{sourceKind:'MANUAL',agentIndependentE2E:false}:{})};
 const value=JSON.parse(JSON.stringify({report,delivery:saved,package:{id:bundle.id,digest:bundle.digest,manifest:bundle.manifest,files:bundle.files},verification,publication:{available:true,scope:manual?'PRIVATE_CLOUD_TEST':'LOCAL_TEST_RELEASE',reason:'合成发布能力，仅验证客户端读取',...(manual?{sourceKind:'MANUAL',sourceRunId:run.id,agentIndependentE2E:false}:{})}}));
 return{store,task,revision,run,value,selection:{taskId:task.id,contextId:task.contextId,revisionId:revision.id,runId:run.id,manual}};
}
test('SQL workflow reads accept matching serialized reports and package bytes',async t=>{
 const f=fixture(t);assert.equal(await checkedAgentWorkflow(f.value,f.selection),f.value);
 assert.equal(f.value.report.status,'PASSED');assert.equal(f.value.package.files['main.sql'],referenceSql);
});
test('queued tasks without an execution or package remain readable as pending',async t=>{
 const f=fixture(t),value={report:developmentVerificationReport(f.task,undefined,undefined),publication:{available:false,scope:'LOCAL_TEST_RELEASE',reason:'等待执行'}};
 assert.equal((await checkedAgentWorkflow(value,{taskId:f.task.id,contextId:f.task.contextId,manual:false})).report.status,'PENDING');
});
test('malformed envelopes, checks and contradictory pass flags reject before display',async t=>{
 const f=fixture(t);for(const mutate of [v=>null,v=>({}),v=>({...v,publication:null}),v=>({...v,report:{...v.report,checks:null}}),v=>({...v,report:{...v.report,checks:[v.report.checks[0],v.report.checks[0]]}}),v=>({...v,report:{...v.report,rowCount:'2'}}),v=>({...v,report:{...v.report,checks:v.report.checks.map(c=>({...c,passed:false}))}}),v=>({...v,report:{...v.report,engine:'synthetic unsupported engine'}}),v=>({...v,publication:{...v.publication,reason:{}}})])await assert.rejects(checkedAgentWorkflow(mutate(structuredClone(f.value)),f.selection),/未确认/);
});
test('another task, context, manual attribution or frozen source cannot be substituted',async t=>{
 const f=fixture(t);for(const mutate of [v=>{v.report.taskId=uuid(9)},v=>{v.report.contextId='stock-cash-t1'},v=>{v.report.sourceKind='MANUAL'},v=>{v.delivery.sourceAgentTaskId=uuid(9)},v=>{v.delivery.sourceRunId=uuid(9)},v=>{v.verification.id=uuid(9)}]){const value=structuredClone(f.value);mutate(value);await assert.rejects(checkedAgentWorkflow(value,f.selection),/未确认/);}
 await assert.rejects(checkedAgentWorkflow(f.value,{...f.selection,expectedSourceBinding:{taskId:f.task.id,revisionId:uuid(9),runId:f.run.id,packageDigest:f.value.package.digest,releaseId:uuid(8),sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY'}}),/未确认/);
 await assert.rejects(checkedAgentWorkflow(f.value,{...f.selection,expectedSourceBinding:{taskId:f.task.id,revisionId:f.revision.id,runId:f.run.id,packageDigest:f.value.package.digest,releaseId:uuid(8),sourceKind:'AGENT',scope:'PRIVATE_CLOUD_TEST'}}),/未确认/);
});
test('package manifests, individual bytes and immutable source relationships are checked',async t=>{
 const f=fixture(t);for(const mutate of [v=>{v.package.files['main.sql']+='\n-- tampered'},v=>{v.package.manifest.files['main.sql'].bytes++},v=>{v.package.files['../extra']='bad'},v=>{v.package.manifest.source.contextId='stock-cash-t1'},v=>{v.package.manifest.name='changed'},v=>{delete v.package.files['schedule.json']},v=>{v.delivery.packageDigest='a'.repeat(64)},v=>{delete v.package},v=>{delete v.verification}]){const value=structuredClone(f.value);mutate(value);await assert.rejects(checkedAgentWorkflow(value,f.selection),/未确认/);}
});
test('same-task historical evidence stays historical while manual reads require exact run and attribution',async t=>{
 const f=fixture(t),selection={...f.selection,revisionId:uuid(8),runId:uuid(9)};const value=await checkedAgentWorkflow(f.value,selection);
 assert.equal(agentJourney({...selection,dirty:false,report:value.report,delivery:value.delivery,bundle:value.package,verification:value.verification}).current,false);
 const m=fixture(t,{manual:true});assert.equal(await checkedAgentWorkflow(m.value,m.selection),m.value);
 for(const mutate of [v=>{v.report.agentIndependentE2E=true},v=>{v.package.manifest.source.attribution.originAgentTaskId=uuid(9)},v=>{v.publication.sourceKind='AGENT'}]){const value=structuredClone(m.value);mutate(value);await assert.rejects(checkedAgentWorkflow(value,m.selection),/未确认/);}
 await assert.rejects(checkedAgentWorkflow(m.value,{...m.selection,runId:uuid(9)}),/未确认/);
});
test('failed preparation remains readable without fabricated files or rehearsal',async t=>{
 const f=fixture(t),value=structuredClone(f.value);value.delivery.status='FAILED';value.delivery.stage='PACKAGE_FAILED';value.delivery.error='合成准备失败';for(const key of ['packageId','packageDigest','verificationId'])delete value.delivery[key];delete value.package;delete value.verification;
 assert.equal((await checkedAgentWorkflow(value,f.selection)).delivery.status,'FAILED');
});
test('actual readonly HTTP projection is compatible and does not create new records',async t=>{
 const f=fixture(t),app=createV2Server({store:f.store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const counts=()=>['agent','run','revision','agent_delivery_task','delivery_verification','release'].map(k=>f.store.list(k,PROJECT).length),before=counts();
 const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v2/agent/tasks/'+f.task.id+'/workflow');assert.equal(response.status,200);
 const value=await checkedAgentWorkflow(await response.json(),f.selection);assert.equal(value.package.digest,f.value.package.digest);assert.deepEqual(counts(),before);
});
