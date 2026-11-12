import {privateReleasePendingLabel} from "../../src/v2/private-release-stage.mjs";

type MonitorTarget = {
  taskId: string;
  releaseId: string;
  revisionId: string;
  firstBatchId: string;
  secondBatchId: string;
  reportBatchId?: string;
};

const fields = ["taskId", "releaseId", "revisionId", "firstBatchId", "secondBatchId"] as const;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const valid = (target: Partial<MonitorTarget>): target is MonitorTarget =>
  fields.every(field => uuid(target[field])) && target.firstBatchId !== target.secondBatchId;

export function opsPublicationTarget(href: string): MonitorTarget | undefined | null {
  const url = new URL(href);
  const query = url.searchParams;
  if (query.get("module") !== "ops" || !fields.some(field => query.has(field))) return undefined;
  const reportBatchId = query.get("reportBatchId");
  if (url.pathname !== "/v2/" || query.size !== fields.length + 1 + Number(reportBatchId !== null) ||
      !fields.every(field => query.getAll(field).length === 1)) return null;
  const target = Object.fromEntries(fields.map(field => [field, query.get(field) ?? ""]));
  if (!valid(target)) return null;
  if (reportBatchId === null) return target;
  return [target.firstBatchId, target.secondBatchId].includes(reportBatchId) ? {...target, reportBatchId} : null;
}

type SavedRelease = {
  id?: string; sourceAgentTaskId?: string; sourceRevisionId?: string;
  sourceRunId?: string; scope?: string; sourceKind?: string; reviewDigest?: string;
  packageId?: string; packageDigest?: string; runCount?: number;
  status?: string; health?: string;
  failureEvidence?: {status?: unknown; batches?: unknown};
};
type SavedBatch = {
  id?: string; releaseId?: string; sourceAgentTaskId?: string; sourceRunId?: string;
  sourceKind?: string; reviewDigest?: string; packageId?: string; packageDigest?: string;
  sequence?: number; status?: string; schedulerTriggered?: boolean; stage?: unknown;
  published?: boolean; engine?: string; mainSqlExecuted?: boolean;
  testSqlValidation?: {passed?: boolean}; validation?: {passed?: boolean};
};
type Reader = <T>(path: string) => Promise<T>;
type WorkerResult = "CONFIRMED" | "PENDING";

function readFailureEvidence(release: SavedRelease, batches: SavedBatch[]) {
  if (!batches.some(batch=>["FAILED","VALIDATION_FAILED"].includes(batch.status??""))) return;
  const evidence=release.failureEvidence, rows=evidence?.batches;
  const aligned=Array.isArray(rows) && rows.length===batches.length && rows.every((row,index)=>
    row?.id===batches[index].id && (row.status==="PENDING" ||
      row.status==="CONFIRMED" && ["SUCCEEDED","FAILED"].includes(batches[index].status??"") &&
      batches[index].schedulerTriggered===true));
  const workerResults=batches.map((batch,index):WorkerResult|undefined=>aligned && rows[index].status==="CONFIRMED" ? "CONFIRMED" :
    batch.schedulerTriggered===true || ["FAILED","VALIDATION_FAILED"].includes(batch.status??"") ? "PENDING" : undefined);
  const status:WorkerResult=evidence?.status==="CONFIRMED" && release.status==="COMPLETED_CLOUD_TEST" &&
    workerResults.every(result=>result==="CONFIRMED") ? "CONFIRMED" : "PENDING";
  return {status,workerResults};
}

export async function readOpsPublication(api: Reader, target: MonitorTarget) {
  const [release, first, second] = await Promise.all([
    api<SavedRelease>("/releases/" + target.releaseId),
    api<SavedBatch>("/release/runs/" + target.firstBatchId),
    api<SavedBatch>("/release/runs/" + target.secondBatchId),
  ]);
  if (release?.id !== target.releaseId || release.sourceAgentTaskId !== target.taskId ||
      release.sourceRevisionId !== target.revisionId || release.scope !== "PRIVATE_CLOUD_TEST" ||
      release.sourceKind !== "AGENT" || release.runCount !== 2 || !uuid(release.sourceRunId) ||
      !uuid(release.packageId) || !hash(release.packageDigest) || !hash(release.reviewDigest) ||
      ![first, second].every((batch, index) => batch?.id === (index === 0 ? target.firstBatchId : target.secondBatchId) &&
        batch.sequence === index + 1 && batch.releaseId === release.id &&
        batch.sourceAgentTaskId === release.sourceAgentTaskId && batch.sourceRunId === release.sourceRunId &&
        batch.sourceKind === release.sourceKind && batch.reviewDigest === release.reviewDigest &&
        batch.packageId === release.packageId && batch.packageDigest === release.packageDigest))
    throw new Error("原发布、代码版本或两个批次的来源不一致。");
  const canConsume = release.status === "COMPLETED_CLOUD_TEST" && release.health === "HEALTHY" &&
    [first, second].every(batch => batch.status === "SUCCEEDED" && batch.schedulerTriggered === true &&
      batch.published === true && batch.engine === "Apache Spark" && batch.mainSqlExecuted === true &&
      batch.testSqlValidation?.passed === true && batch.validation?.passed === true);
  const failure=readFailureEvidence(release,[first,second]);
  const batches = [first, second].map((batch,index) => {
    const {id, sequence, status, schedulerTriggered} = batch;
    const pendingLabel = privateReleasePendingLabel(batch);
    const serviceHref = canConsume ? "/v2/?" + new URLSearchParams({
      module:"services", source_task:target.taskId, source_release:target.releaseId,
      source_revision:target.revisionId, source_run:release.sourceRunId!, source_package:release.packageDigest!,
      source_scope:"PRIVATE_CLOUD_TEST", source_kind:"AGENT", release_batch:id!,
    }) : undefined;
    const reportSource = canConsume ? {
      kind:"AGENT" as const, taskId:target.taskId, releaseId:target.releaseId, revisionId:target.revisionId,
      runId:release.sourceRunId!, packageDigest:release.packageDigest!, batchId:id!,
    } : undefined;
    const workerResult=failure?.workerResults[index];
    return {id, sequence, status, schedulerTriggered, ...(pendingLabel ? {pendingLabel} : {}),
      ...(workerResult?{workerResult}:{}), serviceHref, reportSource};
  });
  return {status:release.status, health:release.health, batches,...(failure?{failureSettlement:failure.status}:{})};
}
