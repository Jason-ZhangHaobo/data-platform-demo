export type JourneyState = "DONE" | "PENDING" | "ATTENTION" | "STALE";
export type JourneyStep = { id: string; label: string; state: JourneyState; detail: string; target: string };
export type TaskConsumption = {
  protocol: string; taskId: string; packageDigest: string; scope: string; status: string; truncated: boolean;
  checkedAt: string; notice: string; externalSystemVerified: boolean; agentIndependentE2E: boolean;
  services: { serviceId: string; serviceType: string; name: string; versionId: string; configHash: string;
    status: string; code?: string; notice: string; sourceRunIds: string[]; fullAssetComposition?: boolean;
    call?: { callId: string; versionId: string; verified: boolean; resultHash: string; rowCount: number; applicationId: string; applicationStatus: string; finishedAt: string } }[];
};
type Evidence = {
  taskId: string; revisionId?: string; runId?: string; dirty: boolean;
  report?: { taskId?: string; revisionId?: string; runId?: string; status: string; checks: { id: string; passed: boolean }[] };
  delivery?: { status: string; packageId?: string; packageDigest?: string; verificationId?: string; sourceRevisionId?: string; sourceRunId?: string };
  bundle?: { id: string; digest: string; files: Record<string, string> };
  verification?: { id: string; status: string; mainSqlExecuted?: boolean; testSqlValidation?: { passed: boolean }; validation?: { passed: boolean; regressions?: { contextId: string; passed: boolean }[] } };
  release?: { id: string; packageId?: string; packageDigest?: string; sourceRevisionId?: string; status: string; health: string; runCount?: number };
  batches?: { id: string; status: string; schedulerTriggered?: boolean }[];
  alerts?: { status: string }[];
  events?: { releaseId?: string; releaseRunId?: string; packageDigest?: string; type: string }[];
  consumption?: TaskConsumption;
};

