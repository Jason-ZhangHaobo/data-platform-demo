import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatEditorLocation,chatEditorSource,clearChatEditorSource} from '../../web/src/agent-chat-editor-location.ts';
import {manualSaveLocation,manualRunLocation} from '../../web/src/manual-run-recovery.ts';

const source={intentId:randomUUID(),taskId:randomUUID(),contextId:'stock-cash-t1',
  revisionId:randomUUID(),runId:randomUUID(),revisionHash:'a'.repeat(64)};
const origin='https://example.invalid/v2/';

test('a chat editor link carries just the exact task, context, code and run references',()=>{
  const target=chatEditorLocation(origin+'?module=services&chat_intent=old&save_request=old#agent-chat',source);
  assert.equal(target.pathname,'/v2/');
  assert.equal(target.hash,'#agent-code');
  assert.deepEqual(chatEditorSource(target.href),source);
  for(const key of ['chat_intent','save_request'])assert.equal(target.searchParams.has(key),false);
  assert.equal(chatEditorSource(origin+'?module=agent-center&task='+source.taskId),undefined);
  assert.throws(()=>chatEditorLocation(origin,{...source,revisionHash:'invalid'}));
});

test('partial, mixed and duplicate editor links cannot be used as ordinary task links',()=>{
  for (const change of [
    q=>q.delete('chat_editor'), q=>q.delete('task'), q=>q.append('chat_run',source.runId),
    q=>q.set('chat_hash','x'), q=>q.set('module','development'), q=>q.set('chat_context',''),
    q=>q.set('save_request',randomUUID()), q=>q.set('derive_task',randomUUID()),
  ]) {
    const url=chatEditorLocation(origin,source);
    change(url.searchParams);
    assert.equal(chatEditorSource(url.href),null);
  }
});

test('a human save and run switch to their own recovery links, retaining the original Agent task',()=>{
  const entry=chatEditorLocation(origin,source);
  const saveKey=randomUUID();
  const save=clearChatEditorSource(manualSaveLocation(entry.href,saveKey,source.taskId));
  assert.equal(chatEditorSource(save.href),undefined);
  assert.equal(save.searchParams.get('save_request'),saveKey);
  const revisionId=randomUUID(),runId=randomUUID();
  const run=clearChatEditorSource(manualRunLocation(entry.href,{revisionId,runId,originTaskId:source.taskId}));
  assert.equal(chatEditorSource(run.href),undefined);
  assert.equal(run.searchParams.get('origin_task'),source.taskId);
  assert.equal(run.searchParams.get('revision'),revisionId);
  assert.equal(run.searchParams.get('run'),runId);
});
