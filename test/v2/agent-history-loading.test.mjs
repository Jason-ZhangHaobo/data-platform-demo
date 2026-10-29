import test from 'node:test';
import assert from 'node:assert/strict';
import {initialAgentTaskId,loadHistoryAfterTarget,mergeTaskHistory} from '../../web/src/agent-history-loading.ts';
const taskId='11111111-1111-4111-8111-111111111111';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

test('an exact task link is restored before a delayed history request starts',async()=>{
  const target=deferred(),history=deferred(),calls=[],visible={};
  const loading=loadHistoryAfterTarget({restoreTarget:async()=>{calls.push('task');visible.task=await target.promise;},readHistory:()=>{calls.push('history');return history.promise;},isCurrent:()=>true,acceptHistory:items=>{visible.history=items;},onHistoryError:()=>assert.fail('unexpected error')});
  assert.deepEqual(calls,['task']);target.resolve({id:taskId,sql:'already-saved-sql'});
  await new Promise(r=>setImmediate(r));assert.equal(visible.task.id,taskId);assert.deepEqual(calls,['task','history']);assert.equal(visible.history,undefined);
  history.resolve([]);await loading;assert.deepEqual(visible.history,[]);assert.equal(visible.task.sql,'already-saved-sql');
});

test('failed optional history does not remove the restored task or retry its read',async()=>{
  let taskReads=0,historyReads=0,error;const visible={};
  await loadHistoryAfterTarget({restoreTarget:async()=>{taskReads++;visible.task={id:taskId};},readHistory:async()=>{historyReads++;throw Error('history timeout');},isCurrent:()=>true,acceptHistory:()=>assert.fail('no successful history'),onHistoryError:e=>{error=e.message;}});
  assert.equal(visible.task.id,taskId);assert.equal(error,'history timeout');assert.equal(taskReads,1);assert.equal(historyReads,1);
});

test('leaving the identity/view during either stage ignores late results and starts no next-stage read',async()=>{
  let active=true,reads=0,applied=0;const target=deferred();
  const first=loadHistoryAfterTarget({restoreTarget:()=>target.promise,readHistory:async()=>{reads++;return[];},isCurrent:()=>active,acceptHistory:()=>applied++,onHistoryError:()=>applied++});
  active=false;target.resolve();await first;assert.equal(reads,0);assert.equal(applied,0);
  const history=deferred();active=true;
  const second=loadHistoryAfterTarget({readHistory:()=>history.promise,isCurrent:()=>active,acceptHistory:()=>applied++,onHistoryError:()=>applied++});
  active=false;history.resolve([{id:taskId}]);await second;assert.equal(applied,0);
});

test('a selected newer task is not lost to a late or incomplete list',()=>{
  const current={id:taskId,version:4,status:'SUCCEEDED'};
  assert.deepEqual(mergeTaskHistory([],current),[current]);
  assert.deepEqual(mergeTaskHistory([{...current,version:3,status:'RUNNING'}],current),[current]);
  const newer={...current,version:5};assert.deepEqual(mergeTaskHistory([newer],current),[newer]);
});

test('direct links reject ambiguous or malformed identifiers before constructing a request path',()=>{
  assert.equal(initialAgentTaskId('https://example.invalid/v2/'),undefined);
  assert.equal(initialAgentTaskId('https://example.invalid/v2/?task='+taskId),taskId);
  for(const query of ['task=../private','task=','task='+taskId+'&task='+taskId])assert.throws(()=>initialAgentTaskId('https://example.invalid/v2/?'+query),/任务链接无效/);
});
