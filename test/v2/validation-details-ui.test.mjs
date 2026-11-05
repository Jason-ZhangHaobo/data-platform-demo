import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {validationDetailsView,validationMismatchCells} from '../../web/src/validation-details.ts';

let source=ts.transpileModule(readFileSync('web/src/ValidationDetails.tsx','utf8'),{
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
for(const pkg of ['react','react/jsx-runtime'])source=source.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
source=source.replaceAll('from "./validation-details"',`from ${JSON.stringify(new URL('../../web/src/validation-details.ts',import.meta.url).href)}`);
source=source.replace('import "./validation-details.css";','');
const {ValidationDetails,ValidationResultScope}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const expectedSource={runId:'synthetic-run',revisionId:'synthetic-revision',revisionHash:'a'.repeat(64),contextId:'stock-cash-t1',contractId:'synthetic-contract'};
const precise='9876543210.012345678901234567';
function fixture(){return {
  schema:'shuduo-validation-details/v1',status:'AVAILABLE',source:{...expectedSource},
  scenarios:[
    {contextId:'stock-cash-t1',name:'标准场景',passed:true,detailsStatus:'AVAILABLE',mismatches:[],totalMismatches:0,truncated:false},
    {contextId:'stock-cash-duplicate-position',name:'重复持仓',passed:false,detailsStatus:'AVAILABLE',mismatches:[
      {kind:'VALUE_MISMATCH',clientId:'CLIENT-001',field:'holding_market_value',expected:'1000.00',actual:precise},
    ],totalMismatches:1,truncated:false},
  ],
};}
const render=(details=fixture(),props={})=>renderToStaticMarkup(React.createElement(ValidationDetails,{details,expectedSource,...props}));

test('actual component displays per-scenario saved differences without rounding decimal evidence',()=>{
  const details=fixture(),before=structuredClone(details),html=render(details);
  assert.match(html,/重复持仓/);assert.match(html,/stock-cash-duplicate-position/);
  assert.match(html,/独立预期/);assert.match(html,/实际执行/);assert.match(html,/CLIENT-001/);
  assert.match(html,/1000\.00/);assert.ok(html.includes(precise));
  assert.match(html,/不是当前结果表的复制/);assert.match(html,/synthetic-run/);
  assert.equal((html.match(/<details /g)||[]).length,1,'only the failed scenario gets an expanded difference card');
  assert.match(html,/<details[^>]*open=""/);assert.doesNotMatch(html,/<button|<input|<form|<script|href=/);
  assert.deepEqual(details,before,'render cannot mutate passed status or saved evidence');
});

test('invalid security counts remain visible as finite actual values while expected counts must be nonnegative integers',()=>{
  for(const actual of ['-1','1.5']){
    const details=fixture();details.scenarios[1].mismatches=[{kind:'VALUE_MISMATCH',clientId:'CLIENT-001',field:'security_count',expected:'1',actual}];
    const html=render(details);
    assert.match(html,/证券数量/);assert.ok(html.includes(`<td>${actual}</td>`));assert.match(html,/<td>1<\/td>/);
    assert.doesNotMatch(html,/差异明细尚未核对/);
  }
  for(const expected of ['-1','1.5']){
    const details=fixture();details.scenarios[1].mismatches=[{kind:'VALUE_MISMATCH',clientId:'CLIENT-001',field:'security_count',expected,actual:'2'}];
    assert.match(render(details),/差异明细尚未核对/);assert.doesNotMatch(render(details),/<table/);
  }
});

test('different selection or missing source prevents all numbers from reaching the rendered view',()=>{
  for(const patch of [{runId:'different-run'},{revisionId:'different-revision'},{contextId:'holdings-t1'},{revisionHash:'b'.repeat(64)},{contractId:'other-contract'},{revisionId:undefined}]){
    const html=render(fixture(),{expectedSource:{...expectedSource,...patch}});
    assert.match(html,/来源或格式尚未核对/);assert.equal(html.includes(precise),false);assert.doesNotMatch(html,/1000\.00|CLIENT-001|<table/);
  }
});

test('legacy and unverified receipts never backfill a comparison using current rows',()=>{
  for(const details of [undefined,null,{...fixture(),status:'LEGACY_UNAVAILABLE'}]){
    const html=render(details===undefined?null:details);
    assert.match(html,/该历史批次未保存差值/);assert.doesNotMatch(html,/<table|1000\.00/);
  }
  for(const details of [{...fixture(),status:'UNVERIFIED'},{...fixture(),schema:'other'}, {...fixture(),source:{...expectedSource,revisionHash:'short'}}]){
    const html=render(details);assert.match(html,/来源或格式尚未核对/);assert.equal(html.includes(precise),false);
  }
});

test('invalid scenario contents suppress values instead of partially trusting a malformed table',()=>{
  for(const alter of [
    row=>row.detailsStatus='INVALID',row=>row.mismatches[0].actual='not a number',
    row=>row.mismatches[0].expected='Infinity',row=>row.mismatches[0].actual='1'.repeat(39),
    row=>row.mismatches[0].actual='0.'+'1'.repeat(19),row=>row.mismatches[0].field='arbitrary_secret',
    row=>row.mismatches[0].kind='UNTRUSTED',row=>row.mismatches[0].actualCount=1001,
    row=>row.mismatches[0].actualCount=-1,row=>row.totalMismatches=0,
    row=>row.mismatches=Array(21).fill(row.mismatches[0]),
  ]){
    const details=fixture();alter(details.scenarios[1]);const html=render(details);
    assert.match(html,/此场景的差异明细尚未核对/);assert.doesNotMatch(html,/<table|1000\.00|arbitrary_secret/);assert.equal(html.includes(precise),false);
  }
});

test('count and invalid-value displays are bounded and never echo raw values or out-of-scope identifiers',()=>{
  const details=fixture();details.scenarios[1].mismatches=[
    {kind:'INVALID_VALUE',clientId:'CLIENT-001',field:'available_cash',expected:'300.00',raw:'RAW_SECRET_MARKER'},
    {kind:'MISSING_CLIENT',clientId:'CLIENT-004'},
    {kind:'DUPLICATE_CLIENT',clientId:'CLIENT-001',expectedCount:1,actualCount:2},
    {kind:'CLIENT_COUNT',expectedCount:2,actualCount:3},
    {kind:'OUT_OF_SCOPE_CLIENTS',actualCount:1,raw:'FOREIGN_CLIENT_SECRET'},
    {kind:'OUTPUT_FIELDS',expectedCount:5,actualCount:6},
  ];details.scenarios[1].totalMismatches=6;
  const html=render(details);
  for(const text of ['无效数值','未返回该客户','客户记录重复','2 条','范围外记录（不展示标识）','5 个字段'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/RAW_SECRET_MARKER|FOREIGN_CLIENT_SECRET/);
  details.scenarios[1].mismatches[4].clientId='FOREIGN-ID';
  assert.match(render(details),/此场景的差异明细尚未核对/);
  assert.equal(validationMismatchCells({kind:'VALUE_MISMATCH',expected:precise,actual:'0'}).expected,precise);
});

test('truncation, unsaved drafts and historical reports remain visible limitations',()=>{
  const details=fixture();details.scenarios[1].totalMismatches=35;details.scenarios[1].truncated=true;
  const html=render(details,{dirty:true,historical:true});
  assert.match(html,/展示 1 \/ 35 项/);assert.match(html,/不代表完整明细/);
  assert.match(html,/不代表当前草稿/);assert.match(html,/不是当前编辑版本的核验结论/);
  assert.ok(html.includes(precise),'saved evidence is visible only with the explicit stale-draft warning');
  details.scenarios[1].detailsStatus='LEGACY_UNAVAILABLE';
  const legacy=render(details);assert.match(legacy,/该历史批次未保存差值/);assert.equal(legacy.includes(precise),false);
});

test('scenario envelope is bounded and does not grant success for empty or inconsistent evidence',()=>{
  for(const alter of [d=>d.scenarios=[],d=>d.scenarios=Array(6).fill(d.scenarios[0]),d=>d.scenarios.push({...d.scenarios[0]})]){
    const details=fixture();alter(details);assert.equal(validationDetailsView(details,expectedSource).status,'UNVERIFIED');
  }
  const details=fixture();details.scenarios[1].passed=true;
  assert.equal(validationDetailsView(details,expectedSource).scenarios[1].detailsStatus,'INVALID');
  assert.doesNotMatch(render(details),/全部通过|可以发布|1000\.00/);
  for(const patch of [
    {truncated:true,totalMismatches:1},
    {truncated:false,totalMismatches:2},
    {mismatches:[],totalMismatches:0,truncated:false},
  ]){
    const inconsistent=fixture();Object.assign(inconsistent.scenarios[1],patch);
    assert.equal(validationDetailsView(inconsistent,expectedSource).scenarios[1].detailsStatus,'INVALID');
    assert.match(render(inconsistent),/差异明细尚未核对/);assert.doesNotMatch(render(inconsistent),/<table/);
  }
});

test('current result heading explicitly names its own scenario and saved version',()=>{
  const html=renderToStaticMarkup(React.createElement(ValidationResultScope,{contextId:'stock-cash-t1',contextName:'标准股票现金场景',runId:'saved-run',revisionId:'saved-version',dirty:true}));
  assert.match(html,/当前结果所属场景：标准股票现金场景/);assert.match(html,/仅展示该场景/);
  assert.match(html,/失败回归场景.*查看“校验”/);assert.match(html,/不是草稿的新执行结果/);
  assert.match(html,/saved-run/);assert.match(html,/saved-version/);
  assert.match(renderToStaticMarkup(React.createElement(ValidationResultScope,{runId:'legacy'})),/历史记录未声明场景/);
});

test('workbench and delivery report reuse the same source-checked renderer and retain original pass/fail UI',()=>{
  const workbench=readFileSync('web/src/AgentDevelopmentWorkbench.tsx','utf8'),panel=readFileSync('web/src/AgentDeliveryPanel.tsx','utf8');
  assert.match(workbench,/ValidationDetails details=\{run\.validationDetails\}/);
  assert.match(workbench,/runId:run\.id,revisionId:baselineRevisionId,contextId/);
  assert.match(workbench,/run\.validation\?\.regressions\?\.map/);
  assert.match(workbench,/<ValidationResultScope contextId=\{run\.contextId\}/);
  assert.match(panel,/report\?\.validationDetails/);assert.match(panel,/runId:report\?\.runId,revisionId:report\?\.revisionId,contextId:report\?\.contextId/);
  assert.match(panel,/historical=\{!current\}/);
  const css=readFileSync('web/src/validation-details.css','utf8');
  assert.match(css,/table-layout:fixed/);assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/white-space:normal/);
});
