import{writeFileSync}from'node:fs';import{join}from'node:path';import{runV2Cli}from'../../bin/shuduo.mjs';import{handleV2Mcp}from'../../bin/shuduo-mcp.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createManualPublicationJourney} from './fixtures/manual-publication-journey.mjs';import{PROJECT}from'../../src/v2/server.mjs';
import{readStandalonePublication,publishStandaloneManual,cancelStandalonePublication}from'../../src/v2/standalone-manual-publication-client.mjs';
async function setup(t){const f=await createManualPublicationJourney({standalone:true});t.after(f.dispose);return f;}
test('manual-only publication API enforces exact source, session, CSRF and prevents old Agent scope reuse',async t=>{
 const f=await setup(t),session=(await f.call('/auth/session')).body;assert.equal(session.manualPublicationOnly,true);assert.equal(session.manualPublicationTaskId,f.delivery.id);assert.equal(session.publicationTaskId,undefined);assert.deepEqual(session.permissions,['SESSION','DELIVERY']);
 for(const identity of[null,'other'])assert.equal((await f.call(f.path,f.body,{identity})).status,403);
 assert.equal((await f.call(f.path,f.body,{headers:{'x-csrf-token':'wrong'}})).status,403);
 for(const patch of[{packageDigest:'a'.repeat(64)},{verificationId:randomUUID()},{sourceRunId:randomUUID()},{sourceKind:'AGENT'},{actorId:f.owner.id}])assert.notEqual((await f.call(f.path,{...f.body,...patch})).status,202);
 for(const path of['/agent/tasks','/runs','/revisions',`/delivery/manual/${f.delivery.id}/advance`,`/agent/tasks/${f.delivery.id}/publication`])assert.equal((await f.call(path,{})).status,403);
 assert.equal((await f.call(f.path+f.query,f.body)).status,422);assert.equal(f.store.list('release',PROJECT).length,0);assert.equal(f.store.list('agent',PROJECT).length,0);assert.equal(f.counts().modelCalls,0);
});
test('two signed timer events recover original manual publication after SQLite restart with no Agent identity',async t=>{
 const f=await setup(t);f.loseNextPublicationAcknowledgement();assert.equal((await f.call(f.path,f.body)).status,500);const release=f.store.list('release',PROJECT)[0],ids=f.store.list('release_run',PROJECT).map(r=>r.id).sort();assert.equal(release.sourceAgentTaskId,undefined);assert.equal(release.manualDeliveryTaskId,f.delivery.id);
 await f.restart();const original=(await f.call(f.path+f.query)).body;assert.equal(original.protocol,'shuduo-standalone-manual-publication/v1');assert.equal(original.release.id,release.id);assert.equal((await f.call(f.path,f.body)).body.release.id,release.id);
 assert.equal((await f.tick(release.id,1,{triggerName:'not-approved'})).status,401);assert.equal((await f.tick(release.id,1)).status,200);let batch=f.store.list('release_run',PROJECT).find(r=>r.status==='RUNNING');assert(batch);await f.restart();f.complete(batch.remoteSubmission.prepared);assert.equal((await f.call(f.path+f.query)).body.runs.find(r=>r.id===batch.id).status,'SUCCEEDED');f.advance();
 assert.equal((await f.tick(release.id,2)).status,200);batch=f.store.list('release_run',PROJECT).find(r=>r.status==='RUNNING');f.complete(batch.remoteSubmission.prepared);await f.restart();const value=(await f.call(f.path+f.query)).body;assert.equal(value.release.health,'HEALTHY');assert.equal(value.release.status,'COMPLETED_CLOUD_TEST');assert.deepEqual(value.runs.map(r=>r.id).sort(),ids);assert(value.runs.every(r=>r.schedulerTriggered&&r.status==='SUCCEEDED'&&r.sourceAttribution==='ENGINEER_AUTHORED'&&r.sourceAgentTaskId===undefined));
 assert.equal(value.events.length,2);assert.equal(f.store.list('agent',PROJECT).length,0);assert.equal(f.store.list('release_approval',PROJECT).length,1);assert.equal(f.counts().jobCreates,2);assert.equal(f.counts().submitCalls,2);assert.equal(f.counts().modelCalls,0);
});
test('an expired manual publication window keeps history readable and blocks further signed computation',async t=>{
 const f=await setup(t),published=await f.call(f.path,f.body);assert.equal(published.status,202);f.expire();assert.equal((await f.call(f.path,f.body)).status,403);assert.equal((await f.tick(published.body.release.id,1)).status,403);assert.equal((await f.call(f.path+f.query)).body.release.id,published.body.release.id);assert.equal(f.counts().submitCalls,0);
});

