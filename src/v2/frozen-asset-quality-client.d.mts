export type FrozenQualitySource={assetId:string;evidenceHash?:string;rowCount?:number};
export type FrozenQualityCheck={id:string;status:"PASSED"|"FAILED";evaluatedCount:number;failedCount:number;passedCount:number;passRate:number};
type Basis={assetId:string;batchId:string;releaseId:string;evidenceHash:string;snapshotHash:string;basisDigest:string;ruleSet:string;rowCount:number};
export type FrozenAssetQuality=Basis&({status:"PENDING";actualExecution:false}|{status:"PASSED"|"FAILED";actualExecution:true;checks:FrozenQualityCheck[];checkId:string;receiptDigest:string;checkedAt:string});
export function frozenQualityRules(): {id:string;name:string}[];
export function frozenQualityPath(assetId:unknown):string;
export function checkedFrozenAssetQuality(value:unknown,expected?:FrozenQualitySource):FrozenAssetQuality;
export function readFrozenAssetQuality(client:{request(path:string):Promise<unknown>},expected:FrozenQualitySource):Promise<FrozenAssetQuality>;
