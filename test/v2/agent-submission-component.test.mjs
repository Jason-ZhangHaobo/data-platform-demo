import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
let source=ts.transpileModule(readFileSync(new URL('../../web/src/AgentSubmissionRecovery.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
for(const name of ['react/jsx-runtime','lucide-react'])source=source.replaceAll(`from "${name}"`,`from ${JSON.stringify(import.meta.resolve(name))}`);
const {AgentSubmissionRecovery}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const props={requestKey:'11111111-1111-4111-8111-111111111111',recoveryHref:'http://127.0.0.1:3100/v2/?module=agent-center&agent_request=11111111-1111-4111-8111-111111111111',busy:false,onRead:()=>{throw Error('render must not read');},onRetry:()=>{throw Error('render must not write');}};
test('reloaded recovery only offers a read, and discloses that source is not stored in the URL',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentSubmissionRecovery,{...props,canRetry:false}));
 assert.match(html,/查询原任务/);assert.match(html,/未保存的需求和代码无法从链接找回/);assert(!html.includes('按原内容、原编号重试'));
 assert.match(html,/noopener noreferrer/);assert.match(html,/原创建账号/);
});
test('the original page can explicitly retry frozen content, and both controls lock while busy',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentSubmissionRecovery,{...props,canRetry:true,busy:true}));
 assert.match(html,/按原内容、原编号重试/);assert.match(html,/不使用当前的新修改/);assert.equal((html.match(/disabled=""/g)??[]).length,2);
});
