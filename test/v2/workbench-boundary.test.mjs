import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
let source=ts.transpileModule(readFileSync(new URL('../../web/src/WorkbenchBoundary.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
for(const dependency of ['react','react/jsx-runtime'])source=source.replaceAll(`from "${dependency}"`,`from ${JSON.stringify(import.meta.resolve(dependency))}`);
const {WorkbenchBoundary}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('component failure renders a recoverable message without exposing exception details or replaying tasks',()=>{
 const component=new WorkbenchBoundary({children:React.createElement('p',null,'normal')});
 assert.match(renderToStaticMarkup(component.render()),/normal/);
 component.state=WorkbenchBoundary.getDerivedStateFromError(new Error('private fixture details'));
 const html=renderToStaticMarkup(component.render());assert.match(html,/role="alert"/);assert.match(html,/工作台组件暂时未能加载/);assert.match(html,/不会自动重新提交任务/);assert.match(html,/尚未保存的输入/);assert(!html.includes('private fixture'));
 assert(!source.includes('setTimeout'));assert(!source.includes('fetch('));
});
