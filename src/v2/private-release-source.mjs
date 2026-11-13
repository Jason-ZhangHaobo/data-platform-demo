import { exactPublicationReceipt, exactPublicationReviewBasis } from "./cloud-release-evidence.mjs";
import { storedAgentReviewEvidence } from "./agent-review-evidence.mjs";
import { resolveDeliverySchedule, sha256, validateDeliveryPackage } from "./delivery.mjs";
import { normalizedDistributionRows } from "./distribution-services.mjs";
import { verifiedPrivateServiceSource } from "./data-services.mjs";

function privateFundBatch(store, project, {run, release, bundle, approval}, get) {
  const invalid = () => Object.assign(Error("基金接口须绑定原审阅及两个已核验发布批次"), {
    status:409, code:"INVALID_FUND_RELEASE_PROVENANCE",
  });
  const plan = validateDeliveryPackage(bundle,bundle.digest);
  const origin = plan.source, attribution = origin.attribution;
  const agent = get("agent",release.sourceAgentTaskId), delivery = get("agent_delivery_task",bundle.agentDeliveryTaskId);
  const verification = get("delivery_verification",release.verificationId);
  if (!agent || !delivery || !verification || !approval || release.sourceKind !== "AGENT" || run.sourceKind !== "AGENT" ||
      release.manualDeliveryTaskId !== undefined || run.manualDeliveryTaskId !== undefined || release.publicDeployed !== false ||
      run.publicDeployed !== false || run.published !== true || run.clockMode !== "FC_TIMER" ||
      run.submittedBy !== agent.submittedBy || attribution.actorId !== agent.submittedBy ||
      attribution.originAgentTaskId !== agent.id || release.submittedBy !== agent.submittedBy ||
      release.sourceRunId !== origin.runId || release.sourceRevisionId !== origin.revisionId ||
      release.sourceCodeHash !== origin.sqlHash || release.packageId !== bundle.id ||
      release.packageDigest !== bundle.digest || delivery.packageId !== bundle.id ||
      release.fundBusinessDate !== origin.fundLookthrough.businessDate) throw invalid();
  const receipt = exactPublicationReceipt(store,project,release);
  if (receipt.monitoring.status !== "VERIFIED" || !receipt.monitoring.batches.some(item=>item.batchId===run.id))
    throw invalid();
  const evidence = storedAgentReviewEvidence({task:agent,delivery,bundle,verification,
    revision:get("revision",origin.revisionId),run:get("run",origin.runId),store,requestSha256:sha256(agent.message)});
  const occurrence = resolveDeliverySchedule(plan,release.businessScheduledFor);
  if (evidence.status !== "REVIEW_EVIDENCE_READY" || !occurrence.eligible ||
      occurrence.businessDate !== release.fundBusinessDate ||
      sha256(JSON.stringify(exactPublicationReviewBasis(evidence,{businessDate:occurrence.businessDate,
        businessScheduledFor:occurrence.scheduledFor}))) !== release.reviewDigest) throw invalid();
  const rows = normalizedDistributionRows(run.rows,origin.validationContractId);
  const sourceEvidence = {
    protocol:"shuduo-fund-consumption-source/v1",scope:"PRIVATE_CLOUD_TEST",upstreamKind:attribution.kind,
    agentTaskId:agent.id, modelMode:attribution.modelMode, releaseId:release.id, packageDigest:bundle.digest,
    batchId:run.id,batchSequence:run.sequence,revisionId:origin.revisionId,developmentRunId:origin.runId,
    contractId:origin.validationContractId,keyFields:origin.fundLookthrough.keyFields,businessDate:occurrence.businessDate,
    inputDigest:origin.fundLookthrough.inputHash,assertionDigest:origin.fundLookthrough.assertionHash,
    testSqlDigest:origin.fundDevelopment.testSqlDigest,resultDigest:sha256(JSON.stringify(rows)),rowCount:rows.length,
    batches:receipt.monitoring.batches,engineClassification:"ISOLATED_SPARK_RECEIPTS",
    eligibleForService:true,agentIndependentE2E:false,publicDeployed:false,
  };
  return {batch:{...run,source:origin,outputContractId:origin.validationContractId,businessDate:occurrence.businessDate,
    fundSource:{rows,evidence:sourceEvidence}},release,bundle,monitoring:receipt.monitoring};
}

export function readPrivateReleaseBatch(store, project, id) {
  const get = (kind, value) => typeof value === "string" ? store.get(kind, value, project) : undefined;
  const run = get("release_run", id);
  const release = get("release", run?.releaseId);
  const bundle = get("delivery_package", run?.packageId);
  const approval = get("release_approval", release?.approvalId);
  if (bundle?.manifest?.source?.fundDevelopment && release && run)
    return privateFundBatch(store,project,{run,release,bundle,approval},get);
  const batch = verifiedPrivateServiceSource({run, release, bundle, approval,
    ...(release?.manualDeliveryTaskId ? {
      delivery: get("manual_delivery_task", release.manualDeliveryTaskId),
      verification: get("delivery_verification", release.verificationId),
      review: get("delivery_review", release.reviewId),
      releaseRuns: store.list("release_run", project).filter(item => item.releaseId === release.id),
    } : {}),
  });
  let monitoring;
  if ([release, run, approval].some(record => Object.hasOwn(record, "reviewDigest"))) {
    const fail = message => Object.assign(Error(message), {status:409, code:"PUBLICATION_MONITORING_UNCONFIRMED"});
    if (typeof release.reviewDigest !== "string" || run.reviewDigest !== release.reviewDigest || approval.reviewDigest !== release.reviewDigest)
      throw fail("原发布审阅摘要不一致");
    ({monitoring} = exactPublicationReceipt(store, project, release));
    if (monitoring.status !== "VERIFIED" || !monitoring.batches.some(item => item.batchId === batch.id))
      throw fail("原发布的两个批次及同包监控尚未核验");
  }
  return {batch, release, bundle, monitoring};
}
