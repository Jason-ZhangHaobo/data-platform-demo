import test from 'node:test';
import assert from 'node:assert/strict';
import {compositionChoices} from '../../web/src/service-composition.ts';
const dapi=(id,version,source,fields)=>({id,serviceType:'DAPI',status:'PUBLISHED',publishedVersion:{id:version,sourceReleaseRunId:source,fields}});
const base={privateCloud:true,sourceRunId:'current-run',holdingsVersionId:'',cashVersionId:''};
test('new composition ignores previous-task APIs and allows additional XAPIs without changing existing versions',()=>{
  const services=[dapi('old-h','old-v','old-run',['holding_market_value']),{id:'old-x',serviceType:'XAPI',status:'PUBLISHED'},
    dapi('new-h','h-v1','current-run',['holding_market_value','security_count']),dapi('new-c','c-v1','current-run',['available_cash','total_assets'])];
  const c=compositionChoices(services,base);assert.equal(c.holdings.id,'new-h');assert.equal(c.cash.id,'new-c');
  assert.deepEqual(c.holdingsOptions.map(s=>s.id),['new-h']);
  assert.equal(services[0].publishedVersion.id,'old-v');
  assert.equal(compositionChoices(services,{...base,sourceRunId:''}).holdings,undefined);
});
test('explicit stale versions and duplicate DAPI selection cannot silently become a different reviewed composition',()=>{
  const full=dapi('full','full-v1','current-run',['holding_market_value','available_cash']);
  assert.equal(compositionChoices([full],base).cash,undefined);
  const services=[full,dapi('cash','cash-v1','current-run',['available_cash'])];
  const c=compositionChoices(services,{...base,holdingsVersionId:'missing-version'});assert.equal(c.holdings,undefined);
  assert.equal(compositionChoices(services,{...base,cashVersionId:'full-v1'}).cash,undefined);
  const draft={...full,currentVersion:{id:'draft-v2',fields:['available_cash']}};
  assert.equal(compositionChoices([draft,services[1]],base).holdings.publishedVersion.id,'full-v1');
});
