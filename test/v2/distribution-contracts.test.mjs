import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {allContextIds,classicContextIds,getContext,publicContext,referenceSqlForContext,validationFamilyForContext} from '../../src/v2/context.mjs';
import {distributionContextIds,outputContractForContext,verifyOutputRows} from '../../src/v2/output-contracts.mjs';
import {validationFamilyForContextId} from '../../web/src/validation-family.ts';
import {createDeliveryPackage} from '../../src/v2/delivery.mjs';

const modulePath=fileURLToPath(new URL('../../src/v2',import.meta.url));
const harness=String.raw`
import sys,json,copy
sys.path.insert(0,sys.argv[1])
from output_contracts import registered_contract,preflight_contexts,verify_output
v=json.load(sys.stdin)
try:
 if v['op']=='verify':out=verify_output(v['rows'],v['context'])
 else:preflight_contexts(v['context'],v.get('others',[]));out={'passed':True}
except Exception as e:out={'rejected':True,'error':str(e)}
print(json.dumps(out,ensure_ascii=False))
`;
function check(context,rows=context.expected,op='verify',others=[]){
 const r=spawnSync('python3',['-c',harness,modulePath],{input:JSON.stringify({context,rows,op,others}),encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('distribution contracts are explicit, independent of old ten contexts and never expose expected answers',()=>{
 assert.equal(allContextIds.length,10);assert.equal(distributionContextIds.length,10);
 assert.deepEqual(classicContextIds, [...allContextIds, ...distributionContextIds, 'synthetic-fund-lookthrough-t1']);
 for(const id of distributionContextIds){
  const c=getContext(id),pub=publicContext(id),contract=outputContractForContext(id),family=validationFamilyForContext(id);
  assert.deepEqual(validationFamilyForContextId(id).contextIds,family.contextIds);assert.equal(validationFamilyForContextId(id).id,family.id);
  assert.equal(family.contextIds.length,5);assert.equal(family.id,c.outputContractId);assert.equal(contract.keyFields.length,3);
  assert.equal(pub.capabilities.agentDevelopment,true);assert.equal(pub.capabilities.delivery,true);assert.equal(pub.capabilities.scope,'LOCAL_ONLY');
  assert(!Object.hasOwn(pub,'expected'));assert(!Object.hasOwn(pub.outputContract,'cases'));
  assert(verifyOutputRows(c.expected,c));assert(check(c).passed);assert(check(c,c.expected,'preflight',family.contextIds.map(getContext)).passed);
  assert.match(referenceSqlForContext(id),/COUNT\(DISTINCT p.security_code\)/);
 }
});
test('known literal answers cover two groups, duplicate holdings, equal amount distinct positions, cash only and changed cash/blank labels/zero divisor',()=>{
 for(const d of ['asset-class','industry']){
  const base=getContext(`holdings-${d}-t1`),dup=getContext(`holdings-${d}-duplicate`),equal=getContext(`holdings-${d}-equal`),zero=getContext(`holdings-${d}-unclassified-zero`);
  assert.deepEqual(dup.expected,base.expected);assert.equal(base.expected[0].market_value_ratio,'0.666667');
  assert.equal(equal.expected[0].holding_market_value,'2000.00');assert.equal(equal.expected[0].security_count,1);
  assert.equal(zero.expected.at(-1).market_value_ratio,'0.000000');assert.equal(getContext(`holdings-${d}-cash-only`).expected.at(-1).security_count,0);
 }
});
test('composite verifier rejects duplicate keys, wrong precision/types/ratios, dates, missing/extra fields and unknown rows without echoing untrusted labels',()=>{
 const c=getContext('holdings-asset-class-t1');
 const variants=[r=>r.push({...r[0]}),r=>r[0].market_value_ratio='0.6666667',r=>r[0].market_value_ratio=true,r=>r[0].security_count='1.1',r=>r[0].holding_market_value='1000.001',r=>r[0].trade_date='2026-09-09',r=>delete r[0].asset_class,r=>r[0].extra='hidden',r=>r[0].asset_class='PRIVATE_UNTRUSTED_LABEL',r=>r[0].client_id=[],r=>r[0].market_value_ratio='2',r=>r[0].holding_market_value='NaN'];
 for(const mutate of variants){const rows=structuredClone(c.expected);mutate(rows);const result=check(c,rows);assert.equal(result.passed,false);assert(!JSON.stringify(result).includes('PRIVATE_UNTRUSTED_LABEL'));assert.equal(verifyOutputRows(rows,c),false);}
});
test('registry rejects caller oracle/schema swaps, missing contract identity and mixed regression contracts before any Spark work',()=>{
 const c=getContext('holdings-asset-class-t1');
 for(const mutate of [v=>v.expected[0].holding_market_value='9.00',v=>delete v.outputContractId,v=>v.outputContractId='untrusted',v=>v.id='unregistered']){
  const v=structuredClone(c);mutate(v);assert.equal(check(v,v.expected,'preflight').rejected,true);
 }
 assert.equal(check(c,c.expected,'preflight',[getContext('holdings-industry-t1')]).rejected,true);
 assert.equal(check(getContext('holdings-t1'),[], 'preflight',[c]).rejected,true);
});
test('input preflight rejects conflicting position IDs and negative values, scopes to advisor/date, and leaves literal reference unchanged',()=>{
 const c=getContext('holdings-industry-t1'),positions=c.tables.find(t=>t.name==='positions');
 const conflict=structuredClone(c);conflict.tables.find(t=>t.name==='positions').rows.push([...positions.rows[0].slice(0,5),'2000.00',positions.rows[0][6]]);
 assert.match(check(conflict,[],'preflight').error,/冲突/);
 const negative=structuredClone(c);negative.tables.find(t=>t.name==='positions').rows[0][5]='-1.00';assert.equal(check(negative,[],'preflight').rejected,true);
 const outside=structuredClone(c);outside.tables.find(t=>t.name==='positions').rows.at(-1)[5]='-1.00';assert.equal(check(outside,[],'preflight').passed,true);
 const oversized=structuredClone(c);oversized.tables.find(t=>t.name==='positions').rows[0][5]='10000000000000000.00';assert.match(check(oversized,[],'preflight').error,/DECIMAL/);
 assert.equal(check(c,[],'preflight').passed,true);
 assert.throws(()=>createDeliveryPackage({revision:{contextId:c.id}}),/本机真实Spark/);
});
