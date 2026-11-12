export type SyncSqlSchemaSource = {runId:string;revisionId:string;revisionHash:string;snapshotHash:string};
type Column = {name:string;type:string;position:number};
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
export function checkedSyncSqlOutputSchema(value:unknown, expected:{runId:string}&Partial<SyncSqlSchemaSource>):SyncSqlOutputSchema;
export function checkedSyncSqlRehearsalSchema(value:unknown, expected:SyncSqlRehearsalSource):SyncSqlRehearsalSchema;
export function checkedSyncSqlScheduledSchema(value:unknown, expected:SyncSqlScheduledSource):SyncSqlScheduledSchema;
export function readSyncSqlOutputSchema(client:{request:(path:string)=>Promise<unknown>},input:{runId:string}):Promise<SyncSqlOutputSchema>;
