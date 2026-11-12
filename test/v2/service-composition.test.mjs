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

test('distribution composition choices preserve contract, release batch and immutable snapshot while legacy choices stay separate',()=>{
 const item=(id,run,hash,fields)=>({...dapi(id,id+'-v1',run,fields),publishedVersion:{id:id+'-v1',sourceReleaseRunId:run,snapshotHash:hash,outputContractId:'distribution-contract',fields}});
 const services=[item('values','run-a','hash-a',['holding_market_value']),item('ratio','run-a','hash-a',['market_value_ratio']),item('other-batch','run-b','hash-b',['market_value_ratio']),dapi('legacy','v-legacy','run-a',['available_cash'])];
 const c=compositionChoices(services,{...base,privateCloud:false,outputContractId:'distribution-contract'});assert.equal(c.holdings.id,'values');assert.deepEqual(c.cashOptions.map(s=>s.id),['ratio']);assert.equal(c.cash.id,'ratio');assert.equal(compositionChoices(services,{...base,privateCloud:false}).holdings,undefined);
});

test("fund picker offers amount and ratio from the selected batch and identical snapshot", () => {
  const contract = "securities-fund-lookthrough-v1";
  const service = (id, fields, batch = "fund-one", snapshot = "same") => ({
    id, serviceType: "DAPI", status: "PUBLISHED",
    publishedVersion: { id: id + "-v1", fields, outputContractId: contract, sourceReleaseRunId: batch, snapshotHash: snapshot },
  });
  const options = { privateCloud: false, sourceRunId: "fund-one", holdingsVersionId: "", cashVersionId: "", outputContractId: contract };
  const choices = compositionChoices([
    service("amount", ["exposure_amount"]),
    service("ratio", ["exposure_ratio"]),
    service("all", ["exposure_amount", "exposure_ratio"]),
    service("different-snapshot", ["exposure_ratio"], "fund-one", "other"),
    service("different-batch", ["exposure_ratio"], "fund-two"),
  ], options);
  assert.equal(choices.holdings.id, "amount");
  assert.equal(choices.cash.id, "ratio");
  assert.deepEqual(choices.cashOptions.map(option => option.id), ["ratio"]);
});
