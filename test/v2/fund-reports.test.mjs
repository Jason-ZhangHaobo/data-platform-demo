import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { executeDistributionReport } from "../../src/v2/distribution-reports.mjs";
import { distributionReportTemplate, fundReportContractId } from "../../src/v2/distribution-report-contract.mjs";
import { fundContext } from "../../src/v2/fund-lookthrough.mjs";
import { normalizedDistributionRows } from "../../src/v2/distribution-services.mjs";
import { publishedReportHash } from "../../src/v2/published-report-source.mjs";
import { checkedPublishedReportLineage, checkedPublishedReportDevelopment, checkedPublishedReportConsumption } from "../../src/v2/published-report-client.mjs";
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

test("fund lineage and development clients verify the original source, chronology and SQL digest", async () => {
  const id = () => randomUUID(), hash = "a".repeat(64), requestId = id();
  const source = { kind: "MANUAL", releaseId: id(), packageDigest: hash, revisionId: id(), runId: id(), batchId: id() };
  const body = { protocol: "shuduo-fund-report-lineage/v1", scope: "LOCAL_TEST_ONLY", requestId, source, publicDeployed: false,
    report: { id: id(), versionId: id(), runId: id(), resultHash: hash },
    snapshot: { id: id(), datasetId: id(), assetId: "dataset:" + fundReportContractId, contractId: fundReportContractId,
      fields: ["portfolio_id", "trade_date", "asset_class", "exposure_amount", "exposure_ratio"].map(name=>({name,label:name})),
      rowCount: 7, contentHash: hash },
    release: { id: source.releaseId, packageDigest: hash, status: "CANCELLED", activeForConsumption: false,
      businessDate: "2026-09-10", engineClassification: "LOCAL_SPARK_PROCESS", resultDigest: hash, assertionDigest: hash },
    batch: { id: source.batchId, sequence: 1, status: "SUCCEEDED", scheduledAt: "2026-09-10T00:00:00Z",
      startedAt: "2026-09-10T00:00:01Z", finishedAt: "2026-09-10T00:00:02Z",
      monitorEvent: { id: id(), type: "BATCH_SUCCEEDED", status: "SUCCEEDED", observedAt: "2026-09-10T00:00:03Z" } },
  };
  assert.equal(checkedPublishedReportLineage(body, {requestId, source}), body);
  assert.throws(() => checkedPublishedReportLineage(body,{source:{...source,batchId:id()}}));
  assert.throws(() => checkedPublishedReportLineage({...body,release:{...body.release,activeForConsumption:true}}));
  const changed=structuredClone(body);
  changed.batch.monitorEvent.observedAt="2026-09-10T00:00:01Z";
  assert.throws(() => checkedPublishedReportLineage(changed));
  const sql = "SELECT 1", sqlHash = createHash("sha256").update(sql).digest("hex");
  const columnLineage = { assetId: body.snapshot.assetId, runId: source.batchId, revisionId: source.revisionId,
    sourceSqlHash: sqlHash, schemaHash: hash, parser: "sqlglot", parserVersion: "27.14.0", status: "COMPLETE",
    analysis: "STATIC_VALUE_DEPENDENCIES", rowSetImpactAnalyzed: false,
    fields: body.snapshot.fields.map(({ name }) => ({ target: name, status: "CONSTANT", expression: "?", sources: [] })),
  };
  const reportWithFields = { ...body, release: { ...body.release, sourceSqlHash: sqlHash }, columnLineage };
  assert.equal(checkedPublishedReportLineage(reportWithFields, { requestId, source }), reportWithFields);
  for (const mismatch of [{ runId: source.runId }, { runId: id() }, { assetId: "dataset:other" },
    { revisionId: id() }, { sourceSqlHash: hash }, { fields: columnLineage.fields.slice().reverse() },
    { status: "UNAVAILABLE" }, { rowSetImpactAnalyzed: true }]) {
    assert.throws(() => checkedPublishedReportLineage({ ...reportWithFields, columnLineage: { ...columnLineage, ...mismatch } }));
  }
  const unavailable = { ...reportWithFields, columnLineage: { assetId: body.snapshot.assetId, runId: source.batchId,
    analysis: "STATIC_VALUE_DEPENDENCIES", rowSetImpactAnalyzed: false, status: "UNAVAILABLE", fields: [] } };
  assert.equal(checkedPublishedReportLineage(unavailable), unavailable);
  const development = {protocol:"shuduo-fund-report-development/v1",lineage:body,
    revision:{id:source.revisionId,hash:sqlHash,sql,source:"ENGINEER_AUTHORED"},
    run:{id:source.runId,revisionId:source.revisionId,revisionHash:sqlHash,status:"SUCCEEDED",engine:"Apache Spark",
      engineVersion:"3.5.9",finishedAt:"2026-09-10T00:00:02Z",durationMs:2000,rowCount:7},
    verification:{status:"PASSED",assertions:["组合及交易日隔离","资产类别敞口金额与占比","未穿透余额","组合市值守恒"],
      inputDigest:hash,assertionDigest:hash,verifierRevision:"fund-lookthrough-v1",rehearsalId:id(),testSqlDigest:hash},
  };
  assert.equal(await checkedPublishedReportDevelopment(development,{requestId,source,lineage:body}),development);
  assert.equal((await checkedPublishedReportDevelopment({ ...development, lineage: reportWithFields },
    { requestId, source, lineage: reportWithFields })).lineage.columnLineage, columnLineage);
  assert.equal(await checkedPublishedReportDevelopment(development,{lineage:reportWithFields}),development);
  const wrongHash = { ...reportWithFields, release: { ...reportWithFields.release, sourceSqlHash: hash },
    columnLineage: { ...columnLineage, sourceSqlHash: hash } };
  await assert.rejects(checkedPublishedReportDevelopment({ ...development, lineage: wrongHash }));
  await assert.rejects(checkedPublishedReportDevelopment(development,{lineage:wrongHash}));
  await assert.rejects(checkedPublishedReportDevelopment({...development,revision:{...development.revision,sql:"SELECT 2"}}));
  await assert.rejects(checkedPublishedReportDevelopment({...development,verification:{...development.verification,assertionDigest:"0".repeat(64)}}));
  await assert.rejects(checkedPublishedReportDevelopment(development,{lineage:{...body,batch:{...body.batch,monitorEvent:{...body.batch.monitorEvent,id:id()}}}}));
  const agentSource = { ...source, kind: "AGENT", taskId: id() };
  const agentLineage = { ...body, source: agentSource,
    release: { ...body.release, upstreamKind: "FUND_AGENT_GENERATED", modelMode: "SYNTHETIC_MODEL" } };
  assert.equal(checkedPublishedReportLineage(agentLineage), agentLineage);
  assert.throws(() => checkedPublishedReportLineage({ ...agentLineage, release: body.release }));
  const agentDevelopment = { ...development, lineage: agentLineage, revision: { ...development.revision, source: "FUND_AGENT_GENERATED" } };
  assert.equal(await checkedPublishedReportDevelopment(agentDevelopment), agentDevelopment);
  await assert.rejects(checkedPublishedReportDevelopment({ ...agentDevelopment, revision: development.revision }));
});

