import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {lifecycleReport,frozenEvidence,lifecycleOutcome} from './lifecycle-fixtures.mjs';
let source=ts.transpileModule(readFileSync(new URL('../../web/src/LifecycleEvaluationPanel.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
for(const name of ['react/jsx-runtime','lucide-react'])source=source.replaceAll(`from "${name}"`,`from ${JSON.stringify(import.meta.resolve(name))}`);
const {LifecycleEvaluationPanel}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const render=props=>renderToStaticMarkup(React.createElement(LifecycleEvaluationPanel,props));
test('actual evaluation panel shows incomplete denominator and preserves failure-stage detail',()=>{
 const outcomes=frozenEvidence.cases.slice(0,2).map(lifecycleOutcome);outcomes[0].stages.postReleaseMonitoring.status='FAILED';
 const html=render({report:lifecycleReport(outcomes)});
 assert.match(html,/5%/);assert.match(html,/固定20例为分母/);assert.match(html,/未通过1例/);assert.match(html,/未执行18例/);
 assert.match(html,/评测尚未完成/);assert.match(html,/上线后监控/);assert.match(html,/Agent完整E2E：待验收/);
 assert(!html.includes('本机回放门槛通过'));
});
test('verified local replay is disclosed; read failure and loading hide even a previous passing report',()=>{
 const report=lifecycleReport(),html=render({report});assert.match(html,/本机回放门槛通过/);assert.match(html,/复用历史模型代码/);
 for(const props of [{report,error:'报告证据不一致'},{report,loading:true}])assert(!render(props).includes('本机回放门槛通过'));
 assert.match(render({report,error:'报告证据不一致'}),/role="alert"/);
});
