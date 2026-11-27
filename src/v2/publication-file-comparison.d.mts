export const maxReviewJsonBytes:number;
export type PublicationFileComparison={
  baseline:{packageId?:string;packageDigest:string;projectId:string;revisionId:string;runId:string;contextId:string};
  current:{packageId?:string;packageDigest:string;projectId:string;revisionId:string;runId:string;contextId:string};
  files:{name:string;changed:boolean;baselineBytes:number;currentBytes:number;baselineHash:string;currentHash:string}[];
};
export function comparePublicationFiles(baseline:unknown,current:unknown,expected?:{baselineDigest?:string;currentDigest?:string}):Promise<PublicationFileComparison>;
