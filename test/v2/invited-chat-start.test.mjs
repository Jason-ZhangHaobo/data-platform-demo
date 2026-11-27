import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {invitedChatScreen,invitedChatStartLocation,invitedPendingRequest,invitedStartReason,invitedWindowTaskLocation} from '../../web/src/invited-chat-start.ts';

const now=Date.now(),iso=offset=>new Date(now+offset).toISOString();
const allowed={developmentOnly:true,taskOnly:false,requestOnly:false,canWrite:true,ready:true,
  startsAt:iso(-1000),expiresAt:iso(1000),sessionExpiresAt:iso(5000),backgroundAvailable:true,contexts:[]};

test('native Agent chat creation requires an effective ordinary invitation and a ready background driver',()=>{
  assert.equal(invitedStartReason(true,allowed,now),undefined);
  assert.ok(invitedStartReason(false,allowed,now));
  for(const change of [{developmentOnly:false},{taskOnly:true},{requestOnly:true},{canWrite:false},{ready:false},
    {startsAt:undefined},{startsAt:iso(1)},{expiresAt:iso(0)},{sessionExpiresAt:iso(-1)},
    {backgroundAvailable:false},{used:true},{windowTaskId:randomUUID()}]) {
    assert.ok(invitedStartReason(true,{...allowed,...change},now));
  }
});

test('native drafts, planning history and request recovery keep distinct navigation',()=>{
  const origin='https://example.invalid/v2/';
  const draft=invitedChatStartLocation(origin),planning=invitedChatStartLocation(origin,true);
  assert.equal(invitedChatScreen(draft.href,true),'start');
  assert.equal(invitedChatScreen(draft.href,false),undefined);
  assert.equal(invitedChatScreen(planning.href,true),undefined);
  const request=randomUUID();
  draft.searchParams.set('agent_request',request);
  assert.equal(invitedPendingRequest(draft.href),request);
  const used=invitedWindowTaskLocation(draft.href,randomUUID());
  assert.deepEqual([...used.searchParams.keys()],['module','task']);
  assert.equal(invitedPendingRequest(used.href),undefined);
  assert.equal(invitedWindowTaskLocation(draft.href,'unconfirmed'),undefined);
  assert.equal(invitedChatScreen(draft.href,false),'start');
  assert.equal(invitedPendingRequest(planning.href),undefined);
  for(const change of [url=>url.searchParams.set('task',randomUUID()),url=>url.searchParams.set('chat_intent',randomUUID()),
    url=>url.searchParams.append('agent_request',request),url=>url.searchParams.delete('module'),url=>url.searchParams.set('agent_request','')]){
    const mixed=new URL(draft.href);change(mixed);
    assert.equal(invitedPendingRequest(mixed.href),null);
  }
});
