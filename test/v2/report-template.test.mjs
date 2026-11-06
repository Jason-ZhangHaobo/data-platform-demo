import test from 'node:test';
import assert from 'node:assert/strict';
import { securitiesReportTemplate } from '../../web/src/report-template.ts';

test('published customer assets include cash and holdings without invented distributions or global security count', () => {
  const fields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
  const {widgets,notes}=securitiesReportTemplate(fields);
  assert.deepEqual(widgets.map(w=>w.id),['total_assets','holding_value','available_cash','client_security_count','client_assets']);
  assert.equal(widgets.find(w=>w.id==='client_security_count').dimension,'client_id');
  assert(notes.some(n=>/不能计算全体客户/.test(n)));
  assert(notes.some(n=>/每客户一行/.test(n)));
  assert(notes.some(n=>/asset_class/.test(n)));
  assert(notes.some(n=>/industry/.test(n)));
});

test('raw holdings produce only dimensions present in the selected dataset', () => {
  const complete=['market_value','security_code','asset_class','industry'];
  assert.deepEqual(securitiesReportTemplate(complete).widgets.map(w=>w.id),['holding_value','security_count','asset_class_distribution','industry_distribution']);
  const partial=securitiesReportTemplate(['market_value','industry']);
  assert.deepEqual(partial.widgets.map(w=>w.id),['holding_value','industry_distribution']);
  assert(partial.notes.some(n=>/持仓市值不能替代总资产/.test(n)));
});

test('empty, partial and combined schemas never reference absent fields or exceed eight widgets', () => {
  const fields=['client_id','holding_market_value','market_value','available_cash','total_assets','security_count','security_code','asset_class','industry'];
  for(let mask=0;mask<2**fields.length;mask++){
    const selected=fields.filter((_,i)=>mask&(1<<i)),{widgets}=securitiesReportTemplate(selected);
    assert(widgets.length<=8);
    assert.equal(new Set(widgets.map(w=>w.id)).size,widgets.length);
    for(const w of widgets){assert(selected.includes(w.field));if(w.dimension)assert(selected.includes(w.dimension));}
  }
  assert.deepEqual(securitiesReportTemplate().widgets,[]);
});
