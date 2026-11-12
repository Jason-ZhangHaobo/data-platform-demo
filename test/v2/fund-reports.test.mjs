import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeDistributionReport } from "../../src/v2/distribution-reports.mjs";
import { distributionReportTemplate, fundReportContractId } from "../../src/v2/distribution-report-contract.mjs";
import { fundContext } from "../../src/v2/fund-lookthrough.mjs";
import { normalizedDistributionRows } from "../../src/v2/distribution-services.mjs";
import { publishedReportHash } from "../../src/v2/published-report-source.mjs";
import { checkedDistributionReportWidgets } from "../../web/src/distribution-report-read.ts";

test("fund reporting preserves partitions and independent precision even when wrong snapshot bytes are rehashed", () => {
  const context = fundContext();
  const rows = normalizedDistributionRows(context.expected, fundReportContractId);
  const template = distributionReportTemplate(fundReportContractId);
  const version = { outputContractId: fundReportContractId, widgets: template.widgets };
  const report = input => {
    const contentHash = publishedReportHash(input);
    return executeDistributionReport({ version, snapshot: { rows: input, rowCount: input.length, contentHash },
      metadata: { outputContractId: fundReportContractId, contextId: context.id, assetVersionId: "batch", contentHash,
        assetEvidenceHash: contentHash, rowCount: input.length,
        sourceEvidence: { protocol: "shuduo-fund-consumption-source/v1", scope: "LOCAL_TEST_ONLY", agentIndependentE2E: false,
          outputContractId: fundReportContractId, eligibleForService: true, engineClassification: "LOCAL_SPARK_PROCESS",
          batchId: "batch", sourceReleaseRunId: "batch", businessDate: context.businessDate, rowCount: input.length,
          resultDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex") } },
      hash: publishedReportHash });
  };
  const result = report(rows);
  assert.equal(result.distributionValidation.passed, true);
  const [amount, ratio] = result.widgets;
  assert.equal(new Set(amount.series.map(item => item.partitionKey)).size, 2);
  assert.equal(amount.series.length, 7);
  assert.ok(amount.series.some(item => item.group === "未穿透" && item.value === "450.00"));
  assert.ok(ratio.series.some(item => item.group === "未穿透" && item.value === "0.225000"));
  assert.ok(!JSON.stringify(result).includes("PORT-DEMO-A1"));
  assert.equal(checkedDistributionReportWidgets(result.widgets, template.widgets, fundReportContractId, 7), result.widgets);
  const forged = rows.map((row,index)=>index===0?{...row,exposure_amount:"0.00"}:row);
  assert.throws(() => report(forged), { code: "DISTRIBUTION_REPORT_UNPROVEN" });
  const badChart = structuredClone(result.widgets);
  badChart[1].series[0].value = "1.000001";
  assert.throws(() => checkedDistributionReportWidgets(badChart, template.widgets, fundReportContractId, 7));
});
