import { agentTaskFinished } from "./agent-task-scope.ts";

export type FailedRunRepairInput = {
  taskOnly: boolean;
  taskStatus?: string;
  ready: boolean;
  canWrite: boolean;
  working: boolean;
  dirty: boolean;
  pendingResult: boolean;
  hasContext: boolean;
  baselineRevisionId?: string;
  run?: { id: string; status: string; revisionId?: string };
};
export type RepairRequest = { message: string; sourceRunId: string };
type RepairAction = { visible: boolean; reason: string; request?: RepairRequest };

// This is a new-task action, not a way to resume an exhausted or scoped task.
// Use the same decision for the visible control and its execution guard.
export function failedRunRepairAction(input: FailedRunRepairInput): RepairAction {
  const { run } = input;
  if (!run || !["FAILED", "VALIDATION_FAILED"].includes(run.status))
    return { visible: false, reason: "当前批次不需要新建修正任务。" };
  let reason: string | undefined;
  if (input.taskOnly) reason = !input.taskStatus || agentTaskFinished(input.taskStatus)
    ? `本窗口仅允许续接指定任务，不能新建修正任务。${input.taskStatus ? "原任务已结束" : "当前是人工接管版本"}；可在 main.sql 中人工编辑，再选择“保存并运行我的代码”。原失败、尝试次数与费用预留保持不变，人工修正不计作 Agent 自主完成。`
    : "本窗口仅允许续接指定任务，不能新建修正任务。请使用上方原任务的“继续任务”或“审阅并恢复云后台”；如需人工接管，先停止正在推进的任务，再编辑 main.sql 并选择“保存并运行我的代码”。";
  else if (!input.canWrite) reason = "当前没有开发写入权限；可以查看失败记录与代码，不会提交新的修正任务。";
  else if (input.working) reason = "当前操作尚未结束；请等待结果或停止后再新建修正任务。";
  else if (input.pendingResult) reason = "原保存或提交结果尚未确认；请先查询原编号，不会重复新建任务。";
  else if (input.dirty) reason = "代码有未保存修改；请先保存并运行，或撤销修改，不能把旧批次的失败归到新代码。";
  else if (!input.baselineRevisionId || run.revisionId !== input.baselineRevisionId)
    reason = "此失败批次不属于当前代码版本；请查看对应版本，或先保存并运行当前代码。";
  else if (!input.ready) reason = "模型或执行环境尚未就绪；恢复后才能新建修正任务，现有记录保留。";
  else if (!input.hasContext) reason = "业务口径尚未读取完成；确认上下文后才能新建修正任务。";
  if (reason) return { visible: true, reason };
  return {
    visible: true,
    reason: "将基于此失败批次和当前已保存代码新建任务，真实调用模型与 Spark；原任务、失败记录和费用不清零。不是恢复原任务，也不会自动发布。",
    request: { sourceRunId: run.id, message: "请依据这次失败运行的真实错误信息修正当前SQL，并重新执行独立业务校验。" },
  };
}

export async function submitFailedRunRepair(input: FailedRunRepairInput, actions: {
  submit: (request: RepairRequest) => Promise<void>;
  explain: (reason: string) => void;
}) {
  const decision = failedRunRepairAction(input);
  if (!decision.request) { actions.explain(decision.reason); return false; }
  await actions.submit(decision.request);
  return true;
}
