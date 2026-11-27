import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { readComparisonSql, type SqlComparisonSelection } from '../../src/v2/run-comparison-client.mjs';

const SqlEditor = lazy(() => import('./SqlEditor'));
type Result = {state:'LOADING'} | {state:'ERROR';error:string} | {state:'READY';value:{baselineSql:string;currentSql:string}};
type Props = {api:<T>(path:string)=>Promise<T>} & SqlComparisonSelection;

export function RunComparisonCode({api,...selection}:Props) {
  const [result,setResult]=useState<Result>();
  const request=useRef(0);
  const [before,after]=selection.derived
    ? [selection.derived.parent,selection.derived.child] : [selection.comparison.baseline,selection.comparison.current];
  useEffect(()=>{
    setResult(undefined);
    return ()=>{request.current++;};
  },[before.revisionId,before.revisionHash,after.revisionId,after.revisionHash]);
  const ready=selection.derived || (selection.comparison.baseline.binding==='VERIFIED' && selection.comparison.current.binding==='VERIFIED');

  async function load(){
    if (!ready || result?.state==='LOADING') return;
    const id=++request.current;
    setResult({state:'LOADING'});
    try {
      const value=await readComparisonSql({request:path=>api<unknown>(path)},selection);
      if (id===request.current) setResult({state:'READY',value});
    } catch (e) {
      if (id===request.current) setResult({state:'ERROR',error:(e as Error).message});
    }
  }
  return <details className="run-comparison-code-v2">
    <summary>查看两版SQL（只读）</summary>
    <p>按原版本和新版本的代码摘要核对保存的 SQL。</p>
    <button className="button" disabled={!ready||result?.state==='LOADING'} onClick={()=>void load()}>
      {result?.state==='LOADING'?'正在核对SQL…':'读取已保存SQL差异'}
    </button>
    {result?.state==='ERROR'&&<p role="alert">{result.error}</p>}
    {result?.state==='READY'&&<div className="run-comparison-sql-editor-v2">
      <Suspense fallback={<p role="status">正在加载只读代码差异…</p>}>
        <SqlEditor value={result.value.currentSql} original={result.value.baselineSql} onChange={()=>{}} diff readOnly focusChanges/>
      </Suspense>
    </div>}
  </details>;
}
