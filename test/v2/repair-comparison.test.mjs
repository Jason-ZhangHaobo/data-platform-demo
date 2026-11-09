import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';
import {seedRunComparison} from './fixtures/run-comparison.mjs';
import {resolveSqlRepairComparison,safeRepairComparisonSummary} from '../../src/v2/sql-repair-comparison.mjs';
import {createDurableSqlAgent} from '../../src/v2/durable-agent.mjs';
import {getContext,contextIds,validationContractId} from '../../src/v2/context.mjs';
import {createComparisonRepairTask,readRepairComparisonBasis,comparisonRepairReceiptMatches} from '../../src/v2/repair-comparison-client.mjs';
import {generateSql} from '../../src/v2/model.mjs';

function setup(t){
  const store=new MetadataStore(':memory:'),project='synthetic-comparison-project',actorId='synthetic-owner',f=seedRunComparison({store,project,author:actorId});
  t.after(()=>store.close());
  for(const side of [f.baseline,f.current])side.revision=store.update('revision',side.revision.id,project,{manualProvenance:{kind:'ENGINEER_EDIT',actorId,agentIndependentE2E:false}});
  const args={store,project,actorId,sourceRunId:f.current.run.id,baselineRunId:f.baseline.run.id,currentSql:f.current.revision.sql,contextId:f.context.id};
  return {store,project,actorId,f,args,read:extra=>resolveSqlRepairComparison({...args,...extra})};
}
test('saved comparison basis is pure, sanitized, byte bound and reference attributed; missing evidence is not causality',t=>{
  const x=setup(t),before=x.store.db.prepare('SELECT data FROM documents ORDER BY id').all(),basis=x.read();
  assert.equal(basis.summary.caseComparison.state,'CONTROLLED_OBSERVATION');assert.equal(basis.summary.caseComparison.changes.length,1);
  assert.equal(basis.attribution.agentIndependentE2E,false);assert.equal(basis.attribution.sourceKind,'MANUAL');
  assert.deepEqual(safeRepairComparisonSummary(basis.summary,x.f.context,x.args.currentSql),basis.summary);
  assert.doesNotMatch(JSON.stringify(basis),/SYNTHETIC_PRIVATE|expression|rows|expected|SELECT |issues|contentHash/);
  assert.deepEqual(x.store.db.prepare('SELECT data FROM documents ORDER BY id').all(),before);
  assert.throws(()=>x.read({currentSql:x.args.currentSql+' '}),{code:'AGENT_REPAIR_COMPARISON_INVALID'});
  assert.throws(()=>x.read({binding:{...basis.binding,sql:'SYNTHETIC_EXTRA'}}),{status:422});
  const old={...x.f.current.run.validation};delete old.assertionEvidence;old.regressions=old.regressions.map(({inputEvidence,assertionEvidence,...v})=>v);
  x.store.update('run',x.f.current.run.id,x.project,{inputEvidence:undefined,validation:old});
  const unknown=x.read();assert.equal(unknown.summary.caseComparison.state,'NOT_CONTROLLED');assert.deepEqual(unknown.summary.caseComparison.changes,[]);
  assert.equal(safeRepairComparisonSummary(unknown.summary,x.f.context,x.args.currentSql).causalConclusion,'NOT_ESTABLISHED');
});
test('owner, baseline provenance, full independent checks and hidden evidence changes are enforced',t=>{
  const x=setup(t),basis=x.read();
  assert.throws(()=>x.read({actorId:'other'}),{code:'AGENT_REPAIR_SOURCE_INVALID'});
  x.store.update('run',x.f.baseline.run.id,x.project,{rows:[{privateChanged:'different result'}]});
  assert.throws(()=>x.read({binding:basis.binding}),{code:'AGENT_REPAIR_COMPARISON_INVALID'});
  x.store.update('revision',x.f.baseline.revision.id,x.project,{author:'other'});
  assert.throws(()=>x.read(),{code:'AGENT_REPAIR_COMPARISON_INVALID'});
  x.store.update('revision',x.f.baseline.revision.id,x.project,{author:x.actorId,manualProvenance:undefined});
  assert.throws(()=>x.read(),{code:'AGENT_REPAIR_COMPARISON_INVALID'});
  x.store.update('revision',x.f.baseline.revision.id,x.project,{manualProvenance:x.f.baseline.revision.manualProvenance});
  x.store.update('run',x.f.baseline.run.id,x.project,{testSqlValidation:{passed:false}});
  assert.throws(()=>x.read(),{code:'AGENT_REPAIR_COMPARISON_INVALID'});
});
function durable(x,model){
  let jobs=0;
  const runner={prepare:(_input,id)=>({job:{jobId:id}}),submit:async()=>{jobs++;},read:async()=>undefined,cancel:async()=>{}};
  const engine=createDurableSqlAgent({store:x.store,project:x.project,runner,generator:model,persist:async()=>{},getContext,contextIds,contractId:validationContractId});
  const create=extra=>engine.create({message:'参考固定基线修正失败证券SQL',currentSql:x.args.currentSql,contextId:x.f.context.id,actorId:x.actorId,
    idempotencyKey:'synthetic-original',sourceRunId:x.f.current.run.id,sourceError:'SYNTHETIC_PRIVATE_ISSUE',repairComparison:x.read().binding,...extra});
  return {engine,create,get jobs(){return jobs;},advance:id=>engine.advance(id,{expectedVersion:engine.get(id).version})};
}
test('durable repair persists exact basis through recreation and keeps assisted attribution on new revision and run',async t=>{
  const x=setup(t);let received,calls=0;
  let d=durable(x,async input=>{calls++;received=input;return{sql:x.f.baseline.revision.sql,model:'TEST_DOUBLE',usage:{total_tokens:20}};});
  const task=await d.create();assert.equal((await d.create()).id,task.id);assert.equal(calls,0);
  d=durable(x,async input=>{calls++;received=input;return{sql:x.f.baseline.revision.sql,model:'TEST_DOUBLE',usage:{total_tokens:20}};});
  let saved=await d.advance(task.id);assert.equal(calls,1);assert.equal(saved.stage,'READY_FOR_RUN');
  assert.equal(received.repairComparison.evidenceDigest,task.repairComparison.evidenceDigest);
  assert.doesNotMatch(JSON.stringify(received.repairComparison),/SYNTHETIC_PRIVATE|SELECT |expression/);
  assert.equal(x.store.get('revision',saved.revisionId,x.project).sourceKind,'MANUAL');
  saved=await d.advance(task.id);assert.equal(saved.stage,'WAITING_FOR_RUN');assert.equal(d.jobs,1);
  assert.equal(x.store.get('run',saved.runId,x.project).agentIndependentE2E,false);
});
test('stale comparison blocks before model, after model, and before enqueue without losing usage or submitting Spark',async t=>{
  const x=setup(t);let calls=0;
  const d=durable(x,async()=>{calls++;x.store.update('run',x.f.baseline.run.id,x.project,{log:'changed while model in flight'});return{sql:x.f.baseline.revision.sql,model:'TEST_DOUBLE',usage:{total_tokens:21}};});
  let task=await d.create(),basis=task.repairComparison;
  task=await d.advance(task.id);assert.equal(calls,1);assert.equal(task.status,'FAILED');assert.equal(task.usedTokens,21);assert.equal(d.jobs,0);assert.equal(task.revisionId,undefined);
  await assert.rejects(d.create({idempotencyKey:'stale',repairComparison:basis}),{code:'AGENT_REPAIR_COMPARISON_INVALID'});
  const fresh=durable(x,async()=>{calls++;return{sql:x.f.baseline.revision.sql,model:'TEST_DOUBLE',usage:{total_tokens:20}};});
  task=await fresh.create({idempotencyKey:'new'});
  x.store.update('run',x.f.baseline.run.id,x.project,{log:'changed before model'});
  await assert.rejects(fresh.advance(task.id),{code:'AGENT_REPAIR_COMPARISON_INVALID'});assert.equal(calls,1);
  task=await fresh.create({idempotencyKey:'third'});task=await fresh.advance(task.id);
  x.store.update('run',x.f.baseline.run.id,x.project,{log:'changed before calculation'});
  await assert.rejects(fresh.advance(task.id),{code:'AGENT_REPAIR_COMPARISON_INVALID'});assert.equal(fresh.jobs,0);
});
test('CLI/MCP shared client uses one exact request and never forwards baseline SQL or malformed receipts',async t=>{
  const x=setup(t),basis=x.read(),writes=[],client={request:async(path,options)=>{if(options){writes.push(options);return{id:randomUUID(),sourceRunId:basis.sourceRunId,contextId:basis.contextId,initialSql:options.body.sql,repairComparison:basis.binding,...basis.attribution};}
    if(path.includes('repair-comparison?'))return basis;if(path===`/runs/${x.f.current.run.id}`)return x.f.current.run;if(path===`/revisions/${x.f.current.revision.id}`)return x.f.current.revision;throw Error('unexpected read');}};
  const input={sourceRunId:x.f.current.run.id,baselineRunId:x.f.baseline.run.id,message:'参考该基线修正证券SQL',requestId:randomUUID(),confirm:true};
  await createComparisonRepairTask(client,input);assert.equal(writes.length,1);assert.equal(writes[0].idempotencyKey,input.requestId);
  assert.deepEqual(writes[0].body.repairComparison,basis.binding);assert.equal(writes[0].body.sql,x.args.currentSql);assert.equal(writes[0].body.summary,undefined);
  await assert.rejects(createComparisonRepairTask(client,{...input,confirm:false}));assert.equal(writes.length,1);
  await assert.rejects(readRepairComparisonBasis({request:async()=>({...basis,sourceRunId:randomUUID()})},input));
});
test('model boundary projects whitelist only, rejects wrong code, and strips arbitrary extras',async t=>{
  const x=setup(t),basis=x.read();let prompt,calls=0;
  const fetchImpl=async(_url,options)=>{calls++;prompt=JSON.parse(JSON.parse(options.body).messages.at(-1).content);return{ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({sql:x.f.baseline.revision.sql,explanation:'synthetic'})}}],usage:{total_tokens:10}})};};
  const input={message:'修正这份证券SQL',context:x.f.context,currentSql:x.args.currentSql,repairComparison:{...basis.summary,rawBaselineSql:'MUST_NOT_FORWARD',rows:['PRIVATE']}};
  await generateSql(input,{DASHSCOPE_API_KEY:'synthetic-not-a-real-key'},fetchImpl);
  assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(prompt.repairComparison),/PRIVATE|MUST_NOT_FORWARD|expression/);
  await assert.rejects(generateSql({...input,currentSql:'SELECT 1'},{DASHSCOPE_API_KEY:'synthetic-not-a-real-key'},fetchImpl));assert.equal(calls,1);
});
test('a further plain failed-run repair cannot discard assisted attribution by omitting the comparison',async t=>{
  const x=setup(t),d=durable(x,async()=>({sql:x.f.baseline.revision.sql,model:'TEST_DOUBLE',usage:{total_tokens:10}}));
  let task=await d.create({repairComparison:undefined});assert.equal(task.sourceKind,'MANUAL');assert.equal(task.agentIndependentE2E,false);
  task=await d.advance(task.id);assert.equal(x.store.get('revision',task.revisionId,x.project).sourceAttribution.kind,'ENGINEER_ASSISTED');
  task=await d.advance(task.id);assert.equal(x.store.get('run',task.runId,x.project).sourceKind,'MANUAL');
});
test('wrong task, basis, original SQL or assisted attribution cannot acknowledge the original comparison request',t=>{
  const x=setup(t),basis=x.read(),body={sql:x.args.currentSql,contextId:x.f.context.id,sourceRunId:x.f.current.run.id,repairComparison:basis.binding},
    task={id:randomUUID(),initialSql:body.sql,contextId:body.contextId,sourceRunId:body.sourceRunId,repairComparison:basis.binding,...basis.attribution};
  assert.equal(comparisonRepairReceiptMatches(task,body),true);
  for(const patch of [{sourceKind:'AGENT'},{agentIndependentE2E:true},{sourceRunId:randomUUID()},{initialSql:body.sql+' '},{repairComparison:{...basis.binding,evidenceDigest:'a'.repeat(64)}},{sourceAttribution:undefined}])assert.equal(comparisonRepairReceiptMatches({...task,...patch},body),false);
});
