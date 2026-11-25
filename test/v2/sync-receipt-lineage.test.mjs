import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {identityPositionMapping} from '../../src/v2/ingestion.mjs';
import {qualityRunRequestPath} from '../../src/v2/quality-input-client.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {archivedSyncSqlInput,materializedSyncSqlInput} from '../../src/v2/sync-sql-archive.mjs';
import {currentSyncSqlInput,freezeSyncSqlInput,readSyncSqlInput} from '../../src/v2/sync-sql-input.mjs';

const targetTable='raw_positions';
const assetId=`landing:${targetTable}`;
const fixtureRoot=fileURLToPath(new URL('../../fixtures/sources/',import.meta.url));

async function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'shuduo-sync-receipt-lineage-'));
  let computes=0;
  const forbidden=async()=>{computes++;throw new Error('Unexpected model or Spark execution');};
  const app=createV2Server({root,fixtureRoot,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},generator:forbidden,runner:forbidden});
  const resources={...app,project:PROJECT};
  t.after(async()=>{
    if(app.server.listening) {
      app.server.closeAllConnections();
      await new Promise(resolve=>app.server.close(resolve));
    }
    app.dispose();
    app.store.close();
    rmSync(root,{recursive:true,force:true});
  });
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${app.server.address().port}/api/v2`;
  const client=new V2Client({baseUrl,client:'workbench'});
  const cliClient=new V2Client({baseUrl,client:'cli'});
  const mcpClient=new V2Client({baseUrl,client:'mcp'});
  const sync=fileName=>{
    const source=app.ingestion.createSource({name:`虚构证券持仓 ${fileName}`,sourceType:'LOCAL_CSV',fileName});
    app.ingestion.testConnection(source.id);
    app.ingestion.collectMetadata(source.id);
    const task=app.ingestion.createTask({name:`虚构证券全量 ${fileName}`,sourceId:source.id,targetTable,mode:'FULL',mapping:identityPositionMapping,keyFields:['position_id']});
    const requestKey=randomUUID();
    const run=app.ingestion.runTask(task.id,{requestKey,requestSignature:'fictional-sync-lineage'});
    const selection={kind:'SYNC_RUN_ARCHIVE_V1',taskId:task.id,runId:run.id,metadataVersionId:run.metadataVersionId,snapshotHash:run.landingSnapshotHash};
    return {task,run,requestKey,selection};
  };
  const first=sync('positions_baseline.csv');
  const latest=sync('positions_incremental.csv');
  assert.equal(first.run.finalCount,4);
  assert.equal(latest.run.finalCount,2);
  assert.equal(currentSyncSqlInput(resources).selection.runId,latest.run.id);
  const rule=app.quality.createRule({name:'持仓市值非空',code:'holding_value_required',assetId,field:'market_value',type:'NOT_NULL',description:'检查虚构证券持仓是否记录市值'});
  const qualityPath=`/quality/rules/${rule.id}`;
  const runQuality=(body,requestId)=>client.request(`${qualityPath}/run`,{method:'POST',body,idempotencyKey:requestId});
  const archiveBody=(batch=first)=>({expectedVersionId:rule.currentVersionId,sourceSelection:batch.selection});
  const mcp=async(name,args)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:mcpClient}));
  const cli=async args=>{
    const output=[],errors=[];
    const status=await runV2Cli(args,{},{client:cliClient,output:line=>output.push(line),error:line=>errors.push(line)});
    return {status,output,errors};
  };
  return {app,client,resources,first,latest,rule,qualityPath,runQuality,archiveBody,mcp,cli,computes:()=>computes};
}

test('an overwritten historical batch with a missing receipt cannot be selected again, but independently saved evidence remains readable',async t=>{
  const f=await setup(t),{app,first,latest,resources,client,rule}=f;
  const original=archivedSyncSqlInput(resources,first.task.id,first.run.id);
  assert.equal(original.source.rowCount,4);
  assert.equal(materializedSyncSqlInput(resources,first.task.id,first.run.id).source.rowCount,4);
  const actorId='local-engineer';
  const binding=freezeSyncSqlInput({...resources,actorId,selection:original.selection,current:original});
  const historicalRequest=randomUUID();
  const saved=await f.runQuality(f.archiveBody(),historicalRequest);
  assert.equal(saved.runs.find(run=>run.id===saved.runWrite.runId).evaluatedCount,4);
  assert.equal(app.ingestion.taskRunRequest(first.task.id,first.requestKey).state,'SUCCEEDED');

  app.landingStore.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(first.run.id);
  const missing={status:409,code:'SYNC_LANDING_RECEIPT_MISSING'};
  assert.throws(()=>app.ingestion.taskRunRequest(first.task.id,first.requestKey),missing);
  assert.throws(()=>archivedSyncSqlInput(resources,first.task.id,first.run.id),missing);
  assert.throws(()=>materializedSyncSqlInput(resources,first.task.id,first.run.id),missing);
  await assert.rejects(f.runQuality(f.archiveBody(),randomUUID()),missing);
  assert.equal(app.store.list('quality_run',PROJECT).length,1);
  assert.deepEqual(readSyncSqlInput({...resources,actorId,binding}),original.context);
  const readback=await client.request(qualityRunRequestPath(rule.id,historicalRequest));
  assert.equal(readback.run.id,saved.runWrite.runId);
  assert.equal(readback.run.archiveSource.runId,first.run.id);
  assert.equal(readback.run.evaluatedCount,4);

  assert.equal(app.assets.detail(assetId).syncSource.runId,latest.run.id);
  assert.equal(app.assets.detail(assetId).syncSource.status,'VERIFIED');
  assert.equal(currentSyncSqlInput(resources).source.rowCount,2);
  assert.equal(app.quality.inputEvidence(rule.id).rows.length,2);
  const archiveWithoutOldWriterFields=app.landingStore.db.prepare('DELETE FROM landing_run_snapshots WHERE run_id=?').run(first.run.id);
  assert.equal(Number(archiveWithoutOldWriterFields.changes),1);
  assert.throws(()=>archivedSyncSqlInput(resources,first.task.id,first.run.id),missing);
  assert.equal(f.computes(),0);
});

test('the current batch receipt gate agrees across asset catalog, current Agent and quality surfaces',async t=>{
  const f=await setup(t),{app,latest,resources,client,rule}=f;
  const currentRequest=randomUUID();
  const saved=await f.runQuality({},currentRequest);
  assert.equal(saved.health,'HEALTHY');
  assert.equal(saved.sourceFreshness.status,'MATCHED');
  assert.equal(saved.runs[0].syncRunId,latest.run.id);
  const metric=app.assets.createMetric({name:'虚构证券持仓市值',code:'fixture_holding_value',assetId,
    aggregation:'SUM',field:'market_value',definition:'按虚构证券持仓逐行汇总市值'});
  const standard=app.assets.createStandard({name:'虚构证券代码标准',code:'fixture_security_code',assetId,
    field:'security_code',semanticType:'SECURITY_CODE',description:'仅核对合成证券代码'});
  const metricPath=`/metrics/${metric.id}`,standardPath=`/standards/${standard.id}`;
  const runAssetAction=(path,requestId=randomUUID())=>client.request(path,{method:'POST',body:{},idempotencyKey:requestId});
  const metricRequest=randomUUID(),standardRequest=randomUUID();
  const savedMetric=await runAssetAction(`${metricPath}/run`,metricRequest);
  const savedStandard=await runAssetAction(`${standardPath}/check`,standardRequest);
  assert.equal(savedMetric.status,'SUCCEEDED');
  assert.deepEqual(savedMetric.values,[{group:'ALL',value:'850.00'}]);
  assert.equal(savedStandard.status,'PASSED');
  assert.equal(savedStandard.passedCount,2);

  app.landingStore.db.prepare('UPDATE landing_run_receipts SET receipt_hash=? WHERE run_id=?').run('0'.repeat(64),latest.run.id);
  const mismatch={status:409,code:'SYNC_LANDING_RECEIPT_MISMATCH'};
  assert.throws(()=>app.ingestion.taskRunRequest(latest.task.id,latest.requestKey),mismatch);
  const asset=await client.request(`/assets/${assetId}`);
  assert.equal(asset.syncSource.status,'UNCONFIRMED');
  assert.equal(asset.syncSource.evidenceCode,mismatch.code);
  assert.equal(asset.executableMetrics,false);
  assert.equal(asset.reportable,false);
  assert.throws(()=>app.assets.reportRows(assetId),mismatch);
  assert.throws(()=>app.assets.runMetric(metric.id),mismatch);
  assert.throws(()=>app.assets.checkStandard(standard.id),mismatch);
  await assert.rejects(runAssetAction(`${metricPath}/run`),mismatch);
  await assert.rejects(runAssetAction(`${standardPath}/check`),mismatch);
  assert.deepEqual(await runAssetAction(`${metricPath}/run`,metricRequest),savedMetric);
  assert.deepEqual(await runAssetAction(`${standardPath}/check`,standardRequest),savedStandard);
  assert.deepEqual((await client.request(metricPath)).runs,[savedMetric]);
  assert.deepEqual((await client.request(standardPath)).checks,[savedStandard]);
  assert.equal(app.store.list('metric_run',PROJECT).length,1);
  assert.equal(app.store.list('standard_check',PROJECT).length,1);
  const cliAsset=await f.cli(['assets','show','--id',assetId]);
  assert.equal(cliAsset.status,0);
  assert.deepEqual(JSON.parse(cliAsset.output[0]).syncSource,asset.syncSource);
  assert.deepEqual((await f.mcp('asset_detail',{assetId})).result.structuredContent.syncSource,asset.syncSource);

  assert.throws(()=>currentSyncSqlInput(resources),mismatch);
  await assert.rejects(client.request('/development/synced-positions'),mismatch);
  const mcpArchive=await f.mcp('sql_archived_positions',{taskId:latest.task.id,runId:latest.run.id});
  assert.deepEqual(mcpArchive.error.data,mismatch);
  assert.throws(()=>app.quality.runRule(rule.id),mismatch);
  await assert.rejects(f.runQuality({},randomUUID()),mismatch);
  await assert.rejects(f.runQuality(f.archiveBody(latest),randomUUID()),mismatch);
  const cliQuality=await f.cli(['quality','run','--id',rule.id]);
  assert.equal(cliQuality.status,1);
  assert.match(cliQuality.errors.join('\n'),/回执/);
  assert.deepEqual((await f.mcp('quality_rule_run',{ruleId:rule.id})).error.data,mismatch);

  const detail=await client.request(f.qualityPath);
  assert.equal(detail.health,'UNCONFIRMED');
  assert.equal(detail.sourceFreshness.evidenceCode,mismatch.code);
  assert.equal(detail.runs.length,1);
  assert.equal(detail.runs[0].status,'PASSED');
  const agentQuality=app.quality.agentContext();
  assert.equal(agentQuality.assets.some(item=>item.id===assetId),false);
  assert.equal(agentQuality.rules.find(item=>item.id===rule.id).currentInputEvidenceCode,mismatch.code);
  assert.equal((await client.request(qualityRunRequestPath(rule.id,currentRequest))).run.id,saved.runs[0].id);
  assert.equal(archivedSyncSqlInput(resources,f.first.task.id,f.first.run.id).source.rowCount,4);

  app.landingStore.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(latest.run.id);
  app.landingStore.db.prepare('DELETE FROM landing_run_snapshots WHERE run_id=?').run(latest.run.id);
  const missing={status:409,code:'SYNC_LANDING_RECEIPT_MISSING'};
  await assert.rejects(f.runQuality({},randomUUID()),missing);
  await assert.rejects(runAssetAction(`${metricPath}/run`),missing);
  await assert.rejects(runAssetAction(`${standardPath}/check`),missing);
  assert.equal((await client.request(`/assets/${assetId}`)).syncSource.evidenceCode,missing.code);
  assert.equal(app.store.list('quality_run',PROJECT).length,1);
  assert.equal(app.store.list('metric_run',PROJECT).length,1);
  assert.equal(app.store.list('standard_check',PROJECT).length,1);
  assert.equal(f.computes(),0);
});

test('a modern target with no current commit pointer cannot substitute an archived batch or use its current rows',async t=>{
  const f=await setup(t),{app,first,latest,resources,client,rule}=f;
  const current=currentSyncSqlInput(resources);
  const actorId='local-engineer';
  const binding=freezeSyncSqlInput({...resources,actorId,selection:current.selection,current});
  const earlierArchive=archivedSyncSqlInput(resources,first.task.id,first.run.id);
  const latestArchive=archivedSyncSqlInput(resources,latest.task.id,latest.run.id);
  const qualityRequest=randomUUID();
  const originalQuality=await f.runQuality({},qualityRequest);
  assert.equal(originalQuality.sourceFreshness.status,'MATCHED');
  const dataset=app.reports.createDataset({name:'虚构证券持仓汇总',code:'fixture_holdings',assetId,fields:['market_value']});
  const originalSnapshot=app.reports.refreshDataset(dataset.id).currentSnapshot;
  const report=app.reports.createReport({name:'持仓市值汇总',code:'fixture_total_value',datasetId:dataset.id,
    description:'固定虚构持仓快照的市值汇总',widgets:[{id:'holding_value',type:'KPI',title:'持仓市值',aggregation:'SUM',field:'market_value'}]});
  const reportRun=app.reports.runReport(report.id).run;
  const originalReportCsv=app.reports.exportReport(report.id,reportRun.id);
  assert.equal(reportRun.widgets[0].value,'850.00');

  const removed=app.landingStore.db.prepare('DELETE FROM landing_commits WHERE target_table=?').run(targetTable);
  assert.equal(removed.changes,1);
  const observed=app.landingStore.inspectTarget(targetTable,{includeRecordedRun:true});
  assert.equal(observed.runId,undefined);
  assert.equal(observed.recordedRunId,undefined);
  assert.equal(observed.targetHash,latest.run.targetHash);

  const unconfirmed={status:409,code:'SYNC_LANDING_RESULT_UNCONFIRMED'};
  const asset=await client.request(`/assets/${assetId}`);
  assert.deepEqual(asset.syncSource,{status:'UNCONFIRMED',evidenceCode:unconfirmed.code,targetHash:latest.run.targetHash});
  assert.equal(asset.executableMetrics,false);
  assert.equal(asset.reportable,false);
  assert.throws(()=>app.assets.executionRows(assetId),unconfirmed);
  assert.throws(()=>app.assets.reportRows(assetId),unconfirmed);
  assert.throws(()=>currentSyncSqlInput(resources),unconfirmed);
  await assert.rejects(client.request('/development/synced-positions'),unconfirmed);
  await assert.rejects(f.runQuality({},randomUUID()),unconfirmed);
  const quality=await client.request(f.qualityPath);
  assert.equal(quality.sourceFreshness.evidenceCode,unconfirmed.code);
  assert.equal(quality.health,'UNCONFIRMED');
  assert.equal(app.quality.agentContext().assets.some(item=>item.id===assetId),false);
  assert.throws(()=>app.quality.inputEvidence(rule.id),unconfirmed);
  assert.throws(()=>app.reports.refreshDataset(dataset.id),unconfirmed);
  assert.equal(app.store.list('quality_run',PROJECT).length,1);

  assert.deepEqual(readSyncSqlInput({...resources,actorId,binding}),current.context);
  assert.deepEqual(archivedSyncSqlInput(resources,first.task.id,first.run.id),earlierArchive);
  assert.deepEqual(archivedSyncSqlInput(resources,latest.task.id,latest.run.id),latestArchive);
  assert.equal(app.ingestion.taskRunRequest(latest.task.id,latest.requestKey).state,'SUCCEEDED');
  assert.equal((await client.request(qualityRunRequestPath(rule.id,qualityRequest))).run.id,originalQuality.runs[0].id);
  assert.deepEqual(app.reports.datasetDetail(dataset.id).snapshots,[originalSnapshot]);
  assert.deepEqual(app.reports.exportReport(report.id,reportRun.id),originalReportCsv);
  assert.equal(f.computes(),0);
});

test('changed current rows fail receipt lineage without invalidating the exact archived snapshot',async t=>{
  const f=await setup(t),{app,latest,resources,client,rule}=f;
  const original=archivedSyncSqlInput(resources,latest.task.id,latest.run.id);
  assert.equal(app.assets.detail(assetId).syncSource.status,'VERIFIED');
  assert.equal(currentSyncSqlInput(resources).selection.runId,latest.run.id);

  const changed=app.landingStore.db.prepare("UPDATE landing_rows SET payload=json_set(payload,'$.market_value','999.00') WHERE target_table=? AND row_key=?")
    .run(targetTable,'POS-002');
  assert.equal(changed.changes,1);
  const observed=app.landingStore.inspectTarget(targetTable,{includeRecordedRun:true});
  assert.equal(observed.runId,undefined);
  assert.equal(observed.recordedRunId,latest.run.id);
  assert.notEqual(observed.targetHash,latest.run.targetHash);
  assert.equal(app.ingestion.taskRunRequest(latest.task.id,latest.requestKey).landingEvidence.targetHash,latest.run.targetHash);

  const mismatch={status:409,code:'SYNC_LANDING_RECEIPT_MISMATCH'};
  const asset=await client.request(`/assets/${assetId}`);
  assert.equal(asset.syncSource.status,'UNCONFIRMED');
  assert.equal(asset.syncSource.evidenceCode,mismatch.code);
  assert.equal(asset.syncSource.runId,latest.run.id);
  assert.equal(asset.executableMetrics,false);
  assert.equal(asset.reportable,false);
  await assert.rejects(client.request('/development/synced-positions'),mismatch);
  await assert.rejects(f.runQuality({},randomUUID()),mismatch);
  assert.equal(app.store.list('quality_run',PROJECT).length,0);

  assert.deepEqual(archivedSyncSqlInput(resources,latest.task.id,latest.run.id),original);
  const archiveRows=app.quality.inputEvidence(rule.id,f.archiveBody(latest)).rows;
  assert.equal(archiveRows.find(row=>row.rowKey==='POS-002').market_value,'550.00');
  assert.equal(f.computes(),0);
});

test('a pre-receipt run keeps independently verifiable current and archived data',async t=>{
  const f=await setup(t),{app,latest,resources,rule}=f;
  for (const {run} of [f.first,latest]) {
    app.store.update('offline_sync_run',run.id,PROJECT,{standardReceiptVersion:undefined,landingReceiptHash:undefined});
    app.landingStore.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(run.id);
  }

  const current=app.assets.detail(assetId);
  assert.equal(current.syncSource.status,'VERIFIED');
  assert.equal(current.syncSource.evidenceCode,undefined);
  assert.equal(current.executableMetrics,true);
  assert.equal(current.reportable,true);
  assert.equal(currentSyncSqlInput(resources).source.rowCount,2);
  assert.equal(archivedSyncSqlInput(resources,latest.task.id,latest.run.id).source.rowCount,2);
  assert.equal(app.quality.runRule(rule.id).run.evaluatedCount,2);

  app.landingStore.db.prepare('DELETE FROM landing_commits WHERE target_table=?').run(targetTable);
  const unbound=app.assets.detail(assetId);
  assert.equal(unbound.syncSource.status,'UNCONFIRMED');
  assert.equal(unbound.syncSource.evidenceCode,undefined);
  assert.equal(unbound.syncSource.runId,undefined);
  assert.equal(unbound.executableMetrics,true);
  assert.equal(unbound.reportable,true);
  assert.equal(app.assets.executionRows(assetId).rows.length,2);
  assert.equal(app.assets.reportRows(assetId).rows.length,2);
  assert.throws(()=>currentSyncSqlInput(resources),{status:409,code:'SYNC_SQL_INPUT_UNAVAILABLE'});
  assert.equal(archivedSyncSqlInput(resources,latest.task.id,latest.run.id).source.rowCount,2);
  assert.equal(f.computes(),0);
});
