import {distributionReportMetadata,fundReportContractId} from '../../src/v2/distribution-report-contract.mjs';
import {checkedDistributionReportWidgets} from './distribution-report-read.ts';
export type PublishedReportSource = {
  kind: "AGENT" | "MANUAL";
  releaseId: string;
  packageDigest: string;
  revisionId: string;
  runId: string;
  taskId?: string;
  batchIds: string[];
};
export type ReportWidgetResult = {
  id: string; type: "KPI" | "BAR" | "PIE"; title: string;
  aggregation: string; field?: string; dimension?: string;
  value?: string; series?: { group: string; value: string;partitionKey?:string;clientLabel?:string;tradeDate?:string;zeroDenominator?:boolean }[]; evaluatedCount: number;
};
export type ReportSourceEvidence = {
  modelClassification?: string; engineClassification?: string; assertionDigest?: string; packageDigest?: string; resultDigest?: string;
};
export type PublishedReportResult = {
  key: string; reportId: string; name: string; versionId: string; versionNumber: number;
  runId: string; snapshotId: string; sourceBatchId: string; contentHash: string;
  outputContractId?:string;sourceEvidence?:ReportSourceEvidence;
  resultHash: string; description: string; fields: string[]; widgets: ReportWidgetResult[]; exportable: boolean;
};
const record = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const invalid = () => Error("报表来源、固定快照或运行回执尚未确认；不改用其他任务的最新结果。");
export function publishedReportSourceKey(source: PublishedReportSource) {
  if (!source || !["AGENT", "MANUAL"].includes(source.kind) ||
    ![source.releaseId, source.revisionId, source.runId].every(id) || !hash(source.packageDigest) ||
    source.kind === "AGENT" && !id(source.taskId) || source.kind === "MANUAL" && source.taskId !== undefined ||
    !Array.isArray(source.batchIds) || !source.batchIds.length || !source.batchIds.every(id) || new Set(source.batchIds).size !== source.batchIds.length) throw invalid();
  return JSON.stringify([source.kind, source.taskId ?? "", source.releaseId, source.packageDigest, source.revisionId, source.runId, [...source.batchIds].sort()]);
}
function checkedWidgets(value: unknown): ReportWidgetResult[] {
  if (!Array.isArray(value) || !value.length || value.length > 8 || new Set(value.map(w => w?.id)).size !== value.length ||
    !value.every(w => record(w) && text(w.id) && text(w.title) && ["KPI", "BAR", "PIE"].includes(w.type) &&
      ["SUM", "COUNT_DISTINCT", "COUNT_ROWS"].includes(w.aggregation) && count(w.evaluatedCount) &&
      (w.aggregation === "COUNT_ROWS" ? w.field === undefined : text(w.field)) && (w.dimension === undefined || text(w.dimension)) &&
      (w.type === "KPI" ? typeof w.value === "string" && /^-?\d+(?:\.\d+)?$/.test(w.value) : text(w.dimension) && Array.isArray(w.series) &&
        w.series.every((s: unknown) => record(s) && text(s.group) && typeof s.value === "string" && /^-?\d+(?:\.\d+)?$/.test(s.value))))) throw invalid();
  return value;
}
const definition = (w: Record<string, any>) => JSON.stringify([w.id, w.type, w.title, w.aggregation, w.field ?? null, w.dimension ?? null]);
export function boundPublishedReports(value: unknown, source: PublishedReportSource): PublishedReportResult[] {
  publishedReportSourceKey(source);
  if (!record(value) || value.scope !== "LOCAL_AGGREGATED_REPORTING" || value.publicDeployed !== false || !Array.isArray(value.datasets) || !Array.isArray(value.reports)) throw invalid();
  const snapshots = new Map<string, { datasetId: string; snapshot: Record<string, any> }>();
  for (const dataset of value.datasets) {
    if (!record(dataset) || !id(dataset.id) || !Array.isArray(dataset.snapshots)) throw invalid();
    for (const snapshot of dataset.snapshots) {
      if (!record(snapshot) || !id(snapshot.id) || snapshots.has(snapshot.id)) throw invalid();
      if (!source.batchIds.includes(snapshot.assetVersionId)) continue;
      if (snapshot.datasetId !== dataset.id || (snapshot.outputContractId?(!distributionReportMetadata(snapshot.outputContractId)||snapshot.assetId!=="dataset:"+snapshot.outputContractId):snapshot.assetId !== "dataset:customer_assets_t1") || dataset.assetId !== snapshot.assetId ||
        snapshot.actualMaterialization !== true || snapshot.status !== "READY" || !hash(snapshot.contentHash) || !hash(snapshot.assetEvidenceHash) || !count(snapshot.rowCount) ||
        !Array.isArray(snapshot.fields) || !snapshot.fields.length || !snapshot.fields.every(text) || new Set(snapshot.fields).size !== snapshot.fields.length) throw invalid();
      if(snapshot.outputContractId){const c=distributionReportMetadata(snapshot.outputContractId),p=dataset.publishedSource,e=snapshot.sourceEvidence;
       if(!c||dataset.outputContractId!==c.id||JSON.stringify(snapshot.fields)!==JSON.stringify(c.fields.map(f=>f.name))||!c.contextIds.includes(snapshot.contextId)||snapshot.contextId!==dataset.contextId||!record(p)||p.kind!==source.kind||p.taskId!==source.taskId||p.releaseId!==source.releaseId||p.packageDigest!==source.packageDigest||p.revisionId!==source.revisionId||p.runId!==source.runId||p.batchId!==snapshot.assetVersionId||!record(e)||e.agentIndependentE2E!==false||e.scope!=='LOCAL_TEST_ONLY'||e.sourceTaskId!==source.taskId||e.sourceRevisionId!==source.revisionId||e.sourceRunId!==source.runId||e.sourceReleaseRunId!==p.batchId)throw invalid();
       if(c.id===fundReportContractId&&(e.engineClassification!=="LOCAL_SPARK_PROCESS"||
        e.eligibleForService!==true||e.batchId!==p.batchId||e.releaseId!==p.releaseId||e.packageDigest!==p.packageDigest||
        ![e.inputDigest,e.assertionDigest,e.resultDigest].every(hash)||
        p.kind==="AGENT"&&(e.upstreamKind!=="FUND_AGENT_GENERATED"||e.agentTaskId!==source.taskId||
          !["LIVE_MODEL","SYNTHETIC_MODEL"].includes(e.modelMode)||
          e.modelClassification!==(e.modelMode==="SYNTHETIC_MODEL"?"SYNTHETIC_UPSTREAM":"MODEL_NAME_RECORDED"))))throw invalid();
      }
      snapshots.set(snapshot.id, { datasetId: dataset.id, snapshot });
    }
  }
  const results: PublishedReportResult[] = [], reportIds = new Set<string>();
  for (const report of value.reports) {
    if (!record(report) || !id(report.id) || reportIds.has(report.id) || !Array.isArray(report.versions) || !Array.isArray(report.runs)) throw invalid();
    reportIds.add(report.id);
    const runIds = new Set<string>();
    for (const run of report.runs) {
      if (!record(run) || !id(run.id) || runIds.has(run.id)) throw invalid();
      runIds.add(run.id);
      const bound = snapshots.get(run.datasetSnapshotId);
      if (!bound) continue;
      const versions = report.versions.filter((v: unknown) => record(v) && v.id === run.reportVersionId), version = versions[0];
      if (versions.length !== 1 || !id(version.id) || version.reportId !== report.id || version.datasetId !== bound.datasetId ||
        version.datasetSnapshotId !== run.datasetSnapshotId || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1 ||
        !text(version.description) || !text(report.name) || !hash(version.configHash) || run.reportId !== report.id || run.datasetId !== bound.datasetId ||
        run.status !== "SUCCEEDED" || run.actualExecution !== true || run.publicDeployed !== false || run.fullLifecycleE2E !== false || run.datasetContentHash !== bound.snapshot.contentHash ||
        run.reportConfigHash !== version.configHash || !hash(run.resultHash)) throw invalid();
      const distribution=bound.snapshot.outputContractId;
      if(distribution&&(version.outputContractId!==distribution||run.outputContractId!==distribution||run.distributionValidation?.passed!==true||run.distributionValidation.agentIndependentE2E!==false))throw invalid();
      if(distribution&&(!record(run.sourceEvidence)||['modelClassification','engineClassification','sourceTaskId','sourceRevisionId','sourceRunId','sourceReleaseRunId','outputContractId','packageDigest','releaseId',...(distribution===fundReportContractId?['resultDigest','assertionDigest','batchId','upstreamKind','agentTaskId','modelMode']:[])].some(k=>run.sourceEvidence[k]!==bound.snapshot.sourceEvidence[k])))throw invalid();
      const widgets = distribution?checkedDistributionReportWidgets(run.widgets,version.widgets,distribution,bound.snapshot.rowCount):checkedWidgets(run.widgets);
      if (!Array.isArray(version.widgets) || version.widgets.length !== widgets.length ||
        widgets.some((w, i) => !record(version.widgets[i]) || definition(w) !== definition(version.widgets[i]) ||
          w.evaluatedCount !== bound.snapshot.rowCount || w.field !== undefined && !bound.snapshot.fields.includes(w.field) || w.dimension !== undefined && !bound.snapshot.fields.includes(w.dimension))) throw invalid();
      results.push({ key: `${report.id}:${version.id}:${run.id}`, reportId: report.id, name: report.name, versionId: version.id, versionNumber: version.versionNumber,
        runId: run.id, snapshotId: run.datasetSnapshotId, sourceBatchId: bound.snapshot.assetVersionId, contentHash: bound.snapshot.contentHash,
        ...(distribution?{outputContractId:distribution,sourceEvidence:run.sourceEvidence}:{}),
        resultHash: run.resultHash, description: version.description, fields: bound.snapshot.fields, widgets,
        exportable: report.lastRunId === run.id && report.currentVersionId === version.id });
    }
  }
  return results;
}
export async function checkedPublishedReportExport(value: unknown, result: PublishedReportResult, { originalRequest = false } = {}) {
  if ((!result.exportable && !originalRequest) || !record(value) || value.reportId !== result.reportId || value.reportVersionId !== result.versionId || value.runId !== result.runId ||
    typeof value.content !== "string" || value.contentType !== "text/csv; charset=utf-8" || !hash(value.contentHash) ||
    typeof value.fileName !== "string" || !/^[a-z][a-z0-9_]*-[a-f0-9]{8}\.csv$/.test(value.fileName)) throw invalid();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.content));
  if ([...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("") !== value.contentHash) throw invalid();
  return { fileName: value.fileName, contentType: value.contentType, content: value.content };
}
