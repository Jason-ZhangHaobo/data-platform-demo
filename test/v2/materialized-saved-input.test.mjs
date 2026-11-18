import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {identityPositionMapping} from '../../src/v2/ingestion.mjs';
import {materializedSyncSqlInput} from '../../src/v2/sync-sql-archive.mjs';
import {freezeSyncSqlInput,syncSqlOutputColumns,syncSqlContractId} from '../../src/v2/sync-sql-input.mjs';
import {verifySavedSyncSqlInput,verifySavedSyncSqlPackageInput} from '../../src/v2/sync-sql-saved-lifecycle.mjs';
import {createDeliveryPackage,sha256} from '../../src/v2/delivery.mjs';
import {referenceSql,contextIds} from '../../src/v2/context.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'shuduo-saved-target-')),sources=join(root,'sources');mkdirSync(sources);
 for(const name of ['seed','close'])cpSync(resolve('fixtures/sources/positions_change_'+name+'.csv'),join(sources,name+'.csv'));
 writeFileSync(join(sources,'empty.csv'),'position_id,client_id,security_code,asset_class,industry,market_value,trade_date,op,seq\nPOS-001,,,,,,,DELETE,9007199254740994\n');
 const app=createV2Server({root,fixtureRoot:sources,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},generator:()=>{throw Error('NO_MODEL')},runner:()=>{throw Error('NO_SPARK')}}),epochId=randomUUID();let closed=false;
 const close=()=>{if(!closed){closed=true;app.dispose();app.store.close();}};t.after(()=>{close();rmSync(root,{recursive:true,force:true});});
 const sync=(file,mode='INCREMENTAL_CHANGELOG',table='positions_changes')=>{const source=app.ingestion.createSource({name:'虚构离线源'+file,sourceType:'LOCAL_CSV',fileName:file});app.ingestion.testConnection(source.id);app.ingestion.collectMetadata(source.id);const task=app.ingestion.createTask({name:'虚构离线同步'+file,sourceId:source.id,targetTable:table,mode,mapping:identityPositionMapping,keyFields:['position_id'],...(mode==='INCREMENTAL_CHANGELOG'?{changeConfig:{epochId,operationField:'op',sequenceField:'seq'}}:{})});const run=app.ingestion.runTask(task.id),current=materializedSyncSqlInput({store:app.store,project:PROJECT,ingestion:app.ingestion},task.id,run.id),binding=freezeSyncSqlInput({store:app.store,project:PROJECT,actorId:'local-engineer',selection:current.selection,current}),input={...binding,actorId:'local-engineer',agentTaskId:randomUUID(),developmentMode:'SYNTHETIC_MODEL'};return {task,run,current,binding,input,context:current.context,csv:readFileSync(join(sources,file),'utf8')};};
 const read=(kind,id)=>app.store.get(kind,id,PROJECT),readSnapshot=id=>app.landingStore.db.prepare('SELECT * FROM landing_run_snapshots WHERE run_id=?').get(id);
 return {root,sources,app,sync,read,readSnapshot,close,verify:item=>verifySavedSyncSqlInput({read,readSnapshot,...item})};
}

