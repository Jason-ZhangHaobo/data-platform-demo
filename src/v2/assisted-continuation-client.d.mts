import type {AssistedContinuationBinding} from './assisted-continuation-binding.mjs';
import type {AssistedDevelopmentReference} from './assisted-development-reference.mjs';
type Client={request:(path:string,options?:unknown)=>Promise<any>};
export type AssistedContinuationProof={protocol:string;contextId:string;binding:AssistedContinuationBinding;developmentReference:AssistedDevelopmentReference};
export function readAssistedContinuation(client:Client,selection:{taskId:string;revisionId?:string;runId?:string;revisionHash?:string;contextId?:string}):Promise<AssistedContinuationProof>;
export function assistedContinuationReceiptMatches(task:unknown,body?:unknown):boolean;
export function createAssistedContinuation(client:Client,input:{taskId:string;message:string;requestId:string;confirm:true}):Promise<any>;
