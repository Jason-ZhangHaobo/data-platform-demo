import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {getContext} from '../../src/v2/context.mjs';
import {identityPositionMapping} from '../../src/v2/ingestion.mjs';
import {archivedSyncSqlInput,selectedSyncSqlInput,syncSqlArchiveCandidates} from '../../src/v2/sync-sql-archive.mjs';
import {freezeSyncSqlInput,readSyncSqlInput,validateSyncSqlDeliveryContext} from '../../src/v2/sync-sql-input.mjs';
import {parseSyncSqlSelection,syncSqlSelectionFromBinding} from '../../src/v2/sync-sql-selection.mjs';
import {readArchivedSyncedPositions,readSyncSqlArchives} from '../../src/v2/sync-sql-output-schema-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';

function setup(t){
  const root=mkdtempSync(join(tmpdir(),'shuduo-archive-input-')),fixtureRoot=join(root,'sources');mkdirSync(fixtureRoot);
  let paid=0;const forbidden=async()=>{paid++;throw Error('NO_COMPUTE_IN_ARCHIVE_READ_TEST');};
  const app=createV2Server({root,fixtureRoot,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},generator:forbidden,runner:forbidden});
  const resources={store:app.store,ingestion:app.ingestion,landingStore:app.landingStore,assets:app.assets,project:PROJECT};
  t.after(async()=>{if(app.server.listening){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}app.dispose();app.store.close();rmSync(root,{recursive:true,force:true});});
  function sync(name,amount,{currency,mode='FULL',targetTable='raw_positions',mapping=identityPositionMapping,client,tradeDate,rowCount}={}){
    const positions=getContext().tables.find(table=>table.name==='positions'),rows=rowCount?Array.from({length:rowCount},(_,index)=>{const row=[...positions.rows[0]];row[0]='POS-LARGE-'+index;return row;}):structuredClone(positions.rows);rows[0][5]=amount;
    if(client)rows[0][1]=client;if(tradeDate)rows[0][6]=tradeDate;
    const header=positions.columns.map(([name])=>name);if(currency){header.push('currency');rows.forEach(row=>row.push(currency));}
    writeFileSync(join(fixtureRoot,name+'.csv'),[header,...rows].map(row=>row.map(cell=>cell??'').join(',')).join('\n'));
    const source=app.ingestion.createSource({name:'虚构持仓 '+name,sourceType:'LOCAL_CSV',fileName:name+'.csv'});app.ingestion.testConnection(source.id);
    const metadata=app.ingestion.collectMetadata(source.id),task=app.ingestion.createTask({name:'虚构同步 '+name,sourceId:source.id,targetTable,mode,mapping,keyFields:['position_id']});
    return {source,metadata,task,run:app.ingestion.runTask(task.id)};
  }
  return {app,root,resources,sync,paid:()=>paid};
}

test('explicit archive selection preserves original rows, frozen context and 14-field delivery proof after overwrite',t=>{
  const f=setup(t),first=f.sync('original','1245.07');f.sync('newer','4000.00');
  const current=archivedSyncSqlInput(f.resources,first.task.id,first.run.id),selection=current.selection;
  assert.equal(selection.kind,'SYNC_RUN_ARCHIVE_V1');assert.equal(current.context.expected[0].total_assets,'2045.07');
  assert.equal(f.app.landingStore.readTable('raw_positions')[0].market_value,'4000.00');
  const binding=freezeSyncSqlInput({...f.resources,actorId:'local-engineer',selection,current});
  const delivery={...binding,actorId:'local-engineer',agentTaskId:'00000000-0000-4000-8000-000000000001',developmentMode:'SYNTHETIC_MODEL'};
  assert.equal(Object.keys(delivery).length,14);validateSyncSqlDeliveryContext(delivery,current.context);
  assert.deepEqual(syncSqlSelectionFromBinding(delivery),selection);
  for(const field of ['landingSnapshotHash','taskId','targetHash'])assert.throws(()=>validateSyncSqlDeliveryContext({...delivery,[field]:field==='taskId'?'00000000-0000-4000-8000-000000000002':'0'.repeat(64)},current.context));
  f.app.landingStore.db.prepare('DELETE FROM landing_run_snapshots').run();
  assert.deepEqual(readSyncSqlInput({...f.resources,actorId:'local-engineer',binding}),current.context);
  assert.throws(()=>readSyncSqlInput({...f.resources,actorId:'other-fictional-engineer',binding}),{code:'SYNC_SQL_INPUT_CHANGED'});
  assert.throws(()=>selectedSyncSqlInput(f.resources,selection),{code:'SYNC_SNAPSHOT_MISSING'});
  assert.equal(f.paid(),0);
});

