export type AssistedDevelopmentReference={kind:'FAILED_RUN_REFERENCE'|'RUN_COMPARISON_REFERENCE'|'ASSISTED_CONTINUATION';sourceRunId:string;sourceRevisionId:string;sourceRevisionHash:string;initialSqlHash:string;baselineRunId?:string;baselineRevisionHash?:string;evidenceDigest?:string;parentTaskId?:string;parentEvidenceDigest?:string;depth?:number;rootReference?:AssistedDevelopmentReference};
export function checkedAssistedDevelopmentReference(value:unknown):AssistedDevelopmentReference;
export function sameAssistedDevelopmentReference(a:unknown,b:unknown):boolean;
