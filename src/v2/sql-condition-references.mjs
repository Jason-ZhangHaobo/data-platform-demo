const FULL = 'shuduo-sql-condition-references/v1', SUMMARY = 'shuduo-sql-condition-reference-summary/v1';
const identifier = v => typeof v === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(v), hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const kinds = new Set(['WHERE', 'GROUP_BY', 'HAVING', 'JOIN_ON', 'JOIN', 'DISTINCT']);
const joins = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'SEMI', 'ANTI', 'LEFT_SEMI', 'LEFT_ANTI', 'UNKNOWN']);
export function unavailableSqlConditionReferences({ sourceSqlHash, schemaHash }) {
    return { protocol: FULL, analysis: 'STATIC_CONDITION_REFERENCES', sourceSqlHash, schemaHash, semanticImpactAnalyzed: false, status: 'UNAVAILABLE', scopeCount: 0, totalClauses: 0, truncated: false, clauses: [], reason: '条件引用与原SQL、结构或登记字段未核对一致；未推断其语义影响' };
}
// Shared by the trusted projection, browser checks and model adapter. Summary
// mode never forwards expressions, comments, scope labels or diagnostic text.
export function sqlConditionReferences(value, { sourceSqlHash, schemaHash, tables, summary = false } = {}) {
    if (!value || !hash(sourceSqlHash) || !hash(schemaHash) || value.sourceSqlHash !== sourceSqlHash || value.schemaHash !== schemaHash ||
        !(value.protocol === FULL || summary && value.protocol === SUMMARY) || value.analysis !== 'STATIC_CONDITION_REFERENCES' || value.semanticImpactAnalyzed !== false ||
        !['COMPLETE', 'PARTIAL', 'UNAVAILABLE'].includes(value.status) || !Number.isSafeInteger(value.scopeCount) || value.scopeCount < 0 || value.scopeCount > 100 ||
        !Number.isSafeInteger(value.totalClauses) || value.totalClauses < 0 || value.totalClauses > 2500 || typeof value.truncated !== 'boolean' || !Array.isArray(value.clauses) || value.clauses.length > 100)
        return;
    if (tables !== undefined && (!Array.isArray(tables) || tables.some(t => !t || !identifier(t.name) || !Array.isArray(t.columns) || t.columns.some(c => !Array.isArray(c) || !identifier(c[0]) || typeof c[1] !== 'string')) || new Set(tables.map(t => t.name)).size !== tables.length))
        return;
    const schema = tables ? new Map(tables.map(t => [t.name, new Set(t.columns.map(c => c[0]))])) : undefined;
    if (value.status === 'UNAVAILABLE') {
        if (value.scopeCount || value.totalClauses || value.clauses.length || value.truncated || value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 300))
            return;
        const { reason, ...safe } = unavailableSqlConditionReferences({ sourceSqlHash, schemaHash });
        return { ...safe, protocol: summary ? SUMMARY : FULL, ...(!summary ? { reason: value.reason ?? reason } : {}) };
    }
    if (value.scopeCount < 1 || (value.truncated ? (value.clauses.length !== 100 || value.totalClauses <= 100 || value.status !== 'PARTIAL') : value.totalClauses !== value.clauses.length))
        return;
    const clauses = [];
    for (const [cIndex, c] of value.clauses.entries()) {
        const full = value.protocol === FULL;
        if (!c || c.id !== `C${cIndex + 1}` || typeof c.scopeId !== 'string' || !/^S[1-9][0-9]{0,2}$/.test(c.scopeId) || Number(c.scopeId.slice(1)) > value.scopeCount || !kinds.has(c.kind) ||
            !['RESOLVED', 'NO_COLUMN_REFERENCE', 'UNRESOLVED'].includes(c.status) || full && (typeof c.scopeLabel !== 'string' || !(identifier(c.scopeLabel) || c.scopeLabel === '主查询') || typeof c.expression !== 'string' || c.expression.length > 1000) ||
            !Array.isArray(c.sources) || c.sources.length > 150 || c.sources.some(s => !s || !identifier(s.table) || !identifier(s.column) || schema && !schema.get(s.table)?.has(s.column)) ||
            new Set(c.sources.map(s => `${s.table}.${s.column}`)).size !== c.sources.length || c.status === 'RESOLVED' && !c.sources.length || c.status === 'NO_COLUMN_REFERENCE' && c.sources.length ||
            (['JOIN', 'JOIN_ON'].includes(c.kind) ? !joins.has(c.joinType) : c.joinType !== undefined) || c.reason !== undefined && (typeof c.reason !== 'string' || c.reason.length > 300))
            return;
        clauses.push({ id: c.id, scopeId: c.scopeId, kind: c.kind, status: c.status, sources: c.sources.map(s => ({ table: s.table, column: s.column })),
            ...(['JOIN', 'JOIN_ON'].includes(c.kind) ? { joinType: c.joinType } : {}), ...(!summary ? { scopeLabel: c.scopeLabel, expression: c.expression, ...(c.reason ? { reason: c.reason } : {}) } : {}) });
    }
    const complete = !value.truncated && clauses.every(c => c.status !== 'UNRESOLVED');
    if ((value.status === 'COMPLETE') !== complete)
        return;
    return { protocol: summary ? SUMMARY : FULL, analysis: 'STATIC_CONDITION_REFERENCES', sourceSqlHash, schemaHash, semanticImpactAnalyzed: false, status: value.status,
        scopeCount: value.scopeCount, totalClauses: value.totalClauses, truncated: value.truncated, clauses };
}
