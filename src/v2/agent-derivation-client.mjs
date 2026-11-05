import {createHash} from 'node:crypto';
import {validateAgentContextDerivation} from './agent-context-derivation.mjs';
import {validationFamilyForContext} from './context.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Source and ownership are decided by the API. The adapter only reads the
// requested immutable SQL and sends one explicit new-task request, never an
// advance, publication, retry or transfer of the parent's approval.
export async function createContextDerivedTask(client,input){
 const keys=['derivation','contextId','message','requestId','confirm'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==keys.length||!keys.every(key=>Object.hasOwn(input,key))||
    input.confirm!==true||!uuid.test(input.requestId??'')||typeof input.contextId!=='string'||!/^[a-z][a-z0-9-]{1,79}$/.test(input.contextId)||
    typeof input.message!=='string'||input.message.trim().length<4||input.message.trim().length>2000)throw Error('请确认新口径任务并提供原来源、目标口径、需求和唯一请求编号；不能指定执行者或继承批准');
 const derivation=validateAgentContextDerivation(input.derivation);
 const revision=await client.request(`/revisions/${encodeURIComponent(derivation.revisionId)}`);
 if(revision?.id!==derivation.revisionId||revision.hash!==derivation.revisionHash||typeof revision.sql!=='string'||!revision.sql.trim()||revision.sql.length>20000||
    createHash('sha256').update(revision.sql).digest('hex')!==derivation.revisionHash||revision.contextId===input.contextId)
  throw Error('原代码版本或目标口径不匹配；未创建新任务');
 const created=await client.request('/agent/tasks',{method:'POST',idempotencyKey:input.requestId,
  body:{message:input.message.trim(),sql:revision.sql,contextId:input.contextId,language:'SPARK_SQL',derivation}});
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
