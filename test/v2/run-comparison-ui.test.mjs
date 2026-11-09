import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
function component(file) { let code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText; for (const m of [...code.matchAll(/from (["'])([^"']+)\1/g)]) {
    const target = m[2].startsWith('.') ? resolve(dirname(file), m[2]) : undefined, url = target ? (m[2].endsWith('.mjs') ? pathToFileURL(target).href : component(target + '.tsx')) : import.meta.resolve(m[2]);
    code = code.replaceAll(m[0], `from ${JSON.stringify(url)}`);
} return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); }
const { default: RunComparisonPanel } = await import(component('web/src/RunComparisonPanel.tsx'));
test('initial comparison remains unconfirmed, read-only and separate from an unsaved draft', () => {
    const html = renderToStaticMarkup(React.createElement(RunComparisonPanel, { api: () => assert.fail('render must not read or run'), runId: '00000000-0000-4000-8000-000000000001', contextId: 'holdings-t1', runStatus: 'SUCCEEDED', dirty: true }));
    for (const text of ['已保存运行对照', '未保存修改不属于本次对照', '未确认前不能比较', '请选择已保存运行', '不重新计算'])
        assert(html.includes(text));
    assert(!html.includes('相同输入与断言依据下'));
});
