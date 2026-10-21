import { createHash } from "node:crypto";
import { m1EvaluationCases, validateM1EvaluationCases } from "./evaluation.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export const lifecycleStages = Object.freeze([
  "requirementUnderstanding",
  "codeAndDebug",
  "scheduleFiles",
  "deploymentFiles",
  "engineerReview",
  "localRelease",
  "postReleaseMonitoring",
]);

export const fullLifecycleContract = Object.freeze({
  id: "securities-full-lifecycle-20-cases-local-v3",
  sourceCodeEvaluationRunId: "a6ccf750-836d-4f1b-8e73-a66da710e1bb",
  sourceEvidenceDigest: "b6c9073eacd19bb63dd4461624e598770d459948061c9db4f0ce7915009edc2b",
  expectedCaseCount: 20,
  targetRate: 0.85,
  deploymentScope: "LOCAL_ACTUAL",
  publicDeployed: false,
  stageNames: lifecycleStages,
  completionRule:
    "每例必须同时具备原真实Agent需求/代码/调试证据、调度与部署文件、成功演练、独立审阅记录、摘要审批、本机版本激活、两个墙上时钟Spark批次和健康监控。",
});

export function validateFrozenCodeEvidence(evidence) {
  const cases = m1EvaluationCases(),
    coverage = validateM1EvaluationCases(cases),
    expected = new Map(cases.map((item) => [item.id, item]));
  if (
    !evidence ||
    hash(evidence) !== fullLifecycleContract.sourceEvidenceDigest ||
    evidence.format !== "shuduo-frozen-code-evidence/v1" ||
    evidence.sourceEvaluationRunId !==
      fullLifecycleContract.sourceCodeEvaluationRunId ||
    evidence.caseSetDigest !== coverage.caseSetDigest ||
    evidence.caseCount !== fullLifecycleContract.expectedCaseCount ||
    !Array.isArray(evidence.cases) ||
    evidence.cases.length !== fullLifecycleContract.expectedCaseCount ||
    new Set(evidence.cases.map((item) => item.caseId)).size !==
      fullLifecycleContract.expectedCaseCount ||
    evidence.logsIncluded !== false ||
    evidence.classification !== "SYNTHETIC_SECURITIES_ONLY"
  )
    throw new Error("冻结代码证据格式、范围或来源不合法");
  for (const item of evidence.cases) {
    const definition = expected.get(item.caseId);
    if (
      !definition ||
      item.contextId !== definition.contextId ||
      item.category !== definition.category ||
      item.requirement !== definition.request ||
      item.code?.source !== "LIVE_MODEL" ||
      hash(item.code.sql) !== item.code.sqlHash ||
      item.execution?.engine !== "Apache Spark" ||
      item.execution?.engineVersion !== "3.5.7" ||
      !item.execution?.validation?.passed ||
      item.execution.validation.regressions?.length !== 5 ||
      item.execution.validation.regressions.some((check) => !check.passed) ||
      item.original?.attemptCount < 1 ||
      item.original?.attemptCount > 3
    )
      throw new Error(`冻结代码证据不一致：${item.caseId}`);
  }
  return {
    contract: fullLifecycleContract,
    caseSetDigest: coverage.caseSetDigest,
    evidenceDigest: hash(evidence),
    caseCount: evidence.cases.length,
  };
}

