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
export type SyncedPositionsOffer = {contextId:"holdings-t1";selection:{targetTable:"raw_positions";runId:string;targetHash:string};
  taskId:string;sourceRevisionId:string;metadataVersionId:string;rowCount:number;verifiedCurrency?:"CNY"};
export function readSyncedPositions(client:{request:(path:string)=>Promise<unknown>}):Promise<SyncedPositionsOffer>;
export function readSyncReviewEvidence(client:{request:(path:string)=>Promise<unknown>},expected:{
  verificationId:string;packageId?:string;packageDigest?:string;syncRehearsalDigest?:string;snapshotHash?:string;
}):Promise<Record<string,unknown>>;
