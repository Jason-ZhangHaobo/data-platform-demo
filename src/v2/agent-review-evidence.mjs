import { isDeepStrictEqual } from "node:util";
import { durableDeliveryMode, verifiedStoredCloudDevelopment } from "./agent-development-workflow.mjs";
import { sha256, validateDeliveryPackage, validationMatchesFamily } from "./delivery.mjs";
import { liveEvidenceProvenance } from "./live-lifecycle-provenance.mjs";
import { assertSqlRequirementPackageSource, sqlRequirementBinding } from "./sql-requirements.mjs";

// This only evaluates persisted, exact records. Provider and Worker reconciliation
// stay on the existing task workflow, and review stays with the engineer.
export function storedAgentReviewEvidence({ task, delivery, revision, run, bundle, verification, requestSha256 }) {
  const base = {
    protocol: "shuduo-agent-review-evidence/v1", scope: "PRIVATE_CLOUD_TEST",
    verificationMode: "STORED_METADATA_ONLY", taskId: task.id, deliveryId: delivery.id,
    fullLifecycleE2E: false, publicDeployed: false,
  };
  const reject = reason => ({ ...base, status: "UNCONFIRMED", reason });
  if (task.executionMode !== "DURABLE_SQL_AGENT_V1" || task.language !== "SPARK_SQL" ||
      task.mode !== "LIVE_MODEL" || delivery.mode !== durableDeliveryMode || delivery.sourceAgentTaskId !== task.id ||
      !task.submittedBy || delivery.submittedBy !== task.submittedBy)
    return reject("NATIVE_CLOUD_SOURCE_REQUIRED");
  if (typeof task.message !== "string" || sha256(task.message) !== requestSha256)
    return reject("REQUEST_DIGEST_MISMATCH");
  const proof = liveEvidenceProvenance(task, revision, run, delivery, bundle, verification);
  if (proof.synthetic || proof.nonNative || proof.unconfirmed || task.sourceRunId !== undefined)
    return reject("EXECUTION_PROVENANCE_UNCONFIRMED");
  if (["QUEUED","RUNNING"].includes(task.status) || ["QUEUED","RUNNING"].includes(delivery.status))
    return { ...base, status:"PENDING", reason:"STORED_RESULT_PENDING" };

  const development = verifiedStoredCloudDevelopment(task, revision, run);
  if (!development) return reject("DEVELOPMENT_RESULT_UNCONFIRMED");
  const {attempt, attempts, family} = development;

  if (delivery.status !== "SUCCEEDED" || delivery.stage !== "AWAITING_ENGINEER_REVIEW" || delivery.actualExecution !== true ||
      delivery.sourceRevisionId !== revision.id || delivery.sourceSqlHash !== revision.hash || delivery.sourceRunId !== run.id ||
      !bundle || bundle.id !== delivery.packageId || bundle.digest !== delivery.packageDigest ||
      bundle.agentDeliveryTaskId !== delivery.id || bundle.sourceRunId !== run.id)
    return reject("DELIVERY_SOURCE_UNCONFIRMED");
  let plan;
  try {
    plan = validateDeliveryPackage(bundle, delivery.packageDigest);
    assertSqlRequirementPackageSource(bundle, {agent:task, run, revision});
    if (!isDeepStrictEqual(delivery.sourceRequirementBinding, task.requirements ? sqlRequirementBinding(task.requirements) : undefined) ||
        plan.source.projectId !== task.projectId || plan.source.revisionId !== revision.id || plan.source.sqlHash !== revision.hash ||
        plan.source.runId !== run.id || plan.source.contextId !== task.contextId || plan.source.validationContractId !== family?.id ||
        plan.deployment.adapter !== "remote-spark-worker-v1")
      return reject("DELIVERY_MANIFEST_UNCONFIRMED");
  } catch {
    return reject("DELIVERY_MANIFEST_UNCONFIRMED");
  }
  if (!verification || verification.id !== delivery.verificationId || verification.agentDeliveryTaskId !== delivery.id ||
      verification.packageId !== bundle.id || verification.packageDigest !== bundle.digest ||
      verification.mode !== "CLOUD_ISOLATED_FILE_REHEARSAL" || verification.isolation !== "FUNCTION_PROCESS" ||
      verification.status !== "SUCCEEDED" || verification.actualExecution !== true || verification.engine !== "Apache Spark" ||
      verification.engineVersion !== plan.deployment.runtime.version || verification.mainSqlExecuted !== true ||
      verification.testSqlValidation?.passed !== true || verification.testSqlValidation.sqlHash !== sha256(bundle.files["tests.sql"]) ||
      !validationMatchesFamily(verification.validation, family) || delivery.remoteSubmission?.prepared?.job?.jobId !== verification.id)
    return reject("FILE_REHEARSAL_UNCONFIRMED");

  return { ...base, status:"REVIEW_EVIDENCE_READY", requestSha256, contextId:task.contextId, taskCreatedAt:task.createdAt,
    validationContractId:family.id, ...(plan.source.requirement ? {requirementBinding:plan.source.requirement} : {}),
    model:{id:attempt.model, attemptCount:attempts.length, accountedTokens:task.usedTokens,
      usageEstimated:attempts.some(item=>item?.usageEstimated === true)},
    development:{revisionId:revision.id, revisionHash:revision.hash, runId:run.id, engine:run.engine,
      engineVersion:run.engineVersion, regressionCount:run.validation.regressions.length},
    delivery:{stage:delivery.stage, packageId:bundle.id, packageDigest:bundle.digest,
      fileHashes:Object.fromEntries(Object.entries(bundle.manifest.files).map(([name,file])=>[name,file.sha256])),
      verificationId:verification.id, regressionCount:verification.validation.regressions.length},
  };
}
