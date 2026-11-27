export type ChatDeliverySource={taskId:string;contextId:string;revisionId:string;runId:string;revisionHash:string};
export type ChatChangeDeliveryReceipt={
  protocol:'shuduo-chat-change-delivery/v1';intentId:string;changeRequestId:string;requestId:string;
  source:ChatDeliverySource;parent:ChatDeliverySource;
  status:'NOT_PREPARED'|'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'INTERRUPTED'|'CANCELLED';
  delivery?:{id:string;status:string;stage?:string;sourceRunId:string;sourceRevisionId:string;sourceSqlHash:string;sourceAgentTaskId:string;packageId?:string;packageDigest?:string;verificationId?:string;error?:string};
  package?:{id:string;digest:string;manifest:unknown;files:Record<string,string>};
  verification?:{id:string;status:string;engine?:string;engineVersion?:string;durationMs?:number;mainSqlExecuted?:boolean;testSqlValidation?:{passed:boolean;sqlHash?:string};validation?:{passed:boolean;regressions?:{contextId:string;passed:boolean}[]};scheduledFor?:string;businessDate?:string;executionOrder?:string[];finishedAt?:string};
};
type Selection={intentId:string;changeRequestId:string;sourceRunId?:string;sourceTaskId?:string;expectedParent?:ChatDeliverySource;expectedSource?:ChatDeliverySource};
type Client={request:(path:string,options?:{method?:'POST';body?:unknown;idempotencyKey?:string})=>Promise<unknown>};
export function readChatChangeDelivery(client:Client,input:Selection):Promise<ChatChangeDeliveryReceipt>;
export function prepareChatChangeDelivery(client:Client,input:Selection&{sourceRunId:string;requestId:string;confirm:true}):Promise<ChatChangeDeliveryReceipt>;
