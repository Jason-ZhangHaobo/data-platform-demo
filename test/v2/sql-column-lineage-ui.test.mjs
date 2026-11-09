import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sqlValueLineageValid } from '../../web/src/sql-column-lineage.ts';
import { assetDetailValid, createAssetReader } from '../../web/src/asset-read.ts';
let conditionCode=ts.transpileModule(readFileSync('web/src/SqlConditionReferencesPanel.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext}}).outputText;
for(const match of [...conditionCode.matchAll(/from (["'])([^"']+)\1/g)])conditionCode=conditionCode.replaceAll(match[0],`from ${JSON.stringify(import.meta.resolve(match[2]))}`);
const conditionUrl='data:text/javascript;base64,'+Buffer.from(conditionCode).toString('base64'),{SqlConditionReferencesPanel}=await import(conditionUrl);
let code = ts.transpileModule(readFileSync('web/src/SqlColumnLineagePanel.tsx', 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
for (const match of [...code.matchAll(/from (["'])([^"']+)\1/g)])
    code = code.replaceAll(match[0], `from ${JSON.stringify(match[2]==='./SqlConditionReferencesPanel'?conditionUrl:import.meta.resolve(match[2]))}`);
const { SqlColumnLineagePanel } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, node = { id: 'dataset:customer_assets_t1', kind: 'PUBLISHED_DATASET', versionId: id(1), name: 'customer_assets_t1', businessName: '虚构证券资产', domain: '财富管理', description: '虚构测试', status: 'PUBLISHED_LOCAL', system: 'LOCAL_SPARK_RELEASE', fields: [{ name: 'total_assets', type: 'DECIMAL(18,2)', nullable: false }], tags: [], evidenceHash: 'a'.repeat(64) }, value = { assetId: node.id, runId: id(1), revisionId: id(2), sourceSqlHash: 'b'.repeat(64), schemaHash: 'c'.repeat(64), status: 'COMPLETE', analysis: 'STATIC_VALUE_DEPENDENCIES', rowSetImpactAnalyzed: false, parser: 'sqlglot', parserVersion: '27.14.0', fields: [{ target: 'total_assets', status: 'RESOLVED', expression: 'holding_market_value + available_cash AS total_assets', sources: [{ table: 'positions', column: 'market_value' }, { table: 'cash', column: 'available_cash' }] }] }, detail = { ...node, lineage: { focusAssetId: node.id, nodes: [node], edges: [], columnLineages: [value], sqlColumnLineageParsed: true }, metrics: [], standards: [] };
test('the real field-lineage panel separates static value dependencies from execution and complete row-set impact', () => {
    const html = renderToStaticMarkup(React.createElement(SqlColumnLineagePanel, { items: [value] }));
    for (const text of ['SQL 字段值来源', '静态分析', 'positions.market_value', 'cash.available_cash', '连接、筛选', '不替代实际 Spark 执行'])
        assert(html.includes(text));
    assert(!html.includes('<button'));
    const missing = renderToStaticMarkup(React.createElement(SqlColumnLineagePanel, { items: [{ ...value, status: 'UNAVAILABLE', fields: [], reason: '原发布尚无分析' }] }));
    assert(missing.includes('本版值来源未确认'));
    assert(missing.includes('原发布尚无分析'));
    assert(!missing.includes('来源已解析'));
});
test('wrong revision schema, malformed fields and inconsistent complete claims cannot enter the asset detail', async () => {
    assert(sqlValueLineageValid(value, [node]));
    assert(assetDetailValid(detail, node.id));
    for (const patch of [{ runId: id(3) }, { schemaHash: 'bad' }, { fields: [{ ...value.fields[0], sources: null }] }, { fields: [{ ...value.fields[0], status: 'UNRESOLVED' }] }, { rowSetImpactAnalyzed: true }])
        assert(!sqlValueLineageValid({ ...value, ...patch }, [node]));
    let response = detail;
    const reads = [];
    const r = createAssetReader({ api: async () => response, validAsset: () => true, validDetail: assetDetailValid, onCatalog() { }, onDetail: v => reads.push(v) });
    await r.select(node.id);
    response = { ...detail, lineage: { ...detail.lineage, columnLineages: [{ ...value, runId: id(3) }] } };
    await r.refreshDetail();
    assert.equal(reads.at(-1).state, 'ERROR');
    assert.equal(reads.at(-1).value.lineage.columnLineages[0].runId, id(1));
    response = detail;
    await r.refreshDetail();
    assert.equal(reads.at(-1).state, 'READY');
    r.close();
});
test('a dirty development draft labels original evidence and starts unconfirmed without executing an effect during render', async () => {
    const panelUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
    let compiled = ts.transpileModule(readFileSync('web/src/RunColumnLineagePanel.tsx', 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
    for (const match of [...compiled.matchAll(/from (["'])([^"']+)\1/g)]) {
        const name = match[2], url = name === './SqlColumnLineagePanel' ? panelUrl : name === './sql-column-lineage' ? new URL('../../web/src/sql-column-lineage.ts', import.meta.url).href : import.meta.resolve(name);
        compiled = compiled.replaceAll(match[0], `from ${JSON.stringify(url)}`);
    }
    const { default: Panel } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')), html = renderToStaticMarkup(React.createElement(Panel, { run: { id: id(1) }, revisionId: id(2), sql: 'SELECT 1', dirty: true }));
    assert(html.includes('原版本字段值来源'));
    assert(html.includes('当前未保存修改尚未验证'));
    assert(html.includes('正在核对原SQL'));
    assert(!html.includes('本版值来源已解析'));
});
test('condition evidence labels missing and partial references and never claims no-column means no row impact',()=>{
 const empty=renderToStaticMarkup(React.createElement(SqlConditionReferencesPanel,{}));assert(empty.includes('尚未采集'));assert(empty.includes('查看不会从当前草稿补造历史'));
 const conditions={status:'PARTIAL',scopeCount:1,totalClauses:2,truncated:false,clauses:[{id:'C1',scopeId:'S1',scopeLabel:'主查询',kind:'JOIN',joinType:'CROSS',status:'NO_COLUMN_REFERENCE',expression:'',sources:[]},{id:'C2',scopeId:'S1',scopeLabel:'主查询',kind:'HAVING',status:'UNRESOLVED',expression:'HAVING COUNT(*) > ?',sources:[],reason:'行集依赖未完整解析'}]},html=renderToStaticMarkup(React.createElement(SqlConditionReferencesPanel,{value:conditions}));assert(html.includes('部分未解析'));assert(html.includes('没有字段引用不代表没有行数影响'));assert(html.includes('行集依赖未完整解析'));assert(html.includes('不证明条件正确'));
});
