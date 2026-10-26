import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createFcIngress} from '../../src/v2/fc-ingress.mjs';
import {codeUpdateConfig,codeUpdateProbes,runControlCodeUpdate,INVITED_READONLY_CODE_SCOPE} from '../../scripts/control-code-update.mjs';
const now=Date.UTC(2026,9,23,15);
const input={authorization:'P0A_PRIVATE_CODE_ONLY',operationId:'a'.repeat(32),applicationSource:'b'.repeat(40),operatorSource:'c'.repeat(40),account:'111122223333',role:'fixture-deploy',functionName:'fixture-control',bucket:'fixture-private-bucket',region:'cn-hangzhou',expiresAt:new Date(now+3600000).toISOString(),previousInvocations:11,previous:{sha256:'d'.repeat(64),bytes:4000,crc64:'123'},candidate:{sha256:'e'.repeat(64),bytes:4100}};
function fixture(options={}){
 const config=codeUpdateConfig({...input,...options.config},now);let checkpoint,updates=[],calls=[],receipts=[],recoveries=0;
 let state={function:{functionName:'fixture-control',codeChecksum:'123',codeSize:4000,runtime:'custom.debian12',cpu:0.25,memorySize:512,instanceConcurrency:1,timeout:120,environmentVariables:{V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',SYNTHETIC_SECRET:'must-not-retain'}},triggers:[{triggerName:'wake',triggerType:'oss'},{triggerName:'result',triggerType:'oss'}],concurrency:{reservedConcurrency:1},scaling:{minInstances:0}};
 const status=()=>({protocol:'shuduo-v2-private-smoke-v1',ingress:{mode:'FC_CONTROL_PATH',publicHttpEnabled:false},metadata:{healthy:true},persistence:{healthy:true,dataState:{healthy:true}},publicReady:false});
 const adapter={
  identity:async()=>({AccountId:config.account,Arn:`acs:ram::${config.account}:assumed-role/${config.role}/fixture`}),
  readState:async()=>structuredClone(state),
  budget:async()=>({complete:true,currentCycle:true,observedCny:options.overBudget?199:1,unsettledReservedCny:0.3}),
  recoverRollback:async()=>{recoveries++;return{sha256:config.previous.sha256,bytes:config.previous.bytes,codeChecksum:config.previous.crc64,safelyRetained:!options.backupMissing};},
  ensurePackage:async(kind,pkg)=>{receipts.push(kind);return{sha256:pkg.sha256,bytes:pkg.bytes,objectKey:pkg.key,crc64:kind==='previous'?'123':'456',readbackVerified:true,privateVerified:!options.notPrivate,immutable:true};},
  updateCode:async body=>{
   assert(checkpoint.updateRequested);assert.deepEqual(Object.keys(body),['code']);assert.deepEqual(Object.keys(body.code).sort(),['checksum','ossBucketName','ossObjectName']);updates.push(structuredClone(body));
   if(options.updateUnapplied&&body.code.checksum==='456')throw Error('unknown write');
   if(options.rollbackUnapplied&&body.code.checksum==='123')throw Error('unknown rollback');
   state.function.codeChecksum=body.code.checksum;state.function.codeSize=body.code.checksum==='123'?4000:4100;
   if(options.driftAfterUpdate)state.function.environmentVariables.OTHER_SETTING='external-change';
   if(options.unknownUpdate&&body.code.checksum==='456')throw Error('response lost');
  },
  invoke:async body=>{
   calls.push(body);assert.equal(checkpoint.invocations,calls.length);
   if(body.operation==='PRIVATE_STATUS_V1')return status();
   const protocol=options.wrongProtocol?'gateway-error':'shuduo-private-application-http/v1';
   if(body.path==='/api/v2/status')return{protocol,status:200,body:{mode:'PUBLIC_INVITATION',publicReady:false,authentication:{publicSessionEnforced:true},spark:{isolation:'REMOTE_FUNCTION'}}};
   if(body.path==='/api/v2/auth/session')return{protocol,status:200,body:{authenticated:false}};
   if(options.foreignCodeOnProbe)state.function.codeChecksum='789';
   return{protocol,status:options.badProbe?200:403,body:{}};
  },
 };
 const storage={now:()=>now,load:async()=>checkpoint,save:async cp=>{if(options.failSaveAtUpdate&&cp.phase==='UPDATE_REQUESTED')throw Error('storage unavailable');checkpoint=structuredClone(cp);}};
 return{config,adapter,storage,state:()=>state,checkpoint:()=>checkpoint,setCheckpoint:v=>{checkpoint=v;},updates,calls,receipts,recoveries:()=>recoveries};
}
test('code-only update requires explicit scope, fixed artifact identities and bounded time',async()=>{
 for(const change of [{authorization:'yes'},{operationId:'invalid'},{previousInvocations:0},{expiresAt:new Date(now+3600001).toISOString()},{candidate:{sha256:'bad',bytes:10}}])assert.throws(()=>codeUpdateConfig({...input,...change},now));
 const f=fixture();await assert.rejects(runControlCodeUpdate({...f.config,authorization:undefined},f.adapter,f.storage),/NOT_AUTHORIZED/);assert.equal(f.updates.length,0);
});
test('successful private update changes only code, preserves history, and uses six read-only invocations',async()=>{
 const f=fixture(),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);
 assert.equal(r.passed,true);assert.equal(f.updates.length,1);assert.equal(r.newInvocations,6);assert.equal(r.cumulativeInvocations,17);assert.equal(r.rollbackAttempts,0);
 assert.deepEqual(f.receipts,['previous','candidate']);assert.equal(f.recoveries(),1);assert.equal(f.checkpoint().phase,'VERIFIED');assert.equal(r.modelCalls,0);assert.equal(r.sparkRuns,0);assert.equal(r.publicEnabled,false);
 assert(!JSON.stringify([r,f.checkpoint(),f.updates]).includes('must-not-retain'));
 const prior=f.calls.length;const second=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(second.passed,true);assert.equal(second.reusedVerifiedResult,true);assert.equal(f.calls.length,prior);assert.equal(f.updates.length,1);
});
test('invited opening has a separate code-only scope, preserves 55 historical calls and never opens HTTP',async()=>{
 const f=fixture({config:{authorization:INVITED_READONLY_CODE_SCOPE,previousInvocations:55}});
 assert.equal(f.config.maxInvocations,6);assert.equal(f.config.maxUpdateAttempts,1);assert.equal(f.config.maxConfigurationReads,30);
 const r=await runControlCodeUpdate(f.config,f.adapter,f.storage);
 assert.equal(r.passed,true);assert.equal(r.requestScope,INVITED_READONLY_CODE_SCOPE);assert.equal(r.newInvocations,6);assert.equal(r.cumulativeInvocations,61);
 assert.equal(r.publicEnabled,false);assert.equal(r.modelCalls,0);assert.equal(r.sparkRuns,0);
 assert.equal(f.state().function.environmentVariables.V2_FC_PUBLIC_HTTP_ENABLED,undefined);
 assert.equal(f.updates.length,1);
 for(const authorization of ['P0A_PRIVATE_CODE_ONLY',INVITED_READONLY_CODE_SCOPE])
  assert.throws(()=>codeUpdateConfig({...input,authorization,previousInvocations:authorization===INVITED_READONLY_CODE_SCOPE?11:55},now));
 for(const change of [{maxInvocations:60},{maxConfigurationReads:31},{maxUpdateAttempts:2}])
  await assert.rejects(runControlCodeUpdate({...f.config,...change},f.adapter,f.storage),/CONFIG_CHANGED/);
 const count=f.calls.length;
 await assert.rejects(runControlCodeUpdate(f.config,f.adapter,{...f.storage,now:()=>f.config.expiresAt}),/UPDATE_WINDOW_EXPIRED/);
 assert.equal(f.calls.length,count);
});
test('an old code-update checkpoint cannot be relabeled as the invited opening grant',async()=>{
 const old=fixture();await runControlCodeUpdate(old.config,old.adapter,old.storage);
 const fresh=fixture({config:{authorization:INVITED_READONLY_CODE_SCOPE,previousInvocations:55}});
 fresh.setCheckpoint(old.checkpoint());
 const r=await runControlCodeUpdate(fresh.config,fresh.adapter,fresh.storage);
 assert.equal(r.failure,'UPDATE_CHECKPOINT_MISMATCH');assert.equal(fresh.updates.length,0);assert.equal(fresh.calls.length,0);
});
test('missing rollback bytes, failed privacy or budget gates stop before code changes',async()=>{
 for(const options of [{backupMissing:true},{notPrivate:true},{overBudget:true}]){const f=fixture(options),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(r.passed,false);assert.equal(f.updates.length,0);assert.equal(f.calls.length,0);}
});
test('lost update receipt is reconciled without a second update',async()=>{
 const f=fixture({unknownUpdate:true}),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(r.passed,true);assert.equal(f.updates.length,1);assert.equal(f.checkpoint().updateResponseUnknown,true);
 const notApplied=fixture({updateUnapplied:true}),a=await runControlCodeUpdate(notApplied.config,notApplied.adapter,notApplied.storage);assert.equal(a.passed,false);assert.equal(a.failure,'UPDATE_OUTCOME_REQUIRES_READBACK');assert.equal(a.originalCodePresent,true);assert.equal(a.rollbackVerified,undefined);assert.equal(notApplied.updates.length,1);
 const b=await runControlCodeUpdate(notApplied.config,notApplied.adapter,notApplied.storage);assert.equal(b.passed,false);assert.equal(notApplied.updates.length,1);
});
test('failed post-update checks restore the exact old package once',async()=>{
 const f=fixture({badProbe:true}),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(r.passed,false);assert.equal(r.rollbackVerified,true);assert.equal(r.rollbackAttempts,1);assert.equal(f.state().function.codeChecksum,'123');assert.equal(f.updates.length,2);
 const second=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(second.rollbackVerified,true);assert.equal(f.updates.length,2);
});
test('unconfirmed rollback never issues a second rollback write on recovery',async()=>{
 const f=fixture({badProbe:true,rollbackUnapplied:true}),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(r.rollbackFailure,'ROLLBACK_NOT_CONFIRMED');assert.equal(f.updates.length,2);
 const again=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(again.passed,false);assert.equal(f.updates.length,2);
});
test('outer opening failure restores previously verified code using the original single rollback allowance',async()=>{
 const f=fixture({config:{authorization:INVITED_READONLY_CODE_SCOPE,previousInvocations:55}});
 assert.equal((await runControlCodeUpdate(f.config,f.adapter,f.storage)).passed,true);
 const original=structuredClone(f.checkpoint()),calls=f.calls.length;
 let cleanup=0;
 const r=await runControlCodeUpdate(f.config,f.adapter,{...f.storage,rollbackOnly:true,beginCleanup:()=>{cleanup++;}});
 assert.equal(r.rollbackVerified,true);assert.equal(r.passed,false);assert.equal(cleanup,1);
 assert.equal(f.updates.length,2);assert.equal(f.calls.length,calls);assert.equal(f.checkpoint().phase,'ROLLED_BACK');
 assert.equal(f.checkpoint().configHash,original.configHash);assert.equal(f.checkpoint().rollbackAttempts,1);
 const replay=await runControlCodeUpdate(f.config,f.adapter,{...f.storage,rollbackOnly:true});
 assert.equal(replay.rollbackVerified,true);assert.equal(f.updates.length,2);assert.equal(f.calls.length,calls);
});
test('outer rollback cannot initialize a new update, overwrite an open entry or gain another rollback',async()=>{
 const config={authorization:INVITED_READONLY_CODE_SCOPE,previousInvocations:55};
 const empty=fixture({config}),a=await runControlCodeUpdate(empty.config,empty.adapter,{...empty.storage,rollbackOnly:true});
 assert.equal(a.failure,'OUTER_ROLLBACK_CHECKPOINT_REQUIRED');assert.equal(empty.updates.length,0);assert.equal(empty.calls.length,0);
 const f=fixture({config});await runControlCodeUpdate(f.config,f.adapter,f.storage);
 f.state().function.environmentVariables.V2_FC_PUBLIC_HTTP_ENABLED='true';
 const b=await runControlCodeUpdate(f.config,f.adapter,{...f.storage,rollbackOnly:true});
 assert.equal(b.failure,'PROTECTED_STATE_DRIFT');assert.equal(f.updates.length,1);
 const lost=fixture({config,rollbackUnapplied:true});await runControlCodeUpdate(lost.config,lost.adapter,lost.storage);
 await runControlCodeUpdate(lost.config,lost.adapter,{...lost.storage,rollbackOnly:true});
 const c=await runControlCodeUpdate(lost.config,lost.adapter,{...lost.storage,rollbackOnly:true});
 assert.equal(c.passed,false);assert.equal(lost.updates.length,2);assert.equal(lost.checkpoint().rollbackAttempts,1);
 const old=fixture();await assert.rejects(runControlCodeUpdate(old.config,old.adapter,{...old.storage,rollbackOnly:true}),/OUTER_ROLLBACK_SCOPE_INVALID/);
});
test('foreign code or protected configuration drift cannot be overwritten by rollback',async()=>{
 for(const options of [{driftAfterUpdate:true},{badProbe:true,foreignCodeOnProbe:true}]){const f=fixture(options),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(r.passed,false);assert.equal(f.updates.length,1);assert.match(r.rollbackFailure,/DRIFT|FOREIGN/);}
});
test('checkpoint failures or a foreign checkpoint cannot cause rollback writes',async()=>{
 const f=fixture({failSaveAtUpdate:true}),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);assert.equal(r.passed,false);assert.equal(f.updates.length,0);
 const other=fixture();await runControlCodeUpdate(other.config,other.adapter,other.storage);const cp={...other.checkpoint(),operationId:'f'.repeat(32),phase:'UPDATED'};other.setCheckpoint(cp);const count=other.updates.length;
 const blocked=await runControlCodeUpdate(other.config,other.adapter,other.storage);assert.equal(blocked.failure,'UPDATE_CHECKPOINT_MISMATCH');assert.equal(other.updates.length,count);
});
test('probe allowlist has no business writes, HTTP entry creation, model or Spark action',()=>{
 assert.equal(codeUpdateProbes.length,5);
 assert(codeUpdateProbes.every(p=>p.body.operation==='PRIVATE_STATUS_V1'||(p.body.operation==='PRIVATE_APPLICATION_HTTP_V1'&&p.body.method==='GET'&&!p.body.body&&!p.body.headers)));
});
test('changed limits, target keys and approval windows cannot bypass normalized configuration',async()=>{
 for(const change of [{maxInvocations:99},{maxUpdateAttempts:99},{maxRollbackAttempts:99},{previousInvocations:0},{candidate:{...fixture().config.candidate,key:'other-object.zip'}},{expiresAt:now+7200000}]){
  const f=fixture();await assert.rejects(runControlCodeUpdate({...f.config,...change},f.adapter,f.storage));assert.equal(f.updates.length,0);assert.equal(f.calls.length,0);assert.equal(f.recoveries(),0);
 }
});
test('recovery binds source versions, full package identity and the original authorization window',async()=>{
 for(const change of [{operatorSource:'f'.repeat(40)},{applicationSource:'f'.repeat(40)},{expiresAt:new Date(now+3500000).toISOString()},{candidate:{...input.candidate,bytes:4200}}]){
  const f=fixture();await runControlCodeUpdate(f.config,f.adapter,f.storage);
  const count=f.calls.length,config=codeUpdateConfig({...input,...change},now),r=await runControlCodeUpdate(config,f.adapter,f.storage);
  assert.equal(r.passed,false);assert.equal(r.failure,'UPDATE_CHECKPOINT_MISMATCH');assert.equal(f.calls.length,count);assert.equal(f.updates.length,1);
 }
});
test('corrupt saved receipts are rejected before recovery probes or rollback writes',async()=>{
 for(const change of [{key:'other-object.zip'},{bytes:999},{sha256:'f'.repeat(64)},{crc64:'not-a-checksum'}]){
  const f=fixture();await runControlCodeUpdate(f.config,f.adapter,f.storage);
  const cp=structuredClone(f.checkpoint());cp.phase='UPDATED';cp.probes=[];cp.previousReceipt={...cp.previousReceipt,...change};f.setCheckpoint(cp);
  const count=f.calls.length,r=await runControlCodeUpdate(f.config,f.adapter,f.storage);
  assert.equal(r.failure,'UPDATE_CHECKPOINT_RECEIPT_INVALID');assert.equal(f.updates.length,1);assert.equal(f.calls.length,count);
 }
});
test('a gateway response with an HTTP status is not application verification',async()=>{
 const f=fixture({wrongProtocol:true}),r=await runControlCodeUpdate(f.config,f.adapter,f.storage);
 assert.equal(r.passed,false);assert.equal(r.failure,'APPLICATION_PROTOCOL_NOT_VERIFIED');assert.equal(r.rollbackVerified,true);
});
test('fixed probes match actual loopback application responses without model or engine execution',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-code-update-test-')),store=new MetadataStore(':memory:');
 // Cloud persistence and FC writes remain doubles. Only the HTTP application
 // protocol and authorization handlers are real in this local contract test.
 store.replicationStatus=()=>({driver:'synthetic-replication',healthy:true});
 let modelCalls=0,engineCalls=0;
 const app=createV2Server({root,store,ingress:createFcIngress(),
  env:{V2_LOCAL_DEVELOPMENT:'false',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true'},
  stateCoordinator:{refresh:async()=>{},flush:async()=>{},replicationStatus:()=>({mode:'synthetic-replication',healthy:true,metadata:{healthy:true},dataState:{healthy:true}})},
  runnerDescriptor:{isolation:'REMOTE_FUNCTION',publicWriteEnabled:false},
  runner:async()=>{engineCalls++;throw Error('engine must not run');},
  generator:async()=>{modelCalls++;throw Error('model must not run');},
 });
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const f=fixture();
 f.adapter.invoke=async body=>{
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/invoke`,{method:'POST',headers:{'content-type':'application/octet-stream','x-fc-control-path':'/invoke'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);return response.json();
 };
 const r=await runControlCodeUpdate(f.config,f.adapter,f.storage);
 assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.newInvocations,6);
 assert.equal(modelCalls,0);assert.equal(engineCalls,0);
 for(const type of ['agent','run','release'])assert.equal(store.list(type,PROJECT).length,0);
});
