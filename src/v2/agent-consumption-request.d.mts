export type AgentConsumptionInput={sourceBinding:{taskId:string;releaseId:string;packageDigest:string;sourceReleaseRunId:string};
  applicationId:string;dapiVersionId:string;xapiVersionId:string};
export const agentConsumptionPath:string;
export function agentConsumptionReceiptPath(requestId:string):string;
export function readAgentConsumption(body:unknown,requestId:string):AgentConsumptionInput;
export const agentConsumptionQuery:Readonly<{page:string;page_size:string}>;
