import {createHash} from 'node:crypto';
import {validSqlClarification,sqlClarificationProtocol} from './sql-clarification-contract.mjs';
export const clarificationHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item)).digest('hex');
export function verifiedSqlClarification(value,{message,contextId}){
 if(!validSqlClarification(value)||value.contextId!==contextId||value.turns.at(-1).answer!==message)return false;
 const {digest,...content}=value;return clarificationHash(content)===digest;
}
export function appendSqlClarification(parent,source,answer){
 const prior=parent.clarification,turn={taskId:parent.id,sourceDigest:source.binding.evidenceDigest,question:source.question,answer,
  usedTokens:parent.usedTokens,usageEstimated:parent.attempts.some(a=>a.usageEstimated===true),attemptCount:parent.attempts.length};
 const value={protocol:sqlClarificationProtocol,originalTaskId:prior?.originalTaskId??parent.id,originalRequest:prior?.originalRequest??parent.message,
  contextId:parent.contextId,sourceSqlHash:clarificationHash(source.sql),turns:[...(prior?.turns??[]),turn],depth:(prior?.depth??0)+1};
 return {...value,digest:clarificationHash(value)};
}
