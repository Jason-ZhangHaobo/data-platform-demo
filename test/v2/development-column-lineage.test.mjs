import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { developmentSqlValueLineage } from '../../web/src/sql-column-lineage.ts';
const hash = v => createHash('sha256').update(v).digest('hex'), id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, sql = 'SELECT SUM(market_value) AS total_assets FROM positions', context = { id: 'synthetic-context', tables: [{ name: 'positions', columns: [['market_value', 'DECIMAL(18,2)']] }] }, schemaHash = hash(JSON.stringify({ tables: [{ columns: context.tables[0].columns, name: 'positions' }] })), proof = { protocol: 'shuduo-sql-value-lineage/v1', dialect: 'spark', analysis: 'STATIC_VALUE_DEPENDENCIES', rowSetImpactAnalyzed: false, status: 'COMPLETE', parser: 'sqlglot', parserVersion: '27.14.0', contextId: context.id, sourceSqlHash: hash(sql), schemaHash, fields: [{ target: 'total_assets', status: 'RESOLVED', expression: 'SUM(positions.market_value) AS total_assets', sources: [{ table: 'positions', column: 'market_value' }] }] }, run = { id: id(1), revisionId: id(2), revisionHash: hash(sql), contextId: context.id, engine: 'Apache Spark', status: 'SUCCEEDED', mainSqlExecuted: true, columns: [{ name: 'total_assets', type: 'DECIMAL(18,2)' }], columnLineage: proof };
test('development lineage checks the original SQL and schema without promoting a run to a published batch', async () => {
    const result = await developmentSqlValueLineage({ run, revisionId: id(2), sql, context });
    assert.equal(result.state, 'READY');
    assert.equal(result.item.runId, run.id);
    assert.equal(result.item.revisionId, id(2));
    assert.equal(result.item.assetId, `run:${run.id}`);
    assert.deepEqual(result.item.fields[0].sources, proof.fields[0].sources);
    assert.equal(result.item.rowSetImpactAnalyzed, false);
    const failure = await developmentSqlValueLineage({ run: { ...run, status: 'VALIDATION_FAILED' }, revisionId: id(2), sql, context });
    assert.equal(failure.state, 'READY', 'value dependencies do not imply business assertions passed');
});
test('changed code, input schema, output field or original run identity cannot inherit analysis; older runs remain unavailable', async () => {
    const base = { run, revisionId: id(2), sql, context };
    for (const patch of [{ sql: sql + ' WHERE market_value>0' }, { revisionId: id(3) }, { run: { ...run, revisionHash: 'a'.repeat(64) } }, { context: { ...context, tables: [{ name: 'positions', columns: [['different_field', 'STRING']] }] } }, { run: { ...run, columns: [{ name: 'other_output', type: 'STRING' }] } }, { run: { ...run, contextId: 'another-context' } }])
        assert.equal((await developmentSqlValueLineage({ ...base, ...patch })).state, 'ERROR');
    assert.equal((await developmentSqlValueLineage({ ...base, run: { ...run, columnLineage: undefined } })).state, 'UNAVAILABLE');
});
test('development condition references share the original source binding and cannot introduce unregistered columns',async()=>{
 const condition={protocol:'shuduo-sql-condition-references/v1',analysis:'STATIC_CONDITION_REFERENCES',sourceSqlHash:proof.sourceSqlHash,schemaHash,semanticImpactAnalyzed:false,status:'COMPLETE',scopeCount:1,totalClauses:1,truncated:false,clauses:[{id:'C1',scopeId:'S1',scopeLabel:'主查询',kind:'WHERE',status:'RESOLVED',expression:'positions.market_value > ?',sources:[{table:'positions',column:'market_value'}]}]},args={run:{...run,columnLineage:{...proof,conditionReferences:condition}},revisionId:id(2),sql,context};
 const valid=await developmentSqlValueLineage(args);assert.equal(valid.state,'READY');assert.equal(valid.item.conditionReferences.semanticImpactAnalyzed,false);
 for(const patch of [{sourceSqlHash:'a'.repeat(64)},{clauses:[{...condition.clauses[0],sources:[{table:'positions',column:'unregistered_field'}]}]}])assert.equal((await developmentSqlValueLineage({...args,run:{...run,columnLineage:{...proof,conditionReferences:{...condition,...patch}}}})).state,'ERROR');
});
