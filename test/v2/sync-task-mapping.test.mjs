import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore} from '../../src/v2/store.mjs';
import {IngestionManager,LandingStore} from '../../src/v2/ingestion.mjs';
import {newSyncMappingDraft,syncMappingProblem,syncTaskMappingFields} from '../../web/src/sync-task-mapping.ts';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

const metadata={id:'meta-v1',revisionId:'source-v1',schemaHash:'schema-v1',columns:[
  {name:'holding_id',type:'STRING',nullable:false},{name:'customer_id',type:'STRING',nullable:false},
  {name:'holding_value',type:'DECIMAL(18,2)',nullable:false},{name:'biz_date',type:'DATE',nullable:false}]};
const configure=(meta=metadata)=>({...newSyncMappingDraft('source-one',meta),mapping:{holding_id:'position_id',customer_id:'client_id',holding_value:'market_value',biz_date:'trade_date'},keySources:['holding_id'],watermarkSource:'biz_date'});

test('renaming a target retains its source-selected key and watermark without mutating metadata',()=>{
  const draft=configure(),before=JSON.stringify(metadata);
  assert.equal(syncMappingProblem(draft,'source-one',metadata),undefined);
  assert.deepEqual(syncTaskMappingFields(draft,'source-one',metadata),{sourceRevisionId:'source-v1',metadataVersionId:'meta-v1',mapping:draft.mapping,keyFields:['position_id'],watermarkField:'trade_date'});
  const renamed={...draft,mapping:{...draft.mapping,holding_id:'holding_key',biz_date:'business_day'}};
  assert.deepEqual(syncTaskMappingFields(renamed,'source-one',metadata).keyFields,['holding_key']);
  assert.equal(syncTaskMappingFields(renamed,'source-one',metadata).watermarkField,'business_day');
  assert.equal(JSON.stringify(metadata),before);
});

test('skip, duplicate targets, missing roles and stale metadata must be resolved before create',()=>{
  const draft=configure();
  assert.match(syncMappingProblem({...draft,mapping:{...draft.mapping,holding_value:'client_id'}},'source-one',metadata),/只能映射一次/);
  assert.match(syncMappingProblem({...draft,mapping:{...draft.mapping,holding_id:''}},'source-one',metadata),/主键/);
  assert.match(syncMappingProblem({...draft,mapping:{...draft.mapping,biz_date:''}},'source-one',metadata),/水位/);
  assert.match(syncMappingProblem({...draft,mapping:{...draft.mapping,holding_value:'Not Valid'}},'source-one',metadata),/小写字母/);
  assert.match(syncMappingProblem(draft,'other-source',metadata),/版本|元数据/);
  const skipped={...draft,mapping:{...draft.mapping,holding_value:''}};
  assert.equal(syncTaskMappingFields(skipped,'source-one',metadata).mapping.holding_value,undefined);
  const next={...metadata,id:'meta-v2',revisionId:'source-v2'};
  assert.throws(()=>syncTaskMappingFields(draft,'source-one',next),/变化/);
  const adopted=newSyncMappingDraft('source-one',next,draft);
  assert.deepEqual(adopted.mapping,draft.mapping);assert.deepEqual(adopted.keySources,['holding_id']);
  assert.equal(syncMappingProblem(adopted,'source-one',next),undefined);
  const removed={...next,id:'meta-v3',columns:next.columns.filter(c=>c.name!=='holding_id')};
  assert.match(syncMappingProblem(newSyncMappingDraft('source-one',removed,draft),'source-one',removed),/主键/);
});

