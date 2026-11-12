import { isDeepStrictEqual as same } from "node:util";
import { fundDapiContract } from "./fund-dapi-contract.mjs";
import { resolveFundReportPublication } from "./fund-consumption-source.mjs";

const unproven = () => Object.assign(new Error("原报表的快照、发布批次或运维记录已变化"), {
  status: 409, code: "FUND_REPORT_LINEAGE_UNPROVEN",
});

function verifiedFundReportLineage({ store, project, record, artifacts, timeUnitMs }) {
  const { report, version, run, snapshot, dataset } = artifacts;
  const source = record.input.source, saved = snapshot.sourceEvidence, contract = fundDapiContract;
  if (source.kind !== "MANUAL" || version.outputContractId !== contract.id)
    throw Object.assign(new Error("当前仅基金组合报表支持查看此发布证据"), { status: 422, code: "REPORT_LINEAGE_UNSUPPORTED" });
  if (!saved || saved.eligibleForService !== true || !same(saved, run.sourceEvidence) || !same(saved, dataset.sourceEvidence) ||
      !same(snapshot.fields, contract.fields.map(field => field.name)) ||
      snapshot.assetId !== "dataset:" + contract.id || dataset.assetId !== snapshot.assetId ||
      snapshot.contentHash !== snapshot.assetEvidenceHash) throw unproven();

  const { evidence, status, batch, revision, development, verification } = resolveFundReportPublication({ store, project, timeUnitMs,
    selection: { releaseId: source.releaseId, packageDigest: source.packageDigest, batchId: source.batchId } });
  const keys = ["protocol", "scope", "contractId", "releaseId", "packageDigest", "batchId", "revisionId", "developmentRunId",
    "batchSequence", "businessDate", "inputDigest", "assertionDigest", "testSqlDigest", "resultDigest", "rowCount",
    "engineClassification", "batches"];
  if (source.revisionId !== evidence.revisionId || source.runId !== evidence.developmentRunId ||
      snapshot.rowCount !== evidence.rowCount || keys.some(key => !same(saved[key], evidence[key])))
    throw unproven();

  const lineage = {
    protocol: "shuduo-fund-report-lineage/v1", scope: "LOCAL_TEST_ONLY", requestId: record.requestId, source,
    report: { id: report.id, versionId: version.id, runId: run.id, resultHash: run.resultHash },
    snapshot: { id: snapshot.id, datasetId: dataset.id, assetId: snapshot.assetId, contractId: contract.id,
      fields: contract.fields.map(({ name, label }) => ({ name, label })), rowCount: snapshot.rowCount, contentHash: snapshot.contentHash },
    release: { id: evidence.releaseId, status, businessDate: evidence.businessDate, packageDigest: evidence.packageDigest,
      resultDigest: evidence.resultDigest, assertionDigest: evidence.assertionDigest, engineClassification: evidence.engineClassification,
      activeForConsumption: evidence.eligibleForService },
    batch, publicDeployed: false,
  };
  return { lineage, revision, development, verification, evidence };
}

export function fundReportLineage(args) {
  return verifiedFundReportLineage(args).lineage;
}

export const fundDevelopmentAssertions = Object.freeze([
  "组合及交易日隔离", "资产类别敞口金额与占比", "未穿透余额", "组合市值守恒",
]);

export function fundReportDevelopment(args) {
  const { lineage, revision, development, verification, evidence } = verifiedFundReportLineage(args);
  if (revision.author !== args.record.actorId || revision.manualProvenance?.actorId !== args.record.actorId)
    throw Object.assign(new Error("原开发版本只允许其拥有者查看"), { status: 403, code: "REPORT_DEVELOPMENT_OWNER" });
  const validation = development.validation, regression = validation.regressions[0];
  if (!same(validation.assertions, fundDevelopmentAssertions) || !same(regression.assertions, fundDevelopmentAssertions) ||
      !same(validation.issues, []) || !same(regression.issues, []) || !Number.isFinite(Date.parse(development.finishedAt)) ||
      !Number.isSafeInteger(development.durationMs) || development.durationMs < 0 || development.exitCode !== 0)
    throw Object.assign(new Error("原开发运行的独立核验记录不完整"), { status: 409, code: "REPORT_DEVELOPMENT_UNPROVEN" });
  return {
    protocol: "shuduo-fund-report-development/v1", lineage,
    revision: { id: revision.id, hash: revision.hash, sql: revision.sql, source: "ENGINEER_AUTHORED" },
    run: { id: development.id, revisionId: development.revisionId, revisionHash: development.revisionHash,
      status: development.status, engine: development.engine, engineVersion: development.engineVersion,
      finishedAt: development.finishedAt, durationMs: development.durationMs, rowCount: development.rows.length },
    verification: { status: "PASSED", assertions: [...validation.assertions], inputDigest: evidence.inputDigest,
      assertionDigest: evidence.assertionDigest, verifierRevision: validation.assertionEvidence.verifierRevision,
      rehearsalId: verification.id, testSqlDigest: evidence.testSqlDigest },
  };
}
