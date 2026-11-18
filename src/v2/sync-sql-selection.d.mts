export type CurrentSyncSelection={targetTable:'raw_positions';runId:string;targetHash:string;kind?:never};
export type ArchivedSyncSelection={kind:'SYNC_RUN_ARCHIVE_V1';targetTable:'raw_positions';taskId:string;runId:string;targetHash:string;landingSnapshotHash:string};
export type SyncSqlSelection=CurrentSyncSelection|ArchivedSyncSelection;
export const archivedSyncInputKind:'SYNC_RUN_ARCHIVE_V1';
export function parseSyncSqlSelection(value:unknown):SyncSqlSelection;
export function syncSqlSelectionFromBinding(value:unknown):SyncSqlSelection;