test('old current-table selector remains stale and archive proof cannot be silently substituted',t=>{
  const f=setup(t),first=f.sync('original','1245.07'),archived=archivedSyncSqlInput(f.resources,first.task.id,first.run.id);
  const legacy={targetTable:'raw_positions',runId:first.run.id,targetHash:first.run.targetHash};
  f.sync('newer','4000.00');
  assert.throws(()=>freezeSyncSqlInput({...f.resources,actorId:'local-engineer',selection:legacy,current:selectedSyncSqlInput(f.resources,legacy)}),{code:'SYNC_SQL_INPUT_STALE'});
  assert.throws(()=>freezeSyncSqlInput({...f.resources,actorId:'local-engineer',selection:{...archived.selection,landingSnapshotHash:'0'.repeat(64)},current:archived}),{code:'SYNC_SQL_INPUT_STALE'});
  assert.deepEqual(parseSyncSqlSelection(legacy),legacy);
  for(const changed of [{...legacy,kind:'UNKNOWN'},{...archived.selection,extra:true},{...archived.selection,runId:first.run.id+'\n'},{...archived.selection,taskId:undefined}])assert.throws(()=>parseSyncSqlSelection(changed));
  assert.equal(f.paid(),0);
});

test('archive candidates do not certify rows; original metadata, currency, clients and business date remain enforced',t=>{
  const f=setup(t),first=f.sync('original','1245.07'),usd=f.sync('usd','1245.07',{currency:'USD',mapping:{...identityPositionMapping,currency:'currency'}}),client=f.sync('client','1245.07',{client:'CLIENT-UNREGISTERED'}),date=f.sync('date','1245.07',{tradeDate:'2026-09-11'});
  const delta=f.sync('delta','100.00',{mode:'INCREMENTAL_UPSERT'}),other=f.sync('other','100.00',{targetTable:'other_holdings'}),large=f.sync('large','100.00',{rowCount:501});
  const candidates=syncSqlArchiveCandidates(f.resources);assert.ok(candidates.every(item=>item.verification==='REQUIRES_CHECK'));assert.ok(!candidates.some(item=>[delta.run.id,other.run.id].includes(item.runId)));
  assert.ok(!candidates.some(item=>item.runId===large.run.id));
  for(const item of [usd,client,date,delta,other,large])assert.throws(()=>archivedSyncSqlInput(f.resources,item.task.id,item.run.id));
  f.app.store.update('source_metadata',first.metadata.id,PROJECT,{schemaHash:'0'.repeat(64)});
  assert.throws(()=>archivedSyncSqlInput(f.resources,first.task.id,first.run.id),{code:'SYNC_SQL_ARCHIVE_UNAVAILABLE'});
  f.app.store.update('source_metadata',first.metadata.id,PROJECT,{schemaHash:first.metadata.schemaHash});
  f.app.landingStore.db.prepare("UPDATE landing_run_snapshots SET payload='{}' WHERE run_id=?").run(first.run.id);
  assert.throws(()=>archivedSyncSqlInput(f.resources,first.task.id,first.run.id),{code:'SYNC_SNAPSHOT_MISMATCH'});
  assert.equal(f.paid(),0);
});

