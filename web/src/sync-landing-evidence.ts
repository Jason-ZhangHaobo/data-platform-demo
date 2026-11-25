export type SyncSourceEvidenceState = { status: string; evidenceCode?: string };

export function syncLandingEvidenceMessage(code: unknown): string | undefined {
  if (code === "SYNC_LANDING_RECEIPT_MISSING") return "当前批次缺少落地回执，请按原同步请求核对。";
  if (code === "SYNC_LANDING_RECEIPT_MISMATCH") return "当前批次的落地回执与原任务或落地结果不一致，请按原同步请求核对。";
  if (code === "SYNC_LANDING_RESULT_UNCONFIRMED") return "当前同步批次尚未确认，请按原同步请求核对。";
}

export function unconfirmedSyncLandingEvidence(source: SyncSourceEvidenceState | undefined): string | undefined {
  if (source?.status === "UNCONFIRMED") return syncLandingEvidenceMessage(source.evidenceCode);
}
