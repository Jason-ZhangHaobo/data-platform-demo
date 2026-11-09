import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getContext,referenceSql} from '../../src/v2/context.mjs';
import {sqlRequirementBasis,sqlRequirementReport,bindSqlRequirementRevision,verifiedSqlRequirementReport,sqlRequirementBinding} from '../../src/v2/sql-requirements.mjs';
import {sqlRequirementReportMatches,validSqlRequirementInterpretation} from '../../src/v2/sql-requirement-contract.mjs';
import {generateSql} from '../../src/v2/model.mjs';
import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';
import {developmentVerificationReport} from '../../src/v2/agent-development-workflow.mjs';
import {createLiveLifecycleFixture} from './fixtures/live-lifecycle-case.mjs';
import {currentLiveLifecycleContract,liveLifecycleCases,advanceLiveLifecycleCase,verifyLiveCaseEvidence} from '../../src/v2/live-lifecycle-evaluation.mjs';
const input={message:'按登记口径计算虚构证券客户日资产',context:getContext(),currentSql:referenceSql};
const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const generated={sql:referenceSql,model:'TEST_DOUBLE',...syntheticSqlRequirement(input)},revision={id:'revision-a',hash:sha(referenceSql),sql:referenceSql,contextId:input.context.id,source:'LIVE_MODEL'},
 task={id:'task-a',contextId:input.context.id,message:input.message,sql:referenceSql,revisionId:revision.id,attempts:[{attempt:1,revisionId:revision.id,model:generated.model}]};
 const report=bindSqlRequirementRevision(sqlRequirementReport({task,...input,generated,attempt:1}),revision);return {generated,revision,task,report};
}
test('registered basis is metadata-only, deterministic, and changes with request, parameters and family',()=>{
 const b=sqlRequirementBasis(input.message,input.context),serialized=JSON.stringify(b);
 assert.equal(b.digest,sqlRequirementBasis(input.message,input.context).digest);assert.equal(b.metrics.length,5);
 assert.notEqual(b.digest,sqlRequirementBasis(input.message+'变更',input.context).digest);
 assert.notEqual(b.digest,sqlRequirementBasis(input.message,getContext('stock-cash-t1')).digest);
 assert.notEqual(b.digest,sqlRequirementBasis(input.message,{...input.context,businessDate:'2026-09-16'}).digest);
 assert.equal(b.tables.every(t=>Object.keys(t).sort().join(',')==='columns,name'),true);
 assert.doesNotMatch(serialized,/"rows"|"expected"|"referenceSql"|1300\.00/);
});
test('saved proposal refuses wrong task/request/revision, missing attempt, altered basis and altered code',()=>{
 const {task,report}=fixture();assert.equal(verifiedSqlRequirementReport(report,task),true);
 for(const patch of [{id:'other'},{message:'other'},{contextId:'stock-cash-t1'},{revisionId:'other'},{attempts:[]},{sql:referenceSql+'\n-- edited'}])
  assert.equal(verifiedSqlRequirementReport(report,{...task,...patch}),false);
 const bad=structuredClone(report);bad.basis.definition='changed definition';assert.equal(verifiedSqlRequirementReport(bad,task),false);
 assert.equal(sqlRequirementReportMatches({...report,basis:{}},task),false);
 assert.equal(validSqlRequirementInterpretation(report.interpretation,{}),false);
 assert.equal(sqlRequirementReport({task,...input,generated:{sql:referenceSql},attempt:1}),undefined,'old tasks never receive invented model understanding');
});
test('same provider response supplies understanding and SQL without sending rows or answers or adding a model call',async()=>{
 let calls=0,request;
 const generated=await generateSql(input,{DASHSCOPE_API_KEY:'SYNTHETIC_TEST_ONLY'},async(_url,options)=>{
  calls++;request=JSON.parse(options.body);const fake=syntheticSqlRequirement(input);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:referenceSql,requirement:fake.requirement,explanation:'合成响应'})}}],usage:{total_tokens:200}}));
 });
 assert.equal(calls,1);assert.equal(generated.requirementProtocol,'shuduo-sql-requirements/v1');
 const p=JSON.parse(request.messages[1].content);assert.equal(p.requirementBasis.digest,generated.requirement.basisDigest);
 assert.equal(p.requirementBasis.tables,undefined,'table metadata is already in context, not duplicated');
 assert.doesNotMatch(request.messages[1].content,/"rows"|"expected"|"referenceSql"/);
 const {task}=fixture();assert.equal(sqlRequirementReport({task,...input,generated,attempt:1}).status,'MODEL_PROPOSED');
});
test('clarification can return null SQL, while schema contradictions are reported without raw model content',async()=>{
 const fake=syntheticSqlRequirement(input,{clarification:true});
 const generated=await generateSql(input,{DASHSCOPE_API_KEY:'SYNTHETIC_TEST_ONLY'},async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:null,requirement:fake.requirement})}}],usage:{total_tokens:200}})));
 const {task}=fixture(),r=sqlRequirementReport({task,...input,generated,attempt:1});assert.equal(r.status,'CLARIFICATION_REQUIRED');assert.equal(generated.sql,null);
 const invalid=sqlRequirementReport({task,...input,generated:{...generated,requirement:{raw:'SYNTHETIC_NOT_FOR_DISPLAY'}},attempt:1});
 assert.equal(invalid.status,'INVALID');assert.equal(JSON.stringify(invalid).includes('SYNTHETIC_NOT_FOR_DISPLAY'),false);
});
test('independent execution does not turn a contradictory requirement proposal into a green delivery report',()=>{
 const {task,report,revision}=fixture(),context=getContext();task.requirements=report;
 const run={id:'run-a',status:'SUCCEEDED',contextId:task.contextId,revisionId:revision.id,revisionHash:revision.hash,engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,
  rows:context.expected,validation:{passed:true,contractId:report.basis.validationContractId,regressions:['holdings-t1','cash-change','duplicate-position','equal-value-positions','cash-only-client'].map(contextId=>({contextId,passed:true}))}};
 assert.equal(developmentVerificationReport(task,run,revision).status,'PASSED');
 task.requirements={...report,request:'wrong request'};const checked=developmentVerificationReport(task,run,revision);
 assert.equal(checked.status,'NEEDS_ATTENTION');assert.equal(checked.checks.find(c=>c.id==='requirement').passed,false);
});
test('new lifecycle evidence retains the structured proposal and refuses a mismatched saved interpretation without migrating old records',async()=>{
 const definition=liveLifecycleCases(currentLiveLifecycleContract.id)[0],f=createLiveLifecycleFixture({definition,contractId:currentLiveLifecycleContract.id,consumed:true,beforeDelivery:({task,run,revision})=>{
  task.attempts[0].attempt=1;task.projectId=revision.projectId;task.submittedBy=revision.author='synthetic-owner';
  const generated={model:task.attempts[0].model,...syntheticSqlRequirement({message:definition.request,context:getContext(definition.contextId)})};
  task.requirements=bindSqlRequirementRevision(sqlRequirementReport({task,message:definition.request,context:getContext(definition.contextId),generated,attempt:1}),revision);
  revision.requirementBinding=sqlRequirementBinding(task.requirements);
 }});
 f.reviewNow();const state=await advanceLiveLifecycleCase(definition,f.checkpoint,f.adapter,{pause:async()=>{},maxPolls:2});
 assert.equal(state.status,'SUCCEEDED',state.errorCode);assert.deepEqual(state.code.requirementEvidence,f.task.requirements);
 const changed=structuredClone(state);changed.code.requirementEvidence.request='changed';assert.equal(verifyLiveCaseEvidence(definition,changed),false);
 f.task.requirements.basis.digest='0'.repeat(64);
 const invalid=await advanceLiveLifecycleCase(definition,f.checkpoint,f.adapter,{pause:async()=>{},maxPolls:2});
 assert.equal(invalid.errorCode,'REQUIREMENT_EVIDENCE_UNCONFIRMED');
});