test('shared publication client confirms frozen bytes, rejects wrong receipt and stops without a preflight GET',async t=>{
 const f=await setup(t),client={request:async(p,o)=>{const r=await f.call(p,o?.method==='POST'?o.body:undefined,{key:o?.idempotencyKey});if(r.status>=400)throw Error(r.body.message);return r.body;}},selection={sourceRunId:f.sourceRun.id,taskId:f.delivery.id,packageDigest:f.item.digest,verificationId:f.verification.id};
 assert.equal((await readStandalonePublication(client,selection)).release,undefined);const value=await publishStandaloneManual(client,{...selection,requestId:randomUUID(),confirm:true,attestations:f.body.attestations});assert.equal(value.release.sourceAgentTaskId,undefined);
 for(const mutate of[v=>{v.manualDeliveryTaskId=randomUUID();},v=>{v.release.sourceAgentTaskId=randomUUID();},v=>{v.release.packageDigest='a'.repeat(64);},v=>{v.runs[0].source.revisionHash='a'.repeat(64);},v=>{v.release.health='HEALTHY';}]){const wrong=structuredClone(value);mutate(wrong);await assert.rejects(readStandalonePublication({request:async(p,o)=>p.endsWith('/publication?'+new URLSearchParams(f.selector))?wrong:client.request(p,o)},selection));}
 await f.tick(value.release.id,1);f.failReceiptReads(true);let gets=0;const stopped=await cancelStandalonePublication({request:(p,o)=>{if(!o){gets++;throw Error('must not read before stop');}return client.request(p,o);}},{...selection,releaseId:value.release.id,confirm:true});assert.equal(gets,0);assert.equal(stopped.scope,'STOP_ACK_ONLY');assert.equal(stopped.status,'CANCELLED');assert.equal(f.counts().modelCalls,0);
});

test('CLI and MCP keep the same reviewed request, never create an Agent and reject actor or duplicate flag injection',async t=>{
 const f=await setup(t),client={request:async(p,o)=>{const r=await f.call(p,o?.method==='POST'?o.body:undefined,{key:o?.idempotencyKey});if(r.status>=400)throw Error(r.body.message);return r.body;}},selected={sourceRunId:f.sourceRun.id,taskId:f.delivery.id,packageDigest:f.item.digest,verificationId:f.verification.id},requestId=randomUUID(),review=join(f.directory,'synthetic-review.json');writeFileSync(review,JSON.stringify({attestations:f.body.attestations}));let value;
 const cli=async args=>runV2Cli(['manual',...args],{}, {client,output:v=>value=JSON.parse(v),error:()=>{}}),flags=['--source-run-id',selected.sourceRunId,'--id',selected.taskId,'--package-digest',selected.packageDigest,'--verification-id',selected.verificationId];
 assert.equal(await cli(['publish',...flags,'--file',review,'--request-id',requestId,'--confirm']),0);const releaseId=value.release.id;
 const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'manual_publication_create',arguments:{...selected,requestId,confirm:true,attestations:f.body.attestations}}},{client}));assert.equal(reply.error,undefined);assert.equal(JSON.parse(reply.result.content[0].text).release.id,releaseId);
 for(const args of[['publish',...flags,'--file',review,'--request-id',requestId],['publication',...flags,'--actor-id','forged'],['publication',...flags,'--id',selected.taskId]])assert.equal(await cli(args),1);
 const invalid=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'manual_publication_create',arguments:{...selected,requestId,confirm:true,attestations:f.body.attestations,actorId:f.owner.id}}},{client}));assert(invalid.error);
 assert.equal(await cli(['stop-publication',...flags,'--release-id',releaseId,'--confirm']),0);assert.equal(value.scope,'STOP_ACK_ONLY');assert.equal(f.store.list('release_approval',PROJECT).length,1);assert.equal(f.store.list('agent',PROJECT).length,0);assert.equal(f.counts().submitCalls,0);
});
test('explicit manual-only private forwarding accepts the same guarded API without enabling model development',async t=>{
 const f=await setup(t),read=await f.forward(f.path+f.query);assert.equal(read.status,200);assert.equal(read.body.status,200);assert.equal(read.body.body.manualDeliveryTaskId,f.delivery.id);
 const made=await f.forward(f.path,f.body);assert.equal(made.status,200);assert.equal(made.body.status,202);assert.equal(made.body.body.release.manualDeliveryTaskId,f.delivery.id);assert.equal(f.store.list('agent',PROJECT).length,0);assert.equal(f.counts().submitCalls,0);
});
