import { useEffect, useRef, useState } from 'react';
import { RefreshCw, GitCompareArrows, LoaderCircle } from 'lucide-react';
import { RunComparisonCode } from './RunComparisonCode';
import { SyncOutputSchemaDetails } from './SyncOutputSchemaDetails';
import {readRepairComparisonBasis} from '../../src/v2/repair-comparison-client.mjs';
import type {RepairComparisonBasis} from '../../src/v2/repair-comparison-client.mjs';
import { readRunComparisonCandidates, readSqlRunComparison } from '../../src/v2/run-comparison-client.mjs';
import type { RunComparisonCandidates, SqlRunComparison, ComparisonSide, ReferenceChange } from '../../src/v2/run-comparison-client.mjs';
type Api = <T>(path: string) => Promise<T>;
const validationLabel = (s: string) => ({ PASSED: '独立核验通过', FAILED: '独立核验未通过', UNCONFIRMED: '核验回执未确认', NOT_MEASURED: '尚未测得核验结果' }[s] ?? s);
const evidenceLabel = (s: string) => ({ SAME: '已核对相同', DIFFERENT: '已记录差异', UNCONFIRMED: '证据未齐', DIFFERENT_CONTEXT: '业务口径不同' }[s] ?? s);
function SideCard({ side, label }: {
    side: ComparisonSide;
    label: string;
}) { return <article className={side.validation.state === 'FAILED' ? 'needs-attention' : side.validation.state === 'PASSED' ? 'verified' : 'unconfirmed'}><small>{label} · {side.sourceKind === 'MANUAL' ? '手工来源' : 'Agent或其他保存来源'}</small><strong>{validationLabel(side.validation.state)}</strong><code>运行 {side.runId.slice(0, 8)} · 代码 {side.revisionId.slice(0, 8)}</code><span>{side.validation.cases.filter(c => c.passed).length}/{side.validation.cases.length} 场景通过 · 文件测试 {side.testSql.state === 'PASSED' ? '通过' : side.testSql.state === 'FAILED' ? '未通过' : '未记录'}</span></article>; }
function ReferenceChanges({ title, value }: {
    title: string;
    value: SqlRunComparison['valueSources'];
}) { return <section className="run-comparison-changes-v2"><h4>{title}</h4>{value.state === 'UNAVAILABLE' ? <p>{value.reason}</p> : !value.changes.length ? <p>没有可见的引用摘要差异；字面量已隐藏，不表示SQL语义等价。</p> : value.changes.map((c: ReferenceChange, i) => <article key={`${c.key}:${i}`}><strong>{{ ADDED: '引用摘要新增', REMOVED: '引用摘要移除', CHANGED: '引用摘要变化', EVIDENCE_CHANGED: '解析证据变化' }[c.kind] ?? c.kind} · {c.before?.target ?? c.after?.target ?? c.before?.kind ?? c.after?.kind}</strong><div>{[['基线', c.before], ['当前', c.after]].map(([label, item]) => { const v = item as ReferenceChange['before']; return <div key={label as string}><small>{label as string}</small>{v ? <><code>{v.expression || '无显式字段表达式'}{v.joinType ? ` · ${v.joinType}` : ''}</code><span>{v.sources.map(s => `${s.table}.${s.column}`).join('、') || '无字段引用／来源未完整解析'}</span></> : <span>无此摘要</span>}</div>; })}</div></article>)}</section>; }
function FrozenInputComparison({ evidence }: { evidence: NonNullable<SqlRunComparison['frozenInput']> }) {
    const status = { MATCHED: '通过', MISMATCH: '未通过', UNAVAILABLE: '证据缺失' };
    return <section aria-label="同一冻结输入的核验对照">
        <h4>同一冻结输入</h4>
        <p>同步批次 <code>{evidence.syncRunId.slice(0,8)}</code> · 元数据 <code>{evidence.metadataVersionId.slice(0,8)}</code> · 快照 <code title={evidence.snapshotHash}>{evidence.snapshotHash.slice(0,12)}</code></p>
        <div className="run-comparison-sides-v2">
            {([['基线', evidence.baseline], ['当前', evidence.current]] as const).map(([label, result]) =>
                <article key={label} className={result.output.status === 'MISMATCH' ? 'needs-attention' : ''}>
                    <strong>{label} · 输出结构{status[result.output.status]}</strong>
                    <span>冻结持仓结果断言{status[result.selectedRows]}</span>
                </article>)}
        </div>
        {evidence.baseline.output.status !== 'MATCHED' && <><h4>基线输出证据</h4><SyncOutputSchemaDetails schema={evidence.baseline.output}/></>}
        {evidence.current.output.status !== 'MATCHED' && <><h4>当前输出证据</h4><SyncOutputSchemaDetails schema={evidence.current.output}/></>}
    </section>;
}
export default function RunComparisonPanel({ api, runId, revisionHash, contextId, snapshotHash, runStatus, dirty, repairReason, onRepair }: {
    api: Api;
    runId: string;
    revisionHash?: string;
    contextId: string;
    snapshotHash?: string;
    runStatus: string;
    dirty: boolean;
    repairReason?:string;
    onRepair?:(basis:RepairComparisonBasis)=>Promise<void>;
}) {
    const key = JSON.stringify([runId, revisionHash, contextId, snapshotHash, runStatus]), active = useRef(key);
    active.current = key;
    const alive = useRef(true), epoch = useRef(0), comparisonSequence = useRef(0), selectedRef = useRef('');
    const [preparing,setPreparing]=useState(false),[repairError,setRepairError]=useState('');
    const repairFlight=useRef(false),latestRepair=useRef({dirty,repairReason,onRepair});latestRepair.current={dirty,repairReason,onRepair};
    const [list, setList] = useState<{
        key: string;
        state: 'LOADING' | 'READY' | 'ERROR';
        value?: RunComparisonCandidates;
        error?: string;
    }>({ key, state: 'LOADING' }), [selected, setSelected] = useState(''), [read, setRead] = useState<{
        key: string;
        state: 'LOADING' | 'READY' | 'ERROR';
        value?: SqlRunComparison;
        error?: string;
    }>();
    const client = { request: (p: string) => api<unknown>(p) }, currentList = list.key === key ? list : undefined, candidate = currentList?.value?.candidates.find(c => c.runId === selected), pair = JSON.stringify([key, selected, candidate?.revisionHash]), currentRead = read?.key === pair ? read : undefined, pairRef = useRef(pair);
    pairRef.current = pair;
    const load = async () => {
        const ticket = ++epoch.current, scope = key;
        setList(old => ({ key: scope, state: 'LOADING', value: old.key === scope ? old.value : undefined }));
        try {
            const value = await readRunComparisonCandidates(client, { runId, contextId, snapshotHash });
            if (alive.current && active.current === scope && ticket === epoch.current) {
                setList({ key: scope, state: 'READY', value });
                if (selectedRef.current && !value.candidates.some(c => c.runId === selectedRef.current)) {
                    setSelected('');
                    selectedRef.current = '';
                }
            }
        }
        catch (e) {
            if (alive.current && active.current === scope && ticket === epoch.current)
                setList(old => ({ key: scope, state: 'ERROR', value: old.key === scope ? old.value : undefined, error: (e as Error).message }));
        }
    };
    useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
    useEffect(() => { selectedRef.current = ''; setSelected(''); setRead(undefined); void load(); }, [key]);
    const compare = async () => {
        if (!candidate || currentList?.state !== 'READY' || currentRead?.state === 'LOADING')
            return;
        const scope = key, baseline = candidate.runId, target = pair, ticket = ++comparisonSequence.current;
        setRead(old => ({ key: target, state: 'LOADING', value: old?.key === target ? old.value : undefined }));
        try {
            const value = await readSqlRunComparison(client, { runId, baselineRunId: baseline, currentRevisionHash: revisionHash, baselineRevisionHash: candidate.revisionHash, contextId, snapshotHash });
            if (alive.current && active.current === scope && selectedRef.current === baseline && pairRef.current === target && comparisonSequence.current === ticket)
                setRead({ key: target, state: 'READY', value });
        }
        catch (e) {
            if (alive.current && active.current === scope && selectedRef.current === baseline && pairRef.current === target && comparisonSequence.current === ticket)
                setRead(old => ({ key: target, state: 'ERROR', value: old?.key === target ? old.value : undefined, error: (e as Error).message }));
        }
    };
    const value = currentRead?.value,baselineReady=Boolean(value?.baseline.runStatus==='SUCCEEDED'&&value.baseline.binding==='VERIFIED'&&value.baseline.validation.state==='PASSED'&&value.baseline.testSql.state==='PASSED');
    const repair=async()=>{
      if(!value||repairReason||dirty||repairFlight.current||!onRepair||currentRead?.state!=='READY'||!baselineReady)return;
      const target=pair,scope=key,baseline=selected;repairFlight.current=true;setPreparing(true);setRepairError('');
      try{
        const basis=await readRepairComparisonBasis(client,{sourceRunId:runId,baselineRunId:baseline,currentRevisionHash:revisionHash,baselineRevisionHash:value.baseline.revisionHash,contextId});
        if(alive.current&&active.current===scope&&pairRef.current===target&&selectedRef.current===baseline&&!latestRepair.current.dirty&&!latestRepair.current.repairReason)await latestRepair.current.onRepair?.(basis);
      }catch(e){if(alive.current&&active.current===scope&&pairRef.current===target)setRepairError((e as Error).message);}
      finally{repairFlight.current=false;if(alive.current)setPreparing(false);}
    };
    return <section className="run-comparison-v2" aria-label="已保存运行对照"><header><GitCompareArrows size={17}/><h3>已保存运行对照</h3><button className="button" disabled={currentList?.state === 'LOADING'} onClick={() => void load()}><RefreshCw size={13}/>重读候选</button></header><p>{snapshotHash ? '选择使用同一冻结输入的历史运行。可核对保存的代码、输出结构和结果断言。' : '选择同口径的基线运行。可核对保存的代码、输入指纹、来源引用和核验记录。'} 只读回查，不重新计算。</p>{dirty && <p role="status">未保存修改不属于本次对照，仍比较所选两次保存运行。</p>}
  {currentList?.state !== 'READY' && <p role={currentList?.state === 'ERROR' ? 'alert' : 'status'}>{currentList?.error ?? '正在读取可见的原运行候选，未确认前不能比较。'}</p>}
  <div className="run-comparison-select-v2"><label>基线运行<select aria-label="基线运行" disabled={currentList?.state !== 'READY'} value={selected} onChange={e => { comparisonSequence.current++; selectedRef.current = e.target.value; setSelected(e.target.value); }}><option value="">请选择已保存运行</option>{currentList?.value?.candidates.map(c => <option key={c.runId} value={c.runId}>{c.runId.slice(0, 8)} · {({ SUCCEEDED: '核验通过', VALIDATION_FAILED: '核验未通过', FAILED: '执行失败', CANCELLED: '已取消', INTERRUPTED: '已中断' } as Record<string, string>)[c.runStatus] ?? c.runStatus} · {new Date(c.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</option>)}</select></label><button className="button" disabled={!candidate || currentList?.state !== 'READY' || currentRead?.state === 'LOADING'} onClick={() => void compare()}>{currentRead?.state === 'LOADING' ? <LoaderCircle size={14} className="spin"/> : <GitCompareArrows size={14}/>}读取两次运行对照</button></div>
  {currentList?.state === 'READY' && !currentList.value?.candidates.length && <p>{snapshotHash ? '此冻结输入暂无其他可核验的保存运行。' : '尚无当前用户可见的同口径历史运行。'}</p>}{currentList?.value?.truncated && <small>只列出最近50条候选。</small>}
  {currentRead?.state === 'ERROR' && <p role="alert">{currentRead.error}{value ? ' 显示同一对运行的上次已读快照，本次读取尚未确认。' : ''}</p>}
  {value && <><div className="run-comparison-sides-v2"><SideCard label="基线" side={value.baseline}/><SideCard label="当前" side={value.current}/></div><div className="run-comparison-basis-v2"><span>代码：{value.code.state === 'CHANGED' ? '摘要有变化' : value.code.state === 'SAME' ? '摘要相同' : '原摘要未确认'}</span><span>实际输入：{evidenceLabel(value.inputs.state)}</span><span>断言依据：{evidenceLabel(value.assertions.state)}</span><span>引擎版本：{value.engineSame ? '已核对相同' : '未核对一致'}</span></div>
   {value.frozenInput && <FrozenInputComparison evidence={value.frozenInput}/>}
   {currentRead?.state === 'READY' && <RunComparisonCode key={`${value.current.runId}:${value.current.revisionHash}:${value.baseline.runId}:${value.baseline.revisionHash}`} api={api} comparison={value}/>}
   {onRepair&&['FAILED','VALIDATION_FAILED'].includes(runStatus)&&<section className="run-comparison-repair-v2"><h4>用该基线辅助修正</h4><p>只向模型提供服务端核对后的引用差异和核验摘要，不传基线原始 SQL。此任务记录为人工辅助，不计自主完成；仍受当前模型、计算预算与权限约束，不包含发布批准。</p><button className="button primary" disabled={!!repairReason||dirty||preparing||currentRead?.state!=='READY'||!baselineReady} onClick={()=>void repair()}>{preparing?'正在核对修正依据…':'以该基线新建修正任务'}</button><p role="status">{repairReason||(dirty?'请先保存修改并核验当前代码。':!baselineReady?'基线缺少完整独立核验或文件测试，请选择已核验成功的运行。':'原失败运行与基线将一并锁定，证据变化后须重新读取。')}</p>{repairError&&<p role="alert">{repairError}</p>}</section>}
   <section><h4>独立核验变化</h4>{value.caseComparison.state === 'CONTROLLED_OBSERVATION' ? value.caseComparison.changes.length ? value.caseComparison.changes.map(c => <p className="run-comparison-case-v2" key={c.contextId}>{c.name}：{c.beforePassed ? '通过' : '未通过'} → {c.afterPassed ? '通过' : '未通过'}</p>) : <p>相同输入与断言依据下，登记场景的通过状态未变。</p> : <p>输入、断言依据或引擎未核对一致；仅分别展示原记录，不将失败变化归因于代码。</p>}</section>
   <ReferenceChanges title="值来源／表达式摘要差异" value={value.valueSources}/><ReferenceChanges title="条件引用摘要差异" value={value.conditionReferences}/><small>{value.notice}</small></>}
 </section>;
}
