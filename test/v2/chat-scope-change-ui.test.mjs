import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {acceptedChange,readChanges,recommendedTarget,reviewChange,submitReviewedChange} from '../../web/src/chat-context-change.ts';

function fixture() {
  const sql='SELECT 1 AS fictional_total';
  const binding={intentId:randomUUID(),taskId:randomUUID(),contextId:'holdings-t1',revisionId:randomUUID(),runId:randomUUID(),
    revisionHash:createHash('sha256').update(sql).digest('hex')};
  const source={id:binding.contextId,name:'原资产口径',definition:'全品类持仓和可用现金'};
  const target={id:'stock-cash-t1',name:'股票与现金',definition:'股票持仓加现金',recommended:true};
  const snapshot={protocol:'shuduo-chat-sql-changes/v1',binding,source,targets:[target],eligible:true,
    nextRequestId:'chat-derive-v1-'+'b'.repeat(64),changes:[]};
  const original={protocol:'shuduo-chat-sql-development/v1',binding,sql,taskStatus:'SUCCEEDED',runStatus:'SUCCEEDED',
    codeSource:'RECORDED_MODEL',engine:'Apache Spark',engineVersion:'3.5.9',testDouble:false,
    attempts:[{attempt:1,status:'SUCCEEDED',runId:binding.runId,revisionId:binding.revisionId}],
    validation:{state:'PASSED',contractId:'securities-assets-five-fixtures-2026-09-14',regressions:[{contextId:'holdings-t1',passed:true}]}};
  return {snapshot,original,sql};
}

test('the reviewed edit fixes the original version, target definition, user request and idempotency key',async()=>{
  const {snapshot,original,sql}=fixture(),calls=[];
  const api=async(path,body,options)=>{
    calls.push({path,body,options});
    if(path.endsWith('/changes')) return structuredClone(snapshot);
    if(path.endsWith('/development')) return original;
    assert.equal(path,'/agent/tasks');
    return {};
  };
  const {binding:b}=snapshot;
  const saved=await readChanges(api,b.intentId,b.taskId);
  const review=reviewChange(saved,'stock-cash-t1','  改为股票持仓与现金。 ');
  assert.equal(calls.length,1);assert.equal(calls[0].body,undefined);
  await submitReviewedChange(api,review,()=>true);
  const writes=calls.filter(c=>c.body);
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0].options,{idempotencyKey:snapshot.nextRequestId});
  assert.deepEqual(writes[0].body,{message:'改为股票持仓与现金。',sql,language:'SPARK_SQL',contextId:'stock-cash-t1',
    derivation:{kind:'REGISTERED_CONTEXT_CHANGE',taskId:b.taskId,runId:b.runId,revisionId:b.revisionId,revisionHash:b.revisionHash},chatChange:{intentId:b.intentId}});
  const entry={requestId:review.requestId,taskId:randomUUID(),contextId:review.target.id,message:review.message,status:'RUNNING'};
  snapshot.changes.push(entry);snapshot.nextRequestId=null;
  await submitReviewedChange(api,review,()=>true);
  assert.equal(calls.filter(c=>c.body).length,1);
  assert.deepEqual(acceptedChange(snapshot,review),entry);
  assert.throws(()=>acceptedChange(snapshot,{...review,message:'不同的修改说明'}));
});

test('stale source, target or request number, interrupted identity and a foreign child prevent a new POST',async()=>{
  const {snapshot,original}=fixture(),{binding:b}=snapshot,edit='仅统计股票持仓和现金';
  const review=reviewChange(snapshot,'stock-cash-t1',edit);
  const [target]=snapshot.targets;
  assert.equal(recommendedTarget([target]),target.id);
  assert.equal(recommendedTarget([target,{...target,id:'cash-change'}]),'');
  for(const corrupt of [
    s=>{s.binding.revisionHash='f'.repeat(64);},
    s=>{s.targets[0].definition='换成另一项已登记口径';},
    s=>{s.nextRequestId='chat-derive-v1-'+'d'.repeat(64);},
    s=>{s.targets.push({...s.targets[0]});},
    s=>{s.eligible=false;s.nextRequestId=null;},
    s=>{s.changes=[{taskId:b.taskId,requestId:review.requestId,contextId:b.contextId,message:edit,status:'RUNNING'}];}
  ]){
    const changed=structuredClone(snapshot);corrupt(changed);let writes=0;
    await assert.rejects(submitReviewedChange(async(path,body)=>{if(body)writes++;return path.endsWith('/changes')?changed:original;},review,()=>true));
    assert.equal(writes,0);
  }
  let writes=0;
  await submitReviewedChange(async(path,body)=>{if(body)writes++;return path.endsWith('/changes')?snapshot:original;},review,()=>false);
  assert.equal(writes,0);
});
