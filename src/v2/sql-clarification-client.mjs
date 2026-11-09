import {sqlClarificationProtocol,clarificationUuid,clarificationReceiptMatches} from './sql-clarification-contract.mjs';
const canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
const bad=()=>Object.assign(Error('澄清回执与原问题、回答或输入未确认；保留原请求编号，不自动重提'),{code:'CLARIFICATION_RECEIPT_INVALID'});
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export async function readSqlClarification(client,selection){
 if(!selection||Object.keys(selection).some(k=>!['taskId','contextId','question','sql','evidenceDigest'].includes(k))||!clarificationUuid(selection.taskId))throw bad();
 const s=await client.request(`/agent/tasks/${selection.taskId}/clarification-source`);
 if(s?.protocol!==sqlClarificationProtocol||s.binding?.taskId!==selection.taskId||!digest(s.binding.evidenceDigest)||
  typeof s.contextId!=='string'||typeof s.sql!=='string'||!s.sql.trim()||s.sql.length>20000||typeof s.question!=='string'||!s.question||s.question.length>300||
  typeof s.originalRequest!=='string'||!s.originalRequest||s.originalRequest.length>2000||!Number.isSafeInteger(s.depth)||s.depth<0||s.depth>=3||!Number.isSafeInteger(s.historicalTokens)||s.historicalTokens<0||
  ['contextId','sql','question'].some(k=>selection[k]!==undefined&&selection[k]!==s[k])||selection.evidenceDigest!==undefined&&selection.evidenceDigest!==s.binding.evidenceDigest)throw bad();
 return s;
}
export function sqlClarificationBody(source,answer){
 if(source?.protocol!==sqlClarificationProtocol||!clarificationUuid(source.binding?.taskId)||!digest(source.binding.evidenceDigest)||typeof answer!=='string'||!answer.trim()||answer.length>1000)throw bad();
 return {message:answer.trim(),sql:source.sql,contextId:source.contextId,clarification:source.binding};
}
export async function verifiedClarificationReceipt(task,body){
 if(!clarificationReceiptMatches(task,body))return false;
 if(task?.clarification===undefined)return true;
 const {digest,...content}=task.clarification;
 return await sha(canonical(content))===digest&&await sha(task.initialSql)===task.clarification.sourceSqlHash;
}
export async function createSqlClarification(client,input){
 if(!input||Object.keys(input).some(k=>!['taskId','answer','evidenceDigest','requestId','confirm'].includes(k))||input.confirm!==true||!clarificationUuid(input.requestId)||!digest(input.evidenceDigest))throw bad();
 const source=await readSqlClarification(client,{taskId:input.taskId,evidenceDigest:input.evidenceDigest}),body=sqlClarificationBody(source,input.answer);
 const task=await client.request('/agent/tasks',{method:'POST',body,idempotencyKey:input.requestId});
 if(!await verifiedClarificationReceipt(task,body)||task.clarification.originalRequest!==source.originalRequest||task.clarification.depth!==source.depth+1||task.clarification.turns.at(-1).question!==source.question)throw bad();
 return task;
}
