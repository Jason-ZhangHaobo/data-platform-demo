import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataStore} from '../../src/v2/store.mjs';
import {getContext} from '../../src/v2/context.mjs';
import {outputContractForContext} from '../../src/v2/output-contracts.mjs';
import {distributionDeliveryBinding} from '../../src/v2/distribution-delivery.mjs';
import {createDeliveryPackage,validateDeliveryPackage,deliveryFiles,createTestSql,computeManifestDigest,sha256} from '../../src/v2/delivery.mjs';
import {requirementDeliverySource} from './fixtures/requirement-delivery.mjs';
const resign=b=>{for(const name of deliveryFiles)b.manifest.files[name]={sha256:sha256(b.files[name]),bytes:Buffer.byteLength(b.files[name])};b.digest=computeManifestDigest(b.manifest);return b;};
function source(t,contextId='holdings-asset-class-t1'){
 const store=new MetadataStore(':memory:');t.after(()=>store.close());return requirementDeliverySource(store,'synthetic-distribution-project',{contextId,isolation:'LOCAL_PROCESS'});
}
test('distribution eight-file package freezes its metadata, requirement and six-place composite assertions while legacy SQL stays unchanged',t=>{
 for(const id of ['holdings-asset-class-t1','holdings-industry-t1']){
  const f=source(t,id),bundle=createDeliveryPackage(f),plan=validateDeliveryPackage(bundle,bundle.digest);
  assert.deepEqual(Object.keys(bundle.files).sort(),[...deliveryFiles].sort());assert.equal(Object.keys(bundle.files).length,8);
  assert.deepEqual(bundle.manifest.source.outputContract,distributionDeliveryBinding(id));assert.deepEqual(plan.fixtures.outputContract,outputContractForContext(id));
  assert.equal(plan.requirements.basis.metrics.length,6);assert.equal(plan.requirements.basis.grain,outputContractForContext(id).grain);
  assert.match(bundle.files['tests.sql'],/market_value_ratio = CAST\('0.666667' AS DECIMAL\(20,6\)\)/);
  assert.match(bundle.files['tests.sql'],/trade_date = '2026-09-10'/);assert.match(bundle.files['tests.sql'],/COUNT\(\*\) = 3/);
  assert.doesNotMatch(bundle.files['tests.sql'],/COUNT\(DISTINCT client_id\)|CAST\(market_value_ratio/);
 }
 const legacy=getContext('holdings-t1');assert.equal(createTestSql(legacy.expected),createTestSql(legacy.expected,legacy.id));
});
test('changed metadata, downgraded precision, constant-pass SQL and missing bindings fail even with fully recomputed file/manifest hashes',t=>{
 const f=source(t),original=createDeliveryPackage(f);
 for(const mutate of [b=>delete b.manifest.source.outputContract,b=>b.manifest.source.outputContract.metadataHash='0'.repeat(64),
  b=>{const j=JSON.parse(b.files['fixtures.json']);j.outputContract.fields.at(-1).scale=2;b.files['fixtures.json']=JSON.stringify(j);},
  b=>{const j=JSON.parse(b.files['fixtures.json']);j.outputContract.keyFields=['client_id'];b.files['fixtures.json']=JSON.stringify(j);},
  b=>b.files['tests.sql']=b.files['tests.sql'].replaceAll('DECIMAL(20,6)','DECIMAL(20,2)'),
  b=>b.files['tests.sql']='SELECT true AS passed FROM __shuduo_result',
  b=>{const j=JSON.parse(b.files['fixtures.json']);j.extra='unsupported';b.files['fixtures.json']=JSON.stringify(j);},
  b=>{const j=JSON.parse(b.files['deployment.json']);j.adapter='remote-spark-worker-v1';j.environment='cloud-isolated-rehearsal';j.runtime.driverMemoryMiB=2048;b.files['deployment.json']=JSON.stringify(j);},
 ]){const b=structuredClone(original);mutate(b);resign(b);assert.throws(()=>validateDeliveryPackage(b,b.digest));}
});
test('claimed success cannot freeze duplicate/wrong groups, test doubles, remote runs or missing Agent understanding',t=>{
 const f=source(t);
 for(const mutate of [v=>v.run.rows[0].market_value_ratio='0.000000',v=>v.run.rows.push({...v.run.rows[0]}),v=>v.run.testDouble=true,v=>v.run.mainSqlExecuted=false,v=>v.run.isolation='FUNCTION_PROCESS',v=>{delete v.agent;delete v.revision.requirementBinding;}]){
  const v=structuredClone(f);mutate(v);assert.throws(()=>createDeliveryPackage(v));
 }
});
