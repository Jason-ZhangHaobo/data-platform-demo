import { isDeepStrictEqual } from "node:util";
import { validationFamilyForContext } from "./context.mjs";
import { deliveryFiles, sha256 } from "./delivery.mjs";
import { currentLiveLifecycleContract, verifiedLiveTaskSnapshotBinding } from "./live-lifecycle-evaluation.mjs";
import { checkpointCaseScope, readCheckpoint, stop, uuid } from "./live-lifecycle-checkpoint.mjs";
import { liveEvidenceProvenance } from "./live-lifecycle-provenance.mjs";
import { agentReviewEvidencePath } from "./publication-request.mjs";
import { normalizeSessionBase } from "./session-credential.mjs";
import { sqlRequirementBinding } from "./sql-requirements.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === "string" && uuid.test(value);
const confirmed = action => action?.status === "CONFIRMED" && id(action.key) && id(action.id);
const nativeEvidence = value => {
  const {synthetic, nonNative, unconfirmed} = liveEvidenceProvenance(value);
  return !synthetic && !nonNative && !unconfirmed;
};

export async function readCloudV3Review(checkpointPath, client) {
  const {state, text} = readCheckpoint(checkpointPath, {privateFile:true});
  if (!id(state?.evaluationRunId)) stop("须使用原 v3 评测检查点");
  const {plan, contractId} = checkpointCaseScope(state, state.evaluationRunId);
  if (contractId !== currentLiveLifecycleContract.id) stop("仅核对固定 v3 首例");
  const base = new URL(normalizeSessionBase(client.baseUrl));
  if (base.pathname !== "/api/v2" || state.origin !== base.origin)
    stop("读取入口与原评测入口不一致");
  if (base.protocol === "https:" && !client.sessionFile) stop("请使用绑定原入口的受保护会话文件");

  const first = plan.selectedCases[0], item = state.outcomes.find(row => row.caseId === first.id);
  const result = await inspectFirstReview(first, item, client);
  if (readCheckpoint(checkpointPath, {privateFile:true}).text !== text)
    stop("读取期间原检查点已变化，请核对当前记录");
  return {
    protocol:"shuduo-cloud-v3-review-binding/v1", verificationMode:"STORED_RECEIPTS_ONLY",
    evaluationRunId:state.evaluationRunId, caseId:first.id, expectedCaseCount:plan.contract.expectedCaseCount,
    ...result, fullLifecycleE2E:false, agentIndependentE2E:false, publicDeployed:false,
  };
}

