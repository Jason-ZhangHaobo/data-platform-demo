import { createHash } from 'node:crypto';
import { getContext, validationFamilyForContext } from './context.mjs';
import { storedRunSqlColumnLineage, sqlLineageSchemaHash } from './sql-column-lineage.mjs';
const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const unavailable = (reason) => ({ state: 'UNAVAILABLE', reason, changes: [] });
const assertion = value => value === undefined ? { state: 'UNRECORDED' } : value?.protocol === 'shuduo-securities-assertion-evidence/v1' && digest(value.contentHash) && typeof value.verifierRevision === 'string' && value.verifierRevision.length > 0 && value.verifierRevision.length <= 64 ? { state: 'VERIFIED', fingerprint: value.contentHash, verifierRevision: value.verifierRevision } : { state: 'UNCONFIRMED' };
function fingerprint(value, contextId) {
    if (value === undefined)
        return { state: 'UNRECORDED' };
    try {
        const c = getContext(contextId);
        if (value.protocol !== 'shuduo-spark-execution-input/v1' || value.scope !== 'ADVISOR_SCOPED_REGISTERED_TABLES' || value.contextId !== contextId || !digest(value.inputHash) || value.schemaHash !== sqlLineageSchemaHash(c) || value.tableCount !== c.tables.length)
            throw Error('UNCONFIRMED');
        return { state: 'VERIFIED', inputHash: value.inputHash, schemaHash: value.schemaHash };
    }
    catch {
        return { state: 'UNCONFIRMED' };
    }
}
function validation(run, contextId) {
    const v = run.validation, family = validationFamilyForContext(contextId), unknown = { state: v ? 'UNCONFIRMED' : 'NOT_MEASURED', cases: [] };
    if (!family || run.validationContractId !== family.id || v?.contractId !== family.id || typeof v.passed !== 'boolean' || !Array.isArray(v.regressions) || v.regressions.length !== family.contextIds.length ||
        new Set(v.regressions.map(c => c?.contextId)).size !== family.contextIds.length || v.regressions.some(c => !c || !family.contextIds.includes(c.contextId) || typeof c.passed !== 'boolean'))
        return unknown;
    const cases = family.contextIds.map(id => { const c = v.regressions.find(c => c.contextId === id); return { contextId: id, name: getContext(id).name, passed: c.passed, input: fingerprint(c.inputEvidence, id), assertions: assertion(c.assertionEvidence) }; });
    if (v.passed && (!cases.every(c => c.passed) || run.status !== 'SUCCEEDED') || !v.passed && run.status !== 'VALIDATION_FAILED')
        return unknown;
    const assertions = assertion(v.assertionEvidence), selected = cases.find(c => c.contextId === contextId);
    if (assertions.state === 'VERIFIED' && (selected?.assertions.state !== 'VERIFIED' || selected.assertions.fingerprint !== assertions.fingerprint || selected.assertions.verifierRevision !== assertions.verifierRevision))
        return unknown;
    return { state: v.passed ? 'PASSED' : 'FAILED', contractId: family.id, cases, assertions };
}
export function runComparisonSide({ run, revision }) {
    const bound = Boolean(revision && run.revisionId === revision.id && run.revisionHash === revision.hash && run.contextId === revision.contextId && typeof revision.sql === 'string' && hash(revision.sql) === revision.hash);
    const lineage = bound ? storedRunSqlColumnLineage({ run, revision }) : undefined;
    const actual = bound && run.engine === 'Apache Spark' && run.mainSqlExecuted === true && ['SUCCEEDED', 'VALIDATION_FAILED'].includes(run.status);
    let measuredInput = actual ? fingerprint(run.inputEvidence, run.contextId) : { state: 'UNCONFIRMED' };
    const measuredValidation = actual ? validation(run, run.contextId) : { state: 'NOT_MEASURED', cases: [] }, selectedCase = measuredValidation.cases.find(c => c.contextId === run.contextId);
    if (measuredInput.state === 'VERIFIED' && selectedCase?.input.state === 'VERIFIED' && (measuredInput.inputHash !== selectedCase.input.inputHash || measuredInput.schemaHash !== selectedCase.input.schemaHash))
        measuredInput = { state: 'UNCONFIRMED' };
    return { runId: run.id, revisionId: run.revisionId, revisionHash: bound ? revision.hash : undefined, contextId: run.contextId ?? revision?.contextId ?? 'UNKNOWN', createdAt: run.createdAt,
        sourceKind: revision?.source === 'MANUAL' || revision?.sourceKind === 'MANUAL' || revision?.sourceAttribution !== undefined ? 'MANUAL' : 'AGENT_OR_OTHER', runStatus: run.status, engine: run.engine, engineVersion: run.engineVersion, binding: bound ? 'VERIFIED' : 'UNCONFIRMED',
        input: measuredInput, validation: measuredValidation,
        testSql: actual && typeof run.testSqlValidation?.passed === 'boolean' && digest(run.testSqlValidation.sqlHash) ? { state: run.testSqlValidation.passed ? 'PASSED' : 'FAILED', sqlHash: run.testSqlValidation.sqlHash } : { state: 'NOT_RECORDED' },
        lineage: lineage ?? { status: 'UNAVAILABLE', fields: [], reason: '原代码与运行摘要未核对一致' } };
}
const sources = f => (f.sources ?? []).map(s => s.table + '.' + s.column).sort();
const orderedSources = f => f.sources.map(s => ({ table: s.table, column: s.column })).sort((a, b) => (a.table + '.' + a.column).localeCompare(b.table + '.' + b.column));
const fieldView = f => ({ target: f.target, status: f.status, sources: orderedSources(f), expression: f.expression });
function values(before, after) {
    if (!['COMPLETE', 'PARTIAL'].includes(before.status) || !['COMPLETE', 'PARTIAL'].includes(after.status))
        return unavailable('至少一次运行缺少可核对的值来源，未推断新增或删除');
    const a = new Map(before.fields.map(f => [f.target, f])), b = new Map(after.fields.map(f => [f.target, f])), changes = [];
    for (const name of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(name), y = b.get(name);
        if (x && y && JSON.stringify(fieldView(x)) === JSON.stringify(fieldView(y)))
            continue;
        const unknown = [x, y].some(f => f && f.status === 'UNRESOLVED');
        changes.push({ key: name, kind: unknown ? 'EVIDENCE_CHANGED' : !x ? 'ADDED' : !y ? 'REMOVED' : 'CHANGED', ...(x ? { before: fieldView(x) } : {}), ...(y ? { after: fieldView(y) } : {}) });
    }
    return { state: before.status === 'PARTIAL' || after.status === 'PARTIAL' ? 'PARTIAL' : 'COMPARED', changes };
}
const clauseView = c => ({ kind: c.kind, status: c.status, sources: orderedSources(c), expression: c.expression ?? '', ...(c.joinType ? { joinType: c.joinType } : {}) });
const clauseGroup = c => JSON.stringify({ kind: c.kind, sources: sources(c) });
function conditions(before, after) {
    if (!before || !after)
        return unavailable('旧运行没有保存条件引用，不能当作条件新增或删除');
    if (before.status !== 'COMPLETE' || after.status !== 'COMPLETE' || before.truncated || after.truncated)
        return unavailable('条件引用未完整解析或被截断，未推断新增或删除');
    const groups = new Map();
    for (const [side, rows] of [['before', before.clauses], ['after', after.clauses]])
        for (const c of rows) {
            const key = clauseGroup(c), g = groups.get(key) ?? { before: [], after: [] };
            g[side].push(clauseView(c));
            groups.set(key, g);
        }
    const changes = [];
    for (const [key, g] of groups) {
        let after = [...g.after], before = [];
        for (const c of g.before) {
            const i = after.findIndex(x => JSON.stringify(x) === JSON.stringify(c));
            if (i >= 0)
                after.splice(i, 1);
            else
                before.push(c);
        }
        if (before.length === 1 && after.length === 1)
            changes.push({ key, kind: 'CHANGED', before: before[0], after: after[0] });
        else {
            for (const c of before)
                changes.push({ key, kind: 'REMOVED', before: c });
            for (const c of after)
                changes.push({ key, kind: 'ADDED', after: c });
        }
    }
    return { state: 'COMPARED', matching: 'KIND_SOURCE_MULTISET', changes };
}
function inputComparison(before, after) {
    if (before.contextId !== after.contextId)
        return { state: 'DIFFERENT_CONTEXT' };
    if (before.input.state !== 'VERIFIED' || after.input.state !== 'VERIFIED')
        return { state: 'UNCONFIRMED' };
    if (before.input.inputHash !== after.input.inputHash || before.input.schemaHash !== after.input.schemaHash)
        return { state: 'DIFFERENT' };
    const a = before.validation, b = after.validation;
    if (!['PASSED', 'FAILED'].includes(a.state) || !['PASSED', 'FAILED'].includes(b.state) || a.contractId !== b.contractId || a.cases.length !== b.cases.length)
        return { state: 'UNCONFIRMED' };
    for (const c of a.cases) {
        const d = b.cases.find(x => x.contextId === c.contextId);
        if (!d || c.input.state !== 'VERIFIED' || d.input.state !== 'VERIFIED')
            return { state: 'UNCONFIRMED' };
        if (c.input.inputHash !== d.input.inputHash || c.input.schemaHash !== d.input.schemaHash)
            return { state: 'DIFFERENT' };
    }
    return { state: 'SAME' };
}
export function compareSqlRuns({ store, project, current, baseline }) {
    const before = runComparisonSide({ run: baseline, revision: store.get('revision', baseline.revisionId, project) }), after = runComparisonSide({ run: current, revision: store.get('revision', current.revisionId, project) });
    const compatible = before.binding === 'VERIFIED' && after.binding === 'VERIFIED' && before.contextId === after.contextId && before.lineage.schemaHash === after.lineage.schemaHash &&
        before.lineage.parser === after.lineage.parser && before.lineage.parserVersion === after.lineage.parserVersion;
    const inputs = inputComparison(before, after), engineSame = Boolean(before.engine === 'Apache Spark' && after.engine === 'Apache Spark' && typeof before.engineVersion === 'string' && before.engineVersion.length > 0 && before.engineVersion === after.engineVersion);
    let assertions = { state: 'UNCONFIRMED' };
    if (['PASSED', 'FAILED'].includes(before.validation.state) && ['PASSED', 'FAILED'].includes(after.validation.state) && before.validation.contractId === after.validation.contractId) {
        const pairs = before.validation.cases.map(c => [c, after.validation.cases.find(d => d.contextId === c.contextId)]);
        if (before.validation.assertions?.state === 'VERIFIED' && after.validation.assertions?.state === 'VERIFIED' && pairs.every(([c, d]) => d && c.assertions.state === 'VERIFIED' && d.assertions.state === 'VERIFIED'))
            assertions = { state: pairs.every(([c, d]) => c.assertions.fingerprint === d.assertions.fingerprint && c.assertions.verifierRevision === d.assertions.verifierRevision) ? 'SAME' : 'DIFFERENT' };
    }
    const caseComparison = inputs.state === 'SAME' && engineSame && assertions.state === 'SAME' ? { state: 'CONTROLLED_OBSERVATION', changes: before.validation.cases.flatMap(c => { const d = after.validation.cases.find(x => x.contextId === c.contextId); return c.passed === d.passed ? [] : [{ contextId: c.contextId, name: c.name, beforePassed: c.passed, afterPassed: d.passed }]; }) } : { state: 'NOT_CONTROLLED', changes: [] };
    const publicSide = side => ({ ...side, validation: { ...side.validation, assertions: { state: side.validation.assertions?.state ?? 'UNRECORDED' }, cases: side.validation.cases.map(({ assertions, ...c }) => ({ ...c, assertions: { state: assertions.state } })) } });
    return { protocol: 'shuduo-sql-run-comparison/v1', current: publicSide(after), baseline: publicSide(before), code: { state: before.binding !== 'VERIFIED' || after.binding !== 'VERIFIED' ? 'UNCONFIRMED' : before.revisionHash === after.revisionHash ? 'SAME' : 'CHANGED' }, inputs, assertions, engineSame,
        valueSources: compatible ? values(before.lineage, after.lineage) : unavailable('口径、结构、原代码或解析器未核对一致，未计算值来源差异'),
        conditionReferences: compatible ? conditions(before.lineage.conditionReferences, after.lineage.conditionReferences) : unavailable('口径、结构、原代码或解析器未核对一致，未计算条件差异'), caseComparison,
        causalConclusion: 'NOT_ESTABLISHED', readOnly: true, notice: '只比较保存证据，不运行模型、解析器或Spark。表达式字面量已隐藏；引用相同不代表SQL等价，观察到的失败变化不证明某个条件是唯一原因。' };
}