test("fund report consumption binds original report version and exact batch, retaining revoked call evidence", () => {
  const id = () => randomUUID(), hash = "b".repeat(64);
  const source = { kind: "AGENT", taskId: id(), releaseId: id(), packageDigest: hash, revisionId: id(), runId: id(), batchId: id() };
  const report = { id: id(), versionId: id(), runId: id(), resultHash: hash }, requestId = id();
  const services = ["DAPI", "XAPI"].map(serviceType => {
    const versionId = id();
    return { serviceId: id(), versionId, serviceType, name: "虚构基金接口", status: "VERIFIED", sourceRunIds: [source.batchId],
      source: { revisionId: source.revisionId, developmentRunId: source.runId, modelMode: "SYNTHETIC_MODEL", resultDigest: hash },
      call: { callId: id(), versionId, verified: true, independentResultVerified: true, resultHash: hash, rowCount: 1, applicationStatus: "REVOKED" } };
  });
  const value = { protocol: "shuduo-fund-report-consumption/v1", scope: "LOCAL_TEST_ONLY", requestId, source, report, status: "VERIFIED",
    consumption: { protocol: "shuduo-local-fund-agent-consumption/v1", scope: "LOCAL_TEST_ONLY", taskId: source.taskId,
      releaseId: source.releaseId, batchId: source.batchId, packageDigest: hash, outputContractId: fundReportContractId,
      publicDeployed: false, externalSystemVerified: false, agentIndependentE2E: false, status: "VERIFIED", truncated: false, services } };
  const expected = { lineage: { requestId, source, report, release: { resultDigest: hash, modelMode: "SYNTHETIC_MODEL" } } };
  assert.equal(checkedPublishedReportConsumption(value, expected), value);
  assert.throws(() => checkedPublishedReportConsumption({ ...value, report: { ...report, runId: id() } }, expected));
  const cross = structuredClone(value);
  cross.consumption.services[0].sourceRunIds = [id()];
  assert.throws(() => checkedPublishedReportConsumption(cross, expected));
  assert.throws(() => checkedPublishedReportConsumption({ ...value, consumption: { ...value.consumption, services: services.slice(0, 1) } }, expected));
});
