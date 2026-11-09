export type ManualContinuationBinding={kind:'MANUAL_SUCCESS_CONTINUATION';revisionId:string;runId:string;revisionHash:string;evidenceDigest:string;originAgentTaskId?:string};
export function checkedManualContinuationBinding(value:unknown):ManualContinuationBinding;
export function manualContinuationAttribution(value:unknown,originAgentTaskId?:string):{sourceKind:string;agentIndependentE2E:false;sourceAttribution:Record<string,unknown>};
