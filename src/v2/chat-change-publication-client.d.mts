import type {ChatDeliverySource} from './chat-change-delivery-client.mjs';
export type ChatPublicationRun={id:string;sequence:number;status:string;schedulerTriggered:boolean;scheduledTriggerAt:string;
  triggeredAt?:string;finishedAt?:string;engine?:string;engineVersion?:string;testSqlPassed?:boolean;assertionCount?:number;rowCount?:number;totalAssets?:string;resultUnknown?:boolean};
export type ChatChangePublicationReceipt={
  protocol:'shuduo-chat-change-publication/v1';scope:'LOCAL_TEST_RELEASE';publicDeployed:false;intentId:string;changeRequestId:string;requestId:string;source:ChatDeliverySource;parent:ChatDeliverySource;
  packageId:string;packageDigest:string;verificationId:string;reviewDigest:string;businessDate:string;
  scheduleSpec:{triggerAfterSeconds:number;intervalSeconds:number;runCount:number};canPublish:boolean;monitoringVerified:boolean;
  phase:'READY'|'PUBLISHED';reviewId?:string;reviewActorScope?:'LOCAL_DEVELOPER'|'SIGNED_MEMBER';approvalId?:string;release?:{id:string;status:string;health:string};
  runs:ChatPublicationRun[];events:{id:string;type:string;releaseRunId?:string;observedAt:string;status?:string}[];
  alerts:{id:string;status:string;releaseRunId?:string}[];
};
type Read={intentId:string;changeRequestId:string;expectedSource?:ChatDeliverySource;expectedParent?:ChatDeliverySource;sourceTaskId?:string;sourceRunId?:string;packageId?:string;packageDigest?:string;verificationId?:string;requestId?:string;reviewDigest?:string};
type Write=Read&{sourceRunId:string;packageId:string;packageDigest:string;verificationId:string;requestId:string;reviewDigest:string;attestations:Record<string,boolean>;confirm:true};
type Client={request:(path:string,options?:{method?:'POST';body?:unknown;idempotencyKey?:string})=>Promise<unknown>};
export function readChatChangePublication(client:Client,input:Read):Promise<ChatChangePublicationReceipt>;
export function publishChatChange(client:Client,input:Write):Promise<ChatChangePublicationReceipt>;
export function reviewedChatChangeInput(receipt:ChatChangePublicationReceipt,attestations:Record<string,boolean>,confirm:true):Write;
