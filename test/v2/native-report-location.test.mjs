import assert from 'node:assert/strict';
import test from 'node:test';
import {serviceHandoffLocation} from '../../web/src/service-source-binding.ts';
import {wealthReportLocation,wealthReportTarget} from '../../web/src/native-report-location.ts';

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('a native batch report preserves its exact source and fails closed for conflicting pins',()=>{
  const binding={taskId:id(1),sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',releaseId:id(2),packageDigest:'a'.repeat(64),revisionId:id(3),runId:id(4)};
  const services=serviceHandoffLocation('http://127.0.0.1/v2/',binding);
  services.searchParams.set('release_batch',id(6));
  const url=new URL(wealthReportLocation(services.href),services.origin);
  assert.equal(url.searchParams.has('release_batch'),false);
  const result=wealthReportTarget(url.href);
  assert.deepEqual(result.binding,binding); assert.equal(result.source.batchId,id(6));
  assert.equal(wealthReportTarget('http://127.0.0.1/v2/?module=reports'),undefined);
  url.searchParams.set('report_request',id(7));
  assert.equal(wealthReportTarget(url.href).requestId,id(7));
  for(const invalid of [url.href.replace('LOCAL_TEST_ONLY','PRIVATE_CLOUD_TEST'),url.href.replace('report_batch','other'),
    url.href.replace('module=reports','module=services'),url.href.replace(id(7),'broken'),url.href.replace('#','&report_batch='+id(5)+'#')]){
    assert.equal(wealthReportTarget(invalid),null);
  }
});

import {customerAnalysisCsv} from '../../web/src/customer-analysis-csv.ts';
test('CSV includes only the selected masked customer, exact percentages and source of that report',()=>{
  const make=(key,label)=>({customerKey:key,clientLabel:label,totalAssets:'5.00',holdingMarketValue:'3.00',availableCash:'2.00',securityCount:2,nullMarketValueCount:0,
    assetClasses:[{label:'股票',marketValue:'2.00',ratio:'0.666667'},{label:'债券',marketValue:'1.00',ratio:'0.333333'}],
    industries:[{label:'金融',marketValue:'3.00',ratio:'1.000000'}]});
  const report={digest:'a'.repeat(64),source:{batchId:id(6),sequence:2,businessDate:'2026-09-10',landingSnapshotHash:'b'.repeat(64)},
    report:{runId:id(2)},customers:[make('c'.repeat(64),'CLI***001'),make('d'.repeat(64),'CLI***002')]};
  const file=customerAnalysisCsv(report,'d'.repeat(64),report.digest);
  assert.match(file.content,/CLI\*\*\*002,2026-09-10,客户总资产,,5\.00,元（CNY）,,本次持仓市值＋可用现金/);
  assert.match(file.content,/资产类别分布,股票,2.00,元（CNY）,66.6667%/);
  assert.match(file.content,/行业分布,金融,3.00,元（CNY）,100%/);
  assert.ok(file.content.includes(id(6)));
  assert.equal(file.content.includes('CLI***001'),false);
  assert.equal(file.content.includes('d'.repeat(64)),false);
  assert.throws(()=>customerAnalysisCsv(report,'d'.repeat(64),'e'.repeat(64)));
  assert.throws(()=>customerAnalysisCsv(report,'e'.repeat(64),report.digest));
});
