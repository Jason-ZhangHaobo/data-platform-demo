import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MetadataStore } from '../../src/v2/store.mjs';
import { publishedSqlColumnLineage, sqlLineageSchemaHash } from '../../src/v2/sql-column-lineage.mjs';
import { getContext, referenceSqlForContext } from '../../src/v2/context.mjs';
import { seedLocalServiceSource } from './fixtures/local-service-sources.mjs';
import{sqlConditionReferences}from'../../src/v2/sql-condition-references.mjs';
const python = existsSync('.runtime/python/bin/python') ? '.runtime/python/bin/python' : 'python3', fields = ['client_id', 'holding_market_value', 'available_cash', 'total_assets', 'security_count'];
const harness = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('worker','src/v2/worker.py');w=importlib.util.module_from_spec(s);s.loader.exec_module(w)\np=json.load(sys.stdin);print(json.dumps(w.analyze_column_lineage(p['sql'],p['context'],p['outputs']),ensure_ascii=False))`;
function analyze(sql = referenceSqlForContext('holdings-t1'), outputs = fields) { const c = getContext('holdings-t1'), metadata = { id: c.id, advisorId: c.advisorId, businessDate: c.businessDate, tables: c.tables.map(t => ({ name: t.name, columns: t.columns })) }, r = spawnSync(python, ['-c', harness], { input: JSON.stringify({ sql, context: metadata, outputs }), encoding: 'utf8', timeout: 5000, maxBuffer: 200000 }); assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); }
test('the existing Spark-dialect parser traces nested CTE aggregates to independently expected securities fields', () => {
    const result = analyze();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.rowSetImpactAnalyzed, false);
    assert.equal(result.schemaHash, sqlLineageSchemaHash(getContext('holdings-t1')));
    assert.equal(result.sourceSqlHash, createHash('sha256').update(referenceSqlForContext('holdings-t1')).digest('hex'));
    assert.deepEqual(Object.fromEntries(result.fields.map(f => [f.target, f.sources.map(s => `${s.table}.${s.column}`)])), { client_id: ['accounts.client_id'], holding_market_value: ['positions.market_value'], available_cash: ['cash.available_cash'], total_assets: ['cash.available_cash', 'positions.market_value'], security_count: ['positions.security_code'] });
    assert(result.fields.every(f => f.status === 'RESOLVED'));
    assert.match(result.fields[3].expression, /DECIMAL\(18, 2\)/);
});
test('CASE expression and scalar constants retain value dependencies without leaking literal values or comments', () => {
    const r = analyze("SELECT CASE WHEN market_value > 123456.78 THEN 'PRIVATE_LITERAL' ELSE 'OTHER_LITERAL' END AS category /* PRIVATE_COMMENT */ FROM positions", ['category']);
    assert.equal(r.status, 'COMPLETE');
    assert.deepEqual(r.fields[0].sources, [{ table: 'positions', column: 'market_value' }]);
    for (const secret of ['123456.78', 'PRIVATE_LITERAL', 'OTHER_LITERAL', 'PRIVATE_COMMENT'])
        assert(!JSON.stringify(r).includes(secret));
    const constant = analyze("SELECT 'PRIVATE_CONSTANT' AS total_assets", ['total_assets']);
    assert.equal(constant.fields[0].status, 'CONSTANT');
    assert.deepEqual(constant.fields[0].sources, []);
    assert(!JSON.stringify(constant).includes('PRIVATE_CONSTANT'));
});
test('unknown or ambiguous columns and mismatched output structures never produce complete lineage', () => {
    for (const [sql, outputs] of [["SELECT missing_field AS total_assets FROM positions", ['total_assets']], ["SELECT client_id FROM accounts JOIN positions ON accounts.client_id = positions.client_id", ['client_id']], ["SELECT client_id FROM accounts", ['total_assets']], ["SELECT * FROM external_table", fields]]) {
        const r = analyze(sql, outputs);
        assert.equal(r.status, 'UNAVAILABLE');
        assert.deepEqual(r.fields, []);
    }
    const rowset = analyze('SELECT COUNT(*) AS customer_count FROM accounts', ['customer_count']);
    assert.equal(rowset.status, 'PARTIAL');
    assert.equal(rowset.fields[0].status, 'UNRESOLVED');
});
test('saved lineage is bound to the exact release revision, registered schema and output fields; read does not write', t => {
    const store = new MetadataStore(':memory:'), project = 'synthetic-column-lineage';
    t.after(() => store.close());
    const seed = seedLocalServiceSource({ store, project }), analysis = analyze(), run = store.update('release_run', seed.batches[0].id, project, { columns: fields.map(name => ({ name, type: 'string' })), columnLineage: analysis });
    const read = () => publishedSqlColumnLineage({ store, project, run: store.get('release_run', run.id, project) }), before = store.db.prepare('SELECT data FROM documents ORDER BY id').all();
    let value = read();
    assert.equal(value.status, 'COMPLETE');
    assert.equal(value.revisionId, seed.revision.id);
    assert.equal(value.runId, run.id);
    assert.deepEqual(store.db.prepare('SELECT data FROM documents ORDER BY id').all(), before);
    for (const patch of [{ columnLineage: { ...analysis, sourceSqlHash: 'a'.repeat(64) } }, { columnLineage: { ...analysis, schemaHash: 'b'.repeat(64) } }, { columns: [{ name: 'different_field' }] }, { columnLineage: { ...analysis, fields: analysis.fields.map((f, i) => i === 0 ? { ...f, sources: [{ table: 'cash', column: 'unknown' }] } : f) } }]) {
        store.update('release_run', run.id, project, { ...run, ...patch });
        assert.equal(read().status, 'UNAVAILABLE');
        assert.deepEqual(read().fields, []);
    }
    store.update('release_run', run.id, project, { ...run, columnLineage: undefined });
    assert.equal(read().status, 'UNAVAILABLE');
});
test('CI and Spark packaging use the same pinned SQL parser', () => {
    const pin = readFileSync('deploy/sql-lineage-requirements.txt', 'utf8').split('\n').find(x => x.startsWith('sqlglot=='));
    assert(pin);
    assert(readFileSync('deploy/spark-worker/requirements.txt', 'utf8').split('\n').includes(pin));
});
test('reachable WHERE, JOIN, GROUP and DISTINCT references trace original securities keys without claiming semantic impact',()=>{
 const r=analyze(),c=r.conditionReferences;assert.equal(c.status,'COMPLETE');assert.equal(c.semanticImpactAnalyzed,false);assert.equal(c.totalClauses,9);assert.equal(c.clauses.filter(x=>x.kind==='WHERE').length,3);assert.equal(c.clauses.filter(x=>x.kind==='GROUP_BY').length,2);assert.equal(c.clauses.filter(x=>x.kind==='JOIN_ON').length,2);assert.equal(c.clauses.filter(x=>x.kind==='DISTINCT').length,2);
 assert.deepEqual(c.clauses.filter(x=>x.kind==='WHERE').flatMap(x=>x.sources.map(s=>`${s.table}.${s.column}`)).sort(),['accounts.advisor_id','cash.trade_date','positions.trade_date']);assert(c.clauses.find(x=>x.kind==='DISTINCT'&&x.sources.some(s=>s.column==='position_id')));assert(c.clauses.filter(x=>x.kind==='JOIN_ON').every(x=>x.joinType==='LEFT'&&x.sources.length===2));
 assert(sqlConditionReferences(c,{sourceSqlHash:r.sourceSqlHash,schemaHash:r.schemaHash,tables:getContext('holdings-t1').tables}));
});
test('using joins, unused CTEs, nested subqueries and row-count-only conditions preserve their distinct evidence boundaries',()=>{
 const using=analyze('SELECT a.client_id FROM accounts a JOIN cash b USING (client_id)',['client_id']).conditionReferences;assert.equal(using.status,'COMPLETE');assert.deepEqual(using.clauses[0].sources,[{table:'accounts',column:'client_id'},{table:'cash',column:'client_id'}]);
 const cross=analyze('SELECT a.client_id FROM accounts a CROSS JOIN cash b',['client_id']).conditionReferences;assert.equal(cross.clauses[0].joinType,'CROSS');assert.equal(cross.clauses[0].status,'NO_COLUMN_REFERENCE');
 const unused=analyze('WITH unused AS (SELECT client_id FROM cash WHERE available_cash>2) SELECT client_id FROM accounts',['client_id']).conditionReferences;assert.equal(unused.clauses.length,0);assert.equal(unused.scopeCount,1);
 for(const sql of ['SELECT a.client_id FROM accounts a WHERE a.client_id IN (SELECT client_id FROM cash)','SELECT client_id FROM positions GROUP BY client_id HAVING COUNT(*)>1']){const c=analyze(sql,['client_id']).conditionReferences;assert.equal(c.status,'PARTIAL');assert(c.clauses.some(x=>x.status==='UNRESOLVED'));assert.equal(c.semanticImpactAnalyzed,false);}
 const literals=analyze("SELECT DISTINCT 'PRIVATE_CONDITION_VALUE' AS client_id FROM accounts WHERE advisor_id='PRIVATE_ADVISOR' /* PRIVATE_CONDITION_COMMENT */",['client_id']).conditionReferences;assert.equal(literals.status,'COMPLETE');assert(!JSON.stringify(literals).includes('PRIVATE_'));assert.equal(literals.clauses.find(c=>c.kind==='DISTINCT').status,'NO_COLUMN_REFERENCE');
});
test('condition projections bind original hashes and schema, reject malformed claims and strip expression text from repair summaries',()=>{
 const r=analyze(),binding={sourceSqlHash:r.sourceSqlHash,schemaHash:r.schemaHash,tables:getContext('holdings-t1').tables},c=r.conditionReferences;
 const summary=sqlConditionReferences(c,{...binding,summary:true});assert.equal(summary.protocol,'shuduo-sql-condition-reference-summary/v1');assert.equal(summary.clauses.length,9);assert(!JSON.stringify(summary).includes('expression'));assert(!JSON.stringify(summary).includes('scopeLabel'));assert(sqlConditionReferences(summary,{...binding,summary:true}));assert.equal(sqlConditionReferences(summary,binding),undefined);
 for(const patch of [{sourceSqlHash:'a'.repeat(64)},{schemaHash:'b'.repeat(64)},{semanticImpactAnalyzed:true},{scopeCount:0},{totalClauses:99},{clauses:[{...c.clauses[0],sources:[{table:'cash',column:'unregistered'}]}]},{clauses:c.clauses.map((x,i)=>i?x:{...x,status:'NO_COLUMN_REFERENCE'})}])assert.equal(sqlConditionReferences({...c,...patch},binding),undefined);
 const clauses=Array.from({length:100},(_,i)=>({id:`C${i+1}`,scopeId:'S1',scopeLabel:'主查询',kind:'WHERE',status:'NO_COLUMN_REFERENCE',expression:'? = ?',sources:[]})),large={...c,status:'PARTIAL',scopeCount:1,totalClauses:101,truncated:true,clauses};assert(sqlConditionReferences(large,binding));assert.equal(sqlConditionReferences({...large,status:'COMPLETE'},binding),undefined);assert.equal(sqlConditionReferences({...large,scopeCount:0},binding),undefined);
 const store=new MetadataStore(':memory:'),project='synthetic-condition-binding';try{const seed=seedLocalServiceSource({store,project}),run=store.update('release_run',seed.batches[0].id,project,{columns:fields.map(name=>({name,type:'string'})),columnLineage:{...r,conditionReferences:{...c,sourceSqlHash:'a'.repeat(64)}}}),value=publishedSqlColumnLineage({store,project,run});assert.equal(value.status,'COMPLETE');assert.equal(value.fields.length,5);assert.equal(value.conditionReferences.status,'UNAVAILABLE');}finally{store.close();}
});