test('API CLI MCP verify same archive without returning rows; denied identities and failed submissions create no task',async t=>{
  const f=setup(t),first=f.sync('original','1245.07');f.sync('newer','4000.00');
  await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${f.app.server.address().port}/api/v2`,path=`/development/synced-positions/archives/${first.task.id}/${first.run.id}`,client=new V2Client({baseUrl:base});
  const candidates=await readSyncSqlArchives(client),candidate=candidates.find(item=>item.runId===first.run.id),offer=await readArchivedSyncedPositions(client,candidate);
  assert.equal(offer.context,undefined);assert.equal(offer.rows,undefined);assert.equal(offer.selection.kind,'SYNC_RUN_ARCHIVE_V1');
  let result;assert.equal(await runV2Cli(['sql','archived-positions','--task-id',first.task.id,'--run-id',first.run.id],{},{client,output:text=>{result=JSON.parse(text);},error:()=>{}}),0);assert.deepEqual(result,offer);
  const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sql_archived_positions',arguments:{taskId:candidate.taskId,runId:candidate.runId,targetHash:candidate.targetHash,landingSnapshotHash:candidate.landingSnapshotHash}}},{client}));assert.deepEqual(mcp.result.structuredContent,offer);
  assert.equal((await fetch(base+path+'?actorId=other')).status,422);
  assert.equal((await fetch(base+path,{headers:{cookie:'shuduo_session=invalid'}})).status,403);
  f.app.auth.bootstrapAdmin({email:'admin@example.test',password:'SyntheticAdmin#2026',displayName:'虚构管理员'});
  const login=f.app.auth.login({email:'admin@example.test',password:'SyntheticAdmin#2026'}),admin=f.app.auth.sessionFromHeaders({cookie:`shuduo_session=${login.rawToken}`});
  for(const role of ['VIEWER','PRODUCT_MANAGER','ENGINEER']){
    const invite=f.app.auth.createInvitation(admin,{email:role.toLowerCase()+'@example.test',role}),member=f.app.auth.redeemInvitation({inviteCode:invite.inviteCode,displayName:'虚构成员',password:'SyntheticMember#2026'});
    const cookie=`shuduo_session=${member.rawToken}`;assert.equal((await fetch(base+path,{headers:{cookie}})).status,role==='ENGINEER'?200:403);
    if(role==='PRODUCT_MANAGER')assert.equal((await fetch(base+'/agent/tasks',{method:'POST',headers:{'Content-Type':'application/json',cookie,'X-Csrf-Token':member.csrfToken,'Idempotency-Key':'forbidden'},body:JSON.stringify({message:'使用原持仓分析资产',sql:'SELECT 1',contextId:'holdings-t1',syncInput:offer.selection})})).status,403);
  }
  const response=await fetch(base+'/agent/tasks',{method:'POST',headers:{'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':'wrong-archive-hash'},body:JSON.stringify({message:'使用原持仓分析资产',sql:'SELECT 1',contextId:'holdings-t1',syncInput:{...offer.selection,landingSnapshotHash:'0'.repeat(64)}})});
  assert.equal(response.status,409);assert.equal(f.app.store.list('agent',PROJECT).length,0);assert.equal(f.paid(),0);
  await assert.rejects(()=>readArchivedSyncedPositions(client,{...candidate,landingSnapshotHash:'0'.repeat(64)}));
  const remote=createV2Server({store:f.app.store,landingStore:f.app.landingStore,env:{V2_LOCAL_DEVELOPMENT:'false',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
  await new Promise(resolve=>remote.server.listen(0,'127.0.0.1',resolve));
  try{assert.equal((await fetch(`http://127.0.0.1:${remote.server.address().port}/api/v2`+path,{headers:{cookie:`shuduo_session=${login.rawToken}`}})).status,403);}
  finally{remote.server.closeAllConnections();await new Promise(resolve=>remote.server.close(resolve));}
});
