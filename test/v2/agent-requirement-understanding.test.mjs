import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sqlRequirementReport,bindSqlRequirementRevision} from '../../src/v2/sql-requirements.mjs';
import {getContext} from '../../src/v2/context.mjs';
import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';
let source=ts.transpileModule(readFileSync('web/src/AgentRequirementUnderstanding.tsx','utf8'),{
 compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
for(const dependency of ['react','react/jsx-runtime','lucide-react','../../src/v2/sql-requirement-contract.mjs','../../src/v2/output-contract-metadata.mjs','../../src/v2/fund-requirement-contract.mjs'])
 source=source.replaceAll(`from '${dependency}'`,`from ${JSON.stringify(import.meta.resolve(dependency))}`).replaceAll(`from "${dependency}"`,`from ${JSON.stringify(import.meta.resolve(dependency))}`);
const {AgentRequirementUnderstanding}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function fixture(clarification=false,contextId='stock-cash-t1'){
 const input={message:'虚构证券资产需求',context:getContext(contextId)},generated={model:'TEST_DOUBLE',...syntheticSqlRequirement(input,{clarification})},
 task={id:'task-a',message:input.message,contextId:input.context.id,language:'SPARK_SQL',revisionId:clarification?undefined:'revision-a',attempts:[{attempt:1,model:generated.model,revisionId:clarification?undefined:'revision-a'}]};
 let requirements=sqlRequirementReport({task,...input,generated,attempt:1});if(!clarification)requirements=bindSqlRequirementRevision(requirements,{id:'revision-a',hash:'a'.repeat(64)});
 return {...task,requirements};
}
test('requirement UI shows model interpretation, source fields, constraints and version as a proposal',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task:fixture(),dirty:false}));
 for(const label of ['可审阅提案','每个客户 × 交易日','positions.market_value','仅统计股票持仓','不等于执行通过','非客户全资产'])assert.ok(html.includes(label),label);
 assert.doesNotMatch(html,/<button|<input|<form| open=""/);
 const edited=renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task:fixture(),dirty:true}));assert.match(edited,/仅对应原保存版本/);
});
test('clarification opens one question; invalid/old/unrelated records never become understanding success',()=>{
 const task=fixture(true),html=renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task,dirty:false}));
 assert.match(html,/open=""/);assert.match(html,/先确认一个问题/);assert.match(html,/没有执行 SQL/);
 for(const changed of [{...fixture(),id:'other'},{...fixture(),requirements:{basis:{}}}]){
  const bad=renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task:changed,dirty:false}));assert.match(bad,/未确认/);assert.doesNotMatch(bad,/可审阅提案/);
 }
 const old=fixture();delete old.requirements;assert.match(renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task:old,dirty:false})),/旧任务不补造模型理解/);
 assert.equal(renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task:{...old,language:'PYTHON'},dirty:false})), '');
});

test('distribution understanding shows the composite grain, all six outputs and holding-only denominator',()=>{
 for(const id of ['holdings-asset-class-t1','holdings-industry-t1']){
  const task=fixture(false,id),html=renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task,dirty:false}));
  assert.match(html,/每个客户 × 交易日 ×/);assert.match(html,id.includes('industry')?/行业标签/:/资产类别/);
  assert.match(html,/不含现金/);assert.match(html,/六位小数/);assert.match(html,/market_value|持仓市值/);assert.doesNotMatch(html,/记录与原任务、口径或代码版本未确认/);
 }
});
