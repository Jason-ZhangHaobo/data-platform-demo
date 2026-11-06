type Api = <T>(path: string) => Promise<T>;
export type IngestionReadStatus = { state: "LOADING" } | { state: "ERROR"; message: string; loginRequired: boolean } | { state: "READY" };
type Pending = Exclude<IngestionReadStatus, { state: "READY" }>;
type Catalog<S, T, P> = Pending | { state: "READY"; sources: S[]; tasks: T[]; plans: P[] };
type Preview<R> = Pending | { state: "READY"; rows: R[] };
const failure = (cause: unknown): Pending => {
  const error = cause as { message?: unknown; status?: unknown; code?: unknown } | undefined;
  return { state: "ERROR", message: typeof error?.message === "string" ? error.message : "读取未确认，请重新读取。", loginRequired: error?.status === 401 || error?.code === "AUTHENTICATION_REQUIRED" };
};

// Catalog truth and the optional default-table preview have independent
// receipts. A failed preview must not turn into an invented empty table.
export function createIngestionReader<S, T, P, R>({ api, onCatalog, onPreview }: {
  api: Api;
  onCatalog: (result: Catalog<S, T, P>) => void;
  onPreview: (result: Preview<R>) => void;
}) {
  let live = true, catalogSequence = 0, previewSequence = 0;
  async function request<T>(path: string) { return api<T>(path); }
  async function readPreview() {
    if (!live) return false;
    const sequence = ++previewSequence;
    const current = () => live && sequence === previewSequence;
    onPreview({ state: "LOADING" });
    try {
      const rows = await api<R[]>("/sync/targets/raw_positions/rows");
      if (!current()) return false;
      if (!Array.isArray(rows)) throw Error("默认表预览响应不完整；行数尚未确认。");
      onPreview({ state: "READY", rows });
      return true;
    } catch (cause) {
      if (current()) onPreview(failure(cause));
      return false;
    }
  }
  async function reload() {
    if (!live) return false;
    const sequence = ++catalogSequence;
    const current = () => live && sequence === catalogSequence;
    onCatalog({ state: "LOADING" });
    try {
      const catalog = Promise.all([
        request<S[]>("/sources"), request<T[]>("/sync/tasks"), request<P[]>("/sync/agent/plans"),
      ]);
      // Submit essential reads first when the transport shares a request lane.
      void readPreview();
      const [sources, tasks, plans] = await catalog;
      if (!current()) return false;
      if (![sources, tasks, plans].every(Array.isArray)) throw Error("接入目录响应不完整；数据源、任务和方案数量尚未确认。");
      onCatalog({ state: "READY", sources, tasks, plans });
      return true;
    } catch (cause) {
      if (!current()) return false;
      onCatalog(failure(cause));
      throw cause;
    }
  }
  return { reload, readPreview, close() { live = false; catalogSequence++; previewSequence++; } };
}
