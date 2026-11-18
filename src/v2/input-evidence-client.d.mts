export type InputEvidence={protocol:'shuduo-sync-input-evidence/v1';scope:'LOCAL_SAVED_INPUT_EVIDENCE';readOnly:true;
 binding:{packageId:string;packageDigest:string;sourceInputHash:string};projectId:string;actorId:string;
 records:{offline_sync_run:{id:string;finalCount:number;readCount:number};offline_sync_task:{targetTable:string;mode:string};source_metadata:unknown;source_revision:unknown;sync_sql_input:unknown};
 snapshot:unknown;sourceCsvIncluded:false;immutableAuditVerified:false;fullLifecycleE2E:false;evidenceHash:string};
export function inputEvidencePath(input:{packageId:string;packageDigest:string}):string;
export function readInputEvidence(client:{request:(path:string)=>Promise<unknown>},input:{packageId:string;packageDigest:string}):Promise<InputEvidence>;
