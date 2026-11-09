import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { readComparisonSql } from '../../src/v2/run-comparison-client.mjs';
import type { SqlRunComparison } from '../../src/v2/run-comparison-client.mjs';
const SqlEditor = lazy(() => import('./SqlEditor'));
export function RunComparisonCode({ api, comparison }: {
    api: <T>(path: string) => Promise<T>;
    comparison: SqlRunComparison;
}) {
    const [read, setRead] = useState<{
        state: 'LOADING' | 'READY' | 'ERROR';
        value?: {
            baselineSql: string;
            currentSql: string;
        };
        error?: string;
    }>(), live = useRef(true);
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    const load = async () => { if (read?.state === 'LOADING')
        return; setRead({ state: 'LOADING' }); try {
        const value = await readComparisonSql({ request: p => api<unknown>(p) }, { comparison });
        if (live.current)
            setRead({ state: 'READY', value });
    }
    catch (e) {
        if (live.current)
            setRead({ state: 'ERROR', error: (e as Error).message });
    } };
    return <details className="run-comparison-code-v2"><summary>查看两版SQL（只读）</summary><p>按所选保存版本读取并核对完整字节摘要；不使用当前草稿，不发送源码给模型。</p><button className="button" disabled={read?.state === 'LOADING' || comparison.current.binding !== 'VERIFIED' || comparison.baseline.binding !== 'VERIFIED'} onClick={() => void load()}>{read?.state === 'LOADING' ? '正在核对SQL…' : '读取已保存SQL差异'}</button>{read?.state === 'ERROR' && <p role="alert">{read.error}</p>}{read?.state === 'READY' && read.value && <div className="run-comparison-sql-editor-v2"><Suspense fallback={<p role="status">正在加载只读代码差异…</p>}><SqlEditor value={read.value.currentSql} original={read.value.baselineSql} onChange={() => { }} diff readOnly focusChanges/></Suspense></div>}</details>;
}
