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
import {checkRegisteredPackageInput} from '../../src/v2/package-input-check.mjs';
import {checkedPackageInputCheck,readPackageInputCheck} from '../../src/v2/package-input-check-client.mjs';
import {publishedReportHash} from '../../src/v2/published-report-source.mjs';
import {customerAssetAnalysis,customerAnalysisPlanCapability} from '../../src/v2/customer-asset-analysis.mjs';
import {createPublishedReportWorkflow,publishedReportRequestKey} from '../../src/v2/published-report-workflow.mjs';
import {syntheticPackage} from './fixtures/input-evidence.mjs';

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

test('a delivery package verifies its original MySQL landing receipt and frozen holdings after the target changes',async t=>{
  const f=await setup(t), {store,ingestion,landingStore}=f.resources, actor='local-engineer';
  const first=f.read(), binding=freezeSyncSqlInput({store,project:PROJECT,actorId:actor,selection:first.selection,current:first});
  const input={...binding,actorId:actor,agentTaskId:randomUUID(),developmentMode:'SYNTHETIC_MODEL'};
  const bundle=store.create('delivery_package',PROJECT,syntheticPackage({binding,input,context:first.context}));
  const checker = {
    retainedRunSnapshot:(taskId,runId)=>ingestion.retainedRunSnapshot(taskId,runId),
    readRegisteredCsv:()=>assert.fail('MySQL package must not read a CSV file'),
  };
  const check=(who=actor)=>checkRegisteredPackageInput({store,project:PROJECT,actor:who,bundle,ingestion:checker});
  const prior=check();
  f.rows[0].amount_rmb='9876.54';
  const replacement=await ingestion.runServerMysqlTask(f.task.id);
  assert.notEqual(replacement.targetHash,f.run.targetHash);
  f.setType('DECIMAL(18,4)');
  await ingestion.collectServerMysqlMetadata(f.source.id);
  const readCount=f.reads();
  assert.deepEqual(check(),prior);
  assert.equal(prior.status,'VERIFIED');
  assert.deepEqual(prior.input,{
    syncRunId:f.run.id, metadataVersionId:f.metadata.id, sourceRevisionId:f.task.sourceRevisionId,
    snapshotHash:binding.snapshotHash, contentHash:f.run.sourceHash, targetHash:f.run.targetHash,
    rows:f.run.finalCount, finishedAt:f.run.finishedAt,
    proof:{protocol:'shuduo-mysql-archive-input-proof/v1',scope:'RETAINED_MYSQL_FULL_SNAPSHOT',sourceType:'SERVER_MYSQL',
      mode:'FULL',targetTable:'raw_positions',syncTaskId:f.task.id,landingReceiptHash:f.run.landingReceiptHash,
      landingSnapshotHash:f.run.landingSnapshotHash,targetRows:f.run.finalCount,upstreamCoverageVerified:false},
  });
  assert.equal(prior.provenance.newSparkRuns,0);
  assert.equal(prior.provenance.fullLifecycleE2E,false);
  await t.test('HTTP, CLI, MCP and a downloaded receipt preserve this exact package and snapshot',async()=>{
    await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
    const client=new V2Client({baseUrl:'http://127.0.0.1:'+f.app.server.address().port+'/api/v2'});
    const selection={packageId:bundle.id,packageDigest:bundle.digest};
    const expected={...selection,sourceType:'SERVER_MYSQL',expectedSyncInput:binding};
    const changes=()=>store.db.prepare('SELECT total_changes() AS changes').get().changes;
    const before=changes();
    assert.deepEqual(await readPackageInputCheck(client,expected),prior);
    let cli;
    assert.equal(await runV2Cli(['delivery','input-check','--id',bundle.id,'--package-digest',bundle.digest],
      {},{client,output:s=>{cli=JSON.parse(s);},error:()=>{}}),0);
    assert.deepEqual(cli,prior);
    const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'delivery_input_check',arguments:selection}},{client}));
    assert.deepEqual(reply.result.structuredContent,prior);
    const saved=JSON.parse(JSON.stringify(cli));
    assert.deepEqual(await checkedPackageInputCheck(saved,expected),prior);
    for (const change of [
      origin=>{origin.syncRunId=randomUUID();}, origin=>{origin.proof.syncTaskId=randomUUID();},
      origin=>{origin.proof.landingSnapshotHash='f'.repeat(64);}, origin=>{delete origin.proof;},
      origin=>{origin.proof.upstreamCoverageVerified=true;}, origin=>{origin.proof.sourceCsvRows=origin.rows;},
      origin=>{origin.proof.targetRows++;},
    ]) {
      const copy=structuredClone(saved);
      change(copy.input);
      const {evidenceDigest,...body}=copy;
      copy.evidenceDigest=publishedReportHash(body);
      await assert.rejects(checkedPackageInputCheck(copy,expected));
    }
    await assert.rejects(client.request('/delivery/packages/'+bundle.id+'/input-evidence?packageDigest='+bundle.digest),
      error=>error.status===409 && error.code==='INPUT_EVIDENCE_CSV_REQUIRED');
    assert.equal(changes(),before);
  });
  assert.throws(()=>check(randomUUID()),{code:'INPUT_CHECK_ACCESS_DENIED'});
  const frozen=store.get('sync_sql_input',binding.snapshotId,PROJECT);
  store.update('sync_sql_input',binding.snapshotId,PROJECT,{contentHash:'0'.repeat(64)});
  assert.throws(()=>check(),{code:'SYNC_SQL_INPUT_CHANGED'});
  store.update('sync_sql_input',binding.snapshotId,PROJECT,{contentHash:frozen.contentHash});
  assert.deepEqual(check(),prior);
  landingStore.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(f.run.id);
  assert.throws(()=>check(),{code:'SYNC_LANDING_RECEIPT_MISSING'});
  assert.equal(f.reads(),readCount);
});


