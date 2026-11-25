type SourceProof =
  | { protocol:'shuduo-mysql-archive-input-proof/v1'; scope:'RETAINED_MYSQL_FULL_SNAPSHOT';
      sourceType:'SERVER_MYSQL'; mode:'FULL'; targetTable:'raw_positions'; syncTaskId:string;
      landingReceiptHash:string; landingSnapshotHash:string; targetRows:number; upstreamCoverageVerified:false }
  | { protocol:'shuduo-materialized-input-proof/v1'; scope:'RETAINED_TARGET_SNAPSHOT'; mode:string;
      targetTable:string; targetRows:number; sourceCsvRows:number; landingSnapshotHash:string; snapshotCreatedAt:string;
      upstreamCoverageVerified:false; eventReplayVerified:false };

type PackageBinding = {packageId:string;packageDigest:string};
export type PackageSyncInput = {
  taskId?:string;runId?:string;sourceRevisionId?:string;metadataVersionId?:string;targetHash?:string;
  snapshotHash?:string;landingSnapshotHash?:string;rowCount?:number};
type CheckSelection = PackageBinding & {sourceType?:'SERVER_MYSQL';expectedSyncInput?:PackageSyncInput};
export type PackageInputCheck={protocol:'shuduo-package-input-check/v1';status:'VERIFIED';scope:'LOCAL_SAVED_INPUT_ONLY';readOnly:true;
 binding:PackageBinding;packageDigest:string;sourceCsvExposed:false;evidenceDigest:string;
 input:{syncRunId:string;metadataVersionId:string;sourceRevisionId:string;snapshotHash:string;contentHash:string;targetHash:string;rows:number;finishedAt:string;proof?:SourceProof};
 provenance:{developmentMode:string;newSparkRuns:0;newModelCalls:0;cloudRequests:0;publicDeployed:false;countsTowardLiveEvaluation:false;agentIndependentE2E:false;fullLifecycleE2E:false}};
export function packageInputCheckPath(input:PackageBinding):string;
export function checkedPackageInputCheck(value:unknown, expected:CheckSelection):Promise<PackageInputCheck>;
export function readPackageInputCheck(client:{request:(path:string)=>Promise<unknown>},input:CheckSelection):Promise<PackageInputCheck>;