const identifier = value => typeof value === "string" && value.trim().length > 0;
const references = (stage, ids) => Array.isArray(stage?.evidenceIds) &&
  stage.evidenceIds.length > 0 && stage.evidenceIds.every(identifier) &&
  ids.every(id => identifier(id) && stage.evidenceIds.includes(id));
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export function inspectLifecycleOutcome(definition, outcome) {
  const stages = outcome?.stages ?? {}, issues = [];
  const check = (stage, condition) => {
    if (stages[stage]?.status !== "PASSED" || !condition) issues.push(stage);
  };
  const requirement = stages.requirementUnderstanding, code = stages.codeAndDebug,
    schedule = stages.scheduleFiles, deployment = stages.deploymentFiles,
    review = stages.engineerReview, release = stages.localRelease,
    monitor = stages.postReleaseMonitoring;
  const digest = schedule?.packageDigest, packageId = outcome?.packageId,
    verificationId = review?.verificationId, releaseId = outcome?.releaseId;
  check("requirementUnderstanding", outcome?.contextId === definition.contextId &&
    outcome?.category === definition.category && outcome?.sourceAgentTaskId === definition.original.agentTaskId &&
    references(requirement, [definition.original.agentTaskId]) &&
    requirement?.requirementSha256 === hash(definition.requirement) && requirement?.liveModel === true);
  check("codeAndDebug", references(code, [definition.original.revisionId, definition.original.runId, code?.currentRevisionId, code?.currentSparkRunId]) &&
    code?.sqlHash === definition.code.sqlHash && code?.attemptCount === definition.original.attemptCount &&
    code?.regressionCount === 5 && code?.importedFromFrozenLiveEvidence === true &&
    /^\d+\.\d+(?:\.\d+)?$/.test(code?.currentSparkVersion ?? "") && code?.currentSparkRunId !== definition.original.runId);
  check("scheduleFiles", sha256(digest) && references(schedule, [packageId]) &&
    Array.isArray(schedule?.files) &&
    ["schedule.json", "calendar.json", "manifest"].every(name => schedule?.files?.includes(name)));
  check("deploymentFiles", deployment?.packageDigest === digest && sha256(digest) &&
    references(deployment, [packageId, verificationId]) && deployment?.actualSparkRehearsal === true &&
    Array.isArray(deployment?.files) &&
    deployment?.rehearsalStatus === "SUCCEEDED" && ["deployment.json", "main.sql", "tests.sql"].every(name => deployment?.files?.includes(name)));
  check("engineerReview", review?.packageDigest === digest && sha256(digest) &&
    references(review, [review?.reviewId, verificationId]) && review?.evaluatorAttestation === true && review?.reviewScope === "LOCAL_TEST_RELEASE");
  const batches = release?.batches;
  const batchIds = Array.isArray(batches) ? batches.map(batch => batch?.id) : [];
  const validBatches = Array.isArray(batches) && batches.length === 2 && new Set(batchIds).size === 2 &&
    batches.every(batch => identifier(batch.id) && batch.releaseId === releaseId && batch.packageId === packageId &&
      batch.packageDigest === digest && batch.status === "SUCCEEDED" && batch.engine === "Apache Spark" &&
      batch.schedulerTriggered === true && batch.clockMode === "WALL_CLOCK_TIMER" && batch.validationPassed === true &&
      [release.activatedAt,batch.scheduledTriggerAt,batch.startedAt,batch.finishedAt].every(timestamp) &&
      Date.parse(release.activatedAt) <= Date.parse(batch.scheduledTriggerAt) &&
      Date.parse(batch.scheduledTriggerAt) <= Date.parse(batch.startedAt) && Date.parse(batch.startedAt) <= Date.parse(batch.finishedAt));
  check("localRelease", sha256(digest) && release?.packageDigest === digest && release?.approvalBound === true &&
    release?.schedulerTriggered === true && release?.actualSparkBatchCount === 2 && outcome?.scheduledBatchCount === 2 &&
    release?.deploymentScope === "LOCAL_ACTUAL" && validBatches &&
    references(release, [review?.reviewId, release?.approvalId, releaseId, ...batchIds]));
  const events = monitor?.successfulEvents;
  check("postReleaseMonitoring", monitor?.health === "HEALTHY" && monitor?.successfulRunCount === 2 &&
    monitor?.openAlertCount === 0 && references(monitor, [releaseId]) && Array.isArray(events) &&
    events.length >= 2 && new Set(events.map(event => event?.id)).size === events.length &&
    batchIds.length === 2 && batchIds.every(id => events.some(event => event.releaseRunId === id)) &&
    events.every(event => identifier(event.id) && event.type === "BATCH_SUCCEEDED" &&
      event.releaseId === releaseId && event.packageDigest === digest && batchIds.includes(event.releaseRunId) &&
      timestamp(event.observedAt) && Date.parse(event.observedAt) >= Date.parse(batches.find(batch=>batch.id===event.releaseRunId).finishedAt) && references(monitor, [event.id])));
  return {caseId: definition.caseId, passed: issues.length === 0 && outcome?.localFullLifecycleE2E === true &&
    outcome?.publicDeployed === false, incompleteStages: issues};
}

