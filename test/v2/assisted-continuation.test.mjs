import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assistedDeliveryFixture} from './fixtures/assisted-sql-delivery.mjs';
import {resolveAssistedContinuation} from '../../src/v2/assisted-sql-delivery-source.mjs';
import {createDurableSqlAgent} from '../../src/v2/durable-agent.mjs';
import {getContext,contextIds,validationContractId} from '../../src/v2/context.mjs';
import {manualCloudDeliverySource,createDurableAgentDelivery} from '../../src/v2/agent-development-workflow.mjs';
import {checkedAssistedDevelopmentReference} from '../../src/v2/assisted-development-reference.mjs';
import {checkedAssistedContinuationBinding} from '../../src/v2/assisted-continuation-binding.mjs';
import {assistedContinuationReceiptMatches} from '../../src/v2/assisted-continuation-client.mjs';

const proof=(f,parent=f.agent)=>resolveAssistedContinuation({...f.options,actorId:f.actor.id,taskId:parent.id});
const body=(f,parent=f.agent)=>({message:'基于成功版本继续完善证券加工SQL',currentSql:parent.sql,contextId:parent.contextId,actorId:f.actor.id,idempotencyKey:randomUUID(),assistedContinuation:proof(f,parent).binding});
async function finish(f,task,engine=f.agentEngine){task=await engine.advance(task.id,{expectedVersion:task.version});task=await engine.advance(task.id,{expectedVersion:task.version});f.complete(task.runId);return engine.advance(task.id,{expectedVersion:task.version});}
test('a successful assisted parent starts a new independent task, retaining lineage but no approval, result or paid attempt',async t=>{
 const f=await assistedDeliveryFixture();t.after(f.dispose);const before=structuredClone(f.agent),input=body(f),parentPackage=await f.delivery.createManual(f.input),child=await f.agentEngine.create(input);
 assert.notEqual(child.id,f.agent.id);assert.equal(child.initialSql,f.agent.sql);assert.equal(child.contextId,f.agent.contextId);assert.equal(child.sourceKind,'MANUAL');assert.equal(child.agentIndependentE2E,false);
 assert.equal(child.usedTokens,0);assert.deepEqual(child.attempts,[]);for(const key of['runId','revisionId','sourceRunId','repairComparison','derivedFrom','packageId','approvalId','releaseId'])assert.equal(child[key],undefined);
 assert.equal((await f.agentEngine.create(input)).id,child.id);assert.equal(f.counts.syntheticModel,1);
 const done=await finish(f,child);assert.equal(done.status,'SUCCEEDED');assert.notEqual(done.runId,f.run.id);assert.notEqual(done.revisionId,f.revision.id);
 const received=f.observed.at(-1);assert.equal(received.currentSql,f.agent.sql);assert.equal(received.error,undefined);assert.equal(received.repairFeedback,undefined);assert.equal(received.repairComparison,undefined);
 assert.deepEqual(f.store.get('agent',f.agent.id,f.project),before);
 const source=manualCloudDeliverySource({...f.options,runId:done.runId,actorId:f.actor.id});assert.equal(source.developmentReference.kind,'ASSISTED_CONTINUATION');assert.equal(source.developmentReference.depth,1);
 assert.equal(source.developmentReference.rootReference.evidenceDigest,f.basis.binding.evidenceDigest);
 const delivery=createDurableAgentDelivery({...f.options,assertExecutionScope:a=>assert.equal(a.id,child.id)}),made=await delivery.createManual({runId:done.runId,actorId:f.actor.id,key:'child-package'});
 assert.notEqual(made.packageDigest,parentPackage.packageDigest);assert.equal(made.developmentReference.parentTaskId,f.agent.id);
 assert.deepEqual(f.store.get('delivery_package',made.packageId,f.project).manifest.source.attribution.developmentReference,source.developmentReference);
});
test('wrong owner, code bytes, context, source selection and mixed intent fail before reserving model or calculation',async t=>{
 const f=await assistedDeliveryFixture();t.after(f.dispose);const input=body(f),before={...f.counts};
 for(const patch of[{actorId:'foreign'},{currentSql:input.currentSql+' '},{contextId:'stock-cash-t1'},{sourceRunId:f.source.current.run.id},{repairComparison:f.basis.binding},{derivation:{}},
   {assistedContinuation:{...input.assistedContinuation,runId:randomUUID()}},{assistedContinuation:{...input.assistedContinuation,evidenceDigest:'a'.repeat(64)}}])await assert.rejects(f.agentEngine.create({...input,...patch}));
 assert.deepEqual(f.counts,before);assert.equal(f.store.list('agent',f.project).length,1);
});
test('parent drift before model, after model and before enqueue cannot add a computation or erase spent usage',async t=>{
 const f=await assistedDeliveryFixture();t.after(f.dispose);let task=await f.agentEngine.create(body(f));
 f.store.update('run',f.run.id,f.project,{log:'changed before model'});await assert.rejects(f.agentEngine.advance(task.id,{expectedVersion:task.version}));assert.equal(f.counts.syntheticModel,1);
 f.store.update('run',f.run.id,f.project,f.run);
 const engine=createDurableSqlAgent({...f.options,assertExecutionScope:()=>{},persist:async()=>{},getContext,contextIds,contractId:validationContractId,generator:async()=>{f.store.update('run',f.run.id,f.project,{log:'changed during model'});return{sql:f.agent.sql,model:'protocol-model-provider',usage:{total_tokens:21}};}});
 task=await engine.create(body(f));task=await engine.advance(task.id,{expectedVersion:task.version});assert.equal(task.status,'FAILED');assert.equal(task.usedTokens,21);assert.equal(task.revisionId,undefined);assert.equal(f.counts.submits,1);
 task=await f.agentEngine.create(body(f));task=await f.agentEngine.advance(task.id,{expectedVersion:task.version});f.store.update('run',f.run.id,f.project,{log:'changed before enqueue'});
 await assert.rejects(f.agentEngine.advance(task.id,{expectedVersion:task.version}));assert.equal(f.counts.submits,1);
});
test('successive continuations keep a flat original reference and reject cycles, missing assertions or forged native markers',async t=>{
 const f=await assistedDeliveryFixture();t.after(f.dispose);let parent=f.agent;
 for(let depth=1;depth<=3;depth++){
   parent=await finish(f,await f.agentEngine.create(body(f,parent)));const source=manualCloudDeliverySource({...f.options,runId:parent.runId,actorId:f.actor.id});
   assert.equal(source.developmentReference.depth,depth);assert.equal(source.developmentReference.rootReference.kind,'RUN_COMPARISON_REFERENCE');assert.equal(source.developmentReference.rootReference.rootReference,undefined);
 }
 const saved=f.store.get('agent',parent.id,f.project);f.store.update('agent',parent.id,f.project,{assistedContinuation:{...saved.assistedContinuation,taskId:parent.id,revisionId:parent.revisionId,runId:parent.runId,revisionHash:f.store.get('revision',parent.revisionId,f.project).hash}});
 assert.throws(()=>proof(f,parent));f.store.update('agent',parent.id,f.project,saved);
 const run=f.store.get('run',parent.runId,f.project);f.store.update('run',run.id,f.project,{validation:{...run.validation,regressions:[]}});assert.throws(()=>proof(f,parent));f.store.update('run',run.id,f.project,run);
 f.store.update('agent',parent.id,f.project,{sourceKind:'AGENT'});assert.throws(()=>proof(f,parent));
});
test('reference and receipt validation rejects missing or changed ancestry and never acknowledges another parent',async t=>{
 const f=await assistedDeliveryFixture();t.after(f.dispose);const p=proof(f),input=body(f),child=await f.agentEngine.create(input),expected={message:input.message,sql:input.currentSql,contextId:input.contextId,assistedContinuation:input.assistedContinuation};
 assert.equal(assistedContinuationReceiptMatches(child,expected),true);
 for(const patch of[{sourceKind:'AGENT'},{agentIndependentE2E:true},{message:'另一个修改意图'},{initialSql:input.currentSql+' '},{assistedContinuation:{...input.assistedContinuation,taskId:randomUUID()}},{sourceAttribution:{}}])assert.equal(assistedContinuationReceiptMatches({...child,...patch},expected),false);
 for(const value of[{...p.binding,depth:17},{...p.binding,approvalId:randomUUID()},{...p.binding,evidenceDigest:'wrong'}])assert.throws(()=>checkedAssistedContinuationBinding(value));
 assert.throws(()=>checkedAssistedDevelopmentReference({...p.developmentReference,rootReference:p.developmentReference}));
});
test('the sixteenth continuation remains attributable, and a seventeenth is rejected before any new task or payment reservation',async t=>{
 const f=await assistedDeliveryFixture();t.after(f.dispose);let parent=f.agent;
 for(let depth=1;depth<=16;depth++)parent=await finish(f,await f.agentEngine.create(body(f,parent)));
 const before={...f.counts};assert.equal(f.store.list('agent',f.project).length,17);assert.throws(()=>proof(f,parent),{code:'ASSISTED_CONTINUATION_INVALID'});
 assert.deepEqual(f.counts,before);assert.equal(f.store.list('agent',f.project).reduce((sum,v)=>sum+v.usedTokens,0),340);
});
