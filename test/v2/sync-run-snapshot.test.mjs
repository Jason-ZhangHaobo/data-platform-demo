import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {MetadataStore} from '../../src/v2/store.mjs';
import {IngestionManager,LandingStore} from '../../src/v2/ingestion.mjs';
import {PROJECT,createV2Server} from '../../src/v2/server.mjs';
import {syncSnapshotDigest,syncSnapshotLimits} from '../../src/v2/sync-run-snapshot.mjs';
import {syncRunSnapshotPath} from '../../src/v2/sync-run-snapshot-client.mjs';
import {StreamStateStore} from '../../src/v2/realtime.mjs';
import {BusinessQueryStore} from '../../src/v2/data-services.mjs';
import {ReportDataStore} from '../../src/v2/reports.mjs';
import {snapshotDataStores,replaceDataStores,emptyDataState,validateDataState} from '../../src/v2/data-state-replica.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';

function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'shuduo-original-sync-'));
  const store=new MetadataStore(join(root,'metadata.sqlite')),landingStore=new LandingStore(join(root,'landing.sqlite'));
  const manager=new IngestionManager({store,landingStore,project:PROJECT,fixtureRoot:resolve('fixtures/sources')});
  const source=manager.createSource({name:'虚构证券异名持仓',sourceType:'LOCAL_CSV',fileName:'positions_aliased.csv'});
  manager.testConnection(source.id);manager.collectMetadata(source.id);
  const config={name:'虚构证券原批次',sourceId:source.id,targetTable:'custom_holdings',mode:'FULL',mapping:{holding_id:'holding_id',holding_value:'amount',customer_id:'client_id'},keyFields:['holding_id']};
  const task=manager.createTask(config),run=manager.runTask(task.id,{requestKey:'full-original',requestSignature:'full-original'});
  t.after(()=>{landingStore.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,landingStore,manager,source,config,task,run};
}

test('original mapped rows survive later UPSERT, pagination, replay and SQLite reopen',t=>{
  const f=setup(t),first=f.manager.previewRunSnapshot(f.task.id,f.run.id,{page:2,pageSize:2});
  assert.equal(first.status,'VERIFIED');assert.equal(first.currentTarget.matchesOriginalRun,true);assert.equal(first.rows.length,1);assert.equal(first.rowCount,3);
  assert.deepEqual(first.columns,['amount','client_id','holding_id']);
  f.manager.createSourceRevision(f.source.id,{fileName:'positions_aliased_incremental.csv'});f.manager.testConnection(f.source.id);f.manager.collectMetadata(f.source.id);
  const next=f.manager.createTask({...f.config,mode:'INCREMENTAL_UPSERT'}),nextRun=f.manager.runTask(next.id);
  const old=f.manager.previewRunSnapshot(f.task.id,f.run.id),current=f.manager.previewRunSnapshot(next.id,nextRun.id);
  assert.equal(old.rowCount,3);assert.equal(old.rows.find(row=>row.holding_id==='POS-002').amount,'500.00');
  assert.equal(old.currentTarget.rowCount,4);assert.equal(old.currentTarget.matchesOriginalRun,false);
  assert.equal(current.rows.find(row=>row.holding_id==='POS-002').amount,'650.00');assert.equal(current.rowCount,4);
  assert.equal(f.manager.runTask(f.task.id,{requestKey:'full-original',requestSignature:'full-original'}).id,f.run.id);
  const reopen=new LandingStore(join(f.root,'landing.sqlite'));
  try {const manager=new IngestionManager({store:f.store,landingStore:reopen,project:PROJECT,fixtureRoot:resolve('fixtures/sources')});assert.deepEqual(manager.previewRunSnapshot(f.task.id,f.run.id),old);}finally{reopen.close();}
  assert.throws(()=>f.manager.previewRunSnapshot(next.id,f.run.id),{code:'SYNC_RUN_NOT_FOUND'});
  const otherProject=new IngestionManager({store:f.store,landingStore:f.landingStore,project:'other-fictional-project',fixtureRoot:resolve('fixtures/sources')});
  assert.throws(()=>otherProject.previewRunSnapshot(f.task.id,f.run.id),{status:404});
  for(const input of [{page:0},{page:2.5},{pageSize:101},{page:4,pageSize:1}])assert.throws(()=>f.manager.previewRunSnapshot(f.task.id,f.run.id,input),{code:'INVALID_SNAPSHOT_PAGE'});
});

