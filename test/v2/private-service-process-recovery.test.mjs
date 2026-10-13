import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareServiceRecovery } from '../../scripts/compare-v2-service-recovery.mjs';
const exec=promisify(execFile);
const worker='fixtures/acceptance/private-service-recovery-worker.mjs';
async function run(phase,root){
  const {stdout}=await exec(process.execPath,[worker,phase,root],{timeout:30000,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}
test('new backend process restores exact service snapshots, sessions, revoked grants, calls and rate counters',async()=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-service-restart-'));
  const before=await run('seed',root),after=await run('resume',root);
  assert.notEqual(before.pid,after.pid);assert.notEqual(before.proof.bootId,after.proof.bootId);
  assert.equal(before.proof.fingerprint,after.proof.fingerprint);
  assert.equal(after.proof.state.evidence.length,3);
  assert.equal(after.proof.state.calls.length,2);
  assert.ok(after.proof.state.evidence.every(v=>v.verified));
  assert.equal(after.revokedRejected,true);assert.equal(after.rateCounterRestored,true);assert.equal(after.idempotencyRestored,true);
  assert.equal(after.scope,'LOCAL_PROCESS_RESTART_FILE_CAS');assert.equal(after.syntheticInputs,true);
  const comparison=compareServiceRecovery(before.proof,after.proof);
  assert.equal(comparison.passed,true);assert.equal(comparison.cloudRestartVerified,false);
  assert.equal(compareServiceRecovery(before.proof,before.proof).passed,false);
  assert.equal(compareServiceRecovery(before.proof,{...after.proof,state:{...after.proof.state,status:'FAKE'}}).passed,false);
  const beforePath=join(root,'before.json'),afterPath=join(root,'after.json');
  writeFileSync(beforePath,JSON.stringify(before.proof),{mode:0o600});
  writeFileSync(afterPath,JSON.stringify(after.proof),{mode:0o600});
  const cli=await exec(process.execPath,['scripts/compare-v2-service-recovery.mjs',beforePath,afterPath],{timeout:10000});
  assert.equal(JSON.parse(cli.stdout).passed,true);
});
for(const kind of ['missing','corrupt'])test(`new process rejects ${kind} business state while metadata remains valid`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-service-restart-'));await run('seed',root);
  const path=join(root,'business.json'),state=JSON.parse(readFileSync(path));
  if(kind==='missing'){state.payload.tables.customerAssets=[];state.payload.tables.serviceSnapshots=[];}
  else state.payload.tables.customerAssets[0].total_assets='9999.00';
  writeFileSync(path,JSON.stringify(state),{mode:0o600});
  const after=await run(kind,root);assert.equal(after.proof.healthy,false);
  assert.ok(after.proof.state.evidence.some(v=>v.code==='SOURCE_SNAPSHOT_UNAVAILABLE'));
});
test('rollback receipt and original request identity survive a different backend process',async()=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-service-restart-'));
  const before=await run('version-seed',root),after=await run('version-resume',root);
  assert.notEqual(before.pid,after.pid);assert.notEqual(before.proof.bootId,after.proof.bootId);
  assert.equal(before.proof.fingerprint,after.proof.fingerprint);
  assert.equal(after.switchReceiptRestored,true);
});
