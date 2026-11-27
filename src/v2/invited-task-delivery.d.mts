export type InvitedTaskDeliverySelection={taskId:string;revisionId:string;revisionHash:string;runId:string;deliveryId?:string};
export function readInvitedDeliverySelection(taskId:string,query:URLSearchParams):InvitedTaskDeliverySelection;
export function invitedTaskDeliveryPath(input:InvitedTaskDeliverySelection):string;
export function invitedTaskDeliveryRequestId(input:InvitedTaskDeliverySelection):Promise<string>;
