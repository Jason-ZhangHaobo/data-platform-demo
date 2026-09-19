import { createHash } from "node:crypto";
import { contextIds, validationContractId } from "./context.mjs";

const sha256 = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const seeds = {
  minimal: `SELECT client_id
FROM accounts
WHERE advisor_id = '{{advisor_id}}'`,
  duplicateCash: `SELECT a.client_id,
       SUM(p.market_value) AS holding_market_value,
       SUM(c.available_cash) AS available_cash,
       SUM(p.market_value) + SUM(c.available_cash) AS total_assets,
       COUNT(p.security_code) AS security_count
FROM accounts a
JOIN positions p ON a.client_id = p.client_id
JOIN cash c ON a.client_id = c.client_id
WHERE a.advisor_id = '{{advisor_id}}'
  AND p.trade_date = '{{trade_date}}'
  AND c.trade_date = '{{trade_date}}'
GROUP BY a.client_id`,
  innerJoin: `SELECT a.client_id,
       CAST(SUM(p.market_value) AS DECIMAL(18,2)) AS holding_market_value,
       CAST(SUM(c.available_cash) AS DECIMAL(18,2)) AS available_cash,
       CAST(SUM(p.market_value) + SUM(c.available_cash) AS DECIMAL(18,2)) AS total_assets,
       COUNT(DISTINCT p.security_code) AS security_count
FROM accounts a
JOIN positions p ON a.client_id = p.client_id
JOIN cash c ON a.client_id = c.client_id
WHERE a.advisor_id = '{{advisor_id}}'
GROUP BY a.client_id`,
  wrongScope: `SELECT p.client_id,
       SUM(p.market_value) AS holding_market_value,
       0 AS available_cash,
       SUM(p.market_value) AS total_assets,
       COUNT(DISTINCT p.security_code) AS security_count
FROM positions p
WHERE p.advisor_id = '{{advisor_id}}'
  AND p.trade_date = '{{trade_date}}'
GROUP BY p.client_id`,
};

const patterns = [
  {
    id: "build",
    category: "FROM_MINIMAL_DRAFT",
    seed: "minimal",
    request:
      "完成财富顾问名下客户的T+1资产加工。输出客户、持仓市值、可用现金、总资产和证券数量；金额保持两位小数。请根据表结构补全当前草稿。",
  },
  {
    id: "cash-dedup",
    category: "REPAIR_DUPLICATE_CASH",
    seed: "duplicateCash",
    request:
      "调试当前客户资产SQL：现金不能因为多条持仓被重复累计，同一position_id的重复记录不能重复计入，但不同position_id即使金额相同也必须保留。",
  },
  {
    id: "cash-only",
    category: "REPAIR_CASH_ONLY_CLIENT",
    seed: "innerJoin",
    request:
      "修改当前资产加工代码：顾问名下只有现金、没有持仓的客户也必须出现，持仓市值和证券数量为0；仅统计指定交易日。",
  },
  {
    id: "scope",
    category: "REPAIR_FIELD_AND_SCOPE",
    seed: "wrongScope",
    request:
      "运行提示positions没有advisor_id。请依据实际字段修复顾问范围关联，并同时补齐现金、去重和金额精度；不要扩大到顾问范围外客户。",
  },
];

export function m1EvaluationCases() {
  return contextIds.flatMap((contextId) =>
    patterns.map((pattern) => ({
      id: `${contextId}--${pattern.id}`,
      contextId,
      category: pattern.category,
      request: pattern.request,
      seedSql: seeds[pattern.seed],
    })),
  );
}

export const m1EvaluationContract = Object.freeze({
  id: "m1-securities-code-stage-20-cases-2026-09-14",
  validationContractId,
  expectedCaseCount: 20,
  maxAttemptsPerCase: 3,
  targetRate: 0.85,
  completionScope: "SQL_DEVELOPMENT",
  fullLifecycleE2E: false,
  dimensions: [
    "从最小草稿生成",
    "现金重复累计修复",
    "纯现金客户边界修复",
    "字段错误与顾问范围修复",
  ],
  disclosure:
    "20例由4类开发意图与5套合成数据上下文交叉组成，仅衡量M1代码阶段，不是20条完整上线链路。",
});

export function validateM1EvaluationCases(cases = m1EvaluationCases()) {
  if (
    !Array.isArray(cases) ||
    cases.length !== m1EvaluationContract.expectedCaseCount ||
    new Set(cases.map((item) => item.id)).size !== cases.length ||
    !cases.every(
      (item) =>
        contextIds.includes(item.contextId) &&
        typeof item.request === "string" &&
        item.request.length >= 20 &&
        typeof item.seedSql === "string" &&
        item.seedSql.length >= 20,
    )
  )
    throw new Error("M1评测集不完整或包含无效场景");
  const perContext = Object.fromEntries(
    contextIds.map((id) => [
      id,
      cases.filter((item) => item.contextId === id).length,
    ]),
  );
  const perCategory = Object.fromEntries(
    patterns.map((pattern) => [
      pattern.category,
      cases.filter((item) => item.category === pattern.category).length,
    ]),
  );
  if (
    Object.values(perContext).some((count) => count !== patterns.length) ||
    Object.values(perCategory).some((count) => count !== contextIds.length)
  )
    throw new Error("M1评测集覆盖分布不平衡");
  return {
    contract: m1EvaluationContract,
    caseSetDigest: sha256(cases),
    perContext,
    perCategory,
  };
}

export function summarizeM1Evaluation(cases, outcomes) {
  const coverage = validateM1EvaluationCases(cases);
  if (!Array.isArray(outcomes)) throw new Error("评测结果必须为数组");
  const byId = new Map(outcomes.map((item) => [item.caseId, item]));
  if (byId.size !== outcomes.length)
    throw new Error("评测结果包含重复场景");
  if (outcomes.some((item) => !cases.some((c) => c.id === item.caseId)))
    throw new Error("评测结果包含未登记场景");
  const completed = cases.filter((item) => byId.has(item.id)).length;
  const succeeded = cases.filter(
    (item) => byId.get(item.id)?.codeStageSucceeded === true,
  ).length;
  const failed = cases.filter(
    (item) => byId.has(item.id) && !byId.get(item.id)?.codeStageSucceeded,
  ).length;
  const attempts = outcomes.reduce(
    (sum, item) => sum + Number(item.attemptCount ?? 0),
    0,
  );
  const tokens = outcomes.reduce(
    (sum, item) => sum + Number(item.usedTokens ?? 0),
    0,
    ),
    inputTokens = outcomes.reduce(
      (sum, item) => sum + Number(item.inputTokens ?? 0),
      0,
    ),
    outputTokens = outcomes.reduce(
      (sum, item) => sum + Number(item.outputTokens ?? 0),
      0,
    );
  return {
    format: "shuduo-m1-evaluation/v1",
    contract: m1EvaluationContract,
    caseSetDigest: coverage.caseSetDigest,
    frozenCaseCount: cases.length,
    completedCaseCount: completed,
    succeededCaseCount: succeeded,
    failedCaseCount: failed,
    unexecutedCaseCount: cases.length - completed,
    codeStageCompletionRate: completed ? succeeded / completed : 0,
    finalRateAvailable: completed === cases.length,
    targetMet:
      completed === cases.length &&
      succeeded / cases.length >= m1EvaluationContract.targetRate,
    totalAttempts: attempts,
    totalReportedTokens: tokens,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    fullLifecycleE2E: false,
    disclosure: m1EvaluationContract.disclosure,
    coverage: {
      perContext: coverage.perContext,
      perCategory: coverage.perCategory,
    },
  };
}
