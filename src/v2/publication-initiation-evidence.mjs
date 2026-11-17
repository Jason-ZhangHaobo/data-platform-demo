import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { uuid } from "./live-lifecycle-checkpoint.mjs";
import {publicationWakeKey} from "./publication-wake.mjs";

const session = "INVITED_SESSION_CONFIRMATION", background = "SIGNED_PUBLICATION_WAKE";
const id = value => typeof value === "string" && uuid.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const time = value => typeof value === "string" ? Date.parse(value) : NaN;

export function validPublicationInitiation(evidence, code, publication) {
  const trigger=evidence?.trigger;
  if (![session,background].includes(trigger) || !digest(evidence.originalRequestDigest) ||
      (trigger===background&&!id(evidence.wakeId)) ||
      ![code?.taskId,code?.revisionId,code?.runId,publication?.id,publication?.approvalId].every(id) ||
      !digest(publication.packageDigest) || !digest(publication.reviewDigest)) return false;
  const accepted = time(evidence.acceptedAt);
  if (!Number.isFinite(accepted) || !(time(publication.approvalTiming?.approvedAt)<=accepted) ||
      (publication.scheduledBatches!==undefined && (!Array.isArray(publication.scheduledBatches) ||
        publication.scheduledBatches.some(batch=>!(accepted<=time(batch?.triggeredAt)))))) return false;
  return isDeepStrictEqual(evidence,{trigger,originalRequestDigest:evidence.originalRequestDigest,
    acceptedAt:evidence.acceptedAt,taskId:code.taskId,revisionId:code.revisionId,developmentRunId:code.runId,
    releaseId:publication.id,approvalId:publication.approvalId,packageDigest:publication.packageDigest,
    reviewDigest:publication.reviewDigest,...(trigger===background?{wakeId:evidence.wakeId}:{})});
}

// The request key is kept on a private record. Later idempotency aliases
// cannot replace the original request that approved and created the release.
export function storedPublicationInitiation(store, project, release, approvalTiming, scheduledBatches) {
  if (release.initiationId === undefined && release.initiationRequestDigest === undefined) return;
  const saved=store.get("release_initiation",release.initiationId,project);
  const invalid=()=>Object.assign(new Error("原发布发起证据与批准或请求不一致"),{status:409});
  if (release.sourceKind!=="AGENT" || ![session,background].includes(saved?.trigger) ||
      typeof saved.requestId!=="string" || !saved.requestId || saved.requestId.length>100 ||
      saved.actorId!==release.submittedBy || saved.approvalId!==release.approvalId || saved.reviewId!==release.reviewId ||
      store.deduplicatedId(`${project}:cloud-publication:${saved.actorId}:${saved.requestId}`)!==release.id)
    throw invalid();
  const trigger=saved.trigger;
  if (trigger===background) {
    const wake=store.get("publication_wake",saved.wakeId,project),approval=store.get("release_approval",release.approvalId,project);
    if (!wake || store.deduplicatedId(publicationWakeKey(project,release.approvalId))!==wake.id ||
        !isDeepStrictEqual(wake.binding,{taskId:release.sourceAgentTaskId,actorId:saved.actorId,requestId:saved.requestId,
          approvalId:saved.approvalId,sourceRunId:release.sourceRunId,packageDigest:release.packageDigest,verificationId:release.verificationId,
          reviewDigest:release.reviewDigest,approvalWindow:approval?.publicationWindow}) ||
        !(wake.binding.approvalWindow?.startsAt<=time(saved.acceptedAt)&&time(saved.acceptedAt)<wake.binding.approvalWindow?.expiresAt) ||
        (wake.state==="RELEASED" && wake.releaseId!==release.id)) throw invalid();
  }
  const result={trigger,originalRequestDigest:createHash("sha256").update(saved.requestId).digest("hex"),
    acceptedAt:saved.acceptedAt,taskId:release.sourceAgentTaskId,revisionId:release.sourceRevisionId,developmentRunId:release.sourceRunId,
    releaseId:release.id,approvalId:release.approvalId,packageDigest:release.packageDigest,reviewDigest:release.reviewDigest,
    ...(trigger===background?{wakeId:saved.wakeId}:{})};
  if (result.originalRequestDigest!==release.initiationRequestDigest ||
      !validPublicationInitiation(result,{taskId:release.sourceAgentTaskId,revisionId:release.sourceRevisionId,runId:release.sourceRunId},
    {...release,approvalTiming,scheduledBatches})) throw invalid();
  return result;
}
