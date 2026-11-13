type PublicationSelector = {sourceKind?:"AGENT"|"MANUAL";sourceRunId?:string;packageDigest?:string;verificationId?:string;releaseId?:string};
export function publicationPreflightPath(taskId:string, selector:PublicationSelector):string;
export function publicationRequestReceiptPath(taskId:string, requestId:string):string;
export function workbenchPublicationRequestKey(packageId:string, verificationId:string):string;