async function inspectFirstReview(definition, item, client) {
  const pending = reason => ({status:"PENDING", reason});
  const reject = reason => ({status:"UNCONFIRMED", reason});
  if (!item) return pending("ORIGINAL_AGENT_RECEIPT_PENDING");
  if (!nativeEvidence(item)) return reject("CASE_PROVENANCE_UNCONFIRMED");
  const agentAction = item.actions?.agent, deliveryAction = item.actions?.delivery;
  if (!confirmed(agentAction)) return pending("ORIGINAL_AGENT_RECEIPT_PENDING");
  if (agentAction.id !== item.taskId) return reject("ORIGINAL_AGENT_MISMATCH");
  if (!confirmed(deliveryAction)) return pending("ORIGINAL_DELIVERY_RECEIPT_PENDING");
  const code = item.code;
  if (code?.taskId !== item.taskId || !id(code.revisionId) || !id(code.runId) || !digest(code.revisionHash) ||
      deliveryAction.bodyHash !== sha256("{}") || (item.delivery && item.delivery.id !== deliveryAction.id))
    return reject("CHECKPOINT_SOURCE_MISMATCH");

  let task, delivery, review;
  try {
    task = await client.request(`/agent/requests/${agentAction.key}`);
    if (task?.executionMode !== "DURABLE_SQL_AGENT_V1" || !nativeEvidence(task) ||
        !verifiedLiveTaskSnapshotBinding(definition, item, task))
      return reject("ORIGINAL_AGENT_MISMATCH");
    const attempt = task.attempts.at(-1);
    if (task.status !== "SUCCEEDED" || attempt?.status !== "SUCCEEDED" ||
        attempt.revisionId !== code.revisionId || attempt.runId !== code.runId)
      return reject("ORIGINAL_DEVELOPMENT_MISMATCH");
    delivery = await client.request(`/agent/tasks/${task.id}/delivery-requests/${deliveryAction.key}`);
    const requirement = code.requirementEvidence ? sqlRequirementBinding(code.requirementEvidence) : undefined;
    if (delivery?.id !== deliveryAction.id || delivery.mode !== "DURABLE_AGENT_DELIVERY_V1" || !nativeEvidence(delivery) ||
        delivery.sourceAgentTaskId !== task.id || delivery.sourceRevisionId !== code.revisionId ||
        delivery.sourceRunId !== code.runId || delivery.sourceSqlHash !== code.revisionHash ||
        !isDeepStrictEqual(delivery.sourceRequirementBinding, requirement))
      return reject("ORIGINAL_DELIVERY_MISMATCH");
    if (["QUEUED","RUNNING"].includes(delivery.status)) return pending("CLOUD_REHEARSAL_PENDING");
    if (delivery.status !== "SUCCEEDED" || delivery.stage !== "AWAITING_ENGINEER_REVIEW" || delivery.actualExecution !== true ||
        !id(delivery.packageId) || !digest(delivery.packageDigest) || !id(delivery.verificationId) ||
        (item.delivery && ["packageId","packageDigest","verificationId"].some(key=>item.delivery[key]!==delivery[key])))
      return reject("ORIGINAL_DELIVERY_UNCONFIRMED");

    const requestSha256 = sha256(definition.request);
    review = await client.request(agentReviewEvidencePath({taskId:task.id, deliveryId:delivery.id, requestSha256}));
    if (review?.protocol !== "shuduo-agent-review-evidence/v1" || review.scope !== "PRIVATE_CLOUD_TEST" ||
        review.verificationMode !== "STORED_METADATA_ONLY" || review.taskId !== task.id || review.deliveryId !== delivery.id ||
        review.fullLifecycleE2E !== false || review.publicDeployed !== false || !nativeEvidence(review))
      return reject("REVIEW_EVIDENCE_MISMATCH");
    if (review.status === "PENDING") return pending("CLOUD_REHEARSAL_PENDING");
    const files = review.delivery?.fileHashes, family = validationFamilyForContext(definition.contextId);
    if (review.status !== "REVIEW_EVIDENCE_READY" || review.requestSha256 !== requestSha256 ||
        review.contextId !== definition.contextId || review.taskCreatedAt !== task.createdAt ||
        review.validationContractId !== family?.id || !isDeepStrictEqual(review.requirementBinding, requirement) ||
        review.model?.id !== attempt.model || review.model.attemptCount !== task.attempts.length ||
        review.model.accountedTokens !== task.usedTokens || review.development?.runId !== code.runId ||
        review.development.revisionId !== code.revisionId || review.development.revisionHash !== code.revisionHash ||
        review.development.engine !== "Apache Spark" || review.development.engineVersion !== "3.5.9" ||
        review.development.regressionCount !== family.contextIds.length || review.delivery?.stage !== delivery.stage ||
        ["packageId","packageDigest","verificationId"].some(key=>review.delivery[key]!==delivery[key]) ||
        review.delivery.regressionCount !== family.contextIds.length ||
        !files || Object.keys(files).length !== deliveryFiles.length || !deliveryFiles.every(name=>digest(files[name])) ||
        files["main.sql"] !== code.revisionHash)
      return reject("REVIEW_EVIDENCE_UNCONFIRMED");
    return {status:"REVIEW_EVIDENCE_BOUND", taskId:task.id, deliveryId:delivery.id, requestSha256,
      revisionId:code.revisionId, developmentRunId:code.runId, packageId:delivery.packageId,
      packageDigest:delivery.packageDigest, verificationId:delivery.verificationId};
  } catch (error) {
    if (error?.status === 404 && !review)
      return reject(!task ? "ORIGINAL_AGENT_NOT_RECORDED" : !delivery ? "ORIGINAL_DELIVERY_NOT_RECORDED" : "REVIEW_EVIDENCE_NOT_RECORDED");
    return reject("CLOUD_RECEIPT_READ_UNCONFIRMED");
  }
}
