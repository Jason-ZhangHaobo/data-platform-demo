import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInvitedSqlSubmission} from '../../web/src/invited-sql-submission.ts';

function fixture({initialKey,mutateTask,mutateContext,writeResult,readResult}={}) {
  const draft={message:'统计两个虚构客户持仓市值和可用现金',contextId:'holdings-t1'};
  const task={id:randomUUID(),version:1,executionMode:'DURABLE_SQL_AGENT_V1',language:'SPARK_SQL',
    mode:'LIVE_MODEL',initialSql:'SELECT 1 AS pending',attempts:[],...draft};
  const calls=[],markers=[];
  const scope={open:true};
  const ctl=createInvitedSqlSubmission({
    initialKey,canSubmit:()=>scope.open,acceptsContext:id=>id===draft.contextId,onPending:key=>markers.push(key),
    api:async(path,body,options)=>{
      calls.push({path,body,key:options?.idempotencyKey});
      if(body!==undefined) {
        assert.equal(path,'/agent/tasks');
        assert.deepEqual(body,{...draft,sql:'SELECT 1 AS pending',background:true});
        assert.equal(markers[0],options.idempotencyKey);
        await writeResult?.(calls);
        return {...task,...mutateTask};
      }
      if(path.startsWith('/agent/requests/')){await readResult?.();return {...task,...mutateTask};}
      const requestId=initialKey??markers[0];
      assert.equal(path,'/agent/tasks/'+task.id+'/chat-context?request_id='+requestId);
      return {...draft,protocol:'shuduo-invited-sql-context/v1',scope:'INVITED_TASK_READ_ONLY',readOnly:true,
        fullLifecycleE2E:false,requestId,taskId:task.id,taskStatus:'QUEUED',taskStage:'READY_FOR_MODEL',
        attemptCount:0,evidenceState:'PENDING',evidenceSource:'STORED_METADATA',...mutateContext};
    },
  });
  return {ctl,draft,task,calls,scope,markers};
}
const lost=()=>{throw Error('response lost');};
const missing=()=>{throw Object.assign(Error('missing'),{status:404});};

test('one invited conversation starts one original SQL task and verifies the request before navigating',async()=>{
  const {ctl,draft,calls,task,markers}=fixture();
  const first=ctl.submit(draft);
  await assert.rejects(ctl.submit(draft),/原请求/);
  assert.deepEqual(await first,{taskId:task.id,requestId:markers[0]});
  assert.equal(calls.length,2);assert.equal(markers.length,2);
  assert.equal(ctl.snapshot().key,undefined);
});

test('a lost response and a cold reopened request recover the same task without a second write',async()=>{
  const {ctl,draft,calls,task,markers}=fixture({writeResult:lost});
  await assert.rejects(ctl.submit(draft));
  assert.equal(ctl.snapshot().key,markers[0]);
  assert.deepEqual(await ctl.recover(),{requestId:markers[0],taskId:task.id});
  assert.equal(calls.filter(c=>c.body).length,1);
  const cold=fixture({initialKey:randomUUID()});
  cold.scope.open=false;
  const key=cold.ctl.snapshot().key;
  assert.deepEqual(await cold.ctl.recover(),{requestId:key,taskId:cold.task.id});
  assert.equal(cold.calls.filter(c=>c.body).length,0);
});

test('only an explicit same-key retry may write after a missing original, with current scope checked again',async()=>{
  const f=fixture({writeResult:calls=>{if(calls.length===1)lost();},readResult:missing});
  await assert.rejects(f.ctl.submit(f.draft));
  f.scope.open=false;
  await assert.rejects(f.ctl.retry(),/未开放/);
  assert.equal(f.calls.filter(c=>c.body).length,1);
  f.scope.open=true;
  const result=await f.ctl.retry();
  const writes=f.calls.filter(c=>c.body);
  assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
  assert.equal(result.requestId,writes[0].key);
  const cold=fixture({initialKey:randomUUID(),readResult:missing});
  await assert.rejects(cold.ctl.retry());
  assert.deepEqual(cold.calls,[]);
});

test('lookup or context ambiguity cannot clear the submitted request or trigger paid retries',async()=>{
  for(const changes of [{mutateTask:{mode:'SYNTHETIC_MODEL'}},{mutateTask:{sourceRunId:randomUUID()}},
    {mutateTask:{derivedFrom:{}}},{mutateTask:{initialSql:'SELECT from_saved_revision'}},
    {mutateContext:{requestId:randomUUID()}},{mutateContext:{message:'其他需求'}},
    {mutateContext:{taskId:randomUUID()}}]){
    const f=fixture(changes);
    await assert.rejects(f.ctl.submit(f.draft));
    assert.equal(f.ctl.snapshot().key,f.markers[0]);
    await assert.rejects(f.ctl.retry());
    assert.equal(f.calls.filter(c=>c.body).length,1);
  }
});

test('invalid draft, limited window and closed identity produce no task writes',async()=>{
  const f=fixture();
  for(const draft of [{...f.draft,message:'短'},{...f.draft,contextId:'other-context'}])
    await assert.rejects(f.ctl.submit(draft));
  f.scope.open=false;
  await assert.rejects(f.ctl.submit(f.draft));
  assert.deepEqual(f.markers,[]);
  f.scope.open=true;
  const pending=f.ctl.submit(f.draft);
  f.ctl.close();
  await assert.rejects(pending);
  assert.deepEqual(f.calls,[]);
  assert.throws(()=>fixture({initialKey:'untrusted/path'}));
});