test('aliased securities CSV maps to canonical rows through actual FULL and incremental writes',t=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-manual-mapping-')),store=new MetadataStore(join(root,'metadata.sqlite')),landing=new LandingStore(join(root,'landing.sqlite'));
  t.after(()=>{landing.close();store.close();rmSync(root,{recursive:true,force:true});});
  const manager=new IngestionManager({store,landingStore:landing,project:'mapping-project',fixtureRoot:resolve('fixtures/sources')});
  const source=manager.createSource({name:'虚构异名证券持仓',sourceType:'LOCAL_CSV',fileName:'positions_aliased.csv'});
  manager.testConnection(source.id);const first=manager.collectMetadata(source.id);
  let draft=newSyncMappingDraft(source.id,first);
  draft={...draft,mapping:{...draft.mapping,holding_id:'position_id',customer_id:'client_id',holding_value:'market_value',biz_date:'trade_date'},keySources:['holding_id'],watermarkSource:'biz_date'};
  const input={name:'异名持仓全量',sourceId:source.id,targetTable:'mapped_positions',mode:'FULL',...syncTaskMappingFields(draft,source.id,first)};
  const full=manager.createTask(input);assert.equal(manager.runTask(full.id).status,'SUCCEEDED');
  assert.equal(landing.readTable('mapped_positions').length,3);
  manager.createSourceRevision(source.id,{fileName:'positions_aliased_incremental.csv'});manager.testConnection(source.id);const second=manager.collectMetadata(source.id);
  const before=store.list('offline_sync_task','mapping-project').length;
  assert.throws(()=>manager.createTask(input),error=>error.code==='SYNC_SOURCE_BINDING_CHANGED');
  assert.equal(store.list('offline_sync_task','mapping-project').length,before);
  draft=newSyncMappingDraft(source.id,second,draft);
  const incremental=manager.createTask({...input,name:'异名持仓增量',mode:'INCREMENTAL_UPSERT',...syncTaskMappingFields(draft,source.id,second)});
  assert.equal(manager.runTask(incremental.id).status,'SUCCEEDED');
  const rows=landing.readTable('mapped_positions');
  assert.deepEqual(rows.map(r=>[r.position_id,r.client_id,r.market_value,r.trade_date]),[
    ['POS-001','CLIENT-001','1000.00','2026-09-10'],['POS-002','CLIENT-001','650.00','2026-09-11'],
    ['POS-003','CLIENT-002','750.00','2026-09-10'],['POS-004','CLIENT-003','1200.00','2026-09-11']]);
  assert.ok(rows.every(r=>!Object.hasOwn(r,'holding_id')&&!Object.hasOwn(r,'holding_value')));
  assert.deepEqual(incremental.keyFields,['position_id']);assert.equal(incremental.watermarkField,'trade_date');
  assert.throws(()=>manager.createTask({...input,sourceRevisionId:undefined,metadataVersionId:second.id}),error=>error.code==='SYNC_SOURCE_BINDING_REQUIRED');
});

test('CLI and MCP pass reviewed source versions through the same sync create body',async()=>{
  const calls=[],client={request:async(path,options)=>{calls.push({path,...options});return {id:'created-task'};}};
  const code=await runV2Cli(['sync','create','--name','虚构证券映射','--source-id','source-one','--target-table','mapped_positions','--mode','full','--mapping','holding_id:position_id,biz_date:trade_date','--keys','position_id','--watermark','trade_date','--source-revision-id','source-v1','--metadata-version-id','meta-v1'],{}, {client,output:()=>{},error:()=>{}});
  assert.equal(code,0);assert.equal(calls[0].body.sourceRevisionId,'source-v1');assert.equal(calls[0].body.metadataVersionId,'meta-v1');
  const reply=await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sync_task_create',arguments:calls[0].body}},{client});
  assert.equal(reply.error,undefined);assert.deepEqual(calls[1].body,calls[0].body);
});

test('each composite-key field must be present and failed merges leave actual target rows unchanged',()=>{
  const landing=new LandingStore();
  try{
    const input={targetTable:'composite_positions',mode:'FULL',mapping:{client:'client_id',position:'position_id'},keyFields:['client_id','position_id'],sourceHash:'fixture-hash',syncedAt:'2026-09-10T00:00:00Z'};
    landing.sync({...input,rows:[{client:'CLIENT-001',position:'POS-001'}]});
    const before=landing.readTable(input.targetTable);
    for(const position of [null,undefined,'','   '])assert.throws(()=>landing.sync({...input,mode:'INCREMENTAL_UPSERT',rows:[{client:'CLIENT-001',position}]}),error=>error.code==='EMPTY_SYNC_KEY');
    assert.throws(()=>landing.sync({...input,rows:[{client:'CLIENT-001',position:'A\u001fB'}]}),error=>error.code==='INVALID_SYNC_KEY_VALUE');
    assert.deepEqual(landing.readTable(input.targetTable),before);
  }finally{landing.close();}
});
