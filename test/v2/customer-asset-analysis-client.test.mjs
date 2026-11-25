import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {publishedReportHash} from '../../src/v2/published-report-source.mjs';
import {checkedCustomerAssetAnalysis,readCustomerAssetAnalysis} from '../../src/v2/customer-asset-analysis-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

function signed(body) {
  const {digest,...fields}=body;
  return {...fields,digest:publishedReportHash(fields)};
}

function fixture() {
  const report={requestId:randomUUID(),reportId:randomUUID(),versionId:randomUUID(),runId:randomUUID(),reportSnapshotId:randomUUID(),resultHash:'a'.repeat(64)};
  const source={taskId:randomUUID(),releaseId:randomUUID(),batchId:randomUUID(),sequence:2,packageDigest:'b'.repeat(64),
    revisionId:randomUUID(),developmentRunId:randomUUID(),sourceType:'SERVER_MYSQL',syncTaskId:randomUUID(),syncRunId:randomUUID(),
    sourceRevisionId:randomUUID(),metadataVersionId:randomUUID(),landingReceiptHash:'c'.repeat(64),landingSnapshotHash:'d'.repeat(64),
    snapshotHash:'e'.repeat(64),businessDate:'2026-09-10',advisorId:'ADVISOR-DEMO-A'};
  const customer={customerKey:'f'.repeat(64),clientLabel:'CLI***001',holdingMarketValue:'3.00',availableCash:'2.00',totalAssets:'5.00',
    securityCount:2,nullMarketValueCount:0,assetClasses:[{label:'股票',marketValue:'2.00',ratio:'0.666667'},
      {label:'基金',marketValue:'1.00',ratio:'0.333333'}],industries:[{label:'金融',marketValue:'3.00',ratio:'1.000000'}]};
  return signed({protocol:'shuduo-customer-asset-analysis/v1',scope:'LOCAL_TEST_ONLY',readOnly:true,report,source,customers:[customer]});
}

test('interfaces read the same original report and reject an unrelated batch or report run', async()=>{
  const receipt=fixture(),{source:s,report:r}=receipt;
  const expected={requestId:r.requestId,reportRunId:r.runId,reportSnapshotId:r.reportSnapshotId,
    source:{kind:'AGENT',taskId:s.taskId,releaseId:s.releaseId,revisionId:s.revisionId,runId:s.developmentRunId,packageDigest:s.packageDigest,batchId:s.batchId}};
  const reads=[];
  const client={request:async (path,opts)=>{assert.equal(opts?.method??'GET','GET');reads.push(path);return receipt;}};
  assert.deepEqual(await readCustomerAssetAnalysis(client,expected),receipt);
  let cli;
  assert.equal(await runV2Cli(['reports','customer-analysis','--request-id',r.requestId],{},
    {client,output:value=>{cli=JSON.parse(value);},error:()=>{}}),0);
  assert.deepEqual(cli,receipt);
  const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{
    name:'report_customer_asset_analysis',arguments:{requestId:r.requestId,source:expected.source}}},{client}));
  assert.deepEqual(mcp.result.structuredContent,receipt);
  assert.deepEqual(reads,Array(3).fill('/reports/published/requests/'+r.requestId+'/customer-analysis'));
  await assert.rejects(checkedCustomerAssetAnalysis(receipt,{...expected,reportRunId:randomUUID()}));
  await assert.rejects(checkedCustomerAssetAnalysis(receipt,{...expected,source:{...expected.source,batchId:randomUUID()}}));
});

test('even internally rehashed amounts, ratios and projections must match the declared report rules', async()=>{
  const receipt=fixture(), expected={requestId:receipt.report.requestId};
  for(const mutate of [
    r=>{r.customers[0].totalAssets='7.00';},
    r=>{r.customers[0].assetClasses[0].ratio='0.400000';},
    r=>{r.customers[0].industries[0].marketValue='2.00';},
    r=>{r.customers[0].assetClasses[1].label='股票';},
    r=>{r.customers[0].clientLabel='CLIENT-001';},
    r=>{r.customers[0].securityCode='SEC-DEMO-001';},
    r=>{r.customers.push(r.customers[0]);},
    r=>{r.source.sourceType='LOCAL_CSV';},
  ]){
    const changed=structuredClone(receipt);mutate(changed);
    await assert.rejects(checkedCustomerAssetAnalysis(signed(changed),expected));
  }
  await assert.rejects(checkedCustomerAssetAnalysis({...receipt,digest:'0'.repeat(64)},expected));
});
