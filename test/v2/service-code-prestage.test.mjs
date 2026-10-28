import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runServiceCodePrestage,validateServicePrestagePlan} from '../../scripts/service-code-prestage.mjs';

function fixture(){
 let clock=Date.parse('2026-10-28T10:00:00Z');
 const bytes=Buffer.from('frozen fictional securities service package');
 const plan={protocol:'SERVICE_CODE_PRESTAGE_V1',authorized:true,attemptNumber:2,
  operationId:'00000000-0000-4000-8000-000000000001',approvalDigest:'a'.repeat(64),closedAttemptDigest:'b'.repeat(64),
  candidate:{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length},issuedAt:clock,deadline:clock+600000,
  maxPuts:1,maxObjectReads:3,maxAclReads:2,priorReserveCny:39,maxIncrementCny:2,monthlyCny:200,billCny:3,
  bucketPrivacy:{aclPrivate:true,policyNotPublic:true,publicAccessBlocked:true,bucketHash:'c'.repeat(64),checkedAt:new Date(clock).toISOString()}};
 const calls=[],controls={};let object,saved;
 const io={save:async state=>{saved=structuredClone(state);calls.push({kind:'SAVE',phase:state.phase,puts:state.putAttempts});
   if(controls.failSave===state.phase)throw Error('synthetic storage unavailable');
   if(controls.expireSave===state.phase)clock=plan.deadline;},
  readObject:async(pkg,options)=>{calls.push({kind:'GET',pkg,options});if(controls.readError)throw controls.readError;
   return controls.readResult??(object?{status:200,bytes:object,crc64:controls.crc??'12345678'}:{status:404,serviceCode:'NoSuchKey'});},
  putObject:async(pkg,value,options)=>{calls.push({kind:'PUT',pkg,options,reservation:saved?.putAttempts});
   if(!controls.dropPut)object=Buffer.from(value);if(controls.lostPut)throw Object.assign(Error('do not retain sensitive detail'),{name:'TimeoutError'});
   return{status:controls.putStatus??200};},
  readAcl:async()=>{calls.push({kind:'ACL'});return{status:200,grant:controls.acl??'default'};}};
 const run=()=>runServiceCodePrestage({plan,bytes,checkpoint:saved,io,now:()=>clock});
 return{plan,bytes,calls,controls,run,io,get saved(){return saved;},setObject:v=>{object=v;}};
}

test('local pre-stage reserves before its sole PUT and verifies full bytes plus private ACL',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.receipt.putAttempts,1);assert.equal(result.checkpoint.phase,'VERIFIED');
 assert.equal(result.receipt.sha256,f.plan.candidate.sha256);assert.equal(result.receipt.crc64,'12345678');
 const writes=f.calls.filter(c=>c.kind==='PUT');assert.equal(writes.length,1);assert.equal(writes[0].reservation,1);
 assert.equal(writes[0].options.forbidOverwrite,true);assert.equal(result.checkpoint.objectReads,2);assert.equal(result.checkpoint.aclReads,1);
 const before=f.calls.length;assert.equal((await f.run()).reused,true);assert.equal(f.calls.length,before);
});

test('an existing exact object is reused without PUT; corrupted bytes and ACL never qualify',async()=>{
 const f=fixture();f.setObject(f.bytes);assert.equal((await f.run()).receipt.putAttempts,0);
 assert.equal(f.calls.filter(c=>c.kind==='PUT').length,0);
 for(const mutate of [g=>g.setObject(Buffer.from('different bytes')),g=>{g.setObject(g.bytes);g.controls.crc='invalid';},g=>{g.setObject(g.bytes);g.controls.acl='public-read';}]){
  const g=fixture();mutate(g);await assert.rejects(g.run());assert.equal(g.saved.phase,'FAILED');assert.equal(g.calls.some(c=>c.kind==='PUT'),false);
 }
});

test('lost PUT response is reconciled, never repeated, and preserves diagnostic failures',async()=>{
 const f=fixture();f.controls.lostPut=true;const result=await f.run();
 assert.equal(result.receipt.putAttempts,1);assert.deepEqual(result.checkpoint.failures,['TRANSFER_TIMEOUT']);assert.equal(f.calls.filter(c=>c.kind==='PUT').length,1);
 assert.equal((await f.run()).reused,true);assert.equal(f.calls.filter(c=>c.kind==='PUT').length,1);
});

test('a missing object after an uncertain PUT cannot be uploaded again, even after restarting',async()=>{
 const f=fixture();f.controls.dropPut=true;f.controls.lostPut=true;await assert.rejects(f.run(),/OBJECT_NOT_VERIFIED/);
 assert.equal(f.saved.putAttempts,1);assert.equal(f.saved.objectReads,2);
 await assert.rejects(f.run(),/UPLOAD_ALREADY_ATTEMPTED/);assert.equal(f.calls.filter(c=>c.kind==='PUT').length,1);
 await assert.rejects(f.run(),/READ_LIMIT/);assert.equal(f.saved.objectReads,3);
});

