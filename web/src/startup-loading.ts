// Page-specific reads, not a shared cache. The caller owns the current account
// and request generation; stale successes and stale errors never reach the UI.
type Reader = <T>(path: string) => Promise<T>;
type Guard = () => boolean;
export type StartupReadState = "LOADING" | "READY" | "ERROR";
type ReadIdentity = { authEpoch: number; coreRequest: number; moduleRequest?: number; module?: string };
export function startupReadCurrent(expected: ReadIdentity, actual: ReadIdentity) {
  return expected.authEpoch === actual.authEpoch && expected.coreRequest === actual.coreRequest &&
    (expected.moduleRequest === undefined || expected.moduleRequest === actual.moduleRequest) &&
    (expected.module === undefined || expected.module === actual.module);
}
export type ModuleStartupInputs<C, R, V, A, D> = {
  contexts?: C[]; runs?: R[]; revisions?: V[]; agents?: A[]; deliveries?: D[];
};
export function moduleStartupPaths(module: string, privatePreview = false) {
  if (module === "agent-center") return ["/contexts"];
  if (module === "development") return ["/contexts", "/runs", "/revisions", ...privatePreview ? [] : ["/agent/tasks", "/agent/deliveries"]];
  if (module === "schedules") return ["/runs"];
  return [];
}
function isStartupStatus(value: unknown) {
  const status = value as { mode?: unknown; capabilities?: unknown };
  return status && (status.mode === "LOCAL_DEVELOPMENT" || status.mode === "PUBLIC_INVITATION") && Array.isArray(status.capabilities);
}
export async function loadStartupCore<S, A>({ read, isCurrent, combined, accept }: {
  read: Reader; isCurrent: Guard; combined?: boolean; accept: (value: { status: S; session: A }) => void;
}) {
  try {
    let status: S, session: A;
    if (combined) {
      const value = await read<S & { status: S; session: A }>("/status?include=session");
      if (!isCurrent()) return false;
      // An older control plane ignores the opt-in and returns the original status.
      const legacy = isStartupStatus(value) && !("status" in value || "session" in value);
      status = legacy ? value : value?.status;
      session = legacy ? await read<A>("/auth/session") : value?.session;
    } else {
      [status, session] = await Promise.all([read<S>("/status"), read<A>("/auth/session")]);
    }
    if (!isCurrent()) return false;
    const a = session as { authenticated?: unknown; user?: {id?: unknown}; role?: unknown; permissions?: unknown };
    if (!isStartupStatus(status) || !a || typeof a.authenticated !== "boolean" ||
        a.authenticated && (typeof a.user?.id !== "string" || !a.user.id || typeof a.role !== "string" || !Array.isArray(a.permissions)))
      throw new Error("平台状态或身份响应尚未确认，请重新读取；不会切换为匿名或开放写入。");
    accept({ status, session }); return true;
  } catch (error) { if (!isCurrent()) return false; throw error; }
}
export async function loadModuleStartup<C, R, V, A, D>({ read, module, privatePreview = false, prefetchedContexts, isCurrent, accept }: {
  read: Reader; module: string; privatePreview?: boolean; isCurrent: Guard;
  prefetchedContexts?: Promise<C[]>;
  accept: (value: ModuleStartupInputs<C, R, V, A, D>) => void;
}) {
  try {
    const paths = moduleStartupPaths(module, privatePreview), values = await Promise.all(paths.map(path =>
      module === "agent-center" && path === "/contexts" && prefetchedContexts ? prefetchedContexts : read<unknown[]>(path)));
    if (!isCurrent()) return false;
    if (values.some(value => !Array.isArray(value))) throw new Error("当前模块的上下文或历史响应格式未确认，请重新读取。");
    const byPath = Object.fromEntries(paths.map((path, index) => [path, values[index]]));
    accept({ contexts: byPath["/contexts"] as C[] | undefined, runs: byPath["/runs"] as R[] | undefined,
      revisions: byPath["/revisions"] as V[] | undefined, agents: byPath["/agent/tasks"] as A[] | undefined,
      deliveries: byPath["/agent/deliveries"] as D[] | undefined });
    return true;
  } catch (error) { if (!isCurrent()) return false; throw error; }
}
