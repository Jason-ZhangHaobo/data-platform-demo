type Reader = <T>(path: string) => Promise<T>;
type Guard = () => boolean;

function isStartupStatus(value: unknown) {
  const status = value as { mode?: unknown; capabilities?: unknown };
  return status && (status.mode === "LOCAL_DEVELOPMENT" || status.mode === "PUBLIC_INVITATION") && Array.isArray(status.capabilities);
}
export async function loadStartupCore<S, A>({ read, isCurrent, combined, accept, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }: {
  read: Reader; isCurrent: Guard; combined?: boolean; wait?: (ms:number) => Promise<unknown>; accept: (value: { status: S; session: A }) => void;
}) {
  const delays = [500, 1000, 2000, 4000, 8000, 8000];
  let attempt = 0;
  while (isCurrent()) {
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
    } catch (error) {
      if (!isCurrent()) return false;
      const pending = error as {status?:number;code?:string} | undefined;
      const delay = delays[attempt++];
      if (pending?.status !== 503 || pending.code !== "CLOUD_STARTUP_PENDING" || delay === undefined) throw error;
      await wait(delay);
    }
  }
  return false;
}
