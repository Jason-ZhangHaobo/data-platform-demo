import test from 'node:test';
import assert from 'node:assert/strict';
import { getContext } from '../../src/v2/context.mjs';
import { customerAssetMetrics } from '../../src/v2/customer-asset-analysis.mjs';

const base = getContext('holdings-t1');
const date = base.businessDate;
const first = 'CLIENT-001', second = 'CLIENT-002', other = 'CLIENT-003';
const snapshot = (positions,cash=[]) => {
  const context=structuredClone(base);
  context.tables.find(t=>t.name==='positions').rows=positions;
  context.tables.find(t=>t.name==='cash').rows=cash;
  return context;
};
const holding=(position,client,code,category,sector,value,tradeDate=date)=>[position,client,code,category,sector,value,tradeDate];
const result=(id,holdings,cash,total,count)=>({client_id:id,holding_market_value:holdings,available_cash:cash,total_assets:total,security_count:count});
const group=(label,marketValue,ratio)=>({label,marketValue,ratio});

test('uses customer/date grain, independent cash and unique securities for both distributions',()=>{
  const firstLot=holding('POS-1',first,'SEC-A','股票','金融','0.01');
  const context=snapshot([
    firstLot,[...firstLot],holding('POS-2',first,'SEC-A','股票','金融','0.01'),
    holding('POS-3',first,'SEC-B','债券','公共事业','0.01'),
    holding('POS-4',first,'SEC-C',null,' ',null),
    holding('POS-5',other,'SEC-X','基金','信息技术','9999.99'),
    holding('POS-6',first,'SEC-X','基金','信息技术','8888.88','2026-09-09'),
  ],[[first,'2.00',date],[first,'1.00',date],[second,'-0.25',date],[first,'900.00','2026-09-09'],[other,'100.00',date]]);
  const customers=customerAssetMetrics(context,[result(second,'0.00','-0.25','-0.25',0),result(first,'0.03','3.00','3.03',3)]);
  const [a,b]=customers;
  assert.deepEqual([a.clientLabel,a.totalAssets,a.holdingMarketValue,a.availableCash,a.securityCount,a.nullMarketValueCount],
    ['CLI***001','3.03','0.03','3.00',3,1]);
  assert.deepEqual(a.assetClasses,[group('股票','0.02','0.666667'),group('债券','0.01','0.333333'),group('未分类','0.00','0.000000')]);
  assert.deepEqual(a.industries,[group('金融','0.02','0.666667'),group('公共事业','0.01','0.333333'),group('未分类','0.00','0.000000')]);
  assert.equal(b.securityCount,0);
  assert.equal(b.totalAssets,'-0.25');
  assert.deepEqual(b.assetClasses,[group('未持仓','0.00','0.000000')]);
  assert.deepEqual(b.industries,b.assetClasses);
  assert.match(a.customerKey,/^[a-f0-9]{64}$/);
  assert.notEqual(a.customerKey,b.customerKey);
  assert.ok(!JSON.stringify(customers).includes(first));
});

test('retains true zero-valued holdings separately from no holdings and uses integer ratio arithmetic',()=>{
  const context=snapshot([holding('P1',first,'A','股票','金融','0.00'),holding('P2',second,'B','股票','金融','9999999999999.99'),
    holding('P3',second,'C','债券','其他','0.01')]);
  const [zero,large]=customerAssetMetrics(context,[
    result(first,'0.00','0','0',1),result(second,'10000000000000','0','10000000000000.00',2)]);
  assert.deepEqual(zero.assetClasses,[group('股票','0.00','0.000000')]);
  assert.equal(zero.nullMarketValueCount,0);
  assert.deepEqual(large.assetClasses,[group('股票','9999999999999.99','1.000000'),group('债券','0.01','0.000000')]);
});

test('unconfirmed published totals, customer sets or conflicting lots fail without producing slices',()=>{
  const context=snapshot([holding('P1',first,'A','股票','金融','1.00')]);
  const rows=[result(first,'1.00','0.00','1.00',1),result(second,'0','0','0',0)];
  for(const patch of [{total_assets:'10.00'},{available_cash:null},{security_count:9},{holding_market_value:'0.99'}]){
    assert.throws(()=>customerAssetMetrics(context,[{...rows[0],...patch},rows[1]]),{code:'CUSTOMER_ANALYSIS_UNPROVEN'});
  }
  for (const invalid of [[rows[0]],[...rows,rows[0]],[rows[0],{...rows[1],client_id:other}]]){
    assert.throws(()=>customerAssetMetrics(context,invalid),{code:'CUSTOMER_ANALYSIS_UNPROVEN'});
  }
  context.tables.find(t=>t.name==='positions').rows.push(holding('P1',first,'A','债券','金融','1.00'));
  assert.throws(()=>customerAssetMetrics(context,rows),{code:'CUSTOMER_ANALYSIS_UNPROVEN'});
  const negative=snapshot([holding('P1',first,'A','股票','金融','-1.00')]);
  assert.throws(()=>customerAssetMetrics(negative,[result(first,'-1','0','-1',1),rows[1]]),
    {status:422,code:'CUSTOMER_ANALYSIS_NEGATIVE_HOLDING'});
});
