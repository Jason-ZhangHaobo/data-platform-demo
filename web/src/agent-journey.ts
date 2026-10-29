import { deliveryFilePresentation } from "./delivery-presentation.ts";
import { publicationStopped } from "./publication-read.ts";
import {validationFamilyForContextId,regressionsMatchFamily} from "./validation-family.ts";
export type JourneyState = "DONE" | "PENDING" | "ATTENTION" | "STALE";
export type JourneyStep = { id: string; label: string; state: JourneyState; detail: string; target: string };
export type EvidenceReadState = "LOADING" | "READY" | "ERROR";
export function verificationPresentation(current: boolean, verified: boolean, readState: EvidenceReadState, reportStatus?: string) {
  if (readState === "ERROR") return { title: "读取未确认", detail: "无法读取最新核验记录；已有报告仅供参考。重试只读取记录，不重新运行模型或 Spark。", currentChecks: false };
  if (readState === "LOADING") return { title: "正在核对记录", detail: "正在读取当前任务与版本的证据；读取完成前不能审阅发布。", currentChecks: false };
  if (!current) return { title: "原版本报告", detail: "报告与当前代码或批次不一致；请运行当前代码后重新核验，原报告保留供对照。", currentChecks: false };
  if (!verified && reportStatus === "PENDING") return { title: "等待执行核验", detail: "任务仍在执行或等待回执；刷新只读取原记录，不重复提交模型或 Spark。", currentChecks: true };
  return { title: verified ? "核验通过" : "需要处理", detail: verified ? "当前版本的独立核验通过，可继续准备交付文件。" : "请先处理未通过的检查项，再重新核验；SQL 跑通不等于结果正确。", currentChecks: true };
}
export function publicationEvidenceText(release: { status: string; health: string }, current: boolean, monitored: boolean): string {
  if (!current) return "历史发布记录 · 不代表当前版本上线";
  if (release.status === "CANCELLED") return "已停止后续批次";
  if (["ROLLED_BACK", "ROLLED_BACK_LOCAL"].includes(release.status)) return "已回滚 · 历史记录保留";
  if (release.status === "SUPERSEDED_LOCAL") return "已被新版本替代 · 历史记录保留";
  if (["FAILED", "FAILED_LOCAL"].includes(release.status)) return "发布失败 · 请检查发布记录";
  if (monitored) return "计划批次与监控证据核对通过 · 仅本次测试范围";
  if (release.health === "CRITICAL") return "存在运行异常 · 请检查批次与告警";
  if (release.status === "WAITING_SCHEDULER") return "已审阅 · 等待调度器实际执行";
  if (release.health === "RECOVERED_WITH_FAILURE") return "后续批次已恢复 · 历史失败保留";
  return "发布记录已保存 · 批次或监控证据尚未齐备";
}
export function deliveryStageText(stage: string, publicationCurrent: boolean, releaseStatus?: string, current = true): string {
  if (!current) return "原版本交付记录；当前修改待核验";
  if (publicationCurrent) return publicationStopped(releaseStatus)
    ? "交付文件已演练；发布已停止"
    : "交付文件已演练并完成发布审阅";
  const labels: Record<string, string> = { PACKAGE_READY: "调度与部署文件已生成", FILE_REHEARSAL_SUBMITTING: "正在提交文件演练", FILE_REHEARSAL_RUNNING: "Spark 正在按交付文件演练", AWAITING_ENGINEER_REVIEW: "演练通过，待审阅交付", FILE_REHEARSAL_FAILED: "文件演练需要处理", CANCELLED: "交付准备已停止" };
  return labels[stage] ?? stage;
}
export type TaskConsumption = {
  protocol: string; taskId: string; packageDigest: string; scope: string; status: string; truncated: boolean;
  checkedAt: string; notice: string; externalSystemVerified: boolean; agentIndependentE2E: boolean;
  services: { serviceId: string; serviceType: string; name: string; versionId: string; configHash: string;
    status: string; code?: string; notice: string; sourceRunIds: string[]; fullAssetComposition?: boolean;
    call?: { callId: string; versionId: string; verified: boolean; resultHash: string; rowCount: number; applicationId: string; applicationStatus: string; finishedAt: string } }[];
};
type Evidence = {
  taskId: string; contextId?:string; revisionId?: string; runId?: string; dirty: boolean; evidenceReadable?: boolean; publicationReadable?: boolean;
  report?: { taskId?: string; contextId?:string; validationContractId?:string; revisionId?: string; runId?: string; status: string; checks: { id: string; passed: boolean }[] };
  delivery?: { status: string; packageId?: string; packageDigest?: string; verificationId?: string; sourceRevisionId?: string; sourceRunId?: string };
  bundle?: { id: string; digest: string; files: Record<string, string> };
  verification?: { id: string; status: string; mainSqlExecuted?: boolean; testSqlValidation?: { passed: boolean }; validation?: { passed: boolean; contractId?:string; regressions?: { contextId: string; passed: boolean }[] } };
  release?: { id: string; packageId?: string; packageDigest?: string; sourceRevisionId?: string; status: string; health: string; runCount?: number };
  batches?: { id: string; status: string; schedulerTriggered?: boolean }[];
  alerts?: { status: string }[];
  events?: { releaseId?: string; releaseRunId?: string; packageDigest?: string; type: string }[];
  consumption?: TaskConsumption;
};

