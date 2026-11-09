import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MetadataStore } from '../../src/v2/store.mjs';
import { compareSqlRuns } from '../../src/v2/run-comparison.mjs';
import { checkedSqlRunComparison, readComparisonSql } from '../../src/v2/run-comparison-client.mjs';
import { seedRunComparison } from './fixtures/run-comparison.mjs';
function fixture(t) { const store = new MetadataStore(':memory:'), project = 'synthetic-run-comparison'; t.after(() => store.close()); return { store, project, ...seedRunComparison({ store, project }) }; }
const compare = f => compareSqlRuns({ store: f.store, project: f.project, current: f.store.get('run', f.current.run.id, f.project), baseline: f.store.get('run', f.baseline.run.id, f.project) });
test('two immutable SQL runs show a removed DISTINCT reference and an observed failed case, without data or a causal claim', t => {
    const f = fixture(t), before = f.store.db.prepare('SELECT data FROM documents ORDER BY id').all(), v = compare(f);
    assert.equal(v.code.state, 'CHANGED');
    assert.equal(v.inputs.state, 'SAME');
    assert.equal(v.assertions.state, 'SAME');
    assert.equal(v.valueSources.changes.length, 0);
    assert.equal(v.conditionReferences.changes.length, 1);
    assert.equal(v.conditionReferences.changes[0].kind, 'REMOVED');
    assert.equal(v.conditionReferences.changes[0].before.kind, 'DISTINCT');
    assert(v.conditionReferences.changes[0].before.sources.some(s => s.column === 'position_id'));
    assert.equal(v.caseComparison.state, 'CONTROLLED_OBSERVATION');
    assert.equal(v.caseComparison.changes.length, 1);
    assert.equal(v.caseComparison.changes[0].beforePassed, true);
    assert.equal(v.caseComparison.changes[0].afterPassed, false);
    assert.equal(v.causalConclusion, 'NOT_ESTABLISHED');
    assert.doesNotMatch(JSON.stringify(v), /SYNTHETIC_PRIVATE|contentHash|expected|actual/);
    assert(!JSON.stringify(v).includes(f.baseline.run.validation.assertionEvidence.contentHash));
    assert.deepEqual(f.store.db.prepare('SELECT data FROM documents ORDER BY id').all(), before);
    assert(checkedSqlRunComparison(v, { runId: f.current.run.id, baselineRunId: f.baseline.run.id, currentRevisionHash: f.current.revision.hash }));
    for (const patch of [{ current: { ...v.current, runId: randomUUID() } }, { code: { state: 'SAME' } }, { caseComparison: { ...v.caseComparison, changes: [] } }])
        assert.throws(() => checkedSqlRunComparison({ ...v, ...patch }, { runId: f.current.run.id, baselineRunId: f.baseline.run.id }));
});
test('missing legacy input/condition evidence never becomes same inputs or invented additions', t => {
    const f = fixture(t);
    f.store.update('run', f.baseline.run.id, f.project, { inputEvidence: undefined, columnLineage: { ...f.baseline.run.columnLineage, conditionReferences: undefined } });
    const v = compare(f);
    assert.equal(v.inputs.state, 'UNCONFIRMED');
    assert.equal(v.caseComparison.state, 'NOT_CONTROLLED');
    assert.equal(v.conditionReferences.state, 'UNAVAILABLE');
    assert.deepEqual(v.conditionReferences.changes, []);
});
test('changed assertion or fixture input evidence prevents a controlled result comparison', t => {
    const f = fixture(t), base = f.baseline.run;
    f.store.update('run', base.id, f.project, { validation: { ...base.validation, regressions: base.validation.regressions.map((c, i) => i === 2 ? { ...c, assertionEvidence: { ...c.assertionEvidence, contentHash: 'a'.repeat(64) } } : c) } });
    let v = compare(f);
    assert.equal(v.inputs.state, 'SAME');
    assert.equal(v.assertions.state, 'DIFFERENT');
    assert.equal(v.caseComparison.state, 'NOT_CONTROLLED');
    f.store.update('run', base.id, f.project, { ...base, inputEvidence: { ...base.inputEvidence, inputHash: 'b'.repeat(64) }, validation: { ...base.validation, regressions: base.validation.regressions.map(c => c.contextId === base.contextId ? { ...c, inputEvidence: { ...c.inputEvidence, inputHash: 'b'.repeat(64) } } : c) } });
    v = compare(f);
    assert.equal(v.inputs.state, 'DIFFERENT');
    assert.equal(v.caseComparison.state, 'NOT_CONTROLLED');
});
test('a changed original code hash or parser version remains unconfirmed instead of producing reference changes', t => {
    const f = fixture(t), base = f.baseline.run;
    f.store.update('run', base.id, f.project, { columnLineage: { ...base.columnLineage, parserVersion: 'another-parser' } });
    let v = compare(f);
    assert.equal(v.conditionReferences.state, 'UNAVAILABLE');
    assert.equal(v.valueSources.state, 'UNAVAILABLE');
    f.store.update('run', base.id, f.project, { ...base, revisionHash: 'c'.repeat(64) });
    v = compare(f);
    assert.equal(v.code.state, 'UNCONFIRMED');
    assert.equal(v.inputs.state, 'UNCONFIRMED');
});
test('two missing engine versions cannot be interpreted as a controlled same-engine observation', t => { const f = fixture(t); f.store.update('run', f.baseline.run.id, f.project, { engineVersion: undefined }); f.store.update('run', f.current.run.id, f.project, { engineVersion: undefined }); const v = compare(f); assert.equal(v.inputs.state, 'SAME'); assert.equal(v.engineSame, false); assert.equal(v.caseComparison.state, 'NOT_CONTROLLED'); });
test('conflicting selected-case and main-input fingerprints are unconfirmed rather than observed input equality', t => { const f = fixture(t), base = f.baseline.run; f.store.update('run', base.id, f.project, { validation: { ...base.validation, regressions: base.validation.regressions.map((c, i) => i ? c : { ...c, inputEvidence: { ...c.inputEvidence, inputHash: 'd'.repeat(64) } }) } }); const v = compare(f); assert.equal(v.baseline.input.state, 'UNCONFIRMED'); assert.equal(v.inputs.state, 'UNCONFIRMED'); assert.equal(v.caseComparison.state, 'NOT_CONTROLLED'); });
test('explicit code reading verifies both immutable revision identifiers and exact SQL bytes', async (t) => { const f = fixture(t), v = compare(f), client = { request: async (path) => f.store.get('revision', path.split('/').at(-1), f.project) }, value = await readComparisonSql(client, { comparison: v }); assert.equal(value.baselineSql, f.baseline.revision.sql); assert.equal(value.currentSql, f.current.revision.sql); await assert.rejects(readComparisonSql({ request: async (path) => ({ ...await client.request(path), sql: 'SELECT other_data' }) }, { comparison: v }), /字节/); });
test('another registered business context is displayed without fabricating a reference comparison', t => { const f = fixture(t), contextId = f.family.contextIds[1]; f.store.update('revision', f.baseline.revision.id, f.project, { contextId }); f.store.update('run', f.baseline.run.id, f.project, { contextId }); const v = compare(f); assert.equal(v.inputs.state, 'DIFFERENT_CONTEXT'); assert.equal(v.conditionReferences.state, 'UNAVAILABLE'); assert.equal(v.valueSources.state, 'UNAVAILABLE'); assert.equal(v.caseComparison.state, 'NOT_CONTROLLED'); });
