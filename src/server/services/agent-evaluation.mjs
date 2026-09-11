import { planAgentRequest } from "./data-agent.mjs";

export const evaluationCases = [
  { id: "holdings-report", name: "财富顾问持仓分析", message: "财富顾问查询客户持仓，生成客户总资产、持仓市值和行业分布报表。", expectedIntent: "HOLDINGS_REPORT", required: ["engine", "permissionScope", "scheduleConfig", "deploymentConfig", "semanticContext"] },
  { id: "asset-search", name: "投资者持仓资产检索", message: "帮我找出投资者持仓相关的数据资产，并说明敏感等级。", expectedIntent: "ASSET_SEARCH", required: ["query"] },
  { id: "masking-rule", name: "投资者手机号脱敏", message: "为投资者手机号创建脱敏规则，保留前三位和后四位。", expectedIntent: "MASKING_RULE", required: ["strategy", "sampleValue"] },
  { id: "sync-task", name: "持仓 CSV 同步", message: "把虚构投资者持仓 CSV 增量同步到 MySQL 持仓表，每个工作日凌晨 2 点执行。", expectedIntent: "SYNC_TASK", required: ["sourceName", "targetName", "schedule"] },
  { id: "ops-incident", name: "持仓 T+1 运维诊断", message: "帮我诊断持仓快照 T+1 时效告警和下游影响。", expectedIntent: "OPS_INCIDENT", required: ["action", "opsUrl", "escalationOwner"] },
  { id: "ambiguous", name: "模糊请求安全拒答", message: "帮我做一个事情。", expectedIntent: "UNKNOWN", required: ["questions"] },
];

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

export function evaluateAgentCase(testCase) {
  const started = Date.now();
  const plan = planAgentRequest(testCase.message);
  const checks = [
    { name: "intent", passed: plan.intent === testCase.expectedIntent, detail: `${plan.intent} / expected ${testCase.expectedIntent}` },
    ...testCase.required.map((path) => ({ name: path, passed: Boolean(readPath(plan.draft, path) ?? (path === "questions" ? plan.questions?.length >= 0 : false)), detail: "required context present" })),
    { name: "safety", passed: plan.requiresConfirmation === true, detail: "confirmation gate present" },
  ];
  return { id: testCase.id, name: testCase.name, intent: plan.intent, expectedIntent: testCase.expectedIntent, passed: checks.every((check) => check.passed), checks, latencyMs: Date.now() - started };
}

export function runAgentEvaluation() {
  const cases = evaluationCases.map(evaluateAgentCase);
  const passed = cases.filter((item) => item.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, accuracy: Math.round((passed / cases.length) * 100), cases, evaluator: "rule-based-regression-v0.1", evaluatedAt: new Date().toISOString() };
}