// A display projection, not a replacement for server-side approval or an E2E score.
export function agentJourney(e: Evidence): { steps: JourneyStep[]; next: JourneyStep; current: boolean; fileVerified: boolean; publicationCurrent: boolean } {
  const family=validationFamilyForContextId(e.contextId??e.report?.contextId);
  const current = e.evidenceReadable !== false && !e.dirty && Boolean(e.revisionId && e.runId && e.report?.taskId === e.taskId && e.report.revisionId === e.revisionId && e.report.runId === e.runId&&(!e.contextId||e.report.contextId===e.contextId));
  const required = ["revision", "execution", "results", "regressions"];
  const verified = current && Boolean(family) && e.report?.status === "PASSED" && (e.report.validationContractId===undefined||e.report.validationContractId===family?.id) && required.every(id => e.report?.checks.some(c => c.id === id && c.passed === true));
  const codeExecuted = current && Boolean(family) && (e.report?.validationContractId===undefined||e.report.validationContractId===family?.id) &&
    ["PASSED", "NEEDS_ATTENTION"].includes(e.report?.status ?? "") &&
    ["revision", "execution"].every(id => e.report?.checks.some(check => check.id === id && check.passed === true));
  const codeFailed = current && e.report?.status === "NEEDS_ATTENTION" && !codeExecuted;
  const files = Boolean(current && e.bundle && e.delivery?.sourceRevisionId === e.revisionId && e.delivery?.sourceRunId === e.runId && e.delivery?.packageId === e.bundle.id && e.delivery.packageDigest === e.bundle.digest && deliveryFilePresentation(e.bundle.files, "").missing.length === 0);
  const fileVerified = Boolean(verified && files && e.delivery?.status === "SUCCEEDED" && e.delivery.verificationId === e.verification?.id && e.verification?.status === "SUCCEEDED" && e.verification.mainSqlExecuted === true && e.verification.testSqlValidation?.passed === true && regressionsMatchFamily(e.verification.validation,family));
  const publicationCurrent = Boolean(fileVerified && e.release?.packageId === e.bundle?.id && e.release?.packageDigest === e.bundle?.digest && e.release?.sourceRevisionId === e.revisionId);
  const stopped = publicationStopped(e.release?.status);
  const batches = e.batches ?? [];
  const executed = e.publicationReadable !== false && publicationCurrent && !stopped && batches.some(b => b.status === "SUCCEEDED" && b.schedulerTriggered === true);
  const healthy = executed && e.release?.health === "HEALTHY" && Number.isSafeInteger(e.release.runCount) && e.release.runCount! > 0 && batches.length === e.release.runCount && new Set(batches.map(b => b.id)).size === batches.length && batches.every(b => b.status === "SUCCEEDED" && b.schedulerTriggered === true && e.events?.some(event => event.type === "BATCH_SUCCEEDED" && event.releaseId === e.release?.id && event.releaseRunId === b.id && event.packageDigest === e.bundle?.digest)) && !(e.alerts ?? []).some(a => a.status === "OPEN");
  const state = (done: boolean, failed = false): JourneyState => e.dirty ? "STALE" : done ? "DONE" : failed ? "ATTENTION" : "PENDING";
  const consumptionScopeMatches = e.release?.status === "ACTIVE_LOCAL"
    ? e.consumption?.protocol === "shuduo-local-task-consumption/v1" && e.consumption.scope === "LOCAL_TEST_ONLY"
    : e.consumption?.protocol === "shuduo-private-task-consumption/v1" && e.consumption.scope === "PRIVATE_CLOUD_TEST";
  const consumptionCurrent = current && consumptionScopeMatches && e.consumption?.taskId === e.taskId && e.consumption.packageDigest === e.bundle?.digest;
  const consumed = Boolean(healthy && consumptionCurrent && !e.consumption?.truncated && e.consumption?.status === "VERIFIED" && e.consumption.services.some(s => s.serviceType === "XAPI" && s.status === "VERIFIED" && s.fullAssetComposition === true && s.call?.verified === true && s.call.versionId === s.versionId && s.call.rowCount > 0));
  const steps: JourneyStep[] = [
    { id: "requirement", label: "需求与口径", state: "DONE", detail: "需求已记录；按已登记证券口径执行，不代表模型已理解任意需求。", target: "agent-requirement" },
    { id: "code", label: "代码与调试", state: state(codeExecuted, codeFailed), detail: e.dirty ? "未保存修改不继承旧结论。" : codeExecuted ? `代码版本 ${e.revisionId!.slice(0, 8)} 已完成实际执行；业务正确性另见独立结果核验。` : codeFailed ? "当前代码执行尚未通过，请查看报错并修正。" : e.revisionId ? `代码版本 ${e.revisionId.slice(0, 8)} 已生成，等待核对执行与调试回执。` : "等待生成代码，可随时人工接管。", target: "agent-code" },
    { id: "validation", label: "独立结果核验", state: state(verified, current && e.report?.status === "NEEDS_ATTENTION"), detail: verified ? "版本、真实执行、结果和五场景断言通过。" : "查看未通过项；SQL跑通不等于完整核验。", target: "agent-verification" },
    { id: "files", label: "调度与部署文件", state: state(fileVerified, e.delivery?.status === "FAILED"), detail: fileVerified ? "同一版本的交付文件演练通过。" : files ? "文件已生成，仍需实际演练。" : "核验通过后准备版本化交付。", target: "agent-files" },
    { id: "publication", label: "审阅与发布", state: state(executed, stopped), detail: executed ? `当前交付包已由调度器执行 · ${e.release?.id.slice(0, 8)}` : e.release && !publicationCurrent ? "保留历史发布，不替当前版本证明上线。" : "需审阅确切版本；不会自动代批。", target: "agent-publication" },
    { id: "monitoring", label: "上线后监控", state: state(Boolean(healthy), publicationCurrent && (e.release?.health === "CRITICAL" || (e.alerts ?? []).some(a => a.status === "OPEN"))), detail: healthy ? "所有计划批次成功，无未解除告警。仅本次测试范围。" : "检查批次、告警与恢复记录；不凭健康标签判完成。", target: "agent-publication" },
    { id: "services", label: "DAPI / XAPI消费", state: state(consumed, Boolean(consumptionCurrent && e.consumption?.services.some(s => s.status === "NEEDS_ATTENTION"))), detail: consumed ? "当前包的组合接口、历史授权调用与实际快照对照通过；不是外部系统验收。" : "到同任务服务工作台核对来源、授权调用与日志；本视图尚未核验消费。", target: "agent-service-handoff" },
  ];
  const next: JourneyStep = steps.find(step => step.state !== "DONE") ?? { id:"evidence",label:"查看完整证据",state:"DONE",detail:"当前任务的测试范围证据已齐；仍不代表自主E2E或公网验收。",target:"agent-service-handoff" };
  return { steps, next, current, fileVerified, publicationCurrent };
}
