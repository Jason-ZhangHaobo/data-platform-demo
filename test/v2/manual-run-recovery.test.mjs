import test from 'node:test';
import assert from 'node:assert/strict';
import { manualRunLocation, manualRunRecovery, manualDeliveryPackages, manualSaveLocation, manualSaveRequest, acknowledgedManualDraft, mayReuseManualRevision } from '../../web/src/manual-run-recovery.ts';
const revisionId='11111111-1111-4111-8111-111111111111', requestKey='22222222-2222-4222-8222-222222222222', originTaskId='33333333-3333-4333-8333-333333333333',runId='44444444-4444-4444-8444-444444444444';
test('confirmed manual save normalizes only its submitted draft and preserves newer edits',()=>{
  const submitted='  SELECT client_id FROM accounts\n',saved=submitted.trim();
  assert.equal(acknowledgedManualDraft(submitted,submitted,saved),saved);
  assert.equal(acknowledgedManualDraft('SELECT changed FROM accounts',submitted,saved),'SELECT changed FROM accounts');
  assert.throws(()=>acknowledgedManualDraft(submitted,submitted,'SELECT 2'),/回执与提交代码不一致/);
});
test('unchanged model code still requires a manual revision; only a matching confirmed manual receipt is reusable',()=>{
  const current={id:revisionId,sql:'SELECT client_id FROM accounts',contextId:'stock-cash-t1',originAgentTaskId:originTaskId};
  assert.equal(mayReuseManualRevision({...current,source:'LIVE_MODEL'},current),false);
  const saved={...current,source:'MANUAL',manualProvenance:{kind:'ENGINEER_EDIT',originAgentTaskId:originTaskId,agentIndependentE2E:false}};
  assert.equal(mayReuseManualRevision(saved,current),true);
  for(const patch of [{id:runId},{sql:'SELECT changed FROM accounts'},{contextId:'holdings-t1'},{originAgentTaskId:runId}])assert.equal(mayReuseManualRevision(saved,{...current,...patch}),false);
  assert.equal(mayReuseManualRevision({...saved,manualProvenance:{...saved.manualProvenance,agentIndependentE2E:true}},current),false);
  assert.equal(mayReuseManualRevision(undefined,current),false);
});
test('save recovery persists only an opaque key then clears it when a version is confirmed',()=>{
  const link=manualSaveLocation(`http://127.0.0.1/v2/?module=agent-center&task=${originTaskId}&run=${runId}`,requestKey,originTaskId);
  assert.equal(manualSaveRequest(link.href),requestKey);assert.equal(link.searchParams.has('run'),false);assert.equal(link.searchParams.has('task'),false);
  assert.deepEqual([...link.searchParams.keys()].sort(),['module','origin_task','save_request']);
  const confirmed=manualRunLocation(link.href,{revisionId,originTaskId});
  assert.equal(manualSaveRequest(confirmed.href),undefined);
  assert.equal(manualSaveRequest('http://127.0.0.1/?save_request=invalid'),undefined);
  assert.throws(()=>manualSaveLocation(link.href,'SQL or secret'),/不合法/);
});
test('manual delivery only offers packages of the explicit source, without breaking classic unscoped view',()=>{
  const packages=[{id:'correct',manifest:{source:{runId}}},{id:'other',manifest:{source:{runId:'other-run'}}},{id:'broken'}];
  assert.deepEqual(manualDeliveryPackages(packages,runId,true).map(p=>p.id),['correct']);
  assert.deepEqual(manualDeliveryPackages(packages,undefined,true),[]);
  assert.equal(manualDeliveryPackages(packages,undefined,false),packages);
});
test('reload restores the exact manual submission key and origin, never SQL or a secret',()=>{
  const link=manualRunLocation(`http://127.0.0.1/v2/?module=agent-center&task=${originTaskId}`,{revisionId,requestKey,originTaskId});
  assert.equal(link.searchParams.get('task'),null);
  assert.equal(link.searchParams.get('module'),'agent-center');
  assert.deepEqual(manualRunRecovery(link.href),{revisionId,requestKey,originTaskId,runId:undefined});
  assert.deepEqual([...link.searchParams.keys()].sort(),['module','origin_task','revision','run_request']);
});
test('confirmed receipt clears pending request while retaining source task',()=>{
  const pending=manualRunLocation('http://127.0.0.1/v2/',{revisionId,requestKey,originTaskId});
  const done=manualRunLocation(pending.href,{revisionId,runId,requestKey,originTaskId});
  assert.equal(done.searchParams.has('run_request'),false);
  assert.deepEqual(manualRunRecovery(done.href),{revisionId,runId,originTaskId,requestKey:undefined});
});
test('malformed or partial recovery identifiers cannot become a replay request',()=>{
  assert.equal(manualRunRecovery(`http://127.0.0.1/v2/?run_request=${requestKey}`).requestKey,undefined);
  assert.equal(manualRunRecovery(`http://127.0.0.1/v2/?revision=${revisionId}&run_request=secret-text`).requestKey,undefined);
  assert.throws(()=>manualRunLocation('http://127.0.0.1/v2/',{revisionId:'SELECT something private'}),/不合法/);
  assert.throws(()=>manualRunLocation('http://127.0.0.1/v2/',{revisionId,originTaskId:'https://untrusted.invalid'}),/不合法/);
});
