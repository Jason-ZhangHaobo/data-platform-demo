import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {getContext} from '../../src/v2/context.mjs';
import {identityPositionMapping} from '../../src/v2/ingestion.mjs';
import {createV2Server, PROJECT} from '../../src/v2/server.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {readArchivedSyncedPositions, readSyncSqlArchives} from '../../src/v2/sync-sql-output-schema-client.mjs';
import {archivedSyncSqlInput, materializedSyncSqlCandidates, syncSqlArchiveCandidates} from '../../src/v2/sync-sql-archive.mjs';
import {freezeSyncSqlInput, readSyncSqlInput, syncSqlContractId, syncSqlOutputColumns, syncSqlOutputSchemaDetails} from '../../src/v2/sync-sql-input.mjs';

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(),'shuduo-mysql-holdings-'));
  const original = getContext('holdings-t1').tables.find(table=>table.name==='positions');
  const fields = Object.keys(identityPositionMapping);
  const mapping = {...identityPositionMapping, amount_rmb:'market_value'};
  delete mapping.market_value; // Test mapping a source name to the holding contract.
  const rows = original.rows.map(cells=>Object.fromEntries(fields.map((name,i)=>
    [name==='market_value'?'amount_rmb':name,cells[i]])));
  let amountType = 'DECIMAL(18,2)', reads = 0;
  const columns = () => Object.keys(mapping).map((name,index)=>({name, ordinal:index+1, nullable:false,
    type:name==='amount_rmb'?amountType:name==='trade_date'?'DATE':'VARCHAR'}));
  const adapter = {profileId:'server-mysql-synthetic',allowTables:['holdings_fixture'],supportsOfflineSync:true,
    async probe() {return {serverVersion:'8.4.fixture'};},
    async describe(tableName) {reads++;return {tableName,columns:columns(),rowCount:rows.length};},
    async readRows() {reads++;return {rows:structuredClone(rows),columns:columns()};},
  };
  const app = createV2Server({root,serverMysqlAdapter:adapter,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
  t.after(async()=>{
    if(app.server.listening){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
    app.dispose();app.store.close();rmSync(root,{recursive:true,force:true});
  });
  const ingestion = app.ingestion;
  const source = ingestion.createSource({sourceType:'SERVER_MYSQL',name:'虚构人民币持仓',tableName:'holdings_fixture'});
  await ingestion.testServerMysqlConnection(source.id);
  const metadata = await ingestion.collectServerMysqlMetadata(source.id);
  const task = ingestion.createTask({name:'原批次全量',sourceId:source.id,targetTable:'raw_positions',mode:'FULL',mapping,keyFields:['position_id']});
  const run = await ingestion.runServerMysqlTask(task.id);
  const resources = {store:app.store,project:PROJECT,ingestion,landingStore:app.landingStore};
  const read = () => archivedSyncSqlInput(resources,task.id,run.id);
  return {app,resources,source,task,run,metadata,rows,read,reads:()=>reads,setType:value=>{amountType=value;}};
}

test('CLI and MCP select the same MySQL archive through HTTP without rereading the source', async t => {
  const f = await setup(t);
  await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const client = new V2Client({baseUrl:'http://127.0.0.1:'+f.app.server.address().port+'/api/v2'});
  const sourceReads = f.reads();
  const [candidate] = await readSyncSqlArchives(client);
  assert.equal(candidate.sourceType, 'SERVER_MYSQL');
  const offer = await readArchivedSyncedPositions(client, candidate);
  assert.equal(offer.sourceType, 'SERVER_MYSQL');
  assert.equal(offer.metadataVersionId, f.metadata.id);
  assert.equal(Object.hasOwn(offer.selection,'sourceType'), false);
  let cli;
  assert.equal(await runV2Cli(['sql','archived-positions','--task-id',f.task.id,'--run-id',f.run.id,
    '--source-type','SERVER_MYSQL','--target-hash',candidate.targetHash,'--landing-snapshot-hash',candidate.landingSnapshotHash],
    {},{client, output:text=>{cli=JSON.parse(text);}, error:()=>{}}),0);
  assert.deepEqual(cli,offer);
  const mcp = JSON.parse(await handleV2Mcp({jsonrpc:'2.0', id:1, method:'tools/call', params:{
    name:'sql_archived_positions',arguments:{taskId:f.task.id,runId:f.run.id,sourceType:'SERVER_MYSQL'}
  }},{client}));
  assert.deepEqual(mcp.result.structuredContent,offer);
  await assert.rejects(readArchivedSyncedPositions(client,{...candidate,sourceType:'LOCAL_CSV'}));
  await assert.rejects(readArchivedSyncedPositions(client,{...candidate,rowCount:candidate.rowCount+1}));
  assert.equal(f.reads(),sourceReads);
});

test('archived MySQL full holdings use the original receipt, mapped rows and collected schema after a new sync', async t => {
  const f = await setup(t);
  assert.ok(syncSqlArchiveCandidates(f.resources).some(c=>c.runId===f.run.id && c.sourceType==='SERVER_MYSQL'));
  assert.deepEqual(materializedSyncSqlCandidates(f.resources),[]);
  const first = f.read();
  assert.equal(first.sourceType,'SERVER_MYSQL');
  const amount = first.context.expected[0].total_assets;
  f.rows[0].amount_rmb = '8000.00';
  const newer = await f.resources.ingestion.runServerMysqlTask(f.task.id);
  const second = archivedSyncSqlInput(f.resources,f.task.id,newer.id);
  assert.notEqual(second.context.expected[0].total_assets,amount);
  f.setType('DECIMAL(18,4)');
  const current = await f.resources.ingestion.collectServerMysqlMetadata(f.source.id);
  const before = f.reads();
  assert.deepEqual(f.read(),first);
  const actorId='local-engineer', selection=first.selection;
  const binding=freezeSyncSqlInput({...f.resources,actorId,selection,current:first});
  assert.deepEqual(readSyncSqlInput({...f.resources,actorId,binding}),first.context);
  const sql='SELECT 1', hash=createHash('sha256').update(sql).digest('hex');
  const revision={projectId:PROJECT,id:randomUUID(),author:actorId,sql,hash,contextId:'holdings-t1',syncInput:binding};
  const run={projectId:PROJECT,id:randomUUID(),status:'SUCCEEDED',engine:'Apache Spark',mainSqlExecuted:true,
    contextId:revision.contextId,validationContractId:syncSqlContractId,revisionId:revision.id,revisionHash:hash,
    syncInput:binding,columns:syncSqlOutputColumns};
  const details = syncSqlOutputSchemaDetails(run,revision,f.resources).inputMetadata;
  assert.equal(details.sourceType,'SERVER_MYSQL');
  assert.equal(details.frozen.metadataVersionId,f.metadata.id);
  assert.equal(details.current.metadataVersionId,current.id);
  assert.equal(details.frozen.columns.find(c=>c.name==='amount_rmb').type,'decimal(18,2)');
  assert.equal(details.current.columns.find(c=>c.name==='amount_rmb').type,'decimal(18,4)');
  assert.equal(f.reads(),before);
  f.resources.landingStore.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(f.run.id);
  assert.equal(syncSqlOutputSchemaDetails(run,revision,f.resources).inputMetadata,null);
  assert.deepEqual(readSyncSqlInput({...f.resources,actorId,binding}),first.context);
});

test('MySQL archives require a real retained receipt and matching source, task configuration and revision', async t=>{
  const f=await setup(t), {store,landingStore}=f.resources;
  const rejected={code:'SYNC_SQL_ARCHIVE_UNAVAILABLE'};
  const revision=store.get('source_revision',f.task.sourceRevisionId,PROJECT);
  for(const [kind,record,field,value] of [
    ['source_revision',revision,'sourceConfigHash','0'.repeat(64)],
    ['source_metadata',f.metadata,'objectName','other_fixture'],
    ['offline_sync_task',f.task,'mapping',{...f.task.mapping,industry:'asset_class',asset_class:'industry'}],
    ['offline_sync_run',f.run,'standardReceiptVersion',undefined],
  ]){
    store.update(kind,record.id,PROJECT,{[field]:value});
    assert.throws(f.read,rejected);
    store.update(kind,record.id,PROJECT,{[field]:record[field]});
  }
  assert.equal(f.read().source.rowCount,f.rows.length);
  landingStore.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(f.run.id);
  assert.throws(f.read,{code:'SYNC_LANDING_RECEIPT_MISSING'});
});

test('unrecorded or incompatible MySQL amount types do not satisfy the frozen holdings contract',async t=>{
  const f=await setup(t), {ingestion}=f.resources;
  for(const type of ['DECIMAL','DECIMAL(18,4)','DOUBLE']){
    f.setType(type);
    await ingestion.collectServerMysqlMetadata(f.source.id);
    const task=ingestion.createTask({name:'独立类型核验',sourceId:f.source.id,targetTable:'raw_positions',
      mode:'FULL',mapping:f.task.mapping,keyFields:['position_id']});
    const run=await ingestion.runServerMysqlTask(task.id);
    assert.throws(()=>archivedSyncSqlInput(f.resources,task.id,run.id),{code:'SYNC_SQL_ARCHIVE_UNAVAILABLE'});
  }
});
