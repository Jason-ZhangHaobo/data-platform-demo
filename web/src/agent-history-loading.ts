const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function initialAgentTaskId(url: string) {
  const values = new URL(url).searchParams.getAll("task");
  if (!values.length) return undefined;
  if (values.length !== 1 || !uuid.test(values[0])) throw Error("任务链接无效，请从任务历史重新选择；原链接未被清除。");
  return values[0];
}

// Task links must not wait for (or depend on membership in) a history listing.
// Only read callbacks are accepted here; no submission or retry is performed.
export async function loadHistoryAfterTarget<T>({restoreTarget,readHistory,isCurrent,acceptHistory,onHistoryError}: {
  restoreTarget?: () => Promise<unknown>;
  readHistory: () => Promise<T[]>;
  isCurrent: () => boolean;
  acceptHistory: (items:T[]) => void;
  onHistoryError: (error:unknown) => void;
}) {
  if (restoreTarget) await restoreTarget();
  if (!isCurrent()) return;
  try {
    const items = await readHistory();
    if (isCurrent()) acceptHistory(items);
  } catch (error) {
    if (isCurrent()) onHistoryError(error);
  }
}

export function mergeTaskHistory<T extends {id:string;version:number}>(items:T[],selected?:T) {
  if (!selected) return items;
  const listed = items.find(item=>item.id===selected.id);
  if (listed && listed.version > selected.version) return items;
  return [selected,...items.filter(item=>item.id!==selected.id)];
}
