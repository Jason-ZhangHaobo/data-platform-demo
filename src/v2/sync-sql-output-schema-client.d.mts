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
export function checkedSyncSqlOutputSchema(value:unknown, expected:{runId:string}&Partial<SyncSqlSchemaSource>):SyncSqlOutputSchema;
export function readSyncSqlOutputSchema(client:{request:(path:string)=>Promise<unknown>},input:{runId:string}):Promise<SyncSqlOutputSchema>;
