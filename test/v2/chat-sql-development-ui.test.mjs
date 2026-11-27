import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {readChatSqlDevelopment,recordChatSqlTakeover} from '../../web/src/chat-sql-development.ts';

function sample() {
  const sql="SELECT '客户 A' AS label\n";
  const binding={intentId:randomUUID(),taskId:randomUUID(),contextId:'holdings-t1',
    revisionId:randomUUID(),runId:randomUUID(),revisionHash:createHash('sha256').update(sql).digest('hex')};
  return {protocol:'shuduo-chat-sql-development/v1',binding,sql,codeSource:'SYNTHETIC_MODEL',taskStatus:'SUCCEEDED',runStatus:'SUCCEEDED',
    engine:'Apache Spark',engineVersion:'3.5.9',testDouble:false,
    attempts:[{attempt:1,status:'VALIDATION_FAILED',revisionId:randomUUID(),runId:randomUUID(),failedChecks:['同一证券多笔持仓']},
      {attempt:2,status:'SUCCEEDED',revisionId:binding.revisionId,runId:binding.runId}],
    validation:{state:'PASSED',contractId:'synthetic-assertions',
      regressions:[{contextId:'duplicate-position',passed:true},{contextId:'cash-only-client',passed:true}]}};
}

test('the chat reads one intent and checks the exact SQL bytes, last attempt and expected editor binding',async()=>{
  const result=sample(),paths=[];
  const api=async path=>{paths.push(path);return result;};
  assert.deepEqual(await readChatSqlDevelopment(api,result.binding.intentId,result.binding),result);
  assert.deepEqual(paths,['/agent/intents/'+result.binding.intentId+'/development']);
  await assert.rejects(readChatSqlDevelopment(api,result.binding.intentId,{...result.binding,revisionId:randomUUID()}));
  for(const changed of [
    {...result,sql:result.sql.trim()},
    {...result,attempts:[...result.attempts].reverse()},
    {...result,binding:{...result.binding,intentId:randomUUID()}},
    {...result,validation:{...result.validation,regressions:[{contextId:'cash-only-client',passed:false}]}},
    {...result,protocol:'unknown'},
  ]) await assert.rejects(readChatSqlDevelopment(async()=>changed,result.binding.intentId));
  await assert.rejects(readChatSqlDevelopment(api,'unbound'));
});

test('taking over checks this version, records the manual step only once and reconciles an unknown receipt',async()=>{
  const evidence=sample(),binding=evidence.binding;
  const handoffs='/agent/intents/'+binding.intentId+'/handoffs';
  const receipt={id:randomUUID(),intentId:binding.intentId,destinationId:'development',status:'HANDED_OFF'};
  const calls=[];
  const api=async(path,body,options)=>{
    if(path.endsWith('/development'))return evidence;
    assert.equal(path,handoffs);
    if(body){
      assert.deepEqual(body,{destinationId:'development'});
      assert.equal(options.idempotencyKey,'chat-editor-'+binding.intentId);
      calls.push('POST');throw Error('unknown response');
    }
    calls.push('GET');return [{...receipt,specialistTaskId:binding.taskId},receipt];
  };
  assert.equal(await recordChatSqlTakeover(api,binding,()=>true),true);
  assert.deepEqual(calls,['POST','GET']);
  assert.equal(await recordChatSqlTakeover(api,binding,()=>false),false);
  await assert.rejects(recordChatSqlTakeover(api,{...binding,runId:randomUUID()},()=>true));
  assert.deepEqual(calls,['POST','GET']);
  await assert.rejects(recordChatSqlTakeover(async(path,body)=>{
    if(path.endsWith('/development'))return evidence;
    if(body)return {};
    return [{...receipt,specialistTaskId:binding.taskId},{...receipt,intentId:randomUUID()}];
  },binding,()=>true),/人工接管记录尚未确认/);
});

let source=ts.transpileModule(readFileSync('web/src/ChatSqlDevelopment.tsx','utf8'),{
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
for(const pkg of ['react','react/jsx-runtime','lucide-react']) {
  source=source.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`)
    .replaceAll(`from '${pkg}'`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
}
for(const file of ['agent-chat-editor-location','chat-sql-development']){
  const to=JSON.stringify(new URL('../../web/src/'+file+'.ts',import.meta.url).href);
  source=source.replaceAll(`from './${file}'`,`from ${to}`).replaceAll(`from "./${file}"`,`from ${to}`);
}
source=source.replace(/import ['"]\.\/chat-sql-development\.css['"];/,'');
const {SqlDevelopmentResult}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('the evidence card displays the stored query, both attempts and the saved assertion outcomes',()=>{
  const evidence=sample();
  const render=evidence=>renderToStaticMarkup(React.createElement(SqlDevelopmentResult,{evidence}));
  const html=render(evidence);
  for(const label of ['SELECT','客户 A','3.5.9','测试模型','第 1 次 · 校验失败','第 2 次 · 成功','同一证券多笔持仓','duplicate-position','cash-only-client',
    evidence.binding.revisionId,evidence.binding.runId]) assert.ok(html.includes(label),label);
  assert.match(render({...evidence,testDouble:true}),/使用测试执行器/);
  const failed=render({...evidence,runStatus:'VALIDATION_FAILED',testDouble:null,
    validation:{state:'FAILED',contractId:'fixture',regressions:[{contextId:'cash-change',passed:false}]}});
  assert.match(failed,/未通过/);assert.match(failed,/执行来源未确认/);
  assert.match(render({...evidence,validation:{state:'UNCONFIRMED',contractId:null,regressions:[]}}),/结果待核对/);
});
