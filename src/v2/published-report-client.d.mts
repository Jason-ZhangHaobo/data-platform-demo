import type{PublishedReportBinding}from'./published-report-request.mjs';
type Client={request:(path:string,options?:{method?:string;body?:unknown;idempotencyKey?:string})=>Promise<unknown>};
export type PublishedReportReceipt={protocol:'shuduo-published-report-creation/v1';id:string;requestId:string;status:'PREPARING'|'PARTIAL'|'SUCCEEDED';scope:'LOCAL_TEST_ONLY';source:PublishedReportBinding;name:string;stage:string;sourceEvidenceHash:string;outputContractId?:string;metricIds?:string[];datasetId?:string;snapshotId?:string;reportId?:string;reportVersionId?:string;reportRunId?:string;rowCount?:number;widgetCount?:number;resultHash?:string;error?:{code:string;message:string};agentIndependentE2E:false;publicDeployed:false};
export function checkedPublishedReportReceipt(value:unknown,expected?:{requestId?:string;source?:PublishedReportBinding;name?:string;metricIds?:string[]}):PublishedReportReceipt;
export function submitPublishedReport(client:Client,args:{name:string;source:PublishedReportBinding;requestId:string;metricIds?:string[]}):Promise<PublishedReportReceipt>;
export function lookupPublishedReport(client:Client,args:{requestId:string;source?:PublishedReportBinding;name?:string}):Promise<PublishedReportReceipt>;
export function resumePublishedReport(client:Client,args:{id:string;requestId?:string;source?:PublishedReportBinding}):Promise<PublishedReportReceipt>;

export type PublishedReportResultRead={protocol:'shuduo-published-report-result/v1';receipt:PublishedReportReceipt;overview:unknown};
export function checkedPublishedReportResult(value:unknown,expected?:{requestId?:string;source?:PublishedReportBinding}):PublishedReportResultRead;
export function readPublishedReportResult(client:Client,args:{requestId:string;source?:PublishedReportBinding}):Promise<PublishedReportResultRead>;

export type PublishedReportLineage={
  protocol:'shuduo-fund-report-lineage/v1';scope:'LOCAL_TEST_ONLY';requestId:string;source:PublishedReportBinding;
  report:{id:string;versionId:string;runId:string;resultHash:string};
  snapshot:{id:string;datasetId:string;assetId:string;contractId:string;fields:{name:string;label:string}[];rowCount:number;contentHash:string};
  release:{id:string;status:'ACTIVE_LOCAL'|'SUPERSEDED_LOCAL'|'CANCELLED';businessDate:string;packageDigest:string;
    resultDigest:string;assertionDigest:string;engineClassification:'LOCAL_SPARK_PROCESS';activeForConsumption:boolean;
    upstreamKind?:'FUND_AGENT_GENERATED';modelMode?:'LIVE_MODEL'|'SYNTHETIC_MODEL'};
  batch:{id:string;sequence:number;status:'SUCCEEDED';scheduledAt:string;startedAt:string;finishedAt:string;
    monitorEvent:{id:string;type:'BATCH_SUCCEEDED';status:'SUCCEEDED';observedAt:string}};
  publicDeployed:false;
};
type LineageExpected={requestId?:string;source?:PublishedReportBinding;receipt?:PublishedReportReceipt};
export function checkedPublishedReportLineage(value:unknown,expected?:LineageExpected):PublishedReportLineage;
export function readPublishedReportLineage(client:Client,args:LineageExpected&{requestId:string}):Promise<PublishedReportLineage>;

export type PublishedReportDevelopment={
  protocol:'shuduo-fund-report-development/v1';lineage:PublishedReportLineage;
  revision:{id:string;hash:string;sql:string;source:'ENGINEER_AUTHORED'|'FUND_AGENT_GENERATED'};
  run:{id:string;revisionId:string;revisionHash:string;status:'SUCCEEDED';engine:'Apache Spark';engineVersion:string;
    finishedAt:string;durationMs:number;rowCount:number};
  verification:{status:'PASSED';assertions:string[];inputDigest:string;assertionDigest:string;verifierRevision:string;
    rehearsalId:string;testSqlDigest:string};
};
type DevelopmentExpected=LineageExpected&{lineage?:PublishedReportLineage};
export function checkedPublishedReportDevelopment(value:unknown,expected?:DevelopmentExpected):Promise<PublishedReportDevelopment>;
export function readPublishedReportDevelopment(client:Client,args:DevelopmentExpected&{requestId:string}):Promise<PublishedReportDevelopment>;

export type PublishedReportConsumption = {
  protocol:'shuduo-fund-report-consumption/v1'; scope:'LOCAL_TEST_ONLY'; requestId:string;
  source:PublishedReportBinding; report:PublishedReportLineage['report']; status:'VERIFIED'|'PENDING'|'UNAVAILABLE';
  consumption?:{ services:{serviceId:string;serviceType:'DAPI'|'XAPI';name:string;status:'VERIFIED'|'PENDING'|'NEEDS_ATTENTION';
    versionId:string;call?:{callId:string;rowCount:number;applicationStatus:'ACTIVE'|'REVOKED'|'EXPIRED'}}[] };
};
type ConsumptionExpected=LineageExpected&{lineage?:PublishedReportLineage};
export function checkedPublishedReportConsumption(value:unknown,expected?:ConsumptionExpected):PublishedReportConsumption;
export function readPublishedReportConsumption(client:Client,args:ConsumptionExpected&{requestId:string}):Promise<PublishedReportConsumption>;
