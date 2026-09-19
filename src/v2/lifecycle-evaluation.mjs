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
  id: "securities-full-lifecycle-20-cases-local-v2",
  sourceCodeEvaluationRunId: "a6ccf750-836d-4f1b-8e73-a66da710e1bb",
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

export function summarizeLifecycleEvaluation(evidence, outcomes) {
  const frozen = validateFrozenCodeEvidence(evidence);
  if (!Array.isArray(outcomes)) throw new Error("完整链路结果必须是数组");
  const byId = new Map(outcomes.map((item) => [item.caseId, item]));
  if (byId.size !== outcomes.length)
    throw new Error("完整链路结果包含重复场景");
  if (outcomes.some((item) => !evidence.cases.some((c) => c.caseId === item.caseId)))
    throw new Error("完整链路结果包含未登记场景");
  const completed = evidence.cases.filter((item) => byId.has(item.caseId)).length,
    succeeded = evidence.cases.filter((item) => {
      const outcome = byId.get(item.caseId);
      return (
        outcome &&
        lifecycleStages.every(
          (stage) => outcome.stages?.[stage]?.status === "PASSED",
        ) &&
        outcome.localFullLifecycleE2E === true &&
        outcome.publicDeployed === false
      );
    }).length,
    detours = outcomes.flatMap((item) => item.detours ?? []),
    finalRate = completed ? succeeded / completed : 0;
  return {
    format: "shuduo-full-lifecycle-evaluation/v1",
    contract: fullLifecycleContract,
    sourceEvidenceDigest: frozen.evidenceDigest,
    frozenCaseCount: evidence.cases.length,
    completedCaseCount: completed,
    succeededCaseCount: succeeded,
    failedCaseCount: completed - succeeded,
    unexecutedCaseCount: evidence.cases.length - completed,
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
      (sum, item) => sum + Number(item.scheduledBatchCount ?? 0),
      0,
    ),
    fullLifecycleE2E: completed === evidence.cases.length && succeeded === completed,
    deploymentScope: "LOCAL_ACTUAL",
    publicDeployed: false,
    disclosure:
      "这是本机完整链路评测：真实文件、审批、版本激活、墙上时钟Spark批次和监控均有证据；不等于公网、云隔离或生产E2E。",
  };
}
