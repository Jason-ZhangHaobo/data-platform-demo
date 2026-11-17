import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { uuid } from "./live-lifecycle-checkpoint.mjs";

const trigger = "INVITED_SESSION_CONFIRMATION";
const id = value => typeof value === "string" && uuid.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const time = value => typeof value === "string" ? Date.parse(value) : NaN;

export function validPublicationInitiation(evidence, code, publication) {
  if (evidence?.trigger !== trigger || !digest(evidence.originalRequestDigest) ||
      ![code?.taskId,code?.revisionId,code?.runId,publication?.id,publication?.approvalId].every(id) ||
      !digest(publication.packageDigest) || !digest(publication.reviewDigest)) return false;
  const accepted = time(evidence.acceptedAt);
  if (!Number.isFinite(accepted) || !(time(publication.approvalTiming?.approvedAt)<=accepted) ||
      (publication.scheduledBatches!==undefined && (!Array.isArray(publication.scheduledBatches) ||
        publication.scheduledBatches.some(batch=>!(accepted<=time(batch?.triggeredAt)))))) return false;
  return isDeepStrictEqual(evidence,{trigger,originalRequestDigest:evidence.originalRequestDigest,
    acceptedAt:evidence.acceptedAt,taskId:code.taskId,revisionId:code.revisionId,developmentRunId:code.runId,
    releaseId:publication.id,approvalId:publication.approvalId,packageDigest:publication.packageDigest,
    reviewDigest:publication.reviewDigest});
}

// The request key is kept on a private record. Later idempotency aliases
// cannot replace the original request that approved and created the release.
export function storedPublicationInitiation(store, project, release, approvalTiming, scheduledBatches) {
  if (release.initiationId === undefined && release.initiationRequestDigest === undefined) return;
  const saved=store.get("release_initiation",release.initiationId,project);
  const invalid=()=>Object.assign(new Error("原发布发起证据与批准或请求不一致"),{status:409});
  if (release.sourceKind!=="AGENT" || saved?.trigger!==trigger ||
      typeof saved.requestId!=="string" || !saved.requestId || saved.requestId.length>100 ||
      saved.actorId!==release.submittedBy || saved.approvalId!==release.approvalId || saved.reviewId!==release.reviewId ||
      store.deduplicatedId(`${project}:cloud-publication:${saved.actorId}:${saved.requestId}`)!==release.id)
    throw invalid();
  const result={trigger,originalRequestDigest:createHash("sha256").update(saved.requestId).digest("hex"),
    acceptedAt:saved.acceptedAt,taskId:release.sourceAgentTaskId,revisionId:release.sourceRevisionId,developmentRunId:release.sourceRunId,
    releaseId:release.id,approvalId:release.approvalId,packageDigest:release.packageDigest,reviewDigest:release.reviewDigest};
  if (result.originalRequestDigest!==release.initiationRequestDigest ||
      !validPublicationInitiation(result,{taskId:release.sourceAgentTaskId,revisionId:release.sourceRevisionId,runId:release.sourceRunId},
    {...release,approvalTiming,scheduledBatches})) throw invalid();
  return result;
}
