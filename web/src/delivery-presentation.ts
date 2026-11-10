// Presentation metadata only: file presence is not an execution or integrity proof.
export const defaultLocalReleaseSchedule={triggerAfterSeconds:5,intervalSeconds:15,runCount:2} as const;
export function localReleaseScheduleText(release?:{scheduleSpec?:{triggerAfterSeconds?:unknown;intervalSeconds?:unknown;runCount?:unknown}}) {
  const spec=release?release.scheduleSpec:defaultLocalReleaseSchedule;
  if(!spec||![spec.triggerAfterSeconds,spec.intervalSeconds,spec.runCount].every(v=>Number.isSafeInteger(v))||Number(spec.triggerAfterSeconds)<1||Number(spec.triggerAfterSeconds)>300||Number(spec.intervalSeconds)<1||Number(spec.intervalSeconds)>300||![2,3].includes(Number(spec.runCount)))return '此历史发布未确认计时参数，请查看批次计划与实际触发时间。';
  return `${release?'此发布的计时配置':'新发布默认配置'}：${spec.triggerAfterSeconds}秒后触发首批，间隔${spec.intervalSeconds}秒，共${spec.runCount}批。页面刷新不重新触发。`;
}
export const deliveryFileGuide = [
  { name: "main.sql", label: "加工代码", purpose: "客户资产加工逻辑；审阅金额精度、关联粒度与现金重复累计风险。" },
  { name: "tests.sql", label: "结果断言", purpose: "独立预期结果的检查 SQL；执行成功后仍需检查每项断言。" },
  { name: "schedule.json", label: "调度依赖", purpose: "任务节点、先后依赖与执行参数；不是已经运行的调度任务。" },
  { name: "deployment.json", label: "部署清单", purpose: "执行适配器、运行环境与限制；文件生成不代表已部署。" },
  { name: "calendar.json", label: "交易日历", purpose: "本次演练使用的样例交易日历；生产使用前必须替换并核验。" },
  { name: "fixtures.json", label: "验证数据", purpose: "虚构证券数据与回归场景；不含公司真实客户数据。" },
  { name: "validation.json", label: "源运行报告", purpose: "生成交付包时的源批次核验记录；不是上线后的监控结果。" },
  { name: "README.md", label: "使用说明", purpose: "执行方式、适配范围和当前限制；内容按纯文本展示。" },
] as const;

export function deliveryFilePresentation(files: Record<string, string>, selected: string) {
  const entries = [
    ...deliveryFileGuide.filter(f => Object.hasOwn(files, f.name)),
    ...Object.keys(files).filter(name => !deliveryFileGuide.some(f => f.name === name)).sort().map(name => ({ name, label: "附加文件", purpose: "附加交付内容；需人工检查用途，不自动认定已经适配或执行。" })),
  ];
  const active = entries.find(f => f.name === selected) ?? entries.find(f => f.name === "schedule.json") ?? entries[0];
  return { entries, active, missing: deliveryFileGuide.filter(f => !Object.hasOwn(files, f.name) || !files[f.name]?.trim()).map(f => f.name) };
}

export function deliveryReviewRequirements(cloud: boolean, distribution=false) {
  return [
    { id: "code", label: "已审阅当前 SQL 版本", target: "agent-code" },
    { id: "assertions", label: "已查看独立核验与文件演练", target: "agent-verification" },
    { id: "deliveryFiles", label: "已审阅调度、部署和日历文件", target: "agent-files" },
    { id: cloud ? "cloudScope" : "localScope", label: cloud ? "仅发布冻结样例的两个云端测试批次，由受控调度器触发" : distribution ? "仅发布同一冻结业务日的两个本机虚构证券批次，不调用模型" : "仅发布本机测试任务：5 秒后触发，共两个批次", target: "agent-publication" },
  ];
}

export function reviewAttestationsComplete(values: Record<string, boolean>, cloud: boolean, distribution=false) {
  const required = deliveryReviewRequirements(cloud,distribution);
  return Object.keys(values).length === required.length && required.every(item => values[item.id] === true);
}