// A display projection, not a replacement for server-side approval or an E2E score.
export function agentJourney(e: Evidence): { steps: JourneyStep[]; next: JourneyStep; current: boolean; fileVerified: boolean; publicationCurrent: boolean } {
  const current = !e.dirty && Boolean(e.revisionId && e.runId && e.report?.taskId === e.taskId && e.report.revisionId === e.revisionId && e.report.runId === e.runId);
  const required = ["revision", "execution", "results", "regressions"];
  const verified = current && e.report?.status === "PASSED" && required.every(id => e.report?.checks.some(c => c.id === id && c.passed === true));
  const files = Boolean(current && e.bundle && e.delivery?.sourceRevisionId === e.revisionId && e.delivery?.sourceRunId === e.runId && e.delivery?.packageId === e.bundle.id && e.delivery.packageDigest === e.bundle.digest && ["main.sql", "tests.sql", "schedule.json", "deployment.json"].every(name => e.bundle?.files[name]?.trim()));
  const fileVerified = Boolean(verified && files && e.delivery?.status === "SUCCEEDED" && e.delivery.verificationId === e.verification?.id && e.verification?.status === "SUCCEEDED" && e.verification.mainSqlExecuted === true && e.verification.testSqlValidation?.passed === true && e.verification.validation?.passed === true && ["holdings-t1", "duplicate-position", "cash-change", "equal-value-positions", "cash-only-client"].every(id => e.verification?.validation?.regressions?.some(c => c.contextId === id && c.passed)));
  const publicationCurrent = Boolean(fileVerified && e.release?.packageId === e.bundle?.id && e.release?.packageDigest === e.bundle?.digest && e.release?.sourceRevisionId === e.revisionId);
  const stopped = ["CANCELLED", "ROLLED_BACK"].includes(e.release?.status ?? "");
  const batches = e.batches ?? [];
  const executed = publicationCurrent && !stopped && batches.some(b => b.status === "SUCCEEDED" && b.schedulerTriggered === true);
  const healthy = executed && e.release?.health === "HEALTHY" && Number.isSafeInteger(e.release.runCount) && e.release.runCount! > 0 && batches.length === e.release.runCount && new Set(batches.map(b => b.id)).size === batches.length && batches.every(b => b.status === "SUCCEEDED" && b.schedulerTriggered === true && e.events?.some(event => event.type === "BATCH_SUCCEEDED" && event.releaseId === e.release?.id && event.releaseRunId === b.id && event.packageDigest === e.bundle?.digest)) && !(e.alerts ?? []).some(a => a.status === "OPEN");
  const state = (done: boolean, failed = false): JourneyState => e.dirty ? "STALE" : done ? "DONE" : failed ? "ATTENTION" : "PENDING";
  const consumptionCurrent = current && e.consumption?.protocol === "shuduo-private-task-consumption/v1" && e.consumption.taskId === e.taskId && e.consumption.packageDigest === e.bundle?.digest && e.consumption.scope === "PRIVATE_CLOUD_TEST";
  const consumed = Boolean(healthy && consumptionCurrent && !e.consumption?.truncated && e.consumption?.status === "VERIFIED" && e.consumption.services.some(s => s.serviceType === "XAPI" && s.status === "VERIFIED" && s.fullAssetComposition === true && s.call?.verified === true && s.call.versionId === s.versionId && s.call.rowCount > 0));
  const steps: JourneyStep[] = [
    { id: "requirement", label: "需求与口径", state: "DONE", detail: "需求已记录；按已登记证券口径执行，不代表模型已理解任意需求。", target: "agent-requirement" },
    { id: "code", label: "代码与调试", state: state(Boolean(e.revisionId)), detail: e.dirty ? "未保存修改不继承旧结论。" : e.revisionId ? `代码版本 ${e.revisionId.slice(0, 8)}` : "等待生成代码，可随时人工接管。", target: "agent-code" },
    { id: "validation", label: "独立结果核验", state: state(verified, current && e.report?.status === "NEEDS_ATTENTION"), detail: verified ? "版本、真实执行、结果和五场景断言通过。" : "查看未通过项；SQL跑通不等于完整核验。", target: "agent-verification" },
    { id: "files", label: "调度与部署文件", state: state(fileVerified, e.delivery?.status === "FAILED"), detail: fileVerified ? "同一版本的交付文件演练通过。" : files ? "文件已生成，仍需实际演练。" : "核验通过后准备版本化交付。", target: "agent-files" },
    { id: "publication", label: "审阅与发布", state: state(executed, stopped), detail: executed ? `当前交付包已由调度器执行 · ${e.release?.id.slice(0, 8)}` : e.release && !publicationCurrent ? "保留历史发布，不替当前版本证明上线。" : "需审阅确切版本；不会自动代批。", target: "agent-publication" },
    { id: "monitoring", label: "上线后监控", state: state(Boolean(healthy), publicationCurrent && (e.release?.health === "CRITICAL" || (e.alerts ?? []).some(a => a.status === "OPEN"))), detail: healthy ? "所有计划批次成功，无未解除告警。仅本次测试范围。" : "检查批次、告警与恢复记录；不凭健康标签判完成。", target: "agent-publication" },
    { id: "services", label: "DAPI / XAPI消费", state: state(consumed, Boolean(consumptionCurrent && e.consumption?.services.some(s => s.status === "NEEDS_ATTENTION"))), detail: consumed ? "当前包的组合接口、历史授权调用与实际快照对照通过；不是外部系统验收。" : "到同任务服务工作台核对来源、授权调用与日志；本视图尚未核验消费。", target: "agent-service-handoff" },
  ];
  const next: JourneyStep = steps.find(step => step.state !== "DONE") ?? { id:"evidence",label:"查看完整证据",state:"DONE",detail:"当前任务的测试范围证据已齐；仍不代表自主E2E或公网验收。",target:"agent-service-handoff" };
  return { steps, next, current, fileVerified, publicationCurrent };
}
