import type {ChatDeliverySource} from './chat-change-delivery-client.mjs';
type AppStatus='ACTIVE'|'EXPIRED'|'REVOKED';
export type ChatConsumptionService={
  serviceId:string;versionId:string;configHash:string;serviceType:'DAPI'|'XAPI';name:string;slug:string;versionNumber:number;
  versionStatus:'PUBLISHED'|'RETIRED';sourceRunIds:string[];fullAssetComposition:boolean;
  sourceVersions:{serviceId:string;versionId:string;configHash:string;sourceReleaseRunId:string;fields:string[]}[];
  call?:{callIdDigest:string;applicationId:string;applicationStatus:AppStatus;finishedAt:string;resultHash:string;rowCount:number};
  pagination?:{status:'COMPLETE'|'INCOMPLETE';applicationId:string;applicationStatus:AppStatus;pageSize:number;totalPages:number;verifiedPages:number[]};
};
export type ChatChangeConsumptionReceipt={
  protocol:'shuduo-chat-batch-consumption/v1';scope:'LOCAL_TEST_ONLY';evidenceScope:'LOCAL_OR_MANUAL_CONSISTENCY_ONLY';
  publicDeployed:false;externalSystemVerified:false;agentIndependentE2E:false;intentId:string;changeRequestId:string;
  parent:ChatDeliverySource;source:ChatDeliverySource;packageId:string;packageDigest:string;verificationId:string;releaseId:string;
  batch:{id:string;sequence:number;status:string;rowCount?:number};status:'PENDING'|'MATCHED_ONLY';truncated:boolean;services:ChatConsumptionService[];
};
type Selection={intentId:string;changeRequestId:string;batchId:string;sequence?:number;expectedSource?:ChatDeliverySource;expectedParent?:ChatDeliverySource;
  sourceTaskId?:string;sourceRunId?:string;releaseId?:string;packageId?:string;packageDigest?:string;verificationId?:string};
export function checkedChatChangeConsumption(value:unknown,input:Selection):ChatChangeConsumptionReceipt;
export function readChatChangeConsumption(client:{request(path:string):Promise<unknown>},input:Selection):Promise<ChatChangeConsumptionReceipt>;
