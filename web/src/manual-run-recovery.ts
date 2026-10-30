const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function acknowledgedManualDraft(current: string, submitted: string, saved: string): string {
  if (saved !== submitted.trim()) throw new Error("保存回执与提交代码不一致，请查询原保存记录。");
  return current === submitted ? saved : current;
}
type ManualRevisionReceipt = {id:string;sql:string;contextId:string;source?:string;manualProvenance?:{kind:string;originAgentTaskId?:string;agentIndependentE2E:boolean}};
export function mayReuseManualRevision(saved: ManualRevisionReceipt | undefined, current: {id?:string;sql:string;contextId:string;originAgentTaskId?:string}): boolean {
  return Boolean(saved && saved.id === current.id && saved.sql === current.sql && saved.contextId === current.contextId &&
    saved.source === "MANUAL" && saved.manualProvenance?.kind === "ENGINEER_EDIT" && saved.manualProvenance.agentIndependentE2E === false &&
    saved.manualProvenance.originAgentTaskId === current.originAgentTaskId);
}
export function manualDeliveryPackages<T extends {manifest?: {source?: {runId?: string}}}>(bundles: T[], runId: string | undefined, locked: boolean): T[] {
  return locked ? bundles.filter(bundle => Boolean(runId) && bundle.manifest?.source?.runId === runId) : bundles;
}
export function manualRunRecovery(href: string) {
  const query = new URL(href).searchParams;
  const valid = (key: string) => { const value = query.get(key); return value && uuid.test(value) ? value : undefined; };
  const revisionId = valid("revision"), runId = valid("run");
  return { revisionId, runId, requestKey: revisionId && !runId ? valid("run_request") : undefined, originTaskId: valid("origin_task") };
}
export function manualSaveRequest(href: string) {
  const value = new URL(href).searchParams.get("save_request");
  return value && uuid.test(value) ? value : undefined;
}
export function manualSaveLocation(href: string, key: string, originTaskId?: string) {
  if (!uuid.test(key) || (originTaskId && !uuid.test(originTaskId))) throw new Error("代码保存恢复标识不合法");
  const url = new URL(href);
  for (const name of ["task","revision","run","run_request","origin_task","agent_request"]) url.searchParams.delete(name);
  url.searchParams.set("save_request",key);
  if (originTaskId) url.searchParams.set("origin_task",originTaskId);
  return url;
}
export function manualRunLocation(href: string, input: { revisionId: string; runId?: string; requestKey?: string; originTaskId?: string }) {
  for (const value of Object.values(input)) if (value !== undefined && !uuid.test(value)) throw new Error("手工运行恢复标识不合法");
  const url = new URL(href); url.searchParams.delete("task");
  for (const key of ["revision", "run", "run_request", "origin_task", "save_request","agent_request"]) url.searchParams.delete(key);
  url.searchParams.set("revision", input.revisionId);
  if (input.runId) url.searchParams.set("run", input.runId);
  else if (input.requestKey) url.searchParams.set("run_request", input.requestKey);
  if (input.originTaskId) url.searchParams.set("origin_task", input.originTaskId);
  return url;
}
