import type {ManualContinuationBinding} from './manual-continuation-binding.mjs';
import type {AssistedDevelopmentReference} from './assisted-development-reference.mjs';
type Client={request:(path:string,options?:unknown)=>Promise<any>};
export type ManualContinuationProof={protocol:string;contextId:string;binding:ManualContinuationBinding;developmentReference:AssistedDevelopmentReference};
export function readManualContinuation(client:Client,selection:{sourceRunId:string;revisionId?:string;revisionHash?:string;contextId?:string}):Promise<ManualContinuationProof>;
export function manualContinuationReceiptMatches(task:unknown,body?:unknown):boolean;
export function createManualContinuation(client:Client,input:{sourceRunId:string;message:string;requestId:string;confirm:true}):Promise<any>;
