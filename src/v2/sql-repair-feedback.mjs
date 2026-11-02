import { validationFamilyForContext } from "./context.mjs";

const protocol = "SECURITIES_SQL_REPAIR_FEEDBACK_V1";
const fields = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
const issueKinds = ["VALUE_MISMATCH", "INVALID_NUMBER", "CLIENT_COUNT", "DUPLICATE_CLIENT", "CLIENT_SCOPE", "OUTPUT_FIELDS"];
const classify = issues => {
  const selectedFields = new Set(), kinds = new Set();
  for (const raw of issues) {
    if (typeof raw !== "string") continue;
    const issue = raw.slice(0, 1024);
    for (const field of fields) if (new RegExp(`\\b${field}\\b`).test(issue)) selectedFields.add(field);
    if (issue.includes("结果不符")) kinds.add("VALUE_MISMATCH");
    if (issue.includes("非有效数值")) kinds.add("INVALID_NUMBER");
    if (issue.includes("客户记录数不符")) kinds.add("CLIENT_COUNT");
    if (issue.includes("客户记录重复")) kinds.add("DUPLICATE_CLIENT");
    if (issue.includes("缺少客户") || issue.includes("范围外客户")) kinds.add("CLIENT_SCOPE");
    if (issue.includes("输出字段")) kinds.add("OUTPUT_FIELDS");
  }
  return { fields: fields.filter(field => selectedFields.has(field)), issueKinds: issueKinds.filter(kind => kinds.has(kind)) };
};

// Describe registered check outcomes, never fixture rows, reference SQL, expected
// values, client identifiers or untrusted error text. The ordinary error summary
// remains a separate input to the model; this adds which checks already passed.
export function buildSqlRepairFeedback(run, contextId) {
  const family = validationFamilyForContext(contextId), validation = run?.validation;
  if (!family || run?.contextId !== contextId || run.status !== "VALIDATION_FAILED" || validation?.passed !== false ||
      validation.contractId !== family.id || !Array.isArray(validation.regressions) || validation.regressions.length !== family.contextIds.length)
    return undefined;
  const cases = new Map();
  for (const row of validation.regressions) {
    if (!row || !family.contextIds.includes(row.contextId) || cases.has(row.contextId) || typeof row.passed !== "boolean" ||
        !Array.isArray(row.issues) || row.issues.length > 100) return undefined;
    cases.set(row.contextId, { contextId: row.contextId, passed: row.passed, ...classify(row.issues) });
  }
  return safeSqlRepairFeedback({ protocol, contextId, contractId: family.id, checks: family.contextIds.map(id => cases.get(id)) }, contextId);
}

export function safeSqlRepairFeedback(value, contextId) {
  const family = validationFamilyForContext(contextId);
  if (!family || value?.protocol !== protocol || value.contextId !== contextId || value.contractId !== family.id ||
      !Array.isArray(value.checks) || value.checks.length !== family.contextIds.length) return undefined;
  const checks = [];
  for (const id of family.contextIds) {
    const rows = value.checks.filter(row => row?.contextId === id);
    if (rows.length !== 1) return undefined;
    const row = rows[0];
    if (typeof row.passed !== "boolean" || !Array.isArray(row.fields) || row.fields.length > fields.length ||
        !Array.isArray(row.issueKinds) || row.issueKinds.length > issueKinds.length ||
        row.fields.some(field => !fields.includes(field)) || row.issueKinds.some(kind => !issueKinds.includes(kind)) ||
        row.passed && (row.fields.length || row.issueKinds.length)) return undefined;
    checks.push({ contextId: id, passed: row.passed,
      fields: fields.filter(field => row.fields.includes(field)), issueKinds: issueKinds.filter(kind => row.issueKinds.includes(kind)) });
  }
  const failedCaseCount = checks.filter(check => !check.passed).length;
  if (!failedCaseCount) return undefined;
  return { protocol, contextId, contractId: family.id, checks, passedCaseCount: checks.length - failedCaseCount, failedCaseCount };
}