test('archive tampering, missing archive and wrong task binding never return mutable current rows',t=>{
  const f=setup(t),record=f.landingStore.db.prepare('SELECT * FROM landing_run_snapshots').get(),original=JSON.parse(record.payload);
  const changed=structuredClone(original);changed.rows[0].amount='9999.00';
  f.landingStore.db.prepare('UPDATE landing_run_snapshots SET payload=?').run(JSON.stringify(changed));
  assert.throws(()=>f.manager.previewRunSnapshot(f.task.id,f.run.id),{code:'SYNC_SNAPSHOT_MISMATCH'});
  f.landingStore.db.prepare('UPDATE landing_run_snapshots SET payload=?').run(record.payload);
  const recachedHash=syncSnapshotDigest(changed),recachedPayload=JSON.stringify(changed);
  f.landingStore.db.prepare('UPDATE landing_run_snapshots SET payload=?,snapshot_hash=?,byte_count=?').run(recachedPayload,recachedHash,Buffer.byteLength(recachedPayload));
  f.store.update('offline_sync_run',f.run.id,PROJECT,{landingSnapshotHash:recachedHash});
  assert.throws(()=>f.manager.previewRunSnapshot(f.task.id,f.run.id),{code:'SYNC_SNAPSHOT_MISMATCH'});
  f.landingStore.db.prepare('UPDATE landing_run_snapshots SET payload=?,snapshot_hash=?,byte_count=?').run(record.payload,record.snapshot_hash,record.byte_count);
  f.store.update('offline_sync_run',f.run.id,PROJECT,{landingSnapshotHash:f.run.landingSnapshotHash});
  f.store.update('offline_sync_run',f.run.id,PROJECT,{configHash:'wrong-version'});
  assert.throws(()=>f.manager.previewRunSnapshot(f.task.id,f.run.id),{code:'SYNC_SNAPSHOT_MISMATCH'});
  f.store.update('offline_sync_run',f.run.id,PROJECT,{configHash:f.task.configHash});
  f.landingStore.db.prepare('DELETE FROM landing_run_snapshots').run();
  assert.throws(()=>f.manager.previewRunSnapshot(f.task.id,f.run.id),{code:'SYNC_SNAPSHOT_MISSING'});
  f.store.update('offline_sync_run',f.run.id,PROJECT,{snapshotStatus:undefined,landingSnapshotHash:undefined});
  const legacy=f.manager.previewRunSnapshot(f.task.id,f.run.id);
  assert.equal(legacy.status,'NOT_RETAINED');assert.equal(legacy.reason,'LEGACY_RUN');assert.equal(legacy.rows,undefined);
  f.store.update('offline_sync_run',f.run.id,PROJECT,{status:'FAILED'});
  assert.throws(()=>f.manager.previewRunSnapshot(f.task.id,f.run.id),{code:'SYNC_RUN_NOT_SUCCEEDED'});
});

test('archive and target commit atomically; repeated run id cannot overwrite rows or archive',t=>{
  const f=setup(t),before=f.landingStore.readTable(f.task.targetTable),old=f.manager.previewRunSnapshot(f.task.id,f.run.id);
  const binding={projectId:PROJECT,taskId:f.task.id,sourceId:f.source.id,sourceRevisionId:f.task.sourceRevisionId,metadataVersionId:f.task.metadataVersionId,configHash:f.task.configHash,sourceHash:f.run.sourceHash};
  assert.throws(()=>f.landingStore.sync({targetTable:f.task.targetTable,runId:f.run.id,snapshotBinding:binding,mode:'FULL',rows:[{id:'OTHER'}],mapping:{id:'id'},keyFields:['id'],sourceHash:'another',syncedAt:'2026-11-18T00:00:00Z'}));
  assert.deepEqual(f.landingStore.readTable(f.task.targetTable),before);assert.deepEqual(f.manager.previewRunSnapshot(f.task.id,f.run.id),old);
  f.landingStore.db.prepare("UPDATE landing_rows SET payload='broken' WHERE row_key='POS-001'").run();
  const checked=f.manager.previewRunSnapshot(f.task.id,f.run.id);assert.equal(checked.status,'VERIFIED');assert.equal(checked.currentTarget.status,'UNCONFIRMED');assert.equal(checked.rows.length,3);
});

test('row, per-snapshot byte and total retention caps retain successful sync summary without inventing an archive',()=>{
  const store=new LandingStore();
  const sync=(id,rows)=>store.sync({runId:id,snapshotBinding:{taskId:'fictional'},targetTable:'bounded_holdings',mode:'FULL',rows,mapping:{id:'id',value:'value'},keyFields:['id'],sourceHash:'fictional',syncedAt:'2026-11-18T00:00:00Z'});
  try {
    const big=sync('oversized',[{id:'ONE',value:'x'.repeat(syncSnapshotLimits.bytes)}]);assert.equal(big.snapshotStatus,'NOT_RETAINED_LIMIT');assert.equal(big.finalCount,1);
    const many=sync('many',Array.from({length:syncSnapshotLimits.rows+1},(_,i)=>({id:String(i),value:'1'})));assert.equal(many.snapshotStatus,'NOT_RETAINED_LIMIT');
    for(let i=0;i<9;i++)sync('retained-'+i,[{id:'ONE',value:'x'.repeat(980000)}]);
    const count=store.db.prepare('SELECT COUNT(*) AS n,SUM(byte_count) AS bytes FROM landing_run_snapshots').get();assert.equal(count.n,8);assert.ok(count.bytes<=syncSnapshotLimits.totalBytes);
    assert.equal(store.readTable('bounded_holdings').length,1);
  }finally{store.close();}
});