test('a fixed customer analysis stops if its retained MySQL landing receipt is missing',async t=>{
  const f=await setup(t), {store,landingStore}=f.resources, actor='local-engineer';
  const archive=f.read();
  const binding=freezeSyncSqlInput({store,project:PROJECT,actorId:actor,selection:archive.selection,current:archive});
  const revision=store.create('revision',PROJECT,{author:actor,syncInput:binding});
  const batch=store.create('release_run',PROJECT,{sequence:2});
  // Only the upstream report/publication stage is a domain-test fixture.
  // The standard landing receipt, original rows and frozen input are persisted by the normal sync path.
  const src={kind:'AGENT',taskId:randomUUID(),releaseId:randomUUID(),batchId:batch.id,revisionId:revision.id,
    runId:randomUUID(),packageDigest:'a'.repeat(64)};
  const rows=archive.context.expected, hash=publishedReportHash(rows);
  const evidence={protocol:'shuduo-sync-sql-consumption-source/v1',sourceReleaseRunId:src.batchId,releaseId:src.releaseId,
    sourceRevisionId:src.revisionId,sourceRunId:src.runId,sourceTaskId:src.taskId,packageDigest:src.packageDigest,
    snapshotHash:binding.snapshotHash,syncRunId:f.run.id,metadataVersionId:f.metadata.id,businessDate:archive.context.businessDate};
  const record={requestId:randomUUID(),actorId:actor,input:{source:src}};
  const asset={id:'dataset:sync-holdings:'+batch.id,evidenceHash:hash};
  const resolved={source:src,sourceEvidence:evidence,rows,expected:rows,asset};
  const artifacts={report:{id:randomUUID()},version:{id:randomUUID()},run:{id:randomUUID(),sourceEvidence:evidence,
    resultHash:publishedReportHash([]),widgets:[]},snapshot:{id:randomUUID(),sourceEvidence:evidence,assetId:asset.id,
    assetVersionId:batch.id,contentHash:hash},dataset:{sourceEvidence:evidence},data:{rows}};
  const datasetId=randomUUID();
  const saved={...record,status:'SUCCEEDED',reportId:artifacts.report.id,reportRunId:artifacts.run.id,
    reportVersionId:artifacts.version.id,snapshotId:artifacts.snapshot.id,datasetId,sourceEvidenceHash:hash};
  store.deduplicate(publishedReportRequestKey(PROJECT,actor,record.requestId),publishedReportHash(record.input),
    ()=>store.create('published_report_creation',PROJECT,saved));
  const visible=[{id:artifacts.report.id,runs:[{...artifacts.run,reportId:saved.reportId,
    reportVersionId:saved.reportVersionId,datasetSnapshotId:saved.snapshotId,datasetId,datasetContentHash:hash,
    status:'SUCCEEDED',actualExecution:true}]}];
  const workflow=createPublishedReportWorkflow({store,project:PROJECT});
  const link=(views,user)=>workflow.withCustomerAnalysisLinks(views,user)[0].runs[0].customerAnalysisRequestId;
  const before=store.db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(link(visible,actor),record.requestId);
  assert.equal(link(visible,'different-synthetic-owner'),undefined);
  const changed=structuredClone(visible);
  changed[0].runs[0].datasetSnapshotId=randomUUID();
  assert.equal(link(changed,actor),undefined);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,before);
  const read=()=>customerAssetAnalysis({...f.resources,record,artifacts,resolved});
  const capability=(source=resolved,actorId=actor)=>customerAnalysisPlanCapability({...f.resources,resolved:source,actorId});
  assert.deepEqual(capability(), {
    kind:'MYSQL_HOLDINGS_CUSTOMER_ANALYSIS',
    metricIds:['total_assets','holding_value','client_security_count','asset_class_distribution','industry_distribution'],
    dimensions:['asset_class','industry'],sourceType:'SERVER_MYSQL',syncRunId:f.run.id,
    metadataVersionId:f.metadata.id,landingReceiptHash:f.run.landingReceiptHash,
    landingSnapshotHash:f.run.landingSnapshotHash,snapshotHash:binding.snapshotHash,businessDate:archive.context.businessDate,
    grain:'按顾问范围内的客户和交易日',denominator:'客户当日持仓市值，不含现金',
  });
  assert.equal(capability({...resolved,source:{...src,batchId:randomUUID()}}),undefined);
  assert.equal(capability(resolved,'other-owner'),undefined);
  const result=read(), {digest,...body}=result;
  assert.equal(result.source.syncRunId,f.run.id);
  assert.equal(result.source.sequence,2);
  assert.equal(digest,publishedReportHash(body));
  const reads=f.reads();
  f.rows[0].amount_rmb='999999.99';
  assert.deepEqual(read(),result);
  assert.equal(f.reads(),reads);
  artifacts.snapshot.sourceEvidence={...evidence,sourceReleaseRunId:randomUUID()};
  assert.throws(read,{code:'CUSTOMER_ANALYSIS_UNPROVEN'});
  artifacts.snapshot.sourceEvidence=evidence;
  landingStore.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(f.run.id);
  assert.throws(read,{code:'SYNC_LANDING_RECEIPT_MISSING'});
  assert.equal(capability(),undefined);
  assert.equal(f.reads(),reads);
  store.create('published_report_creation',PROJECT,{...saved,requestId:randomUUID()});
  assert.equal(link(visible,actor),undefined,'duplicate creators cannot select a different request for the run');
});
