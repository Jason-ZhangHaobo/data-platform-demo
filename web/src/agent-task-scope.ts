// An interrupted task is resumable, unlike a completed task or a terminal run.
export const agentTaskFinished = (status?: string) => Boolean(status && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status));
export function mayEditScopedTask(taskOnly: boolean, taskId: string | undefined, selectedId: string | undefined, originId: string | undefined) {
  return !taskOnly || Boolean(taskId && (selectedId ? selectedId === taskId : originId === taskId));
}

type Background = {status:string;delivery?:string;expiresAt:number;scopeBlocked?:boolean};
export function agentBackgroundAction(task: {executionMode?:string;language?:string;status:string;stage?:string;background?:Background}, now = Date.now()) {
  if (task.executionMode !== "DURABLE_SQL_AGENT_V1" || task.language !== "SPARK_SQL" || agentTaskFinished(task.status) ||
    !["READY_FOR_MODEL", "READY_FOR_RUN"].includes(task.stage ?? "")) return;
  const grant = task.background;
  if (!grant) return "ENABLE";
  if (grant.status === "ACTIVE" && (grant.delivery === undefined || grant.delivery === "UNCONFIRMED") && !grant.scopeBlocked && grant.expiresAt > now) return "REDRIVE";
}

export function agentBackgroundLabel(grant: Background, now = Date.now()) {
  if (grant.status === "ACTIVE") {
    if (grant.scopeBlocked) return "当前窗口不可推进";
    if (grant.expiresAt <= now) return "已到期";
    if (grant.delivery !== "ACKNOWLEDGED") return "唤醒投递待确认";
    return "已委托";
  }
  return ({COMPLETED:"已完成", NEEDS_CONFIRMATION:"结果待确认", PAUSED:"已暂停", CANCELLED:"已停止", EXPIRED:"已到期"} as Record<string,string>)[grant.status] ?? "状态待核对";
}
