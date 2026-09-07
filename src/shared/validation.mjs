const sourceTypes = new Set(["MySQL", "PostgreSQL", "Oracle", "CSV"]);
const syncModes = new Set(["FULL", "INCREMENTAL"]);
const devJobTypes = new Set(["SQL", "PYTHON"]);

export class ValidationError extends Error {
  constructor(issues) {
    super("提交内容不符合要求");
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function validateTaskInput(value) {
  const input = value && typeof value === "object" ? value : {};
  const issues = [];
  const text = (key, min, max, message) => {
    const result = typeof input[key] === "string" ? input[key].trim() : "";
    if (result.length < min || result.length > max) issues.push({ path: key, message });
    return result;
  };
  const result = {
    name: text("name", 2, 60, "任务名称需要 2—60 个字符"),
    description: text("description", 0, 200, "任务说明不能超过 200 个字符"),
    sourceType: input.sourceType,
    sourceName: text("sourceName", 2, 80, "请输入源端名称"),
    targetType: input.targetType,
    targetName: text("targetName", 2, 80, "请输入目标端名称"),
    syncMode: input.syncMode,
    schedule: text("schedule", 2, 60, "请输入调度周期"),
    owner: text("owner", 2, 40, "请输入负责人"),
    enabled: input.enabled !== false,
  };
  if (!sourceTypes.has(result.sourceType)) issues.push({ path: "sourceType", message: "源端类型不合法" });
  if (!sourceTypes.has(result.targetType)) issues.push({ path: "targetType", message: "目标端类型不合法" });
  if (!syncModes.has(result.syncMode)) issues.push({ path: "syncMode", message: "同步模式不合法" });
  if (issues.length) throw new ValidationError(issues);
  return result;
}

export function analyzeSql(sql) {
  const normalized = String(sql ?? "").trim();
  const statement = normalized.match(/^(SELECT|WITH|INSERT|UPDATE|CREATE|DELETE|DROP|ALTER|TRUNCATE)\b/i)?.[1]?.toUpperCase() ?? "UNKNOWN";
  const warnings = [];
  if (!normalized) return { valid: false, statement, warnings: ["SQL 不能为空"] };
  if (statement === "UNKNOWN") warnings.push("当前 Demo 仅识别常见 SQL 语句类型");
  if (/\b(DROP|TRUNCATE)\b/i.test(normalized)) warnings.push("包含高风险结构变更语句，正式环境必须经过审批");
  if (/\b(DELETE|UPDATE)\b/i.test(normalized) && !/\bWHERE\b/i.test(normalized)) warnings.push("写操作缺少 WHERE 条件，请确认影响范围");
  if (/^SELECT\b/i.test(normalized) && !/\bLIMIT\b/i.test(normalized)) warnings.push("查询未设置 LIMIT，调试时建议先限制返回行数");
  return { valid: true, statement, warnings };
}

export function validateDevJobInput(value) {
  const input = value && typeof value === "object" ? value : {};
  const issues = [];
  const text = (key, min, max, message) => {
    const result = typeof input[key] === "string" ? input[key].trim() : "";
    if (result.length < min || result.length > max) issues.push({ path: key, message });
    return result;
  };
  const result = {
    name: text("name", 2, 60, "任务名称需要 2—60 个字符"),
    description: text("description", 0, 200, "任务说明不能超过 200 个字符"),
    jobType: input.jobType,
    sql: text("sql", 1, 20_000, "请输入 SQL 内容，且不能超过 20000 个字符"),
    schedule: text("schedule", 2, 60, "请输入调度周期"),
    owner: text("owner", 2, 40, "请输入负责人"),
    enabled: input.enabled === true,
  };
  if (!devJobTypes.has(result.jobType)) issues.push({ path: "jobType", message: "任务类型不合法" });
  const analysis = analyzeSql(result.sql);
  if (!analysis.valid) issues.push({ path: "sql", message: "SQL 不能为空" });
  if (issues.length) throw new ValidationError(issues);
  return { ...result, analysis };
}