test('cold target proof verifies seed, DELETE and confirmed empty snapshots without replaying the last CSV as a full target',t=>{
 const f=fixture(t),items=['seed.csv','close.csv','empty.csv'].map(file=>f.sync(file));
 for(const [i,item] of items.entries()){const proof=f.verify(item);assert.equal(proof.rows,2-i);assert.equal(proof.proof.sourceCsvRows,i===0?2:1);assert.equal(proof.proof.targetRows,2-i);assert.equal(proof.proof.scope,'RETAINED_TARGET_SNAPSHOT');assert.equal(proof.proof.eventReplayVerified,false);assert.equal(proof.proof.historicalControlReplayVerified,false);assert.equal(proof.proof.upstreamCoverageVerified,false);assert.equal(proof.proof.changeStateHash,item.input.changeStateHash);}
 assert.deepEqual(items[2].context.expected.map(r=>r.total_assets),['300.00','200.00']);
 const expected=f.verify(items[0]);f.close();const meta=join(f.root,'.data/v2-platform.sqlite'),path=join(f.root,'.data/v2-landing.sqlite'),before=[sha256(readFileSync(meta)),sha256(readFileSync(path))],store=new MetadataStore(meta,{readOnly:true}),landing=new DatabaseSync(path,{readOnly:true});
 try{store.db.exec('BEGIN');landing.exec('BEGIN');const restored=verifySavedSyncSqlInput({...items[0],read:(kind,id)=>store.get(kind,id,PROJECT),readSnapshot:id=>landing.prepare('SELECT * FROM landing_run_snapshots WHERE run_id=?').get(id)});assert.deepEqual(restored,expected);assert.throws(()=>landing.exec('DELETE FROM landing_run_snapshots'));}finally{landing.close();store.close();}assert.deepEqual([sha256(readFileSync(meta)),sha256(readFileSync(path))],before);
});

test('FULL and UPSERT new selections require the actual archive; legacy inputs keep their existing CSV replay path',t=>{
 const f=fixture(t),full=f.sync('seed.csv','FULL','merged_positions');writeFileSync(join(f.sources,'delta.csv'),'position_id,client_id,security_code,asset_class,industry,market_value,trade_date\nPOS-002,CLIENT-002,SEC-DEMO-002,股票,信息技术,2500.00,2026-09-10\n');const merged=f.sync('delta.csv','INCREMENTAL_UPSERT','merged_positions');assert.equal(f.verify(merged).rows,2);assert.equal(f.verify(merged).proof.sourceCsvRows,1);assert.equal(f.verify(full).rows,2);
 for(const item of [full,merged])assert.throws(()=>verifySavedSyncSqlInput({...item,read:f.read}),{code:'SYNC_SAVED_TARGET_SNAPSHOT_REQUIRED'});
});

test('wrong metadata, frozen identity, mode, counts and change control are rejected without changing evidence',t=>{
 const f=fixture(t),item=f.sync('seed.csv'),before=f.verify(item);
 const cases=[['source_metadata',item.input.metadataVersionId,{schemaHash:'0'.repeat(64)},'INPUT_CHANGED'],['offline_sync_task',item.task.id,{configHash:'0'.repeat(64)},'INPUT_CHANGED'],['offline_sync_task',item.task.id,{mode:'FULL'},'INPUT_CHANGED'],['offline_sync_run',item.run.id,{finalCount:1},'INPUT_CHANGED'],['offline_sync_run',item.run.id,{changeState:{...item.run.changeState,changeStateHash:'0'.repeat(64)}},'CHANGE_BINDING_CHANGED'],['offline_sync_run',item.run.id,{changeState:{...item.run.changeState,deleteEvents:99}},'CHANGE_BINDING_CHANGED'],['sync_sql_input',item.input.snapshotId,{payload:{}},'INPUT_PROJECTION_CHANGED'],['source_revision',item.input.sourceRevisionId,{projectId:'other-project'},'INPUT_CHANGED']];
 for(const [kind,id,patch,code] of cases){const read=(k,key)=>{const value=f.read(k,key);return k===kind&&key===id?{...value,...patch}:value;};assert.throws(()=>verifySavedSyncSqlInput({...item,read,readSnapshot:f.readSnapshot}),{code:'SYNC_SAVED_'+code});}
 assert.throws(()=>f.verify({...item,csv:item.csv.replace('1000.00','5000.00')}),{code:'SYNC_SAVED_INPUT_CHANGED'});assert.throws(()=>f.verify({...item,input:{...item.input,actorId:randomUUID()}}),{code:'SYNC_SAVED_INPUT_PROJECTION_CHANGED'});const context=structuredClone(item.context);context.expected[0].available_cash='999.00';assert.throws(()=>f.verify({...item,context}),{code:'SYNC_SAVED_INPUT_PROJECTION_CHANGED'});assert.deepEqual(f.verify(item),before);
});

