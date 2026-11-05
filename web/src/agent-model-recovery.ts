import { agentTaskFinished } from "./agent-task-scope.ts";

export const modelRecoveryNeedsAction = (stage?: string) =>
  stage === "MODEL_NOT_SENT" || stage === "MODEL_OUTCOME_UNKNOWN";

export function pauseModelRecovery(stage: string | undefined, {
  explicitNotSentRetry = false, confirmModelRetry = false,
}: { explicitNotSentRetry?: boolean; confirmModelRetry?: boolean } = {}) {
  return stage === "MODEL_NOT_SENT" ? !explicitNotSentRetry
    : stage === "MODEL_OUTCOME_UNKNOWN" ? !confirmModelRetry : false;
}

export type AgentResumeInput = {
  task: { status: string; stage?: string; version: number };
  canWrite: boolean;
  working: boolean;
  dirty: boolean;
  pendingResult: boolean;
  retryConsent: boolean;
};

export function agentResumeDecision(input: AgentResumeInput) {
  const { task } = input;
  const reason = agentTaskFinished(task.status) ? "原任务已结束；不能通过续接清零记录或重新执行。"
    : !input.canWrite ? "当前没有此任务的开发写入权限；仅可查看原任务。"
    : input.working ? "当前操作尚未结束，请等待结果后再续接。"
    : input.dirty ? "请先保存并运行修改，或撤销未保存修改，再续接原任务。"
    : input.pendingResult ? "原保存或提交结果尚未确认，请先查询原编号。"
    : !Number.isSafeInteger(task.version) || task.version < 1 ? "任务版本尚未确认，请先刷新原任务。"
    : task.stage === "MODEL_OUTCOME_UNKNOWN" && !input.retryConsent ? "上次模型结果未知，请先审阅可能产生的费用并勾选确认。"
    : undefined;
  return { reason, confirmModelRetry: task.stage === "MODEL_OUTCOME_UNKNOWN" && input.retryConsent };
}

// Both explicit buttons use this guard; render, refresh and driver loops do not.
export async function submitAgentResume(input: AgentResumeInput, actions: {
  submit: (confirmModelRetry: boolean) => Promise<void>;
  explain: (reason: string) => void;
}) {
  const decision = agentResumeDecision(input);
  if (decision.reason) { actions.explain(decision.reason); return false; }
  await actions.submit(decision.confirmModelRetry);
  return true;
}