export function summarizeLifecycleEvaluation(evidence, outcomes) {
  const frozen = validateFrozenCodeEvidence(evidence);
  if (!Array.isArray(outcomes)) throw new Error("完整链路结果必须是数组");
  const byId = new Map(outcomes.map((item) => [item.caseId, item]));
  if (byId.size !== outcomes.length)
    throw new Error("完整链路结果包含重复场景");
  if (outcomes.some((item) => !evidence.cases.some((c) => c.caseId === item.caseId)))
    throw new Error("完整链路结果包含未登记场景");
  const inspections = evidence.cases.filter(item => byId.has(item.caseId)).map(item => inspectLifecycleOutcome(item, byId.get(item.caseId))),
    completed = inspections.length,
    succeeded = inspections.filter(item => item.passed).length,
    detours = outcomes.flatMap((item) => item.detours ?? []),
    finalRate = succeeded / evidence.cases.length;
  return {
    format: "shuduo-full-lifecycle-evaluation/v2",
    contract: fullLifecycleContract,
    sourceEvidenceDigest: frozen.evidenceDigest,
    frozenCaseCount: evidence.cases.length,
    completedCaseCount: completed,
    succeededCaseCount: succeeded,
    failedCaseCount: completed - succeeded,
    unexecutedCaseCount: evidence.cases.length - completed,
    evidenceChecks: inspections,
    modelEvidenceMode: "FROZEN_REPLAY",
    evidenceValidationScope: "REPORT_CONSISTENCY",
    agentIndependentE2E: false,
    agentE2ETargetMet: false,
    rescuedSucceededCaseCount: inspections.filter(item => item.passed && byId.get(item.caseId).detours?.some(detour => detour.rescued === true)).length,
    localFullLifecycleRate: finalRate,
    finalRateAvailable: completed === evidence.cases.length,
    targetMet:
      completed === evidence.cases.length &&
      succeeded / evidence.cases.length >= fullLifecycleContract.targetRate,
    detourCounts: {
      blocked: detours.filter((item) => item.status === "BLOCKED").length,
      cancelled: detours.filter((item) => item.status === "CANCELLED").length,
      failed: detours.filter((item) => item.status === "FAILED").length,
      rescued: detours.filter((item) => item.rescued === true).length,
    },
    totalScheduledBatches: outcomes.reduce(
      (sum, item) => sum + (Number.isSafeInteger(item.scheduledBatchCount) && item.scheduledBatchCount >= 0 && item.scheduledBatchCount <= 2 ? item.scheduledBatchCount : 0),
      0,
    ),
    fullLifecycleE2E: completed === evidence.cases.length && succeeded === completed,
    deploymentScope: "LOCAL_ACTUAL",
    publicDeployed: false,
    disclosure:
      "本机历史模型产物回放；成功项须具备七阶段关联证据，包含评测执行者审阅与人工救援。成功率分母固定20；不计入新任务Agent自主E2E、公网或生产完成率。",
  };
}

export function verifyLifecycleReport(evidence, report) {
  if (report?.format !== "shuduo-full-lifecycle-evaluation/v2" || report.contract?.id !== fullLifecycleContract.id ||
    JSON.stringify(report.contract?.stageNames) !== JSON.stringify(lifecycleStages) ||
    report.deploymentScope !== "LOCAL_ACTUAL" || report.publicDeployed !== false ||
    !identifier(report.evaluationRunId)) throw new Error("评测报告不符合当前证据契约");
  const summary = summarizeLifecycleEvaluation(evidence, report.outcomes);
  for (const field of ["sourceEvidenceDigest", "frozenCaseCount", "completedCaseCount", "succeededCaseCount", "failedCaseCount",
    "unexecutedCaseCount", "localFullLifecycleRate", "finalRateAvailable", "targetMet", "fullLifecycleE2E",
    "totalScheduledBatches", "modelEvidenceMode", "evidenceValidationScope", "agentIndependentE2E", "agentE2ETargetMet", "rescuedSucceededCaseCount"]) {
    if (report[field] !== summary[field]) throw new Error("评测汇总与逐例证据不一致");
  }
  return {...report, ...summary};
}
