export type PublishedReportBinding={kind:'AGENT'|'MANUAL';releaseId:string;packageDigest:string;revisionId:string;runId:string;batchId:string;taskId?:string};
export function reportRequestId(value:unknown):string;
export function publishedReportSource(value:unknown):PublishedReportBinding;
export function publishedReportInput(value:unknown):{name:string;source:PublishedReportBinding};
