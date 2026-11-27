import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {component} from './fixtures/delivery-component.mjs';
import {invitedTaskSelection,invitedEditorSource,invitedEditorLocation,clearInvitedEditorSource} from '../../web/src/invited-task-location.ts';

const selection={taskId:randomUUID(),requestId:randomUUID()};
const source={...selection,contextId:'stock-cash-t1',revisionId:randomUUID(),revisionHash:'a'.repeat(64),runId:randomUUID()};
const origin='https://example.invalid/v2/';

test('the native task survives a cold invitation link, with its own optional request, SQL and run references',()=>{
  const plain=invitedEditorLocation(origin,selection);
  assert.deepEqual(invitedTaskSelection(plain.href),selection);
  assert.equal(invitedEditorSource(plain.href),undefined);
  const linked=invitedEditorLocation(origin+'?chat_intent=another#agent-chat',selection,source);
  assert.equal(linked.searchParams.has('chat_intent'),false);
  assert.deepEqual(invitedEditorSource(linked.href),source);
  assert.equal(linked.hash,'#agent-code');
  linked.hash='agent-chat';
  assert.deepEqual(invitedTaskSelection(linked.href),selection);
  assert.deepEqual(invitedEditorSource(linked.href),source);
  assert.throws(()=>invitedEditorLocation(origin,{...selection,requestId:'different'},source));
  assert.equal(clearInvitedEditorSource(linked).searchParams.get('task'),selection.taskId);
  assert.equal(invitedEditorSource(linked.href),undefined);
});

test('a mixed or partial native editor link cannot be mistaken for a normal task-only selection',()=>{
  for(const corrupt of [q=>q.delete('invited_revision'),q=>q.set('invited_hash','old'),
    q=>q.set('save_request',randomUUID()),q=>q.set('chat_intent',randomUUID()),
    q=>q.append('task',randomUUID()),q=>q.set('invited_run',''),q=>q.set('module','development')]){
    const url=invitedEditorLocation(origin,selection,source);
    corrupt(url.searchParams);
    assert.equal(invitedTaskSelection(url.href),null);
    assert.equal(invitedEditorSource(url.href),null);
  }
});

const Evidence=await component('InvitedTaskChat','InvitedTaskEvidence');
const markup=value=>renderToStaticMarkup(createElement(Evidence,{value}));
const pending={message:'统计虚构账户的可用现金',contextId:source.contextId,taskStatus:'QUEUED',attemptCount:0,
  evidenceState:'PENDING',evidenceSource:'UNCONFIRMED'};
const recorded={...pending,evidenceState:'RECORDED',evidenceSource:'STORED_METADATA',taskStatus:'SUCCEEDED',
  revision:{id:source.revisionId,hash:source.revisionHash,sql:'SELECT cash FROM balances'},
  run:{id:source.runId,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'4',
    validation:{state:'PASSED',contractId:'cash',regressions:[{contextId:source.contextId,passed:true}]}}};

test('the evidence panel renders the persisted request and SQL, identifying the exact revision and run',()=>{
  const html=markup(recorded);
  for(const text of [pending.message,recorded.revision.sql,source.revisionId,source.runId,'Apache Spark','核验结果','通过'])assert.ok(html.includes(text));
  const waiting=markup(pending);
  assert.match(waiting,/任务尚在推进/);
  assert.doesNotMatch(waiting,/已保存的 SQL|运行批次|核验结果|通过/);
  const unknown=markup({...pending,evidenceState:'UNCONFIRMED'});
  assert.match(unknown,/原版本和运行依据尚待核对/);
});

test('an unconfirmed test-harness receipt discloses its source beside the run and assertion result',()=>{
  const html=markup({...recorded,evidenceSource:'TEST_HARNESS',
    run:{...recorded.run,validation:{...recorded.run.validation,state:'UNCONFIRMED',regressions:[]}}});
  assert.match(html,/测试执行记录/);
  assert.match(html,/核验结果<\/dt><dd>待核对/);
  assert.doesNotMatch(html,/核验结果<\/dt><dd>通过/);
});
