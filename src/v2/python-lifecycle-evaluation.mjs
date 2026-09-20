import { createHash } from "node:crypto";
import { contextIds } from "./context.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export const pythonLifecycleStages = Object.freeze([
  "requirementUnderstanding",
  "codeAndDebug",
  "scheduleFiles",
  "deploymentFiles",
  "engineerReview",
  "localRelease",
  "postReleaseMonitoring",
  "dapiConsumption",
]);

const focuses = {
  "holdings-t1": "基准客户总资产、持仓市值、现金和证券数量",
  "cash-change": "现金变化不能被持仓连接重复累计",
  "duplicate-position": "同一position_id重复记录必须去重",
  "equal-value-positions": "不同position_id即使金额相同也必须分别保留",
  "cash-only-client": "只有现金没有持仓的客户也必须返回",
};

export function pythonLifecycleCases() {
  return contextIds.map((contextId) => ({
    caseId: `python--${contextId}`,
    contextId,
    category: "PYTHON_FULL_LIFECYCLE",
    requirement:
      `使用受限Python开发财富顾问T+1客户资产任务，重点验证${focuses[contextId]}。` +
      "结果必须包含client_id、holding_market_value、available_cash、total_assets、security_count，并完成调度、发布、监控和DAPI消费。",
  }));
}

export const pythonLifecycleContract = Object.freeze({
  id: "securities-python-full-lifecycle-5-cases-local-v1",
  expectedCaseCount: 5,
  targetRate: 0.85,
  deploymentScope: "LOCAL_ACTUAL_RESTRICTED_PYTHON",
  publicDeployed: false,
  stageNames: pythonLifecycleStages,
  completionRule:
    "每例必须由真实模型生成Python并通过五套断言，生成/演练不可变文件，完成人工审阅与审批、两个计时CPython批次、健康监控和授权DAPI调用。",
});

export function validatePythonLifecycleCases(cases = pythonLifecycleCases()) {
  if (
    !Array.isArray(cases) ||
    cases.length !== pythonLifecycleContract.expectedCaseCount ||
    new Set(cases.map((item) => item.caseId)).size !== cases.length ||
    !cases.every(
      (item) =>
        contextIds.includes(item.contextId) &&
        item.caseId === `python--${item.contextId}` &&
        item.category === "PYTHON_FULL_LIFECYCLE" &&
        typeof item.requirement === "string" &&
        item.requirement.length >= 80,
    )
  )
    throw new Error("Python完整链路评测集不完整或不合法");
  return {
    contract: pythonLifecycleContract,
    caseSetDigest: hash(cases),
    perContext: Object.fromEntries(
      contextIds.map((id) => [
        id,
        cases.filter((item) => item.contextId === id).length,
      ]),
    ),
  };
}

export function summarizePythonLifecycleEvaluation(cases, outcomes) {
  const coverage = validatePythonLifecycleCases(cases);
  if (!Array.isArray(outcomes)) throw new Error("Python完整链路结果必须是数组");
  const byId = new Map(outcomes.map((item) => [item.caseId, item]));
  if (byId.size !== outcomes.length)
    throw new Error("Python完整链路结果包含重复场景");
  if (outcomes.some((item) => !cases.some((c) => c.caseId === item.caseId)))
    throw new Error("Python完整链路结果包含未登记场景");
  const completed = cases.filter((item) => byId.has(item.caseId)).length,
    succeeded = cases.filter((item) => {
      const outcome = byId.get(item.caseId);
      return (
        outcome?.localFullLifecycleE2E === true &&
        outcome.publicDeployed === false &&
        pythonLifecycleStages.every(
          (stage) => outcome.stages?.[stage]?.status === "PASSED",
        )
      );
    }).length,
    detours = outcomes.flatMap((item) => item.detours ?? []),
    rate = completed ? succeeded / completed : 0;
  return {
    format: "shuduo-python-full-lifecycle-evaluation/v1",
    contract: pythonLifecycleContract,
    caseSetDigest: coverage.caseSetDigest,
    frozenCaseCount: cases.length,
    completedCaseCount: completed,
    succeededCaseCount: succeeded,
    failedCaseCount: completed - succeeded,
    unexecutedCaseCount: cases.length - completed,
    localFullLifecycleRate: rate,
    finalRateAvailable: completed === cases.length,
    targetMet:
      completed === cases.length &&
      succeeded / cases.length >= pythonLifecycleContract.targetRate,
    totalModelAttempts: outcomes.reduce(
      (sum, item) => sum + Number(item.modelAttemptCount ?? 0),
      0,
    ),
    totalReportedTokens: outcomes.reduce(
      (sum, item) => sum + Number(item.reportedTokens ?? 0),
      0,
    ),
    totalScheduledBatches: outcomes.reduce(
      (sum, item) => sum + Number(item.scheduledBatchCount ?? 0),
      0,
    ),
    detourCounts: {
      blocked: detours.filter((item) => item.status === "BLOCKED").length,
      cancelled: detours.filter((item) => item.status === "CANCELLED").length,
      failed: detours.filter((item) => item.status === "FAILED").length,
      rescued: detours.filter((item) => item.rescued === true).length,
    },
    fullLifecycleE2E:
      completed === cases.length && succeeded === completed,
    agentIndependentE2E: false,
    deploymentScope: "LOCAL_ACTUAL_RESTRICTED_PYTHON",
    publicDeployed: false,
    disclosure:
      "Python评测与SQL 20例分开计分；真实模型、受限CPython、文件、人工审批、计时批次、监控和DAPI均有本机证据，但不是公网或生产E2E。",
    coverage: { perContext: coverage.perContext },
  };
}

