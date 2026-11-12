import { isDeepStrictEqual as same } from "node:util";
import { fundDapiContract } from "./fund-dapi-contract.mjs";
import { resolveFundReportPublication } from "./fund-consumption-source.mjs";

const unproven = () => Object.assign(new Error("原报表的快照、发布批次或运维记录已变化"), {
  status: 409, code: "FUND_REPORT_LINEAGE_UNPROVEN",
});

export function fundReportLineage({ store, project, record, artifacts, timeUnitMs }) {
  const { report, version, run, snapshot, dataset } = artifacts;
  const source = record.input.source, saved = snapshot.sourceEvidence, contract = fundDapiContract;
  if (source.kind !== "MANUAL" || version.outputContractId !== contract.id)
    throw Object.assign(new Error("当前仅基金组合报表支持查看此发布证据"), { status: 422, code: "REPORT_LINEAGE_UNSUPPORTED" });
  if (!saved || saved.eligibleForService !== true || !same(saved, run.sourceEvidence) || !same(saved, dataset.sourceEvidence) ||
      !same(snapshot.fields, contract.fields.map(field => field.name)) ||
      snapshot.assetId !== "dataset:" + contract.id || dataset.assetId !== snapshot.assetId ||
      snapshot.contentHash !== snapshot.assetEvidenceHash) throw unproven();

  const { evidence, status, batch } = resolveFundReportPublication({ store, project, timeUnitMs,
    selection: { releaseId: source.releaseId, packageDigest: source.packageDigest, batchId: source.batchId } });
  const keys = ["protocol", "scope", "contractId", "releaseId", "packageDigest", "batchId", "revisionId", "developmentRunId",
    "batchSequence", "businessDate", "inputDigest", "assertionDigest", "testSqlDigest", "resultDigest", "rowCount",
    "engineClassification", "batches"];
  if (source.revisionId !== evidence.revisionId || source.runId !== evidence.developmentRunId ||
      snapshot.rowCount !== evidence.rowCount || keys.some(key => !same(saved[key], evidence[key])))
    throw unproven();

  return {
    protocol: "shuduo-fund-report-lineage/v1", scope: "LOCAL_TEST_ONLY", requestId: record.requestId, source,
    report: { id: report.id, versionId: version.id, runId: run.id, resultHash: run.resultHash },
    snapshot: { id: snapshot.id, datasetId: dataset.id, assetId: snapshot.assetId, contractId: contract.id,
      fields: contract.fields.map(({ name, label }) => ({ name, label })), rowCount: snapshot.rowCount, contentHash: snapshot.contentHash },
    release: { id: evidence.releaseId, status, businessDate: evidence.businessDate, packageDigest: evidence.packageDigest,
      resultDigest: evidence.resultDigest, assertionDigest: evidence.assertionDigest, engineClassification: evidence.engineClassification,
      activeForConsumption: evidence.eligibleForService },
    batch, publicDeployed: false,
  };
}
