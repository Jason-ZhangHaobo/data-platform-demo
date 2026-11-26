import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFixtureCustomerReports } from "../../scripts/accept-mysql-customer-report.mjs";
import { publishedReportHash } from "../../src/v2/published-report-source.mjs";
import { customerAnalysisCsv } from "../../web/src/customer-analysis-csv.ts";

function fixture(sequence=2) {
  const report={requestId:randomUUID(),reportId:randomUUID(),versionId:randomUUID(),runId:randomUUID(),reportSnapshotId:randomUUID(),resultHash:"a".repeat(64)};
  const source={taskId:randomUUID(),releaseId:randomUUID(),batchId:randomUUID(),sequence,packageDigest:"b".repeat(64),
    revisionId:randomUUID(),developmentRunId:randomUUID(),sourceType:"SERVER_MYSQL",syncTaskId:randomUUID(),syncRunId:randomUUID(),
    sourceRevisionId:randomUUID(),metadataVersionId:randomUUID(),landingReceiptHash:"c".repeat(64),
    landingSnapshotHash:"d".repeat(64),snapshotHash:"e".repeat(64),businessDate:"2026-09-10",advisorId:"ADVISOR-DEMO-A"};
  const clientRow=(label,total,cash,holding,category,industry)=>({
    customerKey:publishedReportHash(label),clientLabel:label,totalAssets:total,availableCash:cash,holdingMarketValue:holding,
    securityCount:1,nullMarketValueCount:0,assetClasses:[{label:category,marketValue:holding,ratio:"1.000000"}],
    industries:[{label:industry,marketValue:holding,ratio:"1.000000"}],
  });
  const body={protocol:"shuduo-customer-asset-analysis/v1",scope:"LOCAL_TEST_ONLY",readOnly:true,report,source,
    customers:[clientRow("CLI***002","700.00","200.00","500.00","债券","公共事业"),clientRow("CLI***001","1300.00","300.00","1000.00","股票","金融")]};
  const original={...body,digest:publishedReportHash(body)},reads=[];
  const client={request:async path=>{reads.push(path);return structuredClone(original);}};
  return {original,client,reads,selection:{requestId:report.requestId,reportRunId:report.runId,reportSnapshotId:report.reportSnapshotId,
    reportId:report.reportId,resultHash:report.resultHash,versionId:report.versionId,
    source:{kind:"AGENT",taskId:source.taskId,batchId:source.batchId,releaseId:source.releaseId,packageDigest:source.packageDigest,
      revisionId:source.revisionId,runId:source.developmentRunId}}};
}

test("opt-in fixture export rechecks batch two and publishes only the two product CSVs without replacing a prior directory",async t=>{
  const root=await mkdtemp(join(tmpdir(),"shuduo-fixture-export-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const target=join(root,"report"),f=fixture();
  assert.equal(await exportFixtureCustomerReports(undefined,f.client,f.selection,f.original),undefined);
  assert.equal(f.reads.length,0);
  const result=await exportFixtureCustomerReports(target,f.client,f.selection,f.original);
  assert.deepEqual(f.reads,["/reports/published/requests/"+f.selection.requestId+"/customer-analysis"]);
  assert.deepEqual((await readdir(target)).sort(),["customer-001.csv","customer-002.csv"]);
  for (const suffix of ["001","002"]) {
    const row=f.original.customers.find(c=>c.clientLabel==="CLI***"+suffix);
    const content=await readFile(join(target,"customer-"+suffix+".csv"),"utf8");
    assert.equal(content,customerAnalysisCsv(f.original,row.customerKey,f.original.digest).content);
    assert.equal(result.files["customer-"+suffix+".csv"],createHash("sha256").update(content).digest("hex"));
    assert.ok(!content.includes(suffix==="001"?"CLI***002":"CLI***001"));
    assert.ok(content.includes(f.original.source.batchId));
    assert.ok(content.includes(f.original.report.runId));
  }
  assert.deepEqual(Object.keys(result.files).sort(),["customer-001.csv","customer-002.csv"]);
  assert.deepEqual({...result,files:undefined},{sequence:2,batchId:f.original.source.batchId,reportRunId:f.original.report.runId,
    landingSnapshotHash:f.original.source.landingSnapshotHash,files:undefined});
  await writeFile(join(target,"customer-001.csv"),"existing fixture");
  await assert.rejects(exportFixtureCustomerReports(target,f.client,f.selection,f.original),{code:"EEXIST"});
  assert.equal(await readFile(join(target,"customer-001.csv"),"utf8"),"existing fixture");
  const drifted=join(root,"changed");
  await assert.rejects(exportFixtureCustomerReports(drifted,f.client,f.selection,{...f.original,digest:"0".repeat(64)}));
  await assert.rejects(stat(drifted),{code:"ENOENT"});
  const first=fixture(1);
  await assert.rejects(exportFixtureCustomerReports(drifted,first.client,first.selection,first.original));
  await assert.rejects(stat(drifted),{code:"ENOENT"});
});
