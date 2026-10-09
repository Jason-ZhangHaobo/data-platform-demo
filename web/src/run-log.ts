type RunLog = {
  id: string;
  status: string;
  stage?: string;
  engine?: string;
  engineVersion?: string;
  submittedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  log?: string;
  stdout?: string;
  stderr?: string;
};

export function developmentRunLog(run?: RunLog): string {
  if (!run) return "尚未提交运行；执行后展示真实运行记录和已返回的日志。";
  const records = [`[运行记录 · 来源：服务端持久化字段]`, `批次：${run.id}`, `状态：${run.status}`];
  if (run.stage) records.push(`阶段：${run.stage}`);
  if (run.engine) records.push(`引擎：${run.engine}${run.engineVersion ? ` ${run.engineVersion}` : ""}`);
  if (run.submittedAt) records.push(`提交：${run.submittedAt}`);
  if (run.finishedAt) records.push(`结束：${run.finishedAt}`);
  if (typeof run.durationMs === "number") records.push(`引擎耗时：${run.durationMs} ms`);
  const output: string[] = [];
  for (const [label, value] of [["错误", run.error], ["Worker 合并输出", run.log], ["标准输出", run.stdout], ["标准错误", run.stderr]])
    if (typeof value === "string" && value.trim()) output.push(`[${label}]\n${value}`);
  return records.join("\n") + "\n\n" + (output.length ? output.join("\n\n") :
    "本次记录未包含 Worker 原始日志；以上为真实运行元数据，不是控制台日志。不会补造输出，也不代表模型未配置。");
}
