import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lookupPublishedReport, readPublishedReportResult, submitPublishedReport } from "../src/v2/published-report-client.mjs";
import { readCustomerAssetAnalysis } from "../src/v2/customer-asset-analysis-client.mjs";
import { runV2Cli } from "../bin/shuduo.mjs";
import { handleV2Mcp } from "../bin/shuduo-mcp.mjs";

// These values come from the two original positions and the registered cash
// fixture. The later three-position landing has a different market value.
const clients = [
  {label:"CLI***001", total:"1300.00", holding:"1000.00", cash:"300.00", category:"股票", industry:"金融"},
  {label:"CLI***002", total:"700.00", holding:"500.00", cash:"200.00", category:"债券", industry:"公共事业"},
];

export async function verifyMysqlCustomerReports({client, source, batchIds, originalInput}) {
  const saved = [];
  const before = (await client.request("/reports/overview")).counts;
  for (const [index,batchId] of batchIds.entries()) {
    const args = {requestId:randomUUID(), name:"虚构客户资产分析 · 第"+(index+1)+"批", source:{...source,batchId}};
    const receipt = await submitPublishedReport(client,args);
    assert.equal(receipt.status,"SUCCEEDED");
    assert.deepEqual(receipt.source,args.source);
    assert.equal(receipt.rowCount,clients.length);

    const result = await readPublishedReportResult(client,args);
    const reportRun = result.overview.reports[0].runs[0];
    assert.equal(reportRun.id,receipt.reportRunId);
    assert.equal(reportRun.actualExecution,true);
    assert.equal(reportRun.customerAnalysisRequestId,args.requestId);
    const widget = name => reportRun.widgets.find(item=>item.id===name);
    assert.equal(widget("total_assets").value,"2000.00");
    assert.equal(widget("holding_value").value,"1500.00");
    assert.equal(widget("available_cash").value,"500.00");

    const selection = {requestId:args.requestId,source:args.source,reportId:receipt.reportId,versionId:receipt.reportVersionId,
      reportRunId:receipt.reportRunId,reportSnapshotId:receipt.snapshotId,resultHash:receipt.resultHash};
    const report = await readCustomerAssetAnalysis(client,selection);
    assert.equal(report.protocol,"shuduo-customer-asset-analysis/v1");
    assert.equal(report.readOnly,true);
    assert.equal(report.scope,"LOCAL_TEST_ONLY");
    assert.match(report.digest,/^[a-f0-9]{64}$/);
    assert.deepEqual(report.report,{requestId:args.requestId, reportId:receipt.reportId, versionId:receipt.reportVersionId,
      runId:receipt.reportRunId, resultHash:receipt.resultHash, reportSnapshotId:receipt.snapshotId});
    const expectedSource = {taskId:source.taskId, releaseId:source.releaseId, batchId, sequence:index+1,
      packageDigest:source.packageDigest, revisionId:source.revisionId, developmentRunId:source.runId,
      ...originalInput, businessDate:"2026-09-10", advisorId:"ADVISOR-DEMO-A", sourceType:"SERVER_MYSQL"};
    for (const [key,value] of Object.entries(expectedSource)) assert.equal(report.source[key],value,key);
    assert.equal(report.customers.length,clients.length);
    assert.equal(new Set(report.customers.map(c=>c.customerKey)).size,clients.length);
    for (const expected of clients) {
      const row=report.customers.find(c=>c.clientLabel===expected.label);
      assert.ok(row);
      assert.match(row.customerKey,/^[a-f0-9]{64}$/);
      assert.deepEqual([row.totalAssets,row.holdingMarketValue,row.availableCash,row.securityCount,row.nullMarketValueCount],
        [expected.total,expected.holding,expected.cash,1,0]);
      assert.deepEqual(row.assetClasses,[{label:expected.category,marketValue:expected.holding,ratio:"1.000000"}]);
      assert.deepEqual(row.industries,[{label:expected.industry,marketValue:expected.holding,ratio:"1.000000"}]);
    }
    assert.doesNotMatch(JSON.stringify(report),/CLIENT-00[12]|SEC-DEMO-00[12]/);
    assert.deepEqual(await lookupPublishedReport(client,args),receipt);
    assert.deepEqual(await submitPublishedReport(client,args),receipt);
    saved.push({selection,report,receipt});
  }

  assert.equal(saved.length,2);
  for (const key of ["reportId","reportVersionId","reportRunId","snapshotId"]) {
    assert.notEqual(saved[0].receipt[key],saved[1].receipt[key],key);
  }
  for (const {selection,report} of saved) assert.deepEqual(await readCustomerAssetAnalysis(client,selection),report);
  const {selection, report} = saved[1];
  const requestId = selection.requestId;
  let cli;
  assert.equal(await runV2Cli(["reports","customer-analysis","--request-id",requestId],{},
    {client,output:value=>{cli=JSON.parse(value);},error:()=>{}}),0);
  assert.deepEqual(cli,report);
  const mcp=JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",params:{
    name:"report_customer_asset_analysis",arguments:{requestId,source:selection.source}
  }},{client}));
  assert.deepEqual(mcp.result.structuredContent,report);
  await assert.rejects(client.request("/reports/published/requests/"+requestId+"/customer-analysis?advisorId=other"),
    error=>error.status===422);
  const overview = await client.request("/reports/overview");
  for (const {receipt} of saved) {
    const listed=overview.reports.find(report=>report.id===receipt.reportId);
    assert.deepEqual(listed.runs.map(run=>[run.id,run.customerAnalysisRequestId]),[[receipt.reportRunId,receipt.requestId]]);
  }
  const after = overview.counts;
  for (const key of ["datasets","reports","runs"]) assert.equal(after[key]-before[key],2,key);
  return {wealthReports:saved.length, wealthReportRuns:after.runs-before.runs,
    wealthCustomersPerReport:clients.length, wealthCustomerAssets:clients.map(c=>c.total),
    wealthHoldingValues:clients.map(c=>c.holding), wealthSecurityCounts:[1,1],
    wealthAssetClasses:clients.map(c=>c.category), wealthIndustries:clients.map(c=>c.industry),
    wealthReportReopenVerified:true};
}
