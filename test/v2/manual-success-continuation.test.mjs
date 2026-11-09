import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {manualSuccessFixture} from './fixtures/manual-success-continuation.mjs';
import {resolveManualContinuation} from '../../src/v2/manual-sql-continuation.mjs';
import {resolveAssistedContinuation} from '../../src/v2/assisted-sql-delivery-source.mjs';
import {createDurableAgentDelivery,manualCloudDeliverySource} from '../../src/v2/agent-development-workflow.mjs';
import {checkedAssistedDevelopmentReference} from '../../src/v2/assisted-development-reference.mjs';
import {manualContinuationReceiptMatches} from '../../src/v2/manual-continuation-client.mjs';
const input=f=>({message:'从已核验手工SQL完善证券加工代码',currentSql:f.revision.sql,contextId:f.context.id,actorId:f.actor.id,idempotencyKey:randomUUID(),manualContinuation:f.proof().binding});
async function finish(f,task){task=await f.engine.advance(task.id,{expectedVersion:task.version});task=await f.engine.advance(task.id,{expectedVersion:task.version});f.complete(task.runId);return f.engine.advance(task.id,{expectedVersion:task.version});}
test('standalone manual success delegates to one independent Agent task without manufacturing an origin or copying results',async t=>{
 const f=manualSuccessFixture();t.after(f.dispose);assert.equal(f.store.list('agent',f.project).length,0);const proof=f.proof(),before=structuredClone(f.run),body=input(f),task=await f.engine.create(body);
 assert.equal(proof.binding.originAgentTaskId,undefined);assert.equal(proof.developmentReference.kind,'MANUAL_SUCCESS_REFERENCE');assert.equal(task.sourceKind,'MANUAL');assert.equal(task.agentIndependentE2E,false);
 assert.equal(task.initialSql,f.revision.sql);assert.equal(task.usedTokens,0);assert.deepEqual(task.attempts,[]);for(const k of['revisionId','runId','sourceRunId','assistedContinuation','derivedFrom','approvalId','packageId','releaseId'])assert.equal(task[k],undefined);
 assert.equal((await f.engine.create(body)).id,task.id);const done=await finish(f,task);assert.equal(done.status,'SUCCEEDED');assert.equal(f.counts.model,1);assert.equal(f.counts.submits,1);
 assert.equal(f.observed[0].error,undefined);assert.equal(f.observed[0].repairFeedback,undefined);assert.equal(f.observed[0].repairComparison,undefined);assert.deepEqual(f.store.get('run',f.run.id,f.project),before);
 const source=manualCloudDeliverySource({...f.options,runId:done.runId,actorId:f.actor.id});assert.equal(source.developmentReference.sourceRevisionId,f.revision.id);assert.equal(source.developmentReference.originAgentTaskId,undefined);
 const delivery=createDurableAgentDelivery({...f.options,artifactStore:f.artifactStore}),made=await delivery.createManual({runId:done.runId,actorId:f.actor.id,key:'manual-root-files'});
 assert.equal(f.store.get('delivery_package',made.packageId,f.project).manifest.source.attribution.developmentReference.kind,'MANUAL_SUCCESS_REFERENCE');assert.equal(made.agentIndependentE2E,false);
});
test('an existing failed origin is preserved as history, not a successful parent or fresh autonomous result',async t=>{
 const f=manualSuccessFixture({withOrigin:true});t.after(f.dispose);const old=structuredClone(f.origin),proof=f.proof(),task=await f.engine.create(input(f));
 assert.equal(proof.binding.originAgentTaskId,f.origin.id);assert.equal(task.sourceAttribution.manualOriginTaskId,f.origin.id);assert.equal(task.assistedContinuation,undefined);
 const done=await finish(f,task),source=manualCloudDeliverySource({...f.options,runId:done.runId,actorId:f.actor.id});assert.equal(source.developmentReference.originAgentTaskId,f.origin.id);assert.deepEqual(f.store.get('agent',f.origin.id,f.project),old);
});
test('foreign author, changed byte/context, false validation and incompatible source cannot create or reserve work',async t=>{
 const f=manualSuccessFixture();t.after(f.dispose);const body=input(f);
 for(const patch of[{actorId:'foreign'},{currentSql:f.revision.sql+' '},{contextId:'stock-cash-t1'},{sourceRunId:f.run.id},{derivation:{}},{assistedContinuation:{}},{repairComparison:{}},
   {manualContinuation:{...body.manualContinuation,runId:randomUUID()}},{manualContinuation:{...body.manualContinuation,evidenceDigest:'a'.repeat(64)}}])await assert.rejects(f.engine.create({...body,...patch}));
 for(const patch of[{status:'FAILED'},{testDouble:true},{agentTaskId:randomUUID()},{validation:{...f.run.validation,regressions:[]}},{rows:[{client_id:'CLIENT-001',total_assets:0}]}]){
  f.store.update('run',f.run.id,f.project,patch);assert.throws(f.proof);f.store.update('run',f.run.id,f.project,{...f.run,testDouble:undefined,agentTaskId:undefined});
 }
 f.store.update('revision',f.revision.id,f.project,{manualProvenance:{...f.revision.manualProvenance,actorId:'foreign'}});assert.throws(f.proof);
 assert.equal(f.store.list('agent',f.project).length,0);assert.deepEqual(f.counts,{model:0,submits:0});
});
test('source drift fences model and Spark boundaries, retaining already spent usage',async t=>{
 const f=manualSuccessFixture();t.after(f.dispose);let task=await f.engine.create(input(f));f.store.update('run',f.run.id,f.project,{log:'changed before model'});await assert.rejects(f.engine.advance(task.id,{expectedVersion:task.version}));assert.equal(f.counts.model,0);
 f.setModel(()=>{f.store.update('run',f.run.id,f.project,{log:'changed during model'});return{sql:f.revision.sql,model:'protocol-model-provider',usage:{total_tokens:21}};});
 task=await f.engine.create(input(f));task=await f.engine.advance(task.id,{expectedVersion:task.version});assert.equal(task.status,'FAILED');assert.equal(task.usedTokens,21);assert.equal(task.revisionId,undefined);assert.equal(f.counts.submits,0);
 f.setModel(undefined);task=await f.engine.create(input(f));task=await f.engine.advance(task.id,{expectedVersion:task.version});f.store.update('run',f.run.id,f.project,{log:'changed before enqueue'});
 await assert.rejects(f.engine.advance(task.id,{expectedVersion:task.version}));assert.equal(f.counts.submits,0);
});
test('later successful Agent continuations retain the manual success root in their immutable reference',async t=>{
 const f=manualSuccessFixture();t.after(f.dispose);let parent=await finish(f,await f.engine.create(input(f)));
 const proof=resolveAssistedContinuation({...f.options,actorId:f.actor.id,taskId:parent.id});assert.equal(proof.developmentReference.rootReference.kind,'MANUAL_SUCCESS_REFERENCE');
 parent=await finish(f,await f.engine.create({message:'继续完善这个成功的辅助版本',currentSql:parent.sql,contextId:f.context.id,actorId:f.actor.id,idempotencyKey:randomUUID(),assistedContinuation:proof.binding}));
 const source=manualCloudDeliverySource({...f.options,runId:parent.runId,actorId:f.actor.id});assert.equal(source.developmentReference.rootReference.sourceRunId,f.run.id);assert.equal(source.developmentReference.depth,1);assert.equal(parent.agentIndependentE2E,false);
});
test('receipt validation binds original intent and optional origin; malformed references never acknowledge another saved version',async t=>{
 const f=manualSuccessFixture({withOrigin:true});t.after(f.dispose);const body=input(f),task=await f.engine.create(body),expected={message:body.message,sql:body.currentSql,contextId:body.contextId,manualContinuation:body.manualContinuation};assert(manualContinuationReceiptMatches(task,expected));
 for(const patch of[{sourceKind:'AGENT'},{message:'其他修改意图'},{initialSql:f.revision.sql+' '},{sourceAttribution:{...task.sourceAttribution,manualOriginTaskId:randomUUID()}},{manualContinuation:{...task.manualContinuation,originAgentTaskId:randomUUID()}}])assert.equal(manualContinuationReceiptMatches({...task,...patch},expected),false);
 for(const value of[{...f.proof().developmentReference,originAgentTaskId:'wrong'},{...f.proof().developmentReference,initialSqlHash:'a'.repeat(64)},{...f.proof().developmentReference,sql:'private'}])assert.throws(()=>checkedAssistedDevelopmentReference(value));
});
