const sourceTypes = new Set(["MySQL", "PostgreSQL", "Oracle", "CSV"]);
const syncModes = new Set(["FULL", "INCREMENTAL"]);
const devJobTypes = new Set(["SQL", "PYTHON"]);
const maskingStrategies = new Set(["PHONE", "ID_CARD", "SECURITY_ACCOUNT", "BANK_CARD", "NAME"]);
const assetTypes = new Set(["TABLE", "VIEW", "DATASET"]);
const assetLayers = new Set(["ODS", "DWD", "DWS", "DIM", "ADS"]);
const assetSensitivityLevels = new Set(["PUBLIC", "INTERNAL", "SENSITIVE", "RESTRICTED"]);
const securityPermissions = new Set(["asset.read", "asset.sensitive.read", "asset.restricted.read", "masking.preview", "masking.manage", "dev.write", "audit.read"]);

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

export function validateMaskingRuleInput(value) {
  const input = value && typeof value === "object" ? value : {};
  const issues = [];
  const text = (key, min, max, message) => {
    const result = typeof input[key] === "string" ? input[key].trim() : "";
    if (result.length < min || result.length > max) issues.push({ path: key, message });
    return result;
  };
  const result = {
    name: text("name", 2, 60, "规则名称需要 2—60 个字符"),
    description: text("description", 0, 200, "规则说明不能超过 200 个字符"),
    fieldName: text("fieldName", 2, 80, "请输入敏感字段名称"),
    strategy: input.strategy,
    sampleValue: text("sampleValue", 1, 200, "请输入虚构样例值"),
    owner: text("owner", 2, 40, "请输入负责人"),
    enabled: input.enabled !== false,
  };
  if (!maskingStrategies.has(result.strategy)) issues.push({ path: "strategy", message: "脱敏策略不合法" });
  if (issues.length) throw new ValidationError(issues);
  return result;
}

export function maskValue(strategy, value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (strategy === "PHONE") return text.length <= 4 ? "*".repeat(text.length) : `${text.slice(0, 3)}${"*".repeat(Math.max(1, text.length - 7))}${text.slice(-4)}`;
  if (strategy === "ID_CARD") return text.length <= 8 ? "*".repeat(text.length) : `${text.slice(0, 4)}${"*".repeat(text.length - 8)}${text.slice(-4)}`;
  if (strategy === "SECURITY_ACCOUNT") return text.length <= 7 ? "*".repeat(text.length) : `${text.slice(0, 3)}${"*".repeat(text.length - 7)}${text.slice(-4)}`;
  if (strategy === "BANK_CARD") return text.length <= 4 ? "*".repeat(text.length) : `${"*".repeat(text.length - 4)}${text.slice(-4)}`;
  if (strategy === "NAME") return text.length <= 1 ? "*" : `${text.slice(0, 1)}${"*".repeat(Math.max(1, text.length - 1))}`;
  return text;
}

export function validateAssetInput(value) {
  const input = value && typeof value === "object" ? value : {};
  const issues = [];
  const text = (key, min, max, message) => {
    const result = typeof input[key] === "string" ? input[key].trim() : "";
    if (result.length < min || result.length > max) issues.push({ path: key, message });
    return result;
  };
  const result = {
    name: text("name", 2, 80, "资产名称需要 2—80 个字符"),
    physicalName: text("physicalName", 2, 120, "请输入物理表或视图名称"),
    assetType: input.assetType,
    layer: input.layer,
    domain: text("domain", 2, 40, "请输入业务域"),
    owner: text("owner", 2, 40, "请输入负责人"),
    sensitivity: input.sensitivity,
    description: text("description", 0, 240, "资产说明不能超过 240 个字符"),
    tags: Array.isArray(input.tags) ? input.tags.filter((item) => typeof item === "string").slice(0, 12) : [],
    fields: Array.isArray(input.fields) ? input.fields.slice(0, 80).map((field) => ({
      name: typeof field?.name === "string" ? field.name.trim() : "",
      label: typeof field?.label === "string" ? field.label.trim() : "",
      type: typeof field?.type === "string" ? field.type.trim() : "STRING",
      sensitivity: field?.sensitivity,
      description: typeof field?.description === "string" ? field.description.trim() : "",
    })) : [],
    upstream: Array.isArray(input.upstream) ? input.upstream.filter((item) => typeof item === "string").slice(0, 20) : [],
  };
  if (!assetTypes.has(result.assetType)) issues.push({ path: "assetType", message: "资产类型不合法" });
  if (!assetLayers.has(result.layer)) issues.push({ path: "layer", message: "数据分层不合法" });
  if (!assetSensitivityLevels.has(result.sensitivity)) issues.push({ path: "sensitivity", message: "敏感等级不合法" });
  if (!result.fields.length) issues.push({ path: "fields", message: "至少登记一个字段" });
  result.fields.forEach((field, index) => {
    if (!field.name || !field.label) issues.push({ path: `fields[${index}]`, message: "字段名称和业务名称不能为空" });
    if (!assetSensitivityLevels.has(field.sensitivity)) issues.push({ path: `fields[${index}].sensitivity`, message: "字段敏感等级不合法" });
  });
  if (issues.length) throw new ValidationError(issues);
  return result;
}

export function validateAccessCheckInput(value) {
  const input = value && typeof value === "object" ? value : {};
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  const permission = typeof input.permission === "string" ? input.permission.trim() : "";
  const sensitivity = typeof input.sensitivity === "string" ? input.sensitivity.trim() : "";
  const issues = [];
  if (!userId) issues.push({ path: "userId", message: "请选择演示用户" });
  if (!securityPermissions.has(permission)) issues.push({ path: "permission", message: "访问权限不合法" });
  if (!assetSensitivityLevels.has(sensitivity)) issues.push({ path: "sensitivity", message: "敏感等级不合法" });
  if (issues.length) throw new ValidationError(issues);
  return { userId, permission, sensitivity, resourceType: typeof input.resourceType === "string" ? input.resourceType.trim().slice(0, 40) : "asset" };
}

export function validateAgentPlanInput(value) {
  const input = value && typeof value === "object" ? value : {};
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const userId = typeof input.userId === "string" ? input.userId.trim() : "user-platform-admin";
  const issues = [];
  if (message.length < 4 || message.length > 2_000) issues.push({ path: "message", message: "请描述 4—2000 个字符的业务需求" });
  if (userId.length < 2 || userId.length > 80) issues.push({ path: "userId", message: "演示用户标识不合法" });
  if (issues.length) throw new ValidationError(issues);
  return { message, userId };
}

export function validateAgentConfirmInput(value) {
  const planId = typeof value?.planId === "string" ? value.planId.trim() : "";
  const userId = typeof value?.userId === "string" ? value.userId.trim() : "";
  if (!planId || !userId) throw new ValidationError([{ path: "planId", message: "缺少 Agent 计划或确认用户" }]);
  return { planId, userId };
}
