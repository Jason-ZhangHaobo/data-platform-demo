export type PackageInputCheck={protocol:'shuduo-package-input-check/v1';status:'VERIFIED';scope:'LOCAL_SAVED_INPUT_ONLY';readOnly:true;
 binding:{packageId:string;packageDigest:string};packageDigest:string;sourceCsvExposed:false;evidenceDigest:string;
 input:{syncRunId:string;metadataVersionId:string;sourceRevisionId:string;snapshotHash:string;contentHash:string;targetHash:string;rows:number;finishedAt:string;proof?:{mode:string;scope:'RETAINED_TARGET_SNAPSHOT';targetRows:number;sourceCsvRows:number;landingSnapshotHash:string}};
 provenance:{developmentMode:string;newSparkRuns:0;newModelCalls:0;cloudRequests:0;publicDeployed:false;countsTowardLiveEvaluation:false;agentIndependentE2E:false;fullLifecycleE2E:false}};
export function packageInputCheckPath(input:{packageId:string;packageDigest:string}):string;
export function readPackageInputCheck(client:{request:(path:string)=>Promise<unknown>},input:{packageId:string;packageDigest:string}):Promise<PackageInputCheck>;