test('missing, corrupted and wrong-run snapshot bytes do not fall back to current rows or raw events',t=>{
 const f=fixture(t),seed=f.sync('seed.csv'),closed=f.sync('close.csv'),expected=f.verify(seed),record=f.readSnapshot(seed.run.id),mutated={...record,payload:record.payload.replace('1000.00','9999.00')};
 for(const readSnapshot of [()=>undefined,()=>mutated,()=>f.readSnapshot(closed.run.id),()=>{throw Error('READ_FAILED')}])assert.throws(()=>verifySavedSyncSqlInput({...seed,read:f.read,readSnapshot}),{code:'SYNC_SAVED_TARGET_SNAPSHOT_CHANGED'});assert.deepEqual(f.verify(seed),expected);
});

// These delivery receipts are synthetic protocol fixtures, not real execution evidence.
function syntheticPackage(item){const id=item.input.agentTaskId,revisionId=randomUUID(),runId=randomUUID(),hash=sha256(referenceSql),revision={id:revisionId,projectId:PROJECT,contextId:'holdings-t1',sql:referenceSql,hash,author:'local-engineer',source:'SYNTHETIC_MODEL',syncInput:item.binding},agent={id,projectId:PROJECT,contextId:'holdings-t1',submittedBy:'local-engineer',mode:'SYNTHETIC_MODEL',status:'SUCCEEDED',revisionId,runId,syncInput:item.binding,attempts:[{status:'SUCCEEDED',revisionId,runId}]},run={id:runId,projectId:PROJECT,agentTaskId:id,revisionId,revisionHash:hash,contextId:'holdings-t1',status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,testDouble:false,syncInput:item.binding,finishedAt:new Date().toISOString(),rows:item.context.expected,columns:syncSqlOutputColumns,validationContractId:syncSqlContractId,validation:{passed:true,contractId:syncSqlContractId,selectedPassed:true,regressions:contextIds.map(contextId=>({contextId,passed:true}))}};return createDeliveryPackage({agent,run,revision,syncContext:item.context});}

test('actual offline CLI verifies an empty-target package before publication and rejects weaker or cross-stage argument combinations',t=>{
 const f=fixture(t);f.sync('seed.csv');f.sync('close.csv');const item=f.sync('empty.csv'),bundle=syntheticPackage(item),file=join(f.root,'synthetic-package.json');writeFileSync(file,JSON.stringify(bundle));const expected=verifySavedSyncSqlPackageInput({store:f.app.store,project:PROJECT,actor:'local-engineer',originalPackage:bundle,packageDigest:bundle.digest,csv:item.csv,readSnapshot:f.readSnapshot});assert.equal(expected.input.rows,0);assert.equal(expected.provenance.fullLifecycleE2E,false);
 const args=['scripts/verify-saved-sync-sql-lifecycle.mjs','--input-only','--metadata',join(f.root,'.data/v2-platform.sqlite'),'--landing-snapshots',join(f.root,'.data/v2-landing.sqlite'),'--source-csv',join(f.sources,'empty.csv'),'--package-file',file,'--package-digest',bundle.digest];f.close();const run=extra=>spawnSync(process.execPath,[...args,...extra],{encoding:'utf8',timeout:10000});const good=run([]);assert.equal(good.status,0,good.stderr);assert.deepEqual(JSON.parse(good.stdout),expected);
 for(const extra of [['--consumption-only'],['--release-id',randomUUID()],['--business-snapshots',join(f.root,'not-created.sqlite')],['--verify-quality'],['--quality-receipt','fictional.json']]){const fail=run(extra);assert.equal(fail.status,1);assert.equal(JSON.parse(fail.stderr).code,'SYNC_SAVED_ARGUMENTS_REQUIRED');assert.equal(fail.stdout,'');}
 const foreign=run(['--project','other-project']);assert.equal(foreign.status,1);assert.equal(JSON.parse(foreign.stderr).code,'SYNC_SAVED_INPUT_PROJECT_CHANGED');
});
