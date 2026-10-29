// An interrupted task is resumable, unlike a completed task or a terminal run.
export const agentTaskFinished = (status?: string) => Boolean(status && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status));
export function mayEditScopedTask(taskOnly: boolean, taskId: string | undefined, selectedId: string | undefined, originId: string | undefined) {
  return !taskOnly || Boolean(taskId && (selectedId ? selectedId === taskId : originId === taskId));
}
