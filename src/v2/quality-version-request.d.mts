export function qualityVersionRequestPath(ruleId:string,requestId:string):string;
export function checkedQualityVersionWrite(value:unknown,ruleId:string,body:{expectedVersionId:string;field:string;type:string;config:Record<string,unknown>;description:string}):{versionId:string;versionNumber:number;currentVersionId:string};
export function readQualityVersionRequest(client:{request:(path:string)=>Promise<unknown>},input:{ruleId:string;requestId:string}):Promise<unknown>;
