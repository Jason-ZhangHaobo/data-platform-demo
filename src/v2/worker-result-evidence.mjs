import { sha256 } from "./delivery.mjs";
import { liveEvidenceProvenance } from "./live-lifecycle-provenance.mjs";
import { uuid } from "./live-lifecycle-checkpoint.mjs";

const digest = value => typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value==="string" && Number.isFinite(Date.parse(value));
const id = value => typeof value==="string" && uuid.test(value);

export function verifiedWorkerResultDigest(receipt) {
  const proof=liveEvidenceProvenance(receipt);
  if (["SUCCEEDED","FAILED","VALIDATION_FAILED"].includes(receipt?.status) &&
      receipt.code!=="REMOTE_SPARK_TIMEOUT" && receipt.engine==="Apache Spark" &&
      !proof.synthetic && !proof.nonNative && !proof.unconfirmed)
    return sha256(JSON.stringify(receipt));
}

export function storedWorkerBatchResult(store,record,job,key) {
  if (!["SUCCEEDED","FAILED"].includes(record?.status) || !job || job.jobId!==record.id ||
      job.projectId!==record.projectId || !digest(record.workerResultDigest) ||
      store.deduplicatedId(key,record.workerResultDigest)!==record.id)
    return;
  const result={id:record.id,status:record.status,resultDigest:record.workerResultDigest,
    createdAt:record.createdAt,finishedAt:record.finishedAt,durationMs:record.durationMs??record.reservedDurationMs};
  if (validStoredWorkerBatchResult(result)) return result;
}

export function validStoredWorkerBatchResult(result) {
  return Boolean(result && Object.keys(result).length===6 && id(result.id) &&
    ["SUCCEEDED","FAILED"].includes(result.status) && digest(result.resultDigest) &&
    date(result.createdAt) && date(result.finishedAt) && Date.parse(result.createdAt)<=Date.parse(result.finishedAt) &&
    Number.isFinite(result.durationMs) && result.durationMs>=0);
}
