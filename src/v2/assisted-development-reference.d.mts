export type AssistedDevelopmentReference={kind:'FAILED_RUN_REFERENCE'|'RUN_COMPARISON_REFERENCE';sourceRunId:string;sourceRevisionId:string;sourceRevisionHash:string;initialSqlHash:string;baselineRunId?:string;baselineRevisionHash?:string;evidenceDigest?:string};
export function checkedAssistedDevelopmentReference(value:unknown):AssistedDevelopmentReference;
export function sameAssistedDevelopmentReference(a:unknown,b:unknown):boolean;