test('failed checkpoint save or expiry before PUT causes zero cloud writes',async()=>{
 for(const key of ['failSave','expireSave']){
  const f=fixture();f.controls[key]='PUT_REQUESTED';await assert.rejects(f.run());
  assert.equal(f.saved.putAttempts,1);assert.equal(f.calls.filter(c=>c.kind==='PUT').length,0);
 }
 const f=fixture();f.controls.expireSave='READ_REQUESTED';await assert.rejects(f.run());assert.equal(f.calls.filter(c=>c.kind==='GET').length,0);
});

test('denial or an unclassified not-found does not authorize a PUT',async()=>{
 for(const readResult of [{status:403},{status:404,serviceCode:'OtherReason'},{status:500}]){
  const f=fixture();f.controls.readResult=readResult;await assert.rejects(f.run());assert.equal(f.calls.some(c=>c.kind==='PUT'),false);
 }
});

test('authority, bytes, binding, budgets and request windows fail closed before any IO',async()=>{
 const changes=[p=>p.authorized=false,p=>p.attemptNumber=3,p=>p.approvalDigest='invalid',p=>p.candidate.sha256='0'.repeat(64),
  p=>p.maxPuts=2,p=>p.maxObjectReads=4,p=>p.maxAclReads=3,p=>p.priorReserveCny=37,p=>p.billCny=159,
  p=>p.bucketPrivacy.publicAccessBlocked=false,p=>p.deadline=p.issuedAt+1200001];
 for(const change of changes){const f=fixture();change(f.plan);await assert.rejects(f.run());assert.equal(f.calls.length,0);}
 const f=fixture();f.setObject(f.bytes);await f.run();f.plan.approvalDigest='f'.repeat(64);
 const before=f.calls.length;await assert.rejects(f.run(),/CHECKPOINT_CHANGED/);assert.equal(f.calls.length,before);
 const g=fixture();assert.throws(()=>validateServicePrestagePlan(g.plan,Buffer.from('wrong'),g.plan.issuedAt));
});

test('a crashed PUT_REQUESTED checkpoint queries first and cannot create another upload',async()=>{
 const f=fixture();f.controls.failSave='PUT_REQUESTED';await assert.rejects(f.run());delete f.controls.failSave;
 const cp={...f.saved,phase:'PUT_REQUESTED'};
 await assert.rejects(runServiceCodePrestage({plan:f.plan,bytes:f.bytes,checkpoint:cp,io:f.io,now:()=>f.plan.issuedAt}),/UPLOAD_ALREADY_ATTEMPTED/);
 assert.equal(f.calls.some(c=>c.kind==='PUT'),false);
});

test('inconsistent unknown-upload and verified checkpoints are rejected before IO',async()=>{
 const f=fixture();f.setObject(f.bytes);await f.run();
 for(const patch of [{phase:'PUT_REQUESTED',putAttempts:0},{phase:'PUT_UNCONFIRMED',putAttempts:0},
  {phase:'PUT_REQUESTED',putAttempts:1,objectReads:0},{phase:'VERIFIED',objectReads:0},{phase:'VERIFIED',aclReads:0},
  {phase:'VERIFIED',receipt:{...f.saved.receipt,verifiedAt:new Date(f.plan.issuedAt-1).toISOString()}},
  {phase:'VERIFIED',receipt:{...f.saved.receipt,verifiedAt:new Date(f.plan.deadline).toISOString()}}]){
  const before=f.calls.length;
  await assert.rejects(runServiceCodePrestage({plan:f.plan,bytes:f.bytes,checkpoint:{...f.saved,...patch},io:f.io,now:()=>f.plan.issuedAt}));
  assert.equal(f.calls.length,before);
 }
});

test('a separately approved third attempt retains both failed-batch reserves without enlarging PUT allowance',async()=>{
 const f=fixture();f.plan.attemptNumber=3;f.plan.priorReserveCny=41;
 const result=await f.run();assert.equal(result.receipt.putAttempts,1);assert.equal(f.calls.filter(c=>c.kind==='PUT').length,1);
 for(const reserve of [39,40,40.5,42]){
  const g=fixture();g.plan.attemptNumber=3;g.plan.priorReserveCny=reserve;
  await assert.rejects(g.run(),/BUDGET_INVALID/);assert.equal(g.calls.length,0);
 }
 const g=fixture();g.plan.attemptNumber=3;g.plan.priorReserveCny=41;g.plan.billCny=157;
 await assert.rejects(g.run(),/BUDGET_INVALID/);assert.equal(g.calls.length,0);
});
