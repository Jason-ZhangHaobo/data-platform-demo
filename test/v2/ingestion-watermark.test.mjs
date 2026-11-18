import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ingestionWatermark} from '../../src/v2/ingestion-watermark.mjs';
import {IngestionManager,LandingStore} from '../../src/v2/ingestion.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';

test('watermarks follow numeric type and exact decimal precision, while text and date retain their order',()=>{
  const max=(values,type)=>ingestionWatermark(values.map(value=>({value})),'value',[{name:'value',type}]);
  assert.equal(max(['9','10'],'BIGINT'),'10');
  assert.equal(max(['9007199254740993','9007199254740992'],'BIGINT'),'9007199254740993');
  assert.equal(max(['-2.10','-2.09','-10'],'DECIMAL(18,2)'),'-2.09');
  assert.equal(max(['1e2','99.9'],'DOUBLE'),'1e2');
  assert.equal(max(['9','10'],'STRING'),'9');
  assert.equal(max([null,'2026-09-10','2026-09-11'],'DATE'),'2026-09-11');
  assert.equal(max([null,undefined],'BIGINT'),undefined);
  assert.throws(()=>max(['1','invalid'],'BIGINT'),error=>error.code==='INVALID_WATERMARK_VALUE');
});

test('actual CSV synchronization records numeric maximum 10 rather than lexical 9',t=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-watermark-'));
  writeFileSync(join(root,'numeric.csv'),'position_id,update_seq\nPOS-001,9\nPOS-002,10\n');
  const store=new MetadataStore(join(root,'metadata.sqlite')),landing=new LandingStore(join(root,'landing.sqlite'));
  t.after(()=>{landing.close();store.close();rmSync(root,{recursive:true,force:true});});
  const manager=new IngestionManager({store,landingStore:landing,project:'numeric-watermark',fixtureRoot:root});
  const source=manager.createSource({name:'虚构证券数字水位',sourceType:'LOCAL_CSV',fileName:'numeric.csv'});
  manager.testConnection(source.id);manager.collectMetadata(source.id);
  const task=manager.createTask({name:'数字水位同步',sourceId:source.id,targetTable:'numeric_positions',mode:'FULL',mapping:{position_id:'position_id',update_seq:'change_seq'},keyFields:['position_id'],watermarkField:'change_seq'});
  const run=manager.runTask(task.id);assert.equal(run.status,'SUCCEEDED');assert.equal(run.watermark,'10');
  assert.equal(landing.readTable('numeric_positions').length,2);
});
