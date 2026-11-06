const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function acknowledgedManualDraft(current: string, submitted: string, saved: string): string {
  if (saved !== submitted.trim()) throw new Error("保存回执与提交代码不一致，请查询原保存记录。");
  return current === submitted ? saved : current;
}
type ManualRevisionReceipt = {id:string;sql:string;contextId:string;source?:string;manualProvenance?:{kind:string;originAgentTaskId?:string;agentIndependentE2E:boolean}};
export function verifiedManualOrigin(saved:Pick<ManualRevisionReceipt,'source'|'manualProvenance'>,requestedOrigin?:string):string|undefined {
  const provenance=saved.manualProvenance,origin=provenance?.originAgentTaskId;
  const verified=saved.source==='MANUAL'&&provenance?.kind==='ENGINEER_EDIT'&&provenance.agentIndependentE2E===false&&typeof origin==='string'&&uuid.test(origin)?origin:undefined;
  if(origin!==undefined&&!verified||requestedOrigin!==undefined&&requestedOrigin!==verified)throw Error('手工版本的原Agent来源未通过保存回执核验；原版本和恢复链接保留，不自动关联其他任务。');
  return verified;
}
export function manualSourceDisclosure(saved:{source?:string}|undefined,originId?:string) {
  return originId?{kind:'AGENT_TAKEOVER',region:'人工接管与交付',title:'人工接管记录',description:'当前代码由工程师保存；原 Agent 的失败和验证结论不改写，也不计作 Agent 自主完成。'}:
    saved?.source==='MANUAL'?{kind:'STANDALONE_MANUAL',region:'手工开发与交付',title:'手工开发记录',description:'当前版本由工程师独立保存，未关联原 Agent 任务；不计作 Agent 自主完成。'}:
    {kind:'UNVERIFIED_SAVED_SOURCE',region:'已保存版本与交付',title:'已保存代码版本',description:'已恢复保存的代码与运行；来源关系尚未核验，不推定为 Agent 生成或人工接管。'};
}
export function developmentContextLocked(input:{readOnly:boolean;publicationOnly:boolean;taskOnly:boolean;working:boolean;hasTask:boolean;hasSavedRevision:boolean;pendingSubmission:boolean;runPending:boolean}) {
  // A fresh read-only demo may inspect different definitions. A saved or
  // recovering source stays bound regardless of whether editing is allowed.
  return input.publicationOnly||input.taskOnly||input.working||input.hasTask||input.hasSavedRevision||input.pendingSubmission||input.runPending;
}
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
