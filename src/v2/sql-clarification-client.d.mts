export type SqlClarification={protocol:string;originalTaskId:string;originalRequest:string;contextId:string;sourceSqlHash:string;depth:number;digest:string;
 turns:{taskId:string;sourceDigest:string;question:string;answer:string;usedTokens:number;usageEstimated:boolean;attemptCount:number}[]};
export type SqlClarificationSource={protocol:string;binding:{taskId:string;evidenceDigest:string};contextId:string;sql:string;question:string;originalRequest:string;depth:number;historicalTokens:number};
type Client={request:(path:string,options?:any)=>Promise<any>};
export function readSqlClarification(client:Client,selection:{taskId:string;contextId?:string;question?:string;sql?:string;evidenceDigest?:string}):Promise<SqlClarificationSource>;
export function sqlClarificationBody(source:SqlClarificationSource,answer:string):{message:string;sql:string;contextId:string;clarification:{taskId:string;evidenceDigest:string}};
export function createSqlClarification(client:Client,input:{taskId:string;answer:string;evidenceDigest:string;requestId:string;confirm:true}):Promise<any>;
export function verifiedClarificationReceipt(task:any,body?:any):Promise<boolean>;
