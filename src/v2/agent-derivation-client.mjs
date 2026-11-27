import {createHash} from 'node:crypto';
import {agentContextDerivationRequest,validateAgentContextDerivation} from './agent-context-derivation.mjs';
import {validationFamilyForContext} from './context.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const chatRequestId=/^chat-derive-v1-[a-f0-9]{64}$/;
// Source and ownership are decided by the API. The adapter only reads the
// requested immutable SQL and sends one explicit new-task request, never an
// advance, publication, retry or transfer of the parent's approval.
export async function createContextDerivedTask(client,input){
 const keys=['derivation','contextId','message','requestId','confirm'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==keys.length||!keys.every(key=>Object.hasOwn(input,key))||
    input.confirm!==true||!uuid.test(input.requestId??'')||typeof input.contextId!=='string'||!/^[a-z][a-z0-9-]{1,79}$/.test(input.contextId)||
    typeof input.message!=='string'||input.message.trim().length<4||input.message.trim().length>2000)throw Error('请确认新口径任务并提供原来源、目标口径、需求和唯一请求编号；不能指定执行者或继承批准');
 const derivation=validateAgentContextDerivation(input.derivation);
 return submitDerived(client,input,derivation);
}

async function submitDerived(client,input,derivation,chatChange){
 const revision=await client.request(`/revisions/${encodeURIComponent(derivation.revisionId)}`);
 if(revision?.id!==derivation.revisionId||revision.hash!==derivation.revisionHash||typeof revision.sql!=='string'||!revision.sql.trim()||revision.sql.length>20000||
    createHash('sha256').update(revision.sql).digest('hex')!==derivation.revisionHash||revision.contextId===input.contextId)
  throw Error('原代码版本或目标口径不匹配；未创建新任务');
 let created;
 try {
   created=await client.request('/agent/tasks',{method:'POST',idempotencyKey:input.requestId,
     body:{message:input.message.trim(),sql:revision.sql,contextId:input.contextId,language:'SPARK_SQL',derivation,...(chatChange?{chatChange}:{})}});
 } catch (error) {
   // Chat requests have a source-bound ledger and can reconcile an uncertain
   // write there. Validation or permission errors retain their original cause.
   if (chatChange && !(error.status>=400 && error.status<500)) return;
   throw error;
 }
 const expected={...derivation,contextId:revision.contextId,validationContractId:validationFamilyForContext(revision.contextId)?.id},source=created?.derivedFrom;
 if(!uuid.test(created?.id??'')||created.id===derivation.taskId||created.contextId!==input.contextId||created.language!=='SPARK_SQL'||created.initialSql!==revision.sql||
    created.sql!==undefined&&(typeof created.sql!=='string'||!created.sql.trim()||created.sql.length>20000)||
    !Number.isSafeInteger(created.version)||created.version<1||created.message!==input.message.trim()||!Array.isArray(created.attempts)||
    !['QUEUED','RUNNING','SUCCEEDED','FAILED','VALIDATION_FAILED','CANCELLED','INTERRUPTED'].includes(created.status)||
    !source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).length!==7||
    Object.entries(expected).some(([key,value])=>typeof value!=='string'||source[key]!==value))
  throw Error(`新任务回执尚未确认，请按原请求编号 ${input.requestId} 查询；不会自动重新提交`);
 return created;
}

export async function readChatScopeChanges(client,{intentId}){
 if (!uuid.test(intentId)) throw Error('请提供原开发对话编号');
 const snapshot=await client.request(`/agent/intents/${intentId}/development/changes`);
 if (snapshot?.protocol!=='shuduo-chat-sql-changes/v1' || snapshot.binding?.intentId!==intentId ||
     snapshot.source?.id!==snapshot.binding.contextId || typeof snapshot.eligible!=='boolean' ||
     (snapshot.nextRequestId!==null && !chatRequestId.test(snapshot.nextRequestId)) ||
     !Array.isArray(snapshot.targets) || !Array.isArray(snapshot.changes) ||
     snapshot.changes.some(row=>!chatRequestId.test(row?.requestId) || !uuid.test(row?.taskId) || row.taskId===snapshot.binding.taskId))
   throw Error('原对话的变更记录尚未核实');
 validateAgentContextDerivation(agentContextDerivationRequest(snapshot.binding));
 return snapshot;
}

export async function submitChatScopeChange(client,input){
 const keys=['intentId','sourceRunId','contextId','message','requestId','confirm'];
 if (!input || Object.keys(input).length!==keys.length || !keys.every(key=>Object.hasOwn(input,key)) ||
     input.confirm!==true || !uuid.test(input.intentId) || !uuid.test(input.sourceRunId) || !chatRequestId.test(input.requestId) ||
     typeof input.contextId!=='string' || typeof input.message!=='string' ||
     input.message.trim().length<4 || input.message.trim().length>2000)
   throw Error('请核对目标口径和服务端提供的变更编号，再确认创建新任务');
 const snapshot=await readChatScopeChanges(client,input);
 if (snapshot.binding.runId!==input.sourceRunId) throw Error('原对话的批次已变化，请重新核对所审阅的来源');
 const confirmed=(current)=>{
   const found=current.changes.filter(row=>row.requestId===input.requestId);
   if (!found.length) return;
   const [row]=found;
   if (found.length!==1 || !uuid.test(row.taskId) || row.taskId===snapshot.binding.taskId ||
       row.contextId!==input.contextId || row.message!==input.message.trim())
     throw Error('原变更编号已用于其他需求或口径');
   return row;
 };
 const already=confirmed(snapshot);
 if (already) return already;
 if (!snapshot.eligible || snapshot.nextRequestId!==input.requestId || !snapshot.targets.some(target=>target.id===input.contextId))
   throw Error('当前来源、目标口径或本次变更编号已不可用，请重新核对原对话');
 const source=validateAgentContextDerivation(agentContextDerivationRequest(snapshot.binding));
 await submitDerived(client,input,source,{intentId:input.intentId});
 const after=await readChatScopeChanges(client,input);
 if (Object.keys(snapshot.binding).some(key=>snapshot.binding[key]!==after.binding[key])) throw Error('原会话绑定已变化，请重新核对');
 const receipt=confirmed(after);
 if (!receipt) throw Error('新任务应答尚未与原对话核对，请查询该对话的变更记录');
 return receipt;
}
