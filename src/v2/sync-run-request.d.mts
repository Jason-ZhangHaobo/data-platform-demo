export type SyncRunRequestSelection = { taskId: string; requestKey: string };
export type SyncRequestRun = {
  id: string;
  taskId: string;
  requestKey?: string;
  configHash?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  readCount?: number;
  finalCount?: number;
  inserted?: number;
  updated?: number;
  deleted?: number;
  skipped?: number;
  watermark?: unknown;
  [key: string]: unknown;
};
export type SyncRunRequestReceipt = SyncRunRequestSelection & {
  schema: "shuduo-sync-run-request/v1";
  state: "SUCCEEDED" | "FAILED" | "LANDING_COMMITTED" | "UNCONFIRMED";
  run: SyncRequestRun;
  landingEvidence?: { runId: string; receiptHash: string; [key: string]: unknown };
};
export function validSyncRunRequestKey(value: unknown): value is string;
export function syncRunRequestPath(selection: SyncRunRequestSelection): string;
export function checkedSyncRunRequest(value: unknown, selection: SyncRunRequestSelection): SyncRunRequestReceipt;
export function readSyncRunRequest(
  client: { request(path: string, options?: { method: "GET" }): Promise<unknown> },
  selection: SyncRunRequestSelection,
): Promise<SyncRunRequestReceipt>;
export function settleSyncRunRequest(
  client: { request(path: string, options: { method: "POST"; body: { runId: string; receiptHash: string; confirm: true } }): Promise<unknown> },
  selection: SyncRunRequestSelection,
  evidence: { runId: string; receiptHash: string },
): Promise<SyncRunRequestReceipt & {
  state: "SUCCEEDED";
  run: SyncRequestRun & { status: "SUCCEEDED" };
  landingEvidence: NonNullable<SyncRunRequestReceipt["landingEvidence"]>;
}>;
