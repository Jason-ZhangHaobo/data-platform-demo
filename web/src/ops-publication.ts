import {privateReleasePendingLabel} from "../../src/v2/private-release-stage.mjs";
import {serviceHandoffLocation, serviceSourceFromLocation} from "./service-source-binding.ts";
import {serviceBatchFromLocation} from "./service-batch-scope.ts";

type MonitorTarget = {
  taskId: string;
  releaseId: string;
  revisionId: string;
  firstBatchId: string;
  secondBatchId: string;
  reportBatchId?: string;
  source?: {runId:string;packageDigest:string;verificationId:string;reviewDigest:string};
};

const fields = ["taskId", "releaseId", "revisionId", "firstBatchId", "secondBatchId"] as const;
const sourceFields = ["runId", "packageDigest", "verificationId", "reviewDigest"] as const;
const servicePublicationFields = ["firstBatchId","secondBatchId","verificationId","reviewDigest"] as const;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const valid = (target: Partial<MonitorTarget>): target is MonitorTarget =>
  fields.every(field => uuid(target[field])) && target.firstBatchId !== target.secondBatchId;

export function opsPublicationTarget(href: string, agent = false): MonitorTarget | undefined | null {
  const url = new URL(href);
  const query = url.searchParams;
  if (agent ? url.hash !== "#agent-publication-history" : query.get("module") !== "ops" || !fields.some(field => query.has(field))) return undefined;
  const reportBatchId = query.get("reportBatchId");
  const hasSource = sourceFields.some(field => query.has(field));
  if (url.pathname !== "/v2/" || query.getAll("module").length !== 1 || query.get("module") !== (agent ? "agent-center" : "ops") ||
      query.size !== fields.length + 1 + Number(reportBatchId !== null) + (hasSource ? sourceFields.length : 0) ||
      !fields.every(field => query.getAll(field).length === 1) || agent && (!hasSource || reportBatchId !== null)) return null;
  const target = Object.fromEntries(fields.map(field => [field, query.get(field) ?? ""]));
  if (!valid(target)) return null;
  if (reportBatchId !== null && ![target.firstBatchId,target.secondBatchId].includes(reportBatchId)) return null;
  const selected={...target,...(reportBatchId===null ? {} : {reportBatchId})};
  if (!hasSource) return selected;
  const [runId,packageDigest,verificationId,reviewDigest]=sourceFields.map(field=>query.get(field));
  if (!sourceFields.every(field=>query.getAll(field).length===1) || !uuid(runId) || !uuid(verificationId) ||
      !hash(packageDigest) || !hash(reviewDigest)) return null;
  return {...selected,source:{runId,packageDigest,verificationId,reviewDigest}};
}

export function publicationMonitorHref(target:MonitorTarget, agent = false) {
  const query=new URLSearchParams({module:agent?"agent-center":"ops"});
  for (const field of fields) query.set(field,target[field]);
  if (target.source) for (const field of sourceFields) query.set(field,target.source[field]);
  return "/v2/?" + query + (agent ? "#agent-publication-history" : "#ops-exact-publication");
}

export function publicationBatchReportHref(target:MonitorTarget, batchId:string) {
  if (![target.firstBatchId,target.secondBatchId].includes(batchId)) throw Error("原报表批次未确认");
  return publicationMonitorHref(target).replace("#ops-exact-publication", "&reportBatchId="+encodeURIComponent(batchId)+"#ops-batch-report");
}

export const batchServiceHistoryHash = "#release-batch-consumption";
export function batchServiceHistoryHref(target:MonitorTarget,batchId:string) {
  const source=target.source;
  if (!source || ![target.firstBatchId,target.secondBatchId].includes(batchId)) throw Error("原消费批次未确认");
  const url=serviceHandoffLocation("https://history.invalid/v2/",{taskId:target.taskId,releaseId:target.releaseId,
    revisionId:target.revisionId,runId:source.runId,packageDigest:source.packageDigest,scope:"PRIVATE_CLOUD_TEST",sourceKind:"AGENT"});
  const {firstBatchId,secondBatchId}=target, {verificationId,reviewDigest}=source;
  for(const [field,value] of Object.entries({firstBatchId,secondBatchId,verificationId,reviewDigest})) url.searchParams.set(field,value);
  url.searchParams.set("release_batch",batchId);
  return url.pathname+url.search+batchServiceHistoryHash;
}

