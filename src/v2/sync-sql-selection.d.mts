export type CurrentSyncSelection={targetTable:'raw_positions';runId:string;targetHash:string;kind?:never};
export type ArchivedSyncSelection={kind:'SYNC_RUN_ARCHIVE_V1';targetTable:'raw_positions';taskId:string;runId:string;targetHash:string;landingSnapshotHash:string};
export type MaterializedSyncSelection={kind:'SYNC_MATERIALIZED_HOLDINGS_V1';targetTable:string;taskId:string;runId:string;targetHash:string;landingSnapshotHash:string}&({mode:'FULL'|'INCREMENTAL_UPSERT'}|{mode:'INCREMENTAL_CHANGELOG';changeEpochId:string;changeStateHash:string});
export type SyncSqlSelection=CurrentSyncSelection|ArchivedSyncSelection|MaterializedSyncSelection;
export const archivedSyncInputKind:'SYNC_RUN_ARCHIVE_V1';
export const materializedSyncInputKind:'SYNC_MATERIALIZED_HOLDINGS_V1';
export function parseSyncSqlSelection(value:unknown):SyncSqlSelection;
export function syncSqlSelectionFromBinding(value:unknown):SyncSqlSelection;
