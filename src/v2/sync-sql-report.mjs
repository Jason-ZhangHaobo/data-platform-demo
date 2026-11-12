import { isDeepStrictEqual as same } from "node:util";
import { syncServiceProtocol } from "./sync-sql-service-source.mjs";
import { publishedSqlColumnLineage } from "./sql-column-lineage.mjs";
import { securitiesReportTemplate } from "./report-template.mjs";

const outputPrefix = "dataset:sync-holdings:";
const inputPrefix = "snapshot:sync-holdings:";
export const syncReportFields = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
export const syncReportAssetId = batchId => outputPrefix + batchId;
export const isSyncAssetId = id => typeof id === "string" && (id.startsWith(outputPrefix) || id.startsWith(inputPrefix));
export const syncAssetBatchId = id => id.slice(id.lastIndexOf(":") + 1);
export const isSyncReportEvidence = evidence => evidence?.protocol === syncServiceProtocol;
const invalid = () => Object.assign(Error("冻结持仓报表的原批次、快照或独立聚合证据未通过核对"),
  { status: 409, code: "SYNC_REPORT_LINEAGE_UNPROVEN" });

export function syncReportAsset(batch, proof, hash) {
  return {
    id: syncReportAssetId(batch.id), kind: "PUBLISHED_DATASET", name: "frozen_holdings_" + batch.id.slice(0, 8),
    businessName: `冻结持仓客户资产 · 第${batch.sequence}批`, domain: "财富管理", system: "LOCAL_SPARK_RELEASE",
    description: `原发布业务日 ${proof.sourceEvidence.businessDate}，使用固定同步持仓与登记账户、现金。`,
    status: "PUBLISHED_LOCAL", rowCount: batch.rows.length, versionId: batch.id, versionCount: 1, runIds: [batch.id],
    fields: syncReportFields.map(name => ({ name, type: name === "client_id" ? "STRING" : name === "security_count" ? "BIGINT" : "DECIMAL", nullable: false })),
    tags: ["虚构证券", "冻结持仓", "已核验批次"], evidenceHash: hash(batch.rows),
    executableMetrics: false, reportable: true, sourceEvidence: proof.sourceEvidence,
  };
}

export function syncAssetView({ store, project, batch, proof, id, hash, fixtures }) {
  const output = syncReportAsset(batch, proof, hash), evidence = proof.sourceEvidence;
  const input = {
    id: inputPrefix + batch.id, kind: "SOURCE_TABLE", name: "frozen_positions_" + evidence.syncRunId.slice(0, 8),
    businessName: "原同步持仓快照", description: "SQL 运行保存的不可变持仓输入", domain: "财富管理", system: "LOCAL_SYNC_SNAPSHOT",
    status: "VERIFIED", tags: ["虚构证券", "冻结持仓"], evidenceHash: evidence.snapshotHash, versionId: evidence.syncRunId,
    fields: ["position_id", "client_id", "security_code", "asset_class", "industry", "market_value", "trade_date"]
      .map(name => ({ name, type: name === "market_value" ? "DECIMAL" : "STRING", nullable: name === "market_value" })),
    executableMetrics: false, reportable: false, sourceEvidence: evidence,
  };
  const selected = id === output.id ? output : id === input.id ? input : undefined;
  if (!selected) throw invalid();
  const column = publishedSqlColumnLineage({ store, project, run: batch, assetId: output.id });
  const parents = [{ table: "positions", id: input.id },
    { table: "accounts", id: "fixture:accounts" }, { table: "cash", id: "fixture:cash" }];
  const lineage = {
    focusAssetId: id, derivation: "VERSION_BINDINGS", sqlColumnLineageParsed: column.status === "COMPLETE",
    nodes: [input, ...fixtures.filter(fixture => ["fixture:accounts","fixture:cash"].includes(fixture.id)), output],
    edges: parents.map(parent => ({ id: `spark:${parent.table}:${batch.id}`, from: parent.id, to: output.id, type: "SPARK_SQL",
      evidenceId: parent.table === "positions" ? evidence.syncRunId : batch.id,
      evidenceHash: parent.table === "positions" ? evidence.snapshotHash : output.evidenceHash,
      fieldMappings: column.fields.filter(field => field.status === "RESOLVED")
        .flatMap(field => field.sources.filter(source => source.table === parent.table).map(source => ({ source: source.column, target: field.target }))),
    })), columnLineages: [column],
  };
  return { ...selected, lineage, metrics: [], standards: [] };
}

function amount(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw invalid();
  return (BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))) * (match[1] ? -1n : 1n);
}

export function assertSyncReportWidgets(widgets, expected) {
  const templates = securitiesReportTemplate(syncReportFields).widgets;
  for (const widget of widgets) {
    const template = templates.find(item => item.id === widget.id);
    if (!template || widget.evaluatedCount !== expected.length ||
        ["type", "aggregation", "field", "dimension"].some(key => widget[key] !== template[key])) throw invalid();
    const sum = rows => rows.reduce((total, row) => total + amount(row[widget.field]), 0n);
    if (template.type === "KPI") {
      if (amount(widget.value) !== sum(expected)) throw invalid();
    } else {
      const groups = Map.groupBy(expected, row => row.client_id.slice(0, 3) + "***" + row.client_id.slice(-3));
      if (widget.series?.length !== groups.size || [...groups].some(([label, rows]) => {
        const entries = widget.series.filter(item => item.group === label);
        return entries.length !== 1 || amount(entries[0].value) !== sum(rows);
      })) throw invalid();
    }
  }
}

export function syncReportLineage({ record, artifacts, resolved, batch, calls, hash }) {
  const { report, version, run, snapshot, dataset, data } = artifacts;
  const evidence = resolved.sourceEvidence, asset = resolved.asset;
  if (!isSyncReportEvidence(evidence) || !same(snapshot.sourceEvidence, evidence) ||
      !same(run.sourceEvidence, evidence) || !same(dataset.sourceEvidence, evidence) ||
      snapshot.assetId !== asset.id || snapshot.assetEvidenceHash !== asset.evidenceHash ||
      snapshot.contentHash !== asset.evidenceHash || !same(data.rows, resolved.rows)) throw invalid();
  assertSyncReportWidgets(run.widgets, resolved.expected);
  const result = { protocol: "shuduo-sync-sql-report-lineage/v1", scope: "LOCAL_TEST_ONLY", requestId: record.requestId,
    source: record.input.source, report: { id: report.id, versionId: version.id, runId: run.id, resultHash: run.resultHash },
    snapshot: { id: snapshot.id, datasetId: dataset.id, assetId: asset.id, rowCount: snapshot.rowCount, contentHash: snapshot.contentHash },
    release: evidence, batch: { id: batch.id, sequence: batch.sequence, status: batch.status, engineVersion: batch.engineVersion },
    calls, publicDeployed: false, agentIndependentE2E: false };
  return { ...result, digest: hash(result) };
}
