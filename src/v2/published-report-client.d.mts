import type{PublishedReportBinding}from'./published-report-request.mjs';
type Client={request:(path:string,options?:{method?:string;body?:unknown;idempotencyKey?:string})=>Promise<unknown>};
export type PublishedReportReceipt={protocol:'shuduo-published-report-creation/v1';id:string;requestId:string;status:'PREPARING'|'PARTIAL'|'SUCCEEDED';scope:'LOCAL_TEST_ONLY';source:PublishedReportBinding;name:string;stage:string;sourceEvidenceHash:string;datasetId?:string;snapshotId?:string;reportId?:string;reportVersionId?:string;reportRunId?:string;rowCount?:number;widgetCount?:number;resultHash?:string;error?:{code:string;message:string};agentIndependentE2E:false;publicDeployed:false};
export function checkedPublishedReportReceipt(value:unknown,expected?:{requestId?:string;source?:PublishedReportBinding;name?:string}):PublishedReportReceipt;
export function submitPublishedReport(client:Client,args:{name:string;source:PublishedReportBinding;requestId:string}):Promise<PublishedReportReceipt>;
export function lookupPublishedReport(client:Client,args:{requestId:string;source?:PublishedReportBinding;name?:string}):Promise<PublishedReportReceipt>;
export function resumePublishedReport(client:Client,args:{id:string;requestId?:string;source?:PublishedReportBinding}):Promise<PublishedReportReceipt>;