export function batchServiceHistoryTarget(href:string) {
  const url=new URL(href), query=url.searchParams;
  if(url.hash!==batchServiceHistoryHash) return;
  const source=serviceSourceFromLocation(href);
  const sourceCount=[...query.keys()].filter(key=>key.startsWith("source_")).length;
  if(url.pathname!=="/v2/"||query.size!==sourceCount+servicePublicationFields.length+2||query.getAll("module").length!==1||source.status!=="VALID") return null;
  const binding=source.binding,batchId=serviceBatchFromLocation(href,binding);
  const [firstBatchId,secondBatchId,verificationId,reviewDigest]=servicePublicationFields.map(key=>query.getAll(key).length===1?query.get(key):null);
  if(!batchId||!uuid(firstBatchId)||!uuid(secondBatchId)||firstBatchId===secondBatchId||![firstBatchId,secondBatchId].includes(batchId)||
     !uuid(verificationId)||!hash(reviewDigest)||!uuid(binding.taskId)||!uuid(binding.revisionId)||!uuid(binding.runId)) return null;
  return {binding,batchId,publication:{taskId:binding.taskId,releaseId:binding.releaseId,revisionId:binding.revisionId,firstBatchId,secondBatchId,
    source:{runId:binding.runId,packageDigest:binding.packageDigest,verificationId,reviewDigest}}};
}

type SavedRelease = {
  id?: string; sourceAgentTaskId?: string; sourceRevisionId?: string;
  sourceRunId?: string; scope?: string; sourceKind?: string; reviewDigest?: string;
  packageId?: string; packageDigest?: string; verificationId?:string; runCount?: number;
  status?: string; health?: string; fundBusinessDate?:string;
  failureEvidence?: {status?: unknown; batches?: unknown};
  monitoringEvidence?: {status?:unknown; batches?:unknown};
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
      target.source && (target.source.runId!==release.sourceRunId || target.source.packageDigest!==release.packageDigest ||
        target.source.verificationId!==release.verificationId || target.source.reviewDigest!==release.reviewDigest) ||
      ![first, second].every((batch, index) => batch?.id === (index === 0 ? target.firstBatchId : target.secondBatchId) &&
        batch.sequence === index + 1 && batch.releaseId === release.id &&
        batch.sourceAgentTaskId === release.sourceAgentTaskId && batch.sourceRunId === release.sourceRunId &&
        batch.sourceKind === release.sourceKind && batch.reviewDigest === release.reviewDigest &&
        batch.packageId === release.packageId && batch.packageDigest === release.packageDigest))
    throw new Error("原发布、代码版本或两个批次的来源不一致。");
  const savedHealthy = release.status === "COMPLETED_CLOUD_TEST" && release.health === "HEALTHY";
  const expectedHealthy = savedHealthy && [first, second].every(batch => batch.status === "SUCCEEDED" && batch.schedulerTriggered === true &&
      batch.published === true && batch.engine === "Apache Spark" && batch.mainSqlExecuted === true &&
      batch.testSqlValidation?.passed === true && batch.validation?.passed === true);
  const events=release.monitoringEvidence?.batches;
  const monitoringVerified=expectedHealthy && release.monitoringEvidence?.status==="VERIFIED" && Array.isArray(events) && events.length===2 &&
    events.every((row,index)=>row?.batchId===[first,second][index].id&&uuid(row.eventId)&&typeof row.observedAt==="string"&&Number.isFinite(Date.parse(row.observedAt))) &&
    events[0].eventId!==events[1].eventId;
  const failure=readFailureEvidence(release,[first,second]);
  const source=uuid(release.verificationId)?{runId:release.sourceRunId,packageDigest:release.packageDigest,verificationId:release.verificationId,reviewDigest:release.reviewDigest}:undefined;
  const batches = [first, second].map((batch,index) => {
    const {id, sequence, status, schedulerTriggered} = batch;
    const pendingLabel = privateReleasePendingLabel(batch);
    const serviceHref = monitoringVerified && !release.fundBusinessDate && source && id ? batchServiceHistoryHref({...target,source},id) : undefined;
    const reportSource = monitoringVerified && !release.fundBusinessDate ? {
      kind:"AGENT" as const, taskId:target.taskId, releaseId:target.releaseId, revisionId:target.revisionId,
      runId:release.sourceRunId!, packageDigest:release.packageDigest!, batchId:id!,
    } : undefined;
    const workerResult=failure?.workerResults[index];
    return {id, sequence, status, schedulerTriggered, ...(pendingLabel ? {pendingLabel} : {}),
      ...(workerResult?{workerResult}:{}), serviceHref, reportSource};
  });
  return {status:release.status, health:release.health, batches, source,
    ...(savedHealthy ? {monitoringVerified} : {}),...(failure?{failureSettlement:failure.status}:{})};
}
