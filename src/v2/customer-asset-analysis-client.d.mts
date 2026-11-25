import type {PublishedReportBinding} from './published-report-request.mjs';
type Distribution = {label:string;marketValue:string;ratio:string};
export type CustomerAssetAnalysis = {
  protocol:'shuduo-customer-asset-analysis/v1'; scope:'LOCAL_TEST_ONLY'; readOnly:true; digest:string;
  report:{requestId:string;reportId:string;versionId:string;runId:string;reportSnapshotId:string;resultHash:string};
  source:{taskId:string;releaseId:string;batchId:string;sequence:number;packageDigest:string;revisionId:string;
    developmentRunId:string;sourceType:'SERVER_MYSQL';syncTaskId:string;syncRunId:string;sourceRevisionId:string;
    metadataVersionId:string;landingReceiptHash:string;landingSnapshotHash:string;snapshotHash:string;businessDate:string;advisorId:string};
  customers:{customerKey:string;clientLabel:string;totalAssets:string;holdingMarketValue:string;availableCash:string;
    securityCount:number;nullMarketValueCount:number;assetClasses:Distribution[];industries:Distribution[]}[];
};
type Selection={requestId:string;source?:PublishedReportBinding;reportId?:string;versionId?:string;reportRunId?:string;
  reportSnapshotId?:string;resultHash?:string};
export function checkedCustomerAssetAnalysis(value:unknown, expected:Selection):Promise<CustomerAssetAnalysis>;
export function readCustomerAssetAnalysis(client:{request:(path:string)=>Promise<unknown>},expected:Selection):Promise<CustomerAssetAnalysis>;
