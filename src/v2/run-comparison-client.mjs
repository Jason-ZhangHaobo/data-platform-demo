const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v), hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const record = v => v && typeof v === 'object' && !Array.isArray(v), input = v => record(v) && ['VERIFIED', 'UNRECORDED', 'UNCONFIRMED'].includes(v.state) && (v.state !== 'VERIFIED' || hash(v.inputHash) && hash(v.schemaHash));
const bad = () => { throw Error('运行对照回执与原编号、版本或证据结构未核对一致；未采用其他运行结果'); };
function side(s) {
    if (!record(s) || !uuid(s.runId) || !uuid(s.revisionId) || typeof s.contextId !== 'string' || typeof s.runStatus !== 'string' || !['VERIFIED', 'UNCONFIRMED'].includes(s.binding) || s.binding === 'VERIFIED' && !hash(s.revisionHash) || !input(s.input) || !record(s.validation) || !['PASSED', 'FAILED', 'UNCONFIRMED', 'NOT_MEASURED'].includes(s.validation.state) || !Array.isArray(s.validation.cases) || s.validation.cases.length > 5 || !record(s.validation.assertions) || !['VERIFIED', 'UNRECORDED', 'UNCONFIRMED'].includes(s.validation.assertions.state))
        return false;
    const cases = s.validation.cases;
    if (new Set(cases.map(c => c?.contextId)).size !== cases.length || cases.some(c => !record(c) || typeof c.contextId !== 'string' || typeof c.name !== 'string' || typeof c.passed !== 'boolean' || !input(c.input) || !record(c.assertions) || !['VERIFIED', 'UNRECORDED', 'UNCONFIRMED'].includes(c.assertions.state)))
        return false;
    if (['PASSED', 'FAILED'].includes(s.validation.state) && (!cases.length || typeof s.validation.contractId !== 'string' || s.validation.state === 'PASSED' && (!cases.every(c => c.passed) || s.runStatus !== 'SUCCEEDED') || s.validation.state === 'FAILED' && s.runStatus !== 'VALIDATION_FAILED'))
        return false;
    return record(s.testSql) && ['PASSED', 'FAILED', 'NOT_RECORDED'].includes(s.testSql.state) && (s.testSql.state === 'NOT_RECORDED' || hash(s.testSql.sqlHash));
}
function diff(d) { return record(d) && ['COMPARED', 'PARTIAL', 'UNAVAILABLE'].includes(d.state) && Array.isArray(d.changes) && d.changes.length <= 400 && (d.state !== 'UNAVAILABLE' || !d.changes.length) && d.changes.every(c => record(c) && typeof c.key === 'string' && c.key.length <= 20000 && ['ADDED', 'REMOVED', 'CHANGED', 'EVIDENCE_CHANGED'].includes(c.kind) && (c.before || c.after) && [c.before, c.after].filter(Boolean).every(v => record(v) && typeof v.status === 'string' && typeof v.expression === 'string' && v.expression.length <= 1000 && Array.isArray(v.sources) && v.sources.length <= 150 && v.sources.every(s => record(s) && typeof s.table === 'string' && typeof s.column === 'string'))); }
export function checkedSqlRunComparison(value, args) {
    const v = value;
    if (!record(v) || v.protocol !== 'shuduo-sql-run-comparison/v1' || !side(v.current) || !side(v.baseline) || v.current.runId !== args.runId || v.baseline.runId !== args.baselineRunId || v.readOnly !== true || v.causalConclusion !== 'NOT_ESTABLISHED' || !diff(v.valueSources) || !diff(v.conditionReferences) || !record(v.code) || !record(v.inputs) || !record(v.assertions) || !record(v.caseComparison) || !Array.isArray(v.caseComparison.changes))
        bad();
    if (args.currentRevisionHash && v.current.revisionHash !== args.currentRevisionHash || args.baselineRevisionHash && v.baseline.revisionHash !== args.baselineRevisionHash || args.contextId && v.current.contextId !== args.contextId)
        bad();
    const code = v.current.binding !== 'VERIFIED' || v.baseline.binding !== 'VERIFIED' ? 'UNCONFIRMED' : v.current.revisionHash === v.baseline.revisionHash ? 'SAME' : 'CHANGED', engineSame = Boolean(v.current.engine === 'Apache Spark' && v.baseline.engine === 'Apache Spark' && typeof v.current.engineVersion === 'string' && v.current.engineVersion.length > 0 && v.current.engineVersion === v.baseline.engineVersion);
    if (v.code.state !== code || v.engineSame !== engineSame || !['SAME', 'DIFFERENT', 'UNCONFIRMED', 'DIFFERENT_CONTEXT'].includes(v.inputs.state) || !['SAME', 'DIFFERENT', 'UNCONFIRMED'].includes(v.assertions.state))
        bad();
    if (v.inputs.state === 'SAME' && (v.current.contextId !== v.baseline.contextId || v.current.input.state !== 'VERIFIED' || v.baseline.input.state !== 'VERIFIED' || v.current.input.inputHash !== v.baseline.input.inputHash || v.current.input.schemaHash !== v.baseline.input.schemaHash || !['PASSED', 'FAILED'].includes(v.current.validation.state) || !['PASSED', 'FAILED'].includes(v.baseline.validation.state) || !v.current.validation.cases.length || v.current.validation.contractId !== v.baseline.validation.contractId || v.current.validation.cases.length !== v.baseline.validation.cases.length || v.current.validation.cases.some(c => { const b = v.baseline.validation.cases.find(b => b.contextId === c.contextId); return !b || c.input.state !== 'VERIFIED' || b.input.state !== 'VERIFIED' || c.input.inputHash !== b.input.inputHash || c.input.schemaHash !== b.input.schemaHash; })))
        bad();
    if (v.assertions.state === 'SAME' && (v.current.validation.assertions.state !== 'VERIFIED' || v.baseline.validation.assertions.state !== 'VERIFIED' || v.current.validation.contractId !== v.baseline.validation.contractId || v.current.validation.cases.some(c => c.assertions.state !== 'VERIFIED') || v.baseline.validation.cases.some(c => c.assertions.state !== 'VERIFIED')))
        bad();
    const controlled = v.inputs.state === 'SAME' && v.engineSame && v.assertions.state === 'SAME';
    if (v.caseComparison.state !== (controlled ? 'CONTROLLED_OBSERVATION' : 'NOT_CONTROLLED'))
        bad();
    const expected = controlled ? v.baseline.validation.cases.flatMap(b => { const c = v.current.validation.cases.find(c => c.contextId === b.contextId); return c && c.passed !== b.passed ? [{ contextId: b.contextId, name: b.name, beforePassed: b.passed, afterPassed: c.passed }] : []; }) : [];
    if (JSON.stringify(v.caseComparison.changes) !== JSON.stringify(expected))
        bad();
    return v;
}
export function checkedRunComparisonCandidates(v, { runId, contextId } = {}) {
    if (!record(v) || v.protocol !== 'shuduo-run-comparison-candidates/v1' || v.currentRunId !== runId || typeof v.contextId !== 'string' || contextId && v.contextId !== contextId || typeof v.truncated !== 'boolean' || !Array.isArray(v.candidates) || v.candidates.length > 50 || new Set(v.candidates.map(c => c?.runId)).size !== v.candidates.length || v.candidates.some(c => !c || !uuid(c.runId) || c.runId === runId || !uuid(c.revisionId) || c.contextId !== v.contextId || typeof c.runStatus !== 'string' || typeof c.createdAt !== 'string' || c.revisionHash !== undefined && !hash(c.revisionHash)))
        bad();
    return v;
}
export async function readSqlRunComparison(client, args) {
    if (!uuid(args.runId) || !uuid(args.baselineRunId))
        throw Error('需要当前与基线的确切运行编号');
    return checkedSqlRunComparison(await client.request('/runs/' + args.runId + '/comparison?baseline_run_id=' + encodeURIComponent(args.baselineRunId)), args);
}
export async function readRunComparisonCandidates(client, args) {
    if (!uuid(args.runId))
        throw Error('需要当前确切运行编号');
    return checkedRunComparisonCandidates(await client.request('/runs/' + args.runId + '/comparison-candidates'), args);
}
export async function readComparisonSql(client, { comparison }) {
    const ids = [comparison.baseline, comparison.current];
    if (ids.some(s => s.binding !== 'VERIFIED' || !uuid(s.revisionId) || !hash(s.revisionHash)))
        throw Error('原代码摘要未确认，不能读取差异');
    const revisions = await Promise.all(ids.map(s => client.request('/revisions/' + s.revisionId)));
    for (const [rIndex, r] of revisions.entries()) {
        const side = ids[rIndex];
        if (!record(r) || r.id !== side.revisionId || r.contextId !== side.contextId || r.hash !== side.revisionHash || typeof r.sql !== 'string' || r.sql.length > 20000)
            throw Error('SQL原文与所选保存版本未核对一致，未采用当前草稿或最新代码');
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.sql)))].map(x => x.toString(16).padStart(2, '0')).join('');
        if (actual !== side.revisionHash)
            throw Error('保存SQL字节与原摘要不一致，差异未展示');
    }
    return { baselineSql: revisions[0].sql, currentSql: revisions[1].sql };
}