test('snapshot business rows restore with the data plane, while legacy wire payload is not rewritten',t=>{
  const f=setup(t),stores={landingStore:f.landingStore,streamStateStore:new StreamStateStore(),businessStore:new BusinessQueryStore(),reportStore:new ReportDataStore()};
  const restored={landingStore:new LandingStore(),streamStateStore:new StreamStateStore(),businessStore:new BusinessQueryStore(),reportStore:new ReportDataStore()};
  try{
    const payload=snapshotDataStores(stores,PROJECT);assert.equal(payload.tables.landingRunSnapshots.length,1);
    replaceDataStores(restored,payload,PROJECT);
    const manager=new IngestionManager({store:f.store,landingStore:restored.landingStore,project:PROJECT,fixtureRoot:resolve('fixtures/sources')});assert.deepEqual(manager.previewRunSnapshot(f.task.id,f.run.id),f.manager.previewRunSnapshot(f.task.id,f.run.id));
    const legacy=emptyDataState(PROJECT);delete legacy.tables.landingRunSnapshots;const original=JSON.stringify(legacy);validateDataState(legacy,PROJECT);assert.equal(JSON.stringify(legacy),original);replaceDataStores(restored,legacy,PROJECT);
    assert.equal(restored.landingStore.db.prepare('SELECT COUNT(*) AS n FROM landing_run_snapshots').get().n,0);
  }finally{for(const [key,store] of Object.entries(stores))if(key!=='landingStore')store.close();for(const store of Object.values(restored))store.close();}
});

test('API, CLI and MCP read the same original batch with no writes or compute; malformed scope and sessions rejected',async t=>{
  const f=setup(t),app=createV2Server({store:f.store,landingStore:f.landingStore,fixtureRoot:resolve('fixtures/sources'),env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${app.server.address().port}/api/v2`,path=syncRunSnapshotPath({taskId:f.task.id,runId:f.run.id,page:2,pageSize:2});
    const response=await fetch(base+path);assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.rows.length,1);
    let result;const client=new V2Client({baseUrl:base});
    assert.equal(await runV2Cli(['sync','snapshot','--id',f.task.id,'--run-id',f.run.id,'--page','2','--page-size','2'],{},{client,output:text=>{result=JSON.parse(text);},error:()=>{}}),0);assert.deepEqual(result,receipt);
    const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sync_run_snapshot',arguments:{taskId:f.task.id,runId:f.run.id,page:2,pageSize:2}}},{client}));assert.deepEqual(mcp.result.structuredContent,receipt);
    for(const suffix of ['&page=1','&actorId=other','&pageSize=101'])assert.equal((await fetch(base+path+suffix)).status,422);
    assert.equal((await fetch(base+path,{headers:{Cookie:'shuduo_session=invalid'}})).status,403);
    assert.equal((await fetch(base+path,{headers:{Authorization:'Bearer invalid'}})).status,403);
    app.auth.bootstrapAdmin({email:'admin@example.test',password:'SyntheticAdmin#2026',displayName:'虚构管理员'});
    const adminLogin=app.auth.login({email:'admin@example.test',password:'SyntheticAdmin#2026'}),admin=app.auth.sessionFromHeaders({cookie:`shuduo_session=${adminLogin.rawToken}`});
    for(const role of ['VIEWER','PRODUCT_MANAGER','ENGINEER']){
      const invite=app.auth.createInvitation(admin,{email:role.toLowerCase()+'@example.test',role});
      const member=app.auth.redeemInvitation({inviteCode:invite.inviteCode,displayName:'虚构成员',password:'SyntheticMember#2026'});
      assert.equal((await fetch(base+path,{headers:{cookie:`shuduo_session=${member.rawToken}`}})).status,role==='ENGINEER'?200:403);
    }
    assert.equal(f.store.list('offline_sync_run',PROJECT).length,1);
    const remote=createV2Server({store:f.store,landingStore:f.landingStore,fixtureRoot:resolve('fixtures/sources'),env:{V2_LOCAL_DEVELOPMENT:'false',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
    await new Promise(resolve=>remote.server.listen(0,'127.0.0.1',resolve));
    try {assert.equal((await fetch(`http://127.0.0.1:${remote.server.address().port}/api/v2`+path,{headers:{cookie:`shuduo_session=${adminLogin.rawToken}`}})).status,403);}
    finally {remote.server.closeAllConnections();await new Promise(resolve=>remote.server.close(resolve));remote.releaseScheduler.shutdown();}
  }finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.releaseScheduler.shutdown();}
});

test('snapshot path rejects encoded/slashed identifiers and invalid pagination before transport',()=>{
  const taskId='00000000-0000-4000-8000-000000000001',runId='00000000-0000-4000-8000-000000000002';
  for(const input of [{taskId:'../other',runId},{taskId,runId:'%2Fother'},{taskId,runId:runId+'\n'},{taskId,runId,page:0},{taskId,runId,pageSize:1000}])assert.throws(()=>syncRunSnapshotPath(input));
  assert.equal(syncSnapshotDigest({a:1,b:2}),syncSnapshotDigest({b:2,a:1}));
});
