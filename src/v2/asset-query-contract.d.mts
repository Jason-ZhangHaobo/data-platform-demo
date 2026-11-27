export type AssetQueryContract={scope:string;serviceType:'DAPI'|'XAPI';serviceId:string;slug:string;name:string;versionId:string;versionNumber:number;
  configHash:string;current:boolean;timeoutMs:number;rateLimitPerMinute:number;sources:{serviceId:string;versionId:string;configHash:string;batchId:string;fields:string[];alias?:string}[]};
export const assetQueryFieldNames:Readonly<Record<string,string>>;
export const assetQueryFields:readonly string[];
export function assetQueryContract(service:unknown,version:unknown,children:unknown[]):AssetQueryContract|undefined;
export function boundAssetQueryContract(entry:unknown,batchId:string):AssetQueryContract|undefined;
export function assetQueryDocument(contract:AssetQueryContract,origin?:string):Record<string,unknown>;
