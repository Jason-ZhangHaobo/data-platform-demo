import { syncRunRequestPath } from "../../src/v2/sync-run-request.mjs";

export type SyncRunSelection = { taskId: string; requestKey: string };

export function syncRunSelectionFromLocation(href: string): SyncRunSelection | undefined {
  const query = new URL(href).searchParams;
  const keys = query.getAll("sync_run_request");
  if (!keys.length) return undefined;
  const tasks = query.getAll("sync_task");
  if (keys.length !== 1 || tasks.length !== 1) throw Error("原执行链接须包含一个任务和一个原请求编号。");
  const selection = { taskId: tasks[0], requestKey: keys[0] };
  // Validate the same identities used by the shared read path.
  syncRunRequestPath(selection);
  return selection;
}

export function syncRunSelectionLocation(href: string, selection: SyncRunSelection): URL {
  syncRunRequestPath(selection);
  const url = new URL(href);
  url.searchParams.set("sync_task", selection.taskId);
  url.searchParams.set("sync_run_request", selection.requestKey);
  return url;
}
