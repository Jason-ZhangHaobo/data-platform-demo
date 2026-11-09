type Client={request:(path:string,options?:{method?:string;body?:unknown;idempotencyKey?:string})=>Promise<unknown>};
export type GateVersion={id:string;bindingId:string;versionNumber:number;contractId:string;contractVersionId:string;freshnessBasis:'SOURCE_ROWS'|'PUBLICATION_FINISHED';configHash:string};
export type GateBinding={id:string;serviceId:string;contractId:string;version:number;currentVersion:GateVersion;versions:GateVersion[]};
export type GateWrite={protocol:'shuduo-service-contract-gate-write/v1';receipt:{id:string;serviceId:string;bindingId:string;requestId:string;operation:'CREATE'|'VERSION';bindingRevisionAtApply:number;appliedVersion:GateVersion};current:GateBinding;currentMatches:boolean;replayed:boolean};
export function checkedServiceGateWrite(value:unknown,expected?:{serviceId?:string;requestId?:string;bindingId?:string;input?:Record<string,unknown>}):GateWrite;
export function submitServiceGateWrite(client:Client,args:{serviceId:string;bindingId?:string;input:Record<string,unknown>;requestId:string}):Promise<GateWrite>;
export function lookupServiceGateWrite(client:Client,args:{serviceId:string;requestId:string}):Promise<GateWrite>;
