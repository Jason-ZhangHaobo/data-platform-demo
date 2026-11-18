import { isDeepStrictEqual } from "node:util";
import { uuid } from "./live-lifecycle-checkpoint.mjs";

const id = value => typeof value === "string" && uuid.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// This is available only once the signed grant has settled the original
// immutable artifact. A trigger label on an in-flight task is insufficient.
export function storedBackgroundPreparationEvidence(store, project, delivery) {
  if (delivery.preparationTrigger !== "SIGNED_BACKGROUND_EVENT" ||
      delivery.sourcePinned !== true || !id(delivery.preparationRequestId) ||
      store.deduplicatedId(`${project}:durable-delivery:${delivery.sourceAgentTaskId}:${delivery.preparationRequestId}`) !== delivery.id)
    return;
  const grant = store.get("agent_background",delivery.preparationRequestId,project);
  const completed = grant?.preparedDelivery;
  if (grant?.status !== "COMPLETED" || grant.prepareFiles !== true ||
      grant.taskId !== delivery.sourceAgentTaskId || grant.actorId !== delivery.submittedBy ||
      completed?.deliveryId !== delivery.id || completed.packageId !== delivery.packageId ||
      completed.packageDigest !== delivery.packageDigest || completed.preparationTrigger !== delivery.preparationTrigger)
    return;
  const bundle = store.get("delivery_package",delivery.packageId,project);
  const source = bundle?.manifest?.source;
  if (!bundle?.artifact || bundle.agentDeliveryTaskId !== delivery.id || bundle.digest !== delivery.packageDigest ||
      !source || source.revisionId !== delivery.sourceRevisionId ||
      source.runId !== delivery.sourceRunId || source.sqlHash !== delivery.sourceSqlHash)
    return;
  return {trigger:"SIGNED_BACKGROUND_EVENT",taskId:delivery.sourceAgentTaskId,revisionId:delivery.sourceRevisionId,
    revisionHash:delivery.sourceSqlHash,developmentRunId:delivery.sourceRunId,
    deliveryId:delivery.id,packageId:delivery.packageId,packageDigest:delivery.packageDigest};
}

export function validBackgroundPreparationEvidence(evidence, code, delivery) {
  return code?.sourceKind === "AGENT" && [code.taskId,code.revisionId,code.runId,delivery?.id,delivery?.packageId].every(id) &&
    digest(code.revisionHash) && digest(delivery.packageDigest) &&
    isDeepStrictEqual(evidence,{trigger:"SIGNED_BACKGROUND_EVENT",taskId:code.taskId,revisionId:code.revisionId,
      revisionHash:code.revisionHash,developmentRunId:code.runId,deliveryId:delivery.id,packageId:delivery.packageId,
      packageDigest:delivery.packageDigest});
}
