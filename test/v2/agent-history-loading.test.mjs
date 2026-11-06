import test from 'node:test';
import assert from 'node:assert/strict';
import {initialAgentTaskId,loadHistoryAfterTarget,mergeTaskHistory,checkedAgentHistory,checkedAgentTask,checkedAgentRun} from '../../web/src/agent-history-loading.ts';
const taskId='11111111-1111-4111-8111-111111111111';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const sampleTask=()=>({id:taskId,version:2,message:'虚构证券持仓加工',contextId:'holdings-t1',status:'SUCCEEDED',stage:'SUCCEEDED',language:'SPARK_SQL',attempts:[],sql:'SELECT 1',revisionId:'22222222-2222-4222-8222-222222222222',runId:'33333333-3333-4333-8333-333333333333'});

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

test('malformed history is rejected without clearing a recovered task or draft',async()=>{
 for(const bad of [null,{}, {items:[]},[null],[{id:taskId}],[{...sampleTask(),version:0}],[{...sampleTask(),message:{text:'unsafe'}}],[sampleTask(),sampleTask()]]){
  const visible={task:sampleTask(),draft:'未保存的虚构证券SQL',history:[sampleTask()]};let errors=0,accepts=0;
  await loadHistoryAfterTarget({readHistory:async()=>bad,isCurrent:()=>true,acceptHistory:items=>{accepts++;visible.history=items;},onHistoryError:()=>errors++});
  assert.equal(errors,1);assert.equal(accepts,0);assert.equal(visible.task.id,taskId);assert.equal(visible.draft,'未保存的虚构证券SQL');assert.equal(visible.history.length,1);
 }
});

test('verified empty and valid history are distinct from a failed response and do not filter silently',()=>{
 assert.deepEqual(checkedAgentHistory([]),[]);assert.deepEqual(checkedAgentHistory([sampleTask()]),[sampleTask()]);
 assert.throws(()=>checkedAgentHistory([sampleTask(),{id:'invalid'}]),/响应不完整/);
 // Old Python tasks remain discoverable; list reads do not relabel them as SQL.
 const python={...sampleTask(),language:'PYTHON',code:'result=[]'};assert.equal(checkedAgentHistory([python])[0].language,'PYTHON');
});

test('exact task reads reject wrong identity, malformed attempts and unsafe rendered values',()=>{
 const current=sampleTask();assert.equal(checkedAgentTask(current,taskId),current);
 for(const bad of [null,{}, {...current,id:'44444444-4444-4444-8444-444444444444'}, {...current,sql:{}},{...current,attempts:null},{...current,attempts:[null]},
  {...current,attempts:[{attempt:1,status:'FAILED',model:{}}]},
  {...current,attempts:[{attempt:1,status:'FAILED',diagnostic:{code:'ERROR',phase:'REQUEST',elapsedMs:1,httpStatus:503}}]},
  {...current,attempts:[{attempt:1,status:'FAILED'},{attempt:1,status:'GENERATED'}]},
  {...current,background:{status:'ACTIVE',expiresAt:{},consumedEvents:0,maxEvents:2}}])assert.throws(()=>checkedAgentTask(bad,taskId),/未替换/);
 const legacy={...current,language:'PYTHON',attempts:[{attempt:1,status:'FAILED',diagnostic:{code:'ERROR',phase:'REQUEST',elapsedMs:1,httpStatus:503,requestMayHaveBeenSent:true}}]};assert.equal(checkedAgentTask(legacy,taskId),legacy);
});

test('a history retry replaces only the list after confirmation and ignores a late invalid response',async()=>{
 let list=[sampleTask()],errors=0;const api=deferred();let current=true;
 const pending=loadHistoryAfterTarget({readHistory:()=>api.promise,isCurrent:()=>current,acceptHistory:items=>{list=items;},onHistoryError:()=>errors++});
 current=false;api.resolve(null);await pending;assert.equal(errors,0);assert.equal(list.length,1);
 await loadHistoryAfterTarget({readHistory:async()=>[],isCurrent:()=>true,acceptHistory:items=>{list=items;},onHistoryError:()=>errors++});assert.deepEqual(list,[]);assert.equal(errors,0);
});

test('run reads must match the exact task run, revision and business context',()=>{
 const task=sampleTask(),run={id:task.runId,status:'SUCCEEDED',revisionId:task.revisionId,contextId:task.contextId,rows:[{client_id:'F001'}],validation:{passed:true,issues:[],regressions:[]}};
 assert.equal(checkedAgentRun(run,task),run);
 for(const bad of [null,{...run,id:taskId},{...run,agentTaskId:'44444444-4444-4444-8444-444444444444'},{...run,revisionId:taskId},{...run,contextId:'stock-cash-t1'},{...run,rows:{}},{...run,rows:[null]},
  {...run,validation:{passed:true,issues:{}}},{...run,validation:{passed:true,regressions:[{contextId:'x',name:{},passed:true}]}}])assert.throws(()=>checkedAgentRun(bad,task),/未确认/);
 // Repair sources may legitimately belong to another task; their exact ID and
 // context remain bound, and they are never reclassified as a current attempt.
 const source={...run,agentTaskId:'44444444-4444-4444-8444-444444444444'};
 assert.equal(checkedAgentRun(source,{contextId:task.contextId,runId:task.runId}),source);
 assert.throws(()=>checkedAgentRun(source,{contextId:task.contextId,runId:taskId}),/未确认/);
});
