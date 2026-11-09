export type AssistedContinuationBinding={kind:'ASSISTED_SUCCESS_CONTINUATION';taskId:string;revisionId:string;runId:string;revisionHash:string;evidenceDigest:string;depth:number};
export function checkedAssistedContinuationBinding(value:unknown):AssistedContinuationBinding;
export function assistedContinuationAttribution(value:unknown):{sourceKind:string;agentIndependentE2E:false;sourceAttribution:Record<string,unknown>};
