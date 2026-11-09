type Client={request:(path:string,options?:any)=>Promise<any>};
export type ManualPublicationSelection={sourceRunId:string;taskId:string;packageDigest:string;verificationId:string;releaseId?:string};
export type ManualPublication={protocol:string;manualDeliveryTaskId:string;scope:'PRIVATE_CLOUD_TEST';agentIndependentE2E:false;release?:{id:string;status:string;health:string;packageDigest:string};runs:{id:string;sequence:number;status:string;durationMs?:number}[];alerts:{id:string;status:string;message:string;recoveryRunId?:string}[];events:{id:string;type:string;observedAt:string}[]};
export function readStandalonePublication(client:Client,input:ManualPublicationSelection):Promise<ManualPublication>;
export function publishStandaloneManual(client:Client,input:ManualPublicationSelection&{requestId:string;confirm:true;attestations:{code:true;assertions:true;deliveryFiles:true;cloudScope:true}}):Promise<ManualPublication>;
export type ManualPublicationStop={protocol:'shuduo-standalone-manual-stop/v1';scope:'STOP_ACK_ONLY';manualDeliveryTaskId:string;releaseId:string;packageDigest:string;verificationId:string;status:string};
export function cancelStandalonePublication(client:Client,input:ManualPublicationSelection&{confirm:true}):Promise<ManualPublicationStop>;
export function checkedStandalonePublication(value:unknown,selection:ManualPublicationSelection,before:unknown):ManualPublication;

export function manualPublicationRequestId(input:ManualPublicationSelection):Promise<string>;
