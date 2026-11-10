import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getContext,referenceSqlForContext,validationFamilyForContext} from '../../src/v2/context.mjs';
import {distributionMetadataForContext} from '../../src/v2/output-contract-metadata.mjs';
import {sqlRequirementBasis,sqlRequirementReport,bindSqlRequirementRevision,verifiedSqlRequirementReport,frozenSqlRequirements} from '../../src/v2/sql-requirements.mjs';
import {validSqlRequirementInterpretation} from '../../src/v2/sql-requirement-contract.mjs';
import {developmentVerificationReport} from '../../src/v2/agent-development-workflow.mjs';
import {buildSqlRepairFeedback} from '../../src/v2/sql-repair-feedback.mjs';
import {generateSql} from '../../src/v2/model.mjs';
import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(contextId='holdings-industry-t1'){
 const context=getContext(contextId),sql=referenceSqlForContext(contextId),family=validationFamilyForContext(contextId);
 const revision={id:randomUUID(),projectId:'synthetic-project',author:'synthetic-engineer',source:'LIVE_MODEL',sql,hash:hash(sql),contextId};
 const task={id:randomUUID(),projectId:revision.projectId,submittedBy:revision.author,mode:'LIVE_MODEL',language:'SPARK_SQL',status:'SUCCEEDED',contextId,message:'按持仓分类加工并核验占比，不含现金',sql,revisionId:revision.id,validationContractId:family.id};
 const run={id:randomUUID(),projectId:revision.projectId,agentTaskId:task.id,status:'SUCCEEDED',contextId,revisionId:revision.id,revisionHash:revision.hash,mainSqlExecuted:true,engine:'Apache Spark',engineVersion:'3.5.9',rows:context.expected,validationContractId:family.id,
 validation:{passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))}};
 task.runId=run.id;task.attempts=[{attempt:1,model:'SYNTHETIC_SCHEMA_FIXTURE',status:'SUCCEEDED',revisionId:revision.id,runId:run.id}];
 task.requirements=bindSqlRequirementRevision(sqlRequirementReport({task,message:task.message,context,attempt:1,generated:{model:task.attempts[0].model,...syntheticSqlRequirement({message:task.message,context})}}),revision);
 return {context,task,revision,run,family};
}
test('both distribution proposals use six metadata-bound fields and the correct composite grain; unknown schemas fail closed',()=>{
 for(const id of ['holdings-asset-class-t1','holdings-industry-t1']){
  const {context,task}=fixture(id),b=task.requirements.basis,c=distributionMetadataForContext(id);
  assert.equal(b.metrics.length,6);assert.equal(b.grain,c.grain);assert.equal(verifiedSqlRequirementReport(task.requirements,task),true);
  assert.equal(validSqlRequirementInterpretation(task.requirements.interpretation,b),true);
  for(const change of [v=>v.grain='CLIENT_TRADE_DATE',v=>v.metrics.pop(),v=>v.constraints=v.constraints.filter(x=>x!=='HOLDINGS_ONLY_DENOMINATOR')]){
   const v=structuredClone(task.requirements.interpretation);change(v);assert.equal(validSqlRequirementInterpretation(v,b),false);
  }
  for(const change of [v=>v.validationContractId='unregistered',v=>v.metrics[5].sourceFields=['cash.available_cash'],v=>v.grain='CLIENT_TRADE_DATE',v=>v.definition='现金作为分母']){
   const basis=structuredClone(b);change(basis);assert.equal(validSqlRequirementInterpretation(task.requirements.interpretation,basis),false);
  }
  assert.equal(sqlRequirementReport({task,message:task.message,context,attempt:1,generated:{sql:'SELECT 1',model:'SYNTHETIC'}}).status,'INVALID');
 }
 const meta=readFileSync(new URL('../../src/v2/output-contract-metadata.json',import.meta.url),'utf8');assert(!meta.includes('"expected"'));assert(!meta.includes('"rows"'));assert(!meta.includes('0.666667'));
});
test('production model adapter requests a registered distribution without rows/answers or fixed five-field instructions',async()=>{
 for(const id of ['holdings-asset-class-t1','holdings-industry-t1']){
  const context=getContext(id),input={message:'加工持仓分布',context,currentSql:'SELECT client_id FROM accounts'};let calls=0;
  const generated=await generateSql(input,{DASHSCOPE_API_KEY:'SYNTHETIC_TEST_ONLY'},async(_url,init)=>{
   calls++;const body=JSON.parse(init.body),prompt=JSON.parse(body.messages[1].content),b=sqlRequirementBasis(input.message,context);
   assert.match(body.messages[0].content,/market_value_ratio/);assert(!body.messages[0].content.includes('total_assets'));
   assert.equal(prompt.requirementResponse.development.grain,b.grain);assert.match(prompt.requirementResponse.development.metrics,/全部6项/);
   assert.equal(prompt.context.outputContract.fields.length,6);assert(prompt.context.tables.every(t=>!Object.hasOwn(t,'rows')));
   assert(!init.body.includes('0.666667'));assert(!init.body.includes('CLIENT-001'));assert(!init.body.includes('"expected"'));
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:referenceSqlForContext(id),explanation:'合成响应，待执行核验',requirement:syntheticSqlRequirement(input).requirement})}}],usage:{total_tokens:100}}));
  });
  assert.equal(calls,1);assert(validSqlRequirementInterpretation(generated.requirement,sqlRequirementBasis(input.message,context)));
 }
});
test('code report checks composite groups and ratio independently and freezes the same requirement without granting delivery',()=>{
 const f=fixture(),{task,revision}=f;assert.equal(developmentVerificationReport(task,f.run,revision).status,'PASSED');
 assert.equal(frozenSqlRequirements({agent:task,run:f.run,revision}).basis.grain,'CLIENT_TRADE_DATE_INDUSTRY');
 for(const change of [v=>v.rows[0].market_value_ratio='0.000000',v=>v.rows.push({...v.rows[0]}),v=>v.rows[0].industry='WRONG_GROUP']){
  const run=structuredClone(f.run);change(run);assert.equal(developmentVerificationReport(task,run,revision).checks.find(c=>c.id==='results').passed,false);
 }
 const old=task.requirements;delete task.requirements;assert.equal(developmentVerificationReport(task,f.run,revision).status,'NEEDS_ATTENTION');task.requirements=old;
 const report=developmentVerificationReport(task,{...f.run,testDouble:true},revision);assert.equal(report.status,'NEEDS_ATTENTION');
});
test('distribution repair feedback includes ratio/group failures, never expected rows, amounts or labels',()=>{
 const f=fixture(),run={...f.run,status:'VALIDATION_FAILED',validation:{passed:false,contractId:f.family.id,regressions:f.family.contextIds.map(contextId=>({contextId,passed:false,issues:['分组数值不符或精度/范围不合法：market_value_ratio','分组复合键重复','包含未登记分组或无效复合键']}))}};
 const feedback=buildSqlRepairFeedback(run,f.context.id,{currentSql:f.revision.sql});assert.equal(feedback.failedCaseCount,5);assert(feedback.checks.every(c=>c.fields.includes('market_value_ratio')&&c.issueKinds.includes('DUPLICATE_KEY')));
 assert(!JSON.stringify(feedback).includes('CLIENT-001'));assert(!JSON.stringify(feedback).includes('0.666667'));
});

test('legacy requirement-basis digests retain published identities',()=>{
 const snapshots={'holdings-t1':'3f72ba0b4e2e74c121e0325ebbcc57c489ac31d2f58890bae0e79018a8cd66fe','stock-cash-t1':'22468c538cb900fc71d856a6a50d99d9bdc62b266f49134cb7a7f5775eaaab25'};
 for(const [id,want] of Object.entries(snapshots))assert.equal(sqlRequirementBasis('Compatibility snapshot',getContext(id)).digest,want);
});
