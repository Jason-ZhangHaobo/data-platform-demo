import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {component} from './fixtures/delivery-component.mjs';
import {changeFromLocation,changeLocation,chatConsumptionLocation,consumptionFromLocation} from '../../web/src/chat-context-change.ts';

const Result=await component('ChatBatchConsumptionResult');
const Monitor=await component('ChatPublicationEvidence','ChatPublicationMonitor');
const render=(type,props)=>renderToStaticMarkup(React.createElement(type,props));

test('a batch link retains the original conversation and change; another change clears the selection',()=>{
  const intent=randomUUID(),change='chat-derive-v1-'+'a'.repeat(64),other='chat-derive-v1-'+'b'.repeat(64),batch=randomUUID();
  const link=chatConsumptionLocation('http://127.0.0.1/v2/?module=agent-center#agent-chat',intent,change,batch);
  assert.equal(changeFromLocation(link.href,intent),change);
  assert.equal(consumptionFromLocation(link.href,intent,change),batch);
  assert.equal(consumptionFromLocation(changeLocation(link.href,intent,other).href,intent,other),undefined);
  assert.equal(consumptionFromLocation(link.href,intent,other),null);
  assert.equal(consumptionFromLocation(link.href,randomUUID(),change),null);
  assert.equal(consumptionFromLocation(chatConsumptionLocation(link.href,intent,change).href,intent,change),undefined);
  for(const invalid of [q=>q.append('chat_consumption',batch),q=>q.set('chat_consumption','invalid'),
    q=>q.delete('chat_change'),q=>q.delete('chat_intent')]){
    const corrupt=new URL(link);invalid(corrupt.searchParams);
    assert.equal(consumptionFromLocation(corrupt.href,intent,change),null);
    if(!corrupt.searchParams.has('chat_change'))assert.equal(changeFromLocation(corrupt.href,intent),null);
  }
});

test('the monitor offers batch-specific reads only for a verified publication',()=>{
  const runs=[1,2].map(sequence=>({id:randomUUID(),sequence,status:'SUCCEEDED',schedulerTriggered:true,
    scheduledTriggerAt:'2026-11-26T09:00:00Z',triggeredAt:'2026-11-26T09:00:01Z'}));
  const receipt={release:{id:randomUUID()},source:{},runs,events:[],alerts:[],monitoringVerified:true};
  const html=render(Monitor,{value:receipt,onChooseBatch:()=>{},selectedBatchId:runs[1].id});
  assert.match(html,/查看第 1 批接口消费/);assert.match(html,/收起第 2 批接口消费/);
  assert.match(html,new RegExp('id="chat-consumption-open-'+runs[1].id+'" aria-expanded="true"'));
  assert.doesNotMatch(render(Monitor,{value:{...receipt,monitoringVerified:false},onChooseBatch:()=>{}}),/批接口消费/);
});

test('batch consumption shows exact calls, pages, grants and XAPI components without inventing a cash DAPI call',()=>{
  const ref=(name,fields)=>({serviceId:name+'-id',versionId:name+'-version',configHash:'a'.repeat(64),sourceReleaseRunId:'batch-1',fields});
  const holdings=ref('holdings',['client_id','holding_market_value']),cash=ref('cash',['client_id','available_cash']);
  const entry=(source,name)=>({...source,serviceType:'DAPI',name,slug:source.serviceId,versionNumber:3,versionStatus:'PUBLISHED',sourceVersions:[source]});
  const call={finishedAt:'2026-11-27T04:05:06Z',rowCount:1,callIdDigest:'b'.repeat(64),resultHash:'c'.repeat(64),
    applicationId:'app-original',applicationStatus:'REVOKED'};
  const pagination={status:'COMPLETE',pageSize:1,totalPages:2,verifiedPages:[1,2],applicationId:'app-original',applicationStatus:'REVOKED'};
  const group={serviceType:'XAPI',name:'资产组合',slug:'combined',versionId:'combo-version',versionNumber:1,versionStatus:'PUBLISHED',
    sourceVersions:[holdings,cash],serviceId:'combined-id',configHash:'f'.repeat(64),call,pagination};
  const matched={status:'MATCHED_ONLY',truncated:false,services:[{...entry(holdings,'持仓查询'),call,pagination},
    {...entry(cash,'现金查询'),versionStatus:'RETIRED'},group]};
  const html=render(Result,{receipt:matched});
  assert.match(html,/本批消费记录已匹配/);assert.match(html,/GET \/api\/v2\/open\/xapis\/combined/);
  assert.match(html,/持仓市值/);assert.match(html,/可用现金/);assert.match(html,/历史版本/);
  assert.doesNotMatch(html,/GET \/api\/v2\/open\/dapis\/cash-id/);
  assert.match(html,/已被组合 XAPI 引用。暂无本版本已核对的成功直调记录/);
  assert.equal(html.split('本次返回 1 行').length-1,2);
  assert.equal(html.split('应用已撤销，历史记录保留').length-1,2);
  assert.equal(html.split('已齐备 · 2/2 页').length-1,2);
  const partial=render(Result,{receipt:{...matched,status:'PENDING',truncated:true,services:[{...group,
    pagination:{...pagination,applicationId:'second-grant',applicationStatus:'EXPIRED',verifiedPages:[1],status:'INCOMPLETE'}}]}});
  assert.match(partial,/证据待补齐/);assert.match(partial,/部分已核对 · 1\/2 页/);assert.match(partial,/应用已到期/);
  assert.match(partial,/记录超过查询上限/);assert.doesNotMatch(partial,/本批消费记录已匹配/);
  assert.match(render(Result,{receipt:{status:'PENDING',truncated:false,services:[]}}),/尚未找到绑定本批结果的已发布接口版本/);
});
