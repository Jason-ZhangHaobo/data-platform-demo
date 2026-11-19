import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {setup} from './fixtures/native-sync-agent.mjs';import {PROJECT} from '../../src/v2/server.mjs';
import {readNativeSyncReview,nativeSyncReviewPath} from '../../src/v2/native-sync-review-client.mjs';
import {publishedReportHash} from '../../src/v2/published-report-source.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
async function prepared(t){const f=await setup(t),started=await f.request('/agent/tasks/'+f.agent.id+'/prepare-delivery',{},randomUUID()),delivery=await f.settled(started.value.id);assert.equal(delivery.status,'SUCCEEDED');return {...f,delivery,input:{taskId:f.agent.id,deliveryId:delivery.id,packageId:delivery.packageId,packageDigest:delivery.packageDigest,verificationId:delivery.verificationId}};}
const state=f=>JSON.stringify(['delivery_review','release_approval','release','release_run','agent_delivery_task','delivery_verification','delivery_package'].map(k=>f.app.store.list(k,PROJECT)));
test('exact native holding preflight reads all file evidence without review, approval, artifact or compute writes',async t=>{
 const f=await prepared(t),before=state(f),changes=f.app.store.db.prepare('SELECT total_changes() AS n').get().n,calls=f.rehearsals(),value=await readNativeSyncReview(f.client,f.input);
 assert.equal(value.review.status,'NEEDS_REVIEW');assert.equal(value.publicationApproved,false);assert.equal(value.schedulerEnabled,false);assert.equal(value.evidence.rehearsal.regressionCount,5);assert.equal(Object.keys(value.evidence.fileHashes).length,8);assert.equal(value.evidence.source.developmentMode,'SYNTHETIC_MODEL');assert.equal(value.consentBasis.confirmFrozenFictionalData,undefined);assert.deepEqual(value.batches.map(v=>v.afterSeconds),[5,35]);assert.equal(value.batches[0].businessDate,value.batches[1].businessDate);assert.equal(state(f),before);assert.equal(f.app.store.db.prepare('SELECT total_changes() AS n').get().n,changes);assert.equal(f.rehearsals(),calls);assert(!JSON.stringify(value).includes(f.root));
});
test('review needs the current rehearsal digest and explicit attestations; rereading cannot approve or start either batch',async t=>{
 const f=await prepared(t),v=await readNativeSyncReview(f.client,f.input),path='/delivery/packages/'+f.input.packageId+'/review',body={packageDigest:f.input.packageDigest,verificationId:f.input.verificationId,syncRehearsalDigest:v.evidence.syncRehearsalDigest,reviewNote:'synthetic protocol fixture review only',attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}};
 assert.equal((await f.request(path,{...body,syncRehearsalDigest:'0'.repeat(64)},randomUUID())).status,409);assert.equal((await f.request(path,{...body,attestations:{...body.attestations,localScope:false}},randomUUID())).status,422);assert.equal(f.app.store.list('delivery_review',PROJECT).length,0);
 const recorded=await f.request(path,body,randomUUID());assert.equal(recorded.status,201);const current=await readNativeSyncReview(f.client,f.input);assert.equal(current.review.status,'REVIEWED');assert.equal(current.review.id,recorded.value.id);assert.equal(current.publicationApproved,false);assert.equal(f.app.store.list('release_approval',PROJECT).length,0);assert.equal(f.app.store.list('release_run',PROJECT).length,0);
 f.app.store.update('delivery_review',recorded.value.id,PROJECT,{syncRehearsalDigest:'0'.repeat(64)});const stale=await readNativeSyncReview(f.client,f.input);assert.equal(stale.review.status,'STALE_REVIEW');assert.equal(stale.review.id,undefined);assert.equal(f.rehearsals(),1);
});
test('wrong task, delivery, package, digest, verification and repeated query never fall back to an available old package',async t=>{
 const f=await prepared(t),path=nativeSyncReviewPath(f.input),before=state(f);
 for(const [k,v]of Object.entries({taskId:randomUUID(),deliveryId:randomUUID(),packageId:randomUUID(),packageDigest:'0'.repeat(64),verificationId:randomUUID()})){const r=await f.request(nativeSyncReviewPath({...f.input,[k]:v}));assert(r.status>=400,k);}
 for(const suffix of ['&deliveryId='+f.input.deliveryId,'&packageDigest='+f.input.packageDigest,'&confirm=true','&taskId='+f.input.taskId])assert.equal((await f.request(path+suffix)).status,422);
 assert.throws(()=>nativeSyncReviewPath({...f.input,confirm:true}));assert.equal(state(f),before);
});
test('owner and original development source remain mandatory, including native versus assisted attribution',async t=>{
 const f=await prepared(t),path=nativeSyncReviewPath(f.input);f.app.store.update('agent',f.agent.id,PROJECT,{submittedBy:'another-engineer'});assert.equal((await f.request(path)).status,403);f.app.store.update('agent',f.agent.id,PROJECT,{submittedBy:'local-engineer',sourceKind:'MANUAL'});assert.equal((await f.request(path)).status,409);f.app.store.update('agent',f.agent.id,PROJECT,{sourceKind:undefined});f.app.store.update('agent_delivery_task',f.delivery.id,PROJECT,{sourceRunId:randomUUID()});assert.equal((await f.request(path)).status,409);
});
test('changed rehearsal rows, file hash or source revision cannot retain a ready review preflight',async t=>{
 const f=await prepared(t),path=nativeSyncReviewPath(f.input),original=f.app.store.get('delivery_verification',f.input.verificationId,PROJECT);
 for(const patch of [{rows:[]},{fileHashes:{...original.fileHashes,'tests.sql':'0'.repeat(64)}},{status:'FAILED'}]){f.app.store.update('delivery_verification',original.id,PROJECT,patch);assert.equal((await f.request(path)).status,409);f.app.store.update('delivery_verification',original.id,PROJECT,original);}
 f.app.store.update('revision',f.revision.id,PROJECT,{hash:'0'.repeat(64)});assert.equal((await f.request(path)).status,409);
});
test('GUI, CLI and MCP share exact readonly binding and checked response; schema drift is rejected before sending',async t=>{
 const f=await prepared(t),expected=await readNativeSyncReview(f.client,f.input);let cli;assert.equal(await runV2Cli(['agent','sync-review-preflight','--id',f.input.taskId,'--delivery-id',f.input.deliveryId,'--package-id',f.input.packageId,'--package-digest',f.input.packageDigest,'--verification-id',f.input.verificationId],{},{client:f.client,output:s=>cli=JSON.parse(s),error:()=>{}}),0);assert.deepEqual(cli,expected);
 const m=JSON.parse(await handleV2Mcp({id:1,method:'tools/call',params:{name:'agent_sync_review_preflight',arguments:f.input}},{client:f.client}));assert.deepEqual(m.result.structuredContent,expected);
 let sent=0;await assert.rejects(()=>readNativeSyncReview({request:async()=>{sent++;}}, {...f.input,confirm:true}));assert.equal(sent,0);assert.equal(f.rehearsals(),1);
});
test('response reader rejects mixed identities, auto-consent, live-evaluation claims and corrupt or malformed evidence',async t=>{
 const f=await prepared(t),original=await readNativeSyncReview(f.client,f.input);
 const changes=[v=>v.binding.deliveryId=randomUUID(),v=>v.publicationApproved=true,v=>v.consentBasis.confirmFrozenFictionalData=true,v=>v.provenance.fullLifecycleE2E=true,v=>v.evidence.rehearsal.regressionCount=0,v=>v.evidence.rehearsal.validationContractId='other',v=>v.evidence.fileHashes['main.sql']='0'.repeat(64),v=>v.evidence.source.developmentMode='MANUAL',v=>v.batches[1].businessDate='2026-09-15',v=>v.evidence.fileHashes['README.md']='invalid',v=>v.evidence.extra='unexpected',v=>v.review={status:'REVIEWED',id:randomUUID(),reviewedAt:'bad'}];
 for(const change of changes){const value=structuredClone(original);change(value);const {evidenceDigest,...body}=value;value.evidenceDigest=publishedReportHash(body);await assert.rejects(()=>readNativeSyncReview({request:async()=>value},f.input));}
 await assert.rejects(()=>readNativeSyncReview({request:async()=>({...original,evidenceDigest:'0'.repeat(64)})},f.input));
});

test('preflight CLI rejects duplicate or mutation flags without a request',async()=>{let requests=0;const client={request:async()=>{requests++;}};for(const flags of [['--confirm'],['--id',randomUUID(),'--id',randomUUID()]])assert.equal(await runV2Cli(['agent','sync-review-preflight',...flags],{},{client,output:()=>{},error:()=>{}}),1);assert.equal(requests,0);});
