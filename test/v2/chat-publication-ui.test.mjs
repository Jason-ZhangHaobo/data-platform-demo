import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {component} from './fixtures/delivery-component.mjs';

const Review=await component('ChatPublicationEvidence','ChatPublicationReview');
const Monitor=await component('ChatPublicationEvidence','ChatPublicationMonitor');
const value={
  source:{revisionId:'stock-revision',runId:'stock-code-run'},packageDigest:'package-hash',reviewDigest:'review-hash',
  verificationId:'rehearsal',businessDate:'2026-09-10',scheduleSpec:{triggerAfterSeconds:5,intervalSeconds:30,runCount:2},
  canPublish:true,
};
const all={code:true,assertions:true,deliveryFiles:true,localScope:true};
const render=(type,props)=>renderToStaticMarkup(React.createElement(type,props));

test('the derived package review starts unchecked and requires all four confirmations for its exact local scope',()=>{
  const form=(checked,extra={})=>render(Review,{value,checked,busy:false,...extra});
  const initial=form({});
  for(const field of ['stock-revision','stock-code-run','rehearsal','package-hash','review-hash','2026-09-10','确认测试发布范围'])assert.ok(initial.includes(field));
  assert.equal([...initial.matchAll(/type="checkbox"/g)].length,4);
  assert.doesNotMatch(initial,/checked=""/);
  const disabled=/disabled="">确认并发布两批本机测试/;
  assert.match(initial,disabled);
  assert.match(form({...all,assertions:false}),disabled);
  assert.match(form(all,{value:{...value,canPublish:false}}),disabled);
  assert.doesNotMatch(form(all),disabled);
  assert.match(form(all,{busy:true}),/disabled="">正在登记发布/);
});

test('the two-batch monitor separates waiting, unknown outcomes and verified records',()=>{
  const first={id:'batch-one',sequence:1,status:'SUCCEEDED',schedulerTriggered:true,triggeredAt:'2026-11-27T01:20:00Z',
    scheduledTriggerAt:'2026-11-27T01:20:00Z',finishedAt:'2026-11-27T01:20:01Z',engine:'Apache Spark',engineVersion:'3.5.9',
    assertionCount:5,rowCount:2,totalAssets:'2250.00'};
  const second={id:'batch-two',sequence:2,status:'SCHEDULED',schedulerTriggered:false,scheduledTriggerAt:'2026-11-27T01:20:30Z'};
  const record={...value,phase:'PUBLISHED',reviewId:'review-id',reviewActorScope:'LOCAL_DEVELOPER',approvalId:'approval-id',release:{id:'local-release'},runs:[first,second],
    events:[{id:'event-one',type:'BATCH_SUCCEEDED',releaseRunId:first.id,observedAt:first.finishedAt}],alerts:[],monitoringVerified:false};
  const waiting=render(Monitor,{value:record});
  assert.match(waiting,/两批测试进行中/);assert.match(waiting,/等待调度/);assert.match(waiting,/实际触发/);
  assert.ok(waiting.includes('2250.00'));assert.match(waiting,/第 1 批 · 批次成功/);assert.match(waiting,/发布编号/);
  assert.match(waiting,/本机开发者/);
  assert.equal([...waiting.matchAll(/口径内资产合计/g)].length,1);
  const unconfirmed=render(Monitor,{value:{...record,runs:[first,{...second,status:'FAILED',resultUnknown:true,totalAssets:'1111.99'}],
    alerts:[{id:'open-alert',status:'OPEN',releaseRunId:second.id}]}});
  assert.match(unconfirmed,/执行结果待核对/);assert.match(unconfirmed,/开放告警 1 条/);assert.doesNotMatch(unconfirmed,/1111.99|两批运行与监控已核验/);
  const finished=render(Monitor,{value:{...record,runs:[first,{...first,id:second.id,sequence:2}],
    events:[...record.events,{...record.events[0],id:'event-two',releaseRunId:second.id}],monitoringVerified:true}});
  assert.match(finished,/两批运行与监控已核验/);assert.equal([...finished.matchAll(/口径内资产合计/g)].length,2);
});
