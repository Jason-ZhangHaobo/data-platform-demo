export type RepairComparisonBinding={baselineRunId:string;currentRevisionHash:string;baselineRevisionHash:string;evidenceDigest:string};
export type RepairComparisonBasis={protocol:string;sourceRunId:string;contextId:string;binding:RepairComparisonBinding};
type Client={request:(path:string,options?:unknown)=>Promise<any>};
export function comparisonRepairReceiptMatches(task:unknown,body?:unknown):boolean;
export function readRepairComparisonBasis(client:Client,selection:{sourceRunId:string;baselineRunId:string;currentRevisionHash?:string;baselineRevisionHash?:string;contextId?:string}):Promise<RepairComparisonBasis>;
export function createComparisonRepairTask(client:Client,input:{sourceRunId:string;baselineRunId:string;message:string;requestId:string;confirm:true}):Promise<any>;
