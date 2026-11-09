import type {SqlClarification} from './sql-clarification-client.mjs';
export const sqlClarificationProtocol:string;
export function clarificationUuid(value:unknown):value is string;
export function validSqlClarification(value:unknown):value is SqlClarification;
export function clarificationAttribution(task:any):{humanClarified?:boolean;directAutonomousEligible?:boolean;clarificationOriginTaskId?:string};
export function clarificationReceiptMatches(task:any,body?:any):boolean;
export function clarificationReplyReason(task:any):string|undefined;
