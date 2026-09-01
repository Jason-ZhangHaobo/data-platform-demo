const sourceTypes = new Set(["MySQL", "PostgreSQL", "Oracle", "CSV"]);
const syncModes = new Set(["FULL", "INCREMENTAL"]);

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
