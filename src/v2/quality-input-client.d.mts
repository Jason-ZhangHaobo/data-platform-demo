export type QualityArchiveSelection={kind:'SYNC_RUN_ARCHIVE_V1';taskId:string;runId:string;metadataVersionId:string;snapshotHash:string};
export type QualityArchiveReceipt={id:string;ruleId:string;ruleVersionId:string;status:string;passedCount:number;failedCount:number;evaluatedCount:number;archiveSource:QualityArchiveSelection;[key:string]:unknown};
export function qualityRunBody(input?:unknown):{expectedVersionId?:string;sourceSelection?:QualityArchiveSelection};
export function qualityArchiveInputsPath(ruleId:string):string;
export function qualityRunRequestPath(ruleId:string,requestId:string):string;
export function checkedArchiveQualityRun(value:unknown,ruleId:string,expected:{expectedVersionId:string;sourceSelection:QualityArchiveSelection}):QualityArchiveReceipt;
