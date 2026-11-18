export type SyncSqlSchemaSource = {runId:string;revisionId:string;revisionHash:string;snapshotHash:string};
type Column = {name:string;type:string;position:number};
type InputColumn = Column & {nullable:boolean};
type InputVersion = {metadataVersionId:string;sourceRevisionId:string;schemaHash:string;columns:InputColumn[]};
type InputMetadata = {
  syncRunId:string;
  frozen:InputVersion;
  current:InputVersion|null;
  differences:{name:string;before:InputColumn|null;after:InputColumn|null}[];
};
type InputBinding = {syncRunId:string;metadataVersionId:string;sourceRevisionId:string};
export type SyncSqlOutputSchema = {
  protocol:"shuduo-sync-sql-output-schema/v1";
  source:SyncSqlSchemaSource;
  readOnly:true;
  status:"MATCHED"|"MISMATCH"|"UNAVAILABLE";
  differences:{
    expected:Column|null;
    actual:{name:string|null;type:string|null;position:number}|null;
    issues:("MISSING"|"TYPE"|"ORDER"|"DUPLICATE"|"EXTRA")[];
  }[];
  inputMetadata?:InputMetadata|null;
};
export type SyncSqlRehearsalSource = SyncSqlSchemaSource & {verificationId:string;packageId:string;packageDigest:string};
export type SyncSqlRehearsalSchema = Omit<SyncSqlOutputSchema,"protocol"|"source"> & {
  protocol:"shuduo-sync-sql-rehearsal-schema/v1";
  source:SyncSqlRehearsalSource;
};
export type SyncSqlScheduledSource = SyncSqlSchemaSource & {batchId:string;releaseId:string;packageId:string;packageDigest:string};
export type SyncSqlScheduledSchema = Omit<SyncSqlOutputSchema,"protocol"|"source"> & {
  protocol:"shuduo-sync-sql-scheduled-schema/v1";
  source:SyncSqlScheduledSource;
};
export function checkedSyncSqlInputMetadata(value:unknown, expected?:Partial<InputBinding>):InputMetadata;
export function checkedSyncSqlOutputSchema(value:unknown, expected:{runId:string}&Partial<SyncSqlSchemaSource & InputBinding>):SyncSqlOutputSchema;
export function checkedSyncSqlRehearsalSchema(value:unknown, expected:SyncSqlRehearsalSource):SyncSqlRehearsalSchema;
export function checkedSyncSqlScheduledSchema(value:unknown, expected:SyncSqlScheduledSource):SyncSqlScheduledSchema;
export function readSyncSqlOutputSchema(client:{request:(path:string)=>Promise<unknown>},input:{runId:string}):Promise<SyncSqlOutputSchema>;
export type SyncedPositionsOffer = {contextId:"holdings-t1";selection:import('./sync-sql-selection.mjs').SyncSqlSelection;
  taskId:string;sourceRevisionId:string;metadataVersionId:string;rowCount:number;verifiedCurrency?:"CNY"};
export function readSyncedPositions(client:{request:(path:string)=>Promise<unknown>}):Promise<SyncedPositionsOffer>;
export type SyncSqlArchiveCandidate={taskId:string;runId:string;targetHash:string;landingSnapshotHash:string;taskName:string;rowCount:number;finishedAt:string;verification:'REQUIRES_CHECK'};
export function readSyncSqlArchives(client:{request:(path:string)=>Promise<unknown>}):Promise<SyncSqlArchiveCandidate[]>;
export function readArchivedSyncedPositions(client:{request:(path:string)=>Promise<unknown>},expected:{taskId:string;runId:string;targetHash?:string;landingSnapshotHash?:string}):Promise<SyncedPositionsOffer>;
export function readSyncReviewEvidence(client:{request:(path:string)=>Promise<unknown>},expected:{
  verificationId:string;packageId?:string;packageDigest?:string;syncRehearsalDigest?:string;snapshotHash?:string;
}):Promise<Record<string,unknown>>;

export type MaterializedSyncSqlCandidate=import('./sync-sql-selection.mjs').MaterializedSyncSelection&{taskName:string;rowCount:number;finishedAt:string;verification:'REQUIRES_CHECK'};
export function readMaterializedSyncSqlArchives(client:{request:(path:string)=>Promise<unknown>}):Promise<MaterializedSyncSqlCandidate[]>;
export function readMaterializedSyncedPositions(client:{request:(path:string)=>Promise<unknown>},expected:{taskId:string;runId:string;targetTable?:string;mode?:string;targetHash?:string;landingSnapshotHash?:string;changeEpochId?:string;changeStateHash?:string;rowCount?:number}):Promise<SyncedPositionsOffer>;
